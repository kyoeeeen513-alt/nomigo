// 年齢確認の申請通知を「送る係」。
//
// 【なぜこれを作ったか】
//  従来は、利用者のブラウザが /api/admin へ notify_pending を投げる方式だった。
//  この方式では ①利用者がアプリを閉じた ②通信が切れた ③LINEの送信が失敗した
//  のいずれの場合も通知が飛ばず、しかも記録が一切残らないため誰も気づけない。
//  実例：2026/9/2 18:41 の申請が 9/4 10:35 まで約40時間放置された（No.275）。
//
// 【新しい作り】3段構え
//  ①データベースのトリガーが、申請が pending になった瞬間に
//    受付台帳（verify_notify_jobs）へ1行積む。
//    ブラウザやサーバーの都合に依存しないため、記録だけは必ず残る。
//  ②この「送る係」が未送信の行を拾ってLINEへ送り、結果を台帳へ書き戻す。
//  ③1分おきの見張り（pg_cron）が、未送信が残っていれば再びこれを呼ぶ。
//
// 【1件の申請につき通知は1通だけ】
//  送信に成功した行には status='sent' の印が付き、二度と拾われない。
//  1分おきの見張りが拾うのは status='queued' の行だけである。
//
// 【なぜ合言葉（秘密の鍵）を必要としないか】
//  この窓口は、送り先も文面もサーバー側で決めており、
//  呼び出した人から一切指定できない。返す内容も件数のみで、
//  利用者の氏名・生年月日・身分証などは扱わない。
//  したがって第三者に呼ばれても、起きうることは
//  「本来送るべき通知が予定より早く運営へ届く」だけであり、実害がない。
//  合言葉を持たせると、その合言葉自体の管理と漏えいが新たな危険になるため、
//  ここでは持たせない設計とした。
//
// 【必要な環境変数】すべて既存のものを使う。追加は不要。
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / LINE_CHANNEL_ACCESS_TOKEN

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 運営ページのURL（LINE通知に載せる）
const ADMIN_PAGE_URL = 'https://nomi-go.jp/admin.html';

// 1回の呼び出しで処理する最大件数。
// 多すぎると処理が長引いて途中で打ち切られるため、少しずつ確実に片付ける。
// 残りは次の見張り（1分後）が拾う。
const MAX_PER_RUN = 5;

// 何回失敗したらあきらめるか。
// 無限に送り続けると、LINE側の障害が長引いたときに延々と試行し続けることになる。
const MAX_ATTEMPTS = 5;

// 運営権限でデータベースを読み書きする共通処理
async function db(path, options) {
  const opt = options || {};
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opt.method || 'GET',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opt.prefer || 'return=representation',
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error('db_error:' + r.status);
  try { return JSON.parse(text); } catch (e) { return null; }
}

// LINEへ1通送る。
// 成功したかどうかと、失敗した場合の理由を返す。
// 従来の pushLine は失敗を false で握りつぶしており、
// 何が起きたのかを後から追えなかった。ここでは理由も持ち帰る。
async function pushLine(lineUserId, text) {
  if (!lineUserId) return { ok: false, error: 'no_target' };
  if (!LINE_TOKEN) return { ok: false, error: 'no_line_token' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text: text }] }),
    });
    if (r.ok) return { ok: true, error: null };
    let detail = '';
    try { detail = (await r.text()).slice(0, 300); } catch (e) {}
    return { ok: false, error: 'line_' + r.status + ':' + detail };
  } catch (e) {
    return { ok: false, error: 'line_exception:' + String(e && e.message).slice(0, 200) };
  }
}

// 台帳の1行を更新する
async function updateJob(id, patch) {
  patch.updated_at = new Date().toISOString();
  await db(`verify_notify_jobs?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: patch,
  });
}

module.exports = async (req, res) => {
  // GET でも POST でも動くようにしている。
  // 1分おきの見張り（データベース側）からも、利用者の申請直後のブラウザからも
  // 同じ窓口を叩くため、呼び方を限定しない。
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }

  if (!SUPABASE_URL || !SERVICE_KEY || !LINE_TOKEN) {
    res.status(500).json({ success: false, error: 'server_not_configured' });
    return;
  }

  let picked = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  try {
    // ── ①未送信の行を古い順に取り出す ─────────────────
    const jobs = await db(
      'verify_notify_jobs?status=eq.queued' +
      '&select=id,user_id,attempts' +
      '&order=created_at.asc&limit=' + MAX_PER_RUN
    );

    if (!jobs || jobs.length === 0) {
      res.status(200).json({ success: true, picked: 0, sent: 0, failed: 0, skipped: 0 });
      return;
    }
    picked = jobs.length;

    // ── ②送り先を1回だけ引く ──────────────────────
    let target = null;
    try {
      const rows = await db(
        'notify_targets?role=eq.age_verification&enabled=is.true&select=line_user_id'
      );
      target = rows && rows[0] ? rows[0].line_user_id : null;
    } catch (e) {}

    for (const job of jobs) {
      const attempts = (job.attempts || 0) + 1;

      // ── ③まだ本当に確認待ちかを見る ──────────────
      //  申請したあとに運営が既に承認・否認を済ませていることがある。
      //  その場合に通知を送っても意味がないため、送らずに片付ける。
      //  ここで pending でなかったからといって捨てるのではなく、
      //  skipped として記録に残す点が従来との違いである。
      //  （従来は skipped:true を返すだけで何も残らなかった）
      let stillPending = false;
      try {
        const p = await db(
          `profiles?user_id=eq.${job.user_id}&select=id_verify_status`
        );
        stillPending = !!(p && p[0] && p[0].id_verify_status === 'pending');
      } catch (e) {
        // データベースの読み取りに失敗した場合は、判断できないので
        // 送らずに次回へ回す。取りこぼすより、遅れて届くほうがよい。
        await updateJob(job.id, {
          attempts: attempts,
          last_error: 'profile_read_failed',
        });
        failed++;
        continue;
      }

      if (!stillPending) {
        await updateJob(job.id, {
          status: 'skipped',
          attempts: attempts,
          last_error: 'already_handled',
        });
        skipped++;
        continue;
      }

      // ── ④送り先が無い場合 ─────────────────────
      if (!target) {
        await updateJob(job.id, {
          attempts: attempts,
          last_error: 'no_notify_target',
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
        });
        failed++;
        continue;
      }

      // ── ⑤未対応の件数を数える ────────────────────
      let count = 1;
      try {
        const all = await db('profiles?id_verify_status=eq.pending&select=user_id');
        count = all ? all.length : 1;
      } catch (e) {}

      // ── ⑥送る ───────────────────────────
      //  文面に利用者の氏名・生年月日等は一切含めない。
      //  LINEのトーク画面に個人情報を残さないため。
      const text =
        '📋 年齢確認の申請が届きました\n\n' +
        '未対応：' + count + '件\n\n' +
        '運営ページを開いて確認してください。\n' + ADMIN_PAGE_URL;

      const result = await pushLine(target, text);

      if (result.ok) {
        await updateJob(job.id, {
          status: 'sent',
          attempts: attempts,
          sent_to: target,
          sent_at: new Date().toISOString(),
          last_error: null,
        });
        sent++;
      } else {
        // 失敗した理由を必ず残す。
        // 上限に達したらあきらめる（status='failed'）。
        // あきらめた行は見張りに拾われなくなるが、記録としては残るため、
        // 後から「なぜ届かなかったか」を追える。
        await updateJob(job.id, {
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
          attempts: attempts,
          last_error: String(result.error).slice(0, 500),
        });
        failed++;
      }
    }

    res.status(200).json({
      success: true,
      picked: picked,
      sent: sent,
      failed: failed,
      skipped: skipped,
    });
  } catch (e) {
    // 呼び出し元（見張り）へ異常を伝えるが、
    // 未送信の行はそのまま残るため、次回の見張りが拾い直す。
    res.status(200).json({
      success: false,
      error: 'failed',
      picked: picked,
      sent: sent,
      failed: failed,
      skipped: skipped,
    });
  }
};
