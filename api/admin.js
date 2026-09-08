// 運営ページ（admin.html）専用の窓口。
//
// 【この作りの考え方】
// ・呼び出した人が「運営本人か」を毎回サーバー側で確認する。運営以外は何もできない。
// ・LINEの送り先と文面はサーバーが決める。ブラウザからは指定できない。
// ・操作内容は admin_audit_logs に記録する。
//
// 【2026-08-08 の変更】
//  これまで admin.html がブラウザから直接データベースを読んでいたため、
//  「奈良のアカウントだけ読める」というルール（RLS）に依存していた。
//  そのため代表（永澤）がログインしても本人確認の一覧が空になり、
//  法令上の担当者が作業できない状態だった。
//  一覧の取得と画像URLの発行をすべてサーバー側に移し、
//  admin_users テーブルの権限で判定する形に変更した。
//  あわせて、奈良個人のIDで固定されたRLSポリシーを削除できるようにした。
//
//  追加した action：
//    list_pending  … 本人確認の待ち一覧を返す（can_verify が必要）
//    photo_url     … 身分証・顔写真の一時URLを発行する（can_verify が必要）
//    list_inquiries… 問い合わせ一覧を返す（can_reply が必要）
//    mark_handled  … 問い合わせを対応済みにする（can_reply が必要）
//
// 【2026-09-02 の変更・No.253】
//  否認するときに「理由の種類」を受け取るようにした（reason）。
//  以前はどんな理由で否認しても、利用者には必ず
//  「もう一度書類のご提出をお願いします」というLINEが届いていた。
//  そのため、生年月日の打ち間違いが理由の方が写真を何度出し直しても通らず、
//  行き止まりになっていた（実例：2026/9/2、利用者バンコ）。
//  理由は3種類。
//    mismatch … 登録内容が身分証と違う（写真の再提出は不要。入力を直してもらう）
//    photo    … 写真が確認できない（撮り直しが必要）
//    invalid  … 書類として受け付けられない（別の書類が必要）
//  受け取った理由は profiles.reject_reason に保存する。
//  この値を見て、アプリ側が利用者に出す画面を変える。
//  また、mismatch のときだけデータベース側が本人による生年月日・本名の
//  修正を許可する（guard_profiles_update トリガー）。
//
//  あわせて list_rejected を追加した。以前は否認した時点で一覧から消え、
//  運営がその後の状況を追えなくなっていたため。
//
// 【2026-09-08 の変更・No.24 / No.296】
//  退会（アカウントの利用停止）を行えるようにした。
//
//  これまで「退会希望の方はこちら」を押しても、問い合わせが1件届くだけで、
//  アカウントを止める手段がどこにも無かった。利用者には
//  「運営が確認後、アカウントを利用できない状態にします」と表示していたため、
//  表示と実態が食い違っていた。
//
//  追加した action：
//    withdraw   … 本人の申請による退会。再登録できる（can_suspend が必要）
//    ban        … 運営による強制退会。blacklist にも登録し再登録も拒否（can_suspend が必要）
//    restore    … 退会・凍結を解除して元に戻す（can_suspend が必要）
//
//  【消さずに止める理由】
//   auth.users から利用者を削除すると、外部キーの連鎖削除により
//   profiles・registrations・messages・match_members などが一緒に消える。
//   registrations には本人確認記録（本名・生年月日・身分証画像）が入っており、
//   これが消えると保存義務との関係で問題になりうる（No.297 で弁護士に確認中）。
//   また payments・ticket_ledger・refunds は連鎖削除が禁止されているため、
//   課金履歴のある利用者はそもそも削除自体が失敗する。
//   よって「消す」のではなく profiles.account_status で「入れなくする」。
//
//  【チケットを消さない理由】
//   誤操作で退会させた場合に元へ戻せるようにするため。
//   また購入済みのチケットを消すと返金請求の根拠を与えかねない。
//   ログインできない時点で使用はできないため、残しても実害がない。
//
//  【進行中のマッチがあるときは退会させない理由】
//   相手が待ちぼうけになり、ドタキャン扱いのトラブルになるため。
//   先にマッチを終わらせてから退会させる。
//
// 【必要な環境変数】すべて設定済み
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / LINE_CHANNEL_ACCESS_TOKEN

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 運営ページのURL（LINE通知に載せる）
const ADMIN_PAGE_URL = 'https://nomi-go.jp/admin.html';

// 身分証を保存しているバケット名。ブラウザからは指定させない
const ID_BUCKET = 'id_photos';

// 否認の理由として受け付ける値。これ以外は受け取らない。
const REJECT_REASONS = ['mismatch', 'photo', 'invalid'];

// ログイン証明（トークン）の中身から「2段階認証を済ませたか」を読み取る。
//
// 【なぜ必要か】
//  画面側で6桁の番号を確認しても、この窓口を直接呼ばれてしまえば意味がありません。
//  そのため、2段階認証を通ったログインかどうかをサーバー側でも必ず確かめます。
//
//  Supabaseのトークンには aal という項目が入っており、
//    aal1 … メールアドレスとパスワードだけでログインした状態
//    aal2 … さらに6桁の番号を入力して確認が済んだ状態
//  を表します。運営ページの操作はすべて aal2 でなければ受け付けません。
//
//  なお、このトークンが本物かどうかは、この関数の前に
//  Supabaseへ問い合わせて確認済みです。ここでは中身を読むだけです。
function getAal(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && payload.aal ? String(payload.aal) : null;
  } catch (e) {
    return null;
  }
}

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
  if (!r.ok) throw new Error('db_error');
  try { return JSON.parse(text); } catch (e) { return null; }
}

// 保管庫の画像について、一定時間だけ有効なURLを発行する
async function signUrl(bucket, path, seconds) {
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${encodeURI(path)}`,
    {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: seconds }),
    }
  );
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j.signedURL) return null;
  return `${SUPABASE_URL}/storage/v1${j.signedURL}`;
}

// LINEへ1通送る。失敗しても本体の処理は止めない
async function pushLine(lineUserId, text) {
  if (!lineUserId || !text) return false;
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text: text }] }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// 役割ごとの通知先を取り出す（notify_targets テーブル）
async function notifyTarget(role) {
  try {
    const rows = await db(`notify_targets?role=eq.${role}&enabled=is.true&select=line_user_id`);
    return rows && rows[0] ? rows[0].line_user_id : null;
  } catch (e) {
    return null;
  }
}

// 操作の記録を残す。失敗しても本体の処理は止めない
async function audit(actorId, action, targetTable, targetId, after, note) {
  try {
    await db('admin_audit_logs', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        actor_id: actorId,
        action: action,
        target_table: targetTable,
        target_id: String(targetId),
        after_data: after || null,
        note: note || null,
      },
    });
  } catch (e) {}
}

// 否認したときに本人へ送るLINEの文面を、理由の種類ごとに作る。
//
// 【なぜ分けるか】
//  以前はどの理由でも「もう一度書類のご提出をお願いします」で固定だった。
//  生年月日の打ち間違いが理由の方にこれを送ると、写真を出し直しても
//  永久に通らないため、同じことを繰り返させてしまう。
//  やるべきことを、理由ごとに正確に伝える。
function rejectMessage(reason, note) {
  const reasonLine = note ? '内容：' + note + '\n\n' : '';
  if (reason === 'mismatch') {
    return (
      '⚠️ ご登録内容のご確認をお願いします\n\n' +
      reasonLine +
      'ご登録の内容と、ご提出の身分証の記載が一致しませんでした。\n\n' +
      'お預かりしたお写真はそのままお預かりしていますので、撮り直しは必要ありません。\n' +
      'Nomi Goを開いて「登録内容を修正する」から、身分証と同じ内容にご修正ください。'
    );
  }
  if (reason === 'invalid') {
    return (
      '⚠️ ご提出の書類を確認できませんでした\n\n' +
      reasonLine +
      'この書類では年齢の確認ができませんでした。\n\n' +
      '運転免許証・マイナンバーカード・パスポートなど、有効期限内の公的な身分証をご用意のうえ、Nomi Goからもう一度ご提出をお願いします。'
    );
  }
  // photo、または理由が未指定の場合（従来どおりの案内）
  return (
    '⚠️ お写真を確認できませんでした\n\n' +
    reasonLine +
    '文字がぼやけていたり、一部が切れていた可能性があります。\n\n' +
    '明るい場所で、四隅まで入るように撮り直して、Nomi Goからもう一度ご提出をお願いします。'
  );
}

// 【2026-09-08 追加】退会・凍結の共通処理。
//
// withdraw（本人申請）と ban（強制）で共通する部分をまとめる。
// 違いは3つだけ。
//   ・profiles.account_status に入れる値
//   ・blacklist に登録するかどうか
//   ・本人へ送るLINEの文面
//
// 進行中のマッチがある場合は、どちらであっても止める。
// 相手が待ちぼうけになるため。
async function doDeactivate(myId, admin, userId, mode, reason) {
  // 対象の現状を読む
  const rows = await db(
    `profiles?user_id=eq.${userId}` +
    `&select=user_id,nickname,real_name,birthdate,line_user_id,account_status,ticket_count`
  );
  if (!rows || !rows[0]) return { code: 404, body: { success: false, error: 'user_not_found' } };
  const p = rows[0];

  // すでに止まっているなら二重に処理しない
  if (p.account_status && p.account_status !== 'active') {
    return { code: 200, body: { success: false, error: 'already_inactive', status: p.account_status } };
  }

  // 進行中のマッチがあるなら止める。
  // 相手が待っている状態で消すと、ドタキャン扱いのトラブルになる。
  const mm = await db(`match_members?user_id=eq.${userId}&status=eq.active&select=match_id`);
  if (mm && mm.length > 0) {
    return { code: 200, body: { success: false, error: 'active_match' } };
  }

  const now = new Date().toISOString();

  // 募集中のものがあれば取り下げる。
  // 残したままだと、退会後もマッチの候補として拾われてしまう。
  try {
    await db(`registrations?user_id=eq.${userId}&status=eq.waiting`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { status: 'cancelled' },
    });
  } catch (e) {}

  // アカウントを止める。チケットは消さない（誤操作の復旧と返金対応のため）
  const patch = {
    account_status: mode === 'ban' ? 'banned' : 'withdrawn',
    status_changed_at: now,
    status_reason: reason || null,
    updated_at: now,
  };
  const updated = await db(`profiles?user_id=eq.${userId}`, { method: 'PATCH', body: patch });
  if (!updated || updated.length === 0) {
    return { code: 404, body: { success: false, error: 'user_not_found' } };
  }

  // 強制退会のときは blacklist にも登録する。
  // 本名と生年月日を入れることで、別のメールアドレスで登録し直しても
  // reject_blacklisted_profile トリガーが弾く。
  let banned = false;
  if (mode === 'ban') {
    try {
      await db('blacklist', {
        method: 'POST',
        prefer: 'return=minimal',
        body: {
          user_id: userId,
          real_name: p.real_name || null,
          birthdate: p.birthdate || null,
          line_user_id: p.line_user_id || null,
          reason: reason || '運営による強制退会',
          banned_by: 'admin',
          severity: 'perm',
        },
      });
      banned = true;
    } catch (e) {
      // blacklist への登録に失敗しても、アカウントは止まっている。
      // 呼び出し元へ知らせて手当てできるようにする。
      banned = false;
    }
  }

  const text =
    mode === 'ban'
      ? 'ご利用の停止についてのお知らせ\n\n' +
        (reason ? '理由：' + reason + '\n\n' : '') +
        'ご利用規約に沿わない行為が確認されたため、アカウントのご利用を停止いたしました。\n' +
        '再度のご登録はお受けしておりません。\n\n' +
        'お心当たりのない場合は、お手数ですが info@nomi-go.jp までご連絡ください。'
      : '退会のお手続きが完了しました\n\n' +
        'ご利用いただきありがとうございました。\n' +
        'アカウントは利用できない状態になりました。\n\n' +
        'またご利用になりたくなったときは、あらためてご登録いただけます。\n' +
        '（初回無料チケットは、お一人さま1回までとなります）';
  const sent = await pushLine(p.line_user_id, text);

  await audit(myId, mode === 'ban' ? 'account_ban' : 'account_withdraw', 'profiles', userId,
    { status: patch.account_status, blacklisted: banned, line_sent: sent,
      ticket_count_kept: p.ticket_count },
    reason || null);

  return {
    code: 200,
    body: {
      success: true,
      status: patch.account_status,
      blacklisted: banned,
      lineSent: sent,
      hasLine: !!p.line_user_id,
      nickname: p.nickname || null,
    },
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }

  try {
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !LINE_TOKEN) {
      res.status(500).json({ success: false, error: 'server_not_configured' });
      return;
    }

    const body0 = req.body || {};

    // ── 年齢確認の申請通知 ────────────────────────
    // これは申請した利用者自身が呼ぶため、運営確認より前に処理する。
    // 送り先と文面はサーバーが決める。個人情報は一切含めない。
    if (body0.action === 'notify_pending') {
      const auth0 = req.headers.authorization || '';
      if (!auth0.startsWith('Bearer ')) {
        res.status(401).json({ success: false, error: 'unauthorized' });
        return;
      }
      const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ANON_KEY, Authorization: auth0 },
      });
      if (!u.ok) {
        res.status(401).json({ success: false, error: 'unauthorized' });
        return;
      }
      const uid = (await u.json()).id;

      // 本当に申請中かどうかをサーバー側で確認する（嘘の通知を防ぐ）
      const p = await db(`profiles?user_id=eq.${uid}&select=id_verify_status`);
      if (!p || !p[0] || p[0].id_verify_status !== 'pending') {
        res.status(200).json({ success: true, skipped: true });
        return;
      }

      // 未対応の件数を数えて知らせる
      const all = await db('profiles?id_verify_status=eq.pending&select=user_id');
      const count = all ? all.length : 1;

      const to = await notifyTarget('age_verification');
      const sent = await pushLine(
        to,
        '📋 年齢確認の申請が届きました\n\n未対応：' + count + '件\n\n運営ページを開いて確認してください。\n' + ADMIN_PAGE_URL
      );

      res.status(200).json({ success: true, sent: sent });
      return;
    }

    // ── 運営として登録された人かどうかを確認する ──────────
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'unauthorized' });
      return;
    }
    const me = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: auth },
    });
    if (!me.ok) {
      res.status(401).json({ success: false, error: 'unauthorized' });
      return;
    }
    const myId = (await me.json()).id;

    // ── 2段階認証を済ませたログインかを確認する ──────────────
    // 認証アプリの6桁を入力していないログインでは、ここから先へ進めません。
    // 画面側の確認だけに頼らず、この窓口でも必ず確かめます。
    const token = auth.slice('Bearer '.length);
    if (getAal(token) !== 'aal2') {
      res.status(403).json({ success: false, error: 'mfa_required' });
      return;
    }

    // 【2026-09-08】can_suspend を追加で読む。
    // 列がまだ無い場合に一覧の取得ごと失敗すると運営ページが開かなくなるため、
    // まず can_suspend 付きで試し、失敗したら従来の項目だけで読み直す。
    // 列を追加したあとは1回目で成功する。
    let admin = null;
    try {
      const rows = await db(
        `admin_users?user_id=eq.${myId}&enabled=is.true&select=user_id,label,can_verify,can_reply,can_suspend`
      );
      admin = rows && rows[0] ? rows[0] : null;
    } catch (e) {
      const rows = await db(
        `admin_users?user_id=eq.${myId}&enabled=is.true&select=user_id,label,can_verify,can_reply`
      );
      admin = rows && rows[0] ? rows[0] : null;
    }
    if (!admin) {
      res.status(403).json({ success: false, error: 'forbidden' });
      return;
    }

    const body = body0;
    const action = body.action;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // ── 自分が誰かを返す（運営ページの入場判定） ──────────
    if (action === 'whoami') {
      res.status(200).json({
        success: true,
        label: admin.label || null,
        can_verify: !!admin.can_verify,
        can_reply: !!admin.can_reply,
        can_suspend: !!admin.can_suspend,
      });
      return;
    }

    // ── 本人確認の待ち一覧を返す ──────────────────────
    // 年齢確認の担当者だけが取得できる。
    if (action === 'list_pending') {
      if (!admin.can_verify) {
        res.status(403).json({ success: false, error: 'no_verify_permission' });
        return;
      }
      const rows = await db(
        'profiles?id_verify_status=eq.pending' +
        '&select=user_id,real_name,birthdate,nickname,gender,id_photo_url,face_photo_url' +
        '&order=updated_at.asc'
      );
      res.status(200).json({ success: true, list: rows || [] });
      return;
    }

    // ── 否認した方の一覧を返す（2026-09-02 追加） ──────────
    // 以前は否認した時点で一覧から消え、その後どうなったかを追えなかった。
    // 直近30日ぶんだけを新しい順に返す。
    if (action === 'list_rejected') {
      if (!admin.can_verify) {
        res.status(403).json({ success: false, error: 'no_verify_permission' });
        return;
      }
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const rows = await db(
        'profiles?id_verify_status=eq.rejected' +
        '&updated_at=gte.' + since +
        '&select=user_id,real_name,birthdate,nickname,gender,reject_reason,id_verify_note,id_photo_url,face_photo_url,updated_at' +
        '&order=updated_at.desc&limit=100'
      );
      res.status(200).json({ success: true, list: rows || [] });
      return;
    }

    // ── 身分証・顔写真の一時URLを発行する ──────────────
    // どの画像かは「利用者ID＋種類」で指定させる。
    // ブラウザから任意のファイル名を渡させない（他人の画像を覗かせない）。
    if (action === 'photo_url') {
      if (!admin.can_verify) {
        res.status(403).json({ success: false, error: 'no_verify_permission' });
        return;
      }
      const userId = body.userId;
      const kind = body.kind; // 'id' か 'face'
      if (!userId || !isUuid.test(userId) || (kind !== 'id' && kind !== 'face')) {
        res.status(400).json({ success: false, error: 'bad_request' });
        return;
      }

      const p = await db(`profiles?user_id=eq.${userId}&select=id_photo_url,face_photo_url`);
      if (!p || !p[0]) {
        res.status(404).json({ success: false, error: 'user_not_found' });
        return;
      }
      const path = (kind === 'id') ? p[0].id_photo_url : p[0].face_photo_url;
      if (!path) {
        res.status(404).json({ success: false, error: 'photo_not_found' });
        return;
      }

      const url = await signUrl(ID_BUCKET, path, 300); // 5分間だけ有効
      if (!url) {
        res.status(500).json({ success: false, error: 'sign_failed' });
        return;
      }

      // 誰がいつ身分証を閲覧したかを記録する
      await audit(myId, 'view_' + kind + '_photo', 'profiles', userId, null, null);

      res.status(200).json({ success: true, url: url });
      return;
    }

    // ── 年齢確認の承認・否認 ───────────────────────
    if (action === 'verify') {
      const userId = body.userId;
      const decision = body.decision; // 'approved' か 'rejected'
      const note = (body.note || '').trim().slice(0, 300);
      // 否認の理由の種類。決められた3つ以外は受け取らない。
      const reason = REJECT_REASONS.indexOf(body.reason) !== -1 ? body.reason : null;

      if (!admin.can_verify) {
        res.status(403).json({ success: false, error: 'no_verify_permission' });
        return;
      }
      if (!userId || !isUuid.test(userId) ||
          (decision !== 'approved' && decision !== 'rejected')) {
        res.status(400).json({ success: false, error: 'bad_request' });
        return;
      }
      // 否認するときは理由の種類を必ず選んでもらう。
      // 選ばれていないと、利用者側で何をすべきかを出し分けられないため。
      if (decision === 'rejected' && !reason) {
        res.status(400).json({ success: false, error: 'reason_required' });
        return;
      }

      const patch = {
        id_verify_status: decision,
        id_verify_note: note || null,
        // 承認したときは、古い否認の理由が残らないよう必ず消す。
        reject_reason: decision === 'rejected' ? reason : null,
        updated_at: new Date().toISOString(),
      };
      if (decision === 'approved') patch.verified_level = 2;

      const updated = await db(`profiles?user_id=eq.${userId}`, {
        method: 'PATCH',
        body: patch,
      });
      if (!updated || updated.length === 0) {
        res.status(404).json({ success: false, error: 'user_not_found' });
        return;
      }

      // service_role の更新ではDBトリガーから担当者を判定できないため、
      // 認証済みの運営者IDをここで明示して本人確認ログへ残す。
      const profile = updated[0];
      let ageAtCheck = null;
      if (profile.birthdate) {
        const born = new Date(profile.birthdate + 'T00:00:00Z');
        const today = new Date();
        ageAtCheck = today.getUTCFullYear() - born.getUTCFullYear();
        const beforeBirthday =
          today.getUTCMonth() < born.getUTCMonth() ||
          (today.getUTCMonth() === born.getUTCMonth() && today.getUTCDate() < born.getUTCDate());
        if (beforeBirthday) ageAtCheck -= 1;
      }
      await db('age_verification_logs', {
        method: 'POST',
        body: {
          user_id: userId,
          event: decision,
          old_status: null,
          new_status: decision,
          birthdate: profile.birthdate || null,
          age_at_check: ageAtCheck,
          id_photo_url: profile.id_photo_url || null,
          face_photo_url: profile.face_photo_url || null,
          actor_id: myId,
          actor_is_admin: true,
        },
      });

      const lineId = updated[0].line_user_id || null;
      const text =
        decision === 'approved'
          ? '✅ 年齢確認が完了しました！\n\nNomi Goを開いて、さっそく募集してみてください。'
          : rejectMessage(reason, note);
      const sent = await pushLine(lineId, text);

      await audit(myId, 'verify_' + decision, 'profiles', userId,
        { decision: decision, reason: reason, line_sent: sent }, note || null);

      res.status(200).json({ success: true, lineSent: sent, hasLine: !!lineId });
      return;
    }

    // ── 問い合わせ一覧を返す ────────────────────────
    // 【2026-09-08】退会申請の行に操作ボタンを出せるよう、
    //   送信者の現在の状態（account_status とニックネーム）も一緒に返す。
    //   すでに退会済みの人に、もう一度「退会させる」ボタンを出さないため。
    if (action === 'list_inquiries') {
      if (!admin.can_reply) {
        res.status(403).json({ success: false, error: 'no_reply_permission' });
        return;
      }
      const rows = await db(
        'inquiries?select=id,user_id,name,email,content,handled,reply_content,replied_at,created_at' +
        '&order=created_at.desc&limit=100'
      );
      const list = rows || [];

      // 送信者の状態をまとめて引く。問い合わせごとに1回ずつ引くと遅いため、
      // 重複を除いた利用者IDで1回だけ問い合わせる。
      try {
        const ids = [];
        for (const q of list) {
          if (q.user_id && ids.indexOf(q.user_id) === -1) ids.push(q.user_id);
        }
        if (ids.length > 0) {
          const ps = await db(
            'profiles?user_id=in.(' + ids.join(',') + ')' +
            '&select=user_id,nickname,account_status'
          );
          const map = {};
          for (const p of (ps || [])) map[p.user_id] = p;
          for (const q of list) {
            const p = q.user_id ? map[q.user_id] : null;
            q.sender_nickname = p ? (p.nickname || null) : null;
            q.sender_status = p ? (p.account_status || 'active') : null;
          }
        }
      } catch (e) {
        // 状態が取れなくても一覧そのものは返す。
        // account_status 列を追加する前でもページが開けるようにするため。
      }

      res.status(200).json({ success: true, list: list });
      return;
    }

    // ── 問い合わせを対応済みにする ──────────────────
    if (action === 'mark_handled') {
      const inquiryId = body.inquiryId;
      if (!admin.can_reply) {
        res.status(403).json({ success: false, error: 'no_reply_permission' });
        return;
      }
      if (!inquiryId || !isUuid.test(inquiryId)) {
        res.status(400).json({ success: false, error: 'bad_request' });
        return;
      }
      await db(`inquiries?id=eq.${inquiryId}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { handled: true },
      });
      await audit(myId, 'inquiry_mark_handled', 'inquiries', inquiryId, null, null);
      res.status(200).json({ success: true });
      return;
    }

    // ── 問い合わせへの返信 ────────────────────────
    if (action === 'reply') {
      const inquiryId = body.inquiryId;
      const reply = (body.reply || '').trim();

      if (!admin.can_reply) {
        res.status(403).json({ success: false, error: 'no_reply_permission' });
        return;
      }
      if (!inquiryId || !isUuid.test(inquiryId) ||
          reply.length === 0 || reply.length > 2000) {
        res.status(400).json({ success: false, error: 'bad_request' });
        return;
      }

      const rows = await db(`inquiries?id=eq.${inquiryId}&select=id,user_id,email`);
      if (!rows || rows.length === 0) {
        res.status(404).json({ success: false, error: 'inquiry_not_found' });
        return;
      }
      const inq = rows[0];

      // 送信者がログイン利用者なら、その人のLINEを引く
      let lineId = null;
      if (inq.user_id) {
        const p = await db(`profiles?user_id=eq.${inq.user_id}&select=line_user_id`);
        lineId = p && p[0] ? p[0].line_user_id : null;
      }

      const text =
        '📩 お問い合わせへの回答です。\n\n' +
        reply +
        '\n\n――――――\nご不明な点があれば、Nomi Goの「お問い合わせ」から再度ご連絡ください。';
      const sent = await pushLine(lineId, text);

      await db(`inquiries?id=eq.${inquiryId}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          reply_content: reply,
          replied_at: new Date().toISOString(),
          replied_by: myId,
          reply_channel: sent ? 'line' : 'none',
          handled: true,
        },
      });

      await audit(myId, 'inquiry_reply', 'inquiries', inquiryId, { line_sent: sent }, null);

      res.status(200).json({
        success: true,
        lineSent: sent,
        hasLine: !!lineId,
        email: inq.email || null,
      });
      return;
    }

    // ── 退会させる（本人の申請による） ─────────────────
    // 【2026-09-08 追加・No.296】
    //   アカウントを消さずに、ログインできない状態にする。
    //   本人が希望した退会なので、あらためて登録し直すことはできる。
    //   ただし初回無料チケットは1人1回までのため、2度目は付かない
    //   （データベース側の grant_welcome_ticket_on_approve が判定する）。
    if (action === 'withdraw' || action === 'ban') {
      const userId = body.userId;
      const reason = (body.reason || '').trim().slice(0, 300);

      if (!admin.can_suspend) {
        res.status(403).json({ success: false, error: 'no_suspend_permission' });
        return;
      }
      if (!userId || !isUuid.test(userId)) {
        res.status(400).json({ success: false, error: 'bad_request' });
        return;
      }
      // 強制退会は理由を必ず書いてもらう。
      // あとから「なぜ止めたのか」を説明できないと、問い合わせに答えられない。
      if (action === 'ban' && !reason) {
        res.status(400).json({ success: false, error: 'reason_required' });
        return;
      }
      // 自分自身は止められないようにする。運営が締め出される事故を防ぐ。
      if (userId === myId) {
        res.status(400).json({ success: false, error: 'cannot_suspend_self' });
        return;
      }

      const out = await doDeactivate(myId, admin, userId, action, reason);
      res.status(out.code).json(out.body);
      return;
    }

    // ── 退会・凍結を解除して元に戻す ───────────────────
    // 誤操作の取り消し用。blacklist に入れた分は自動では消さない。
    // 消すと「強制退会を解除したのに再登録も許す」ことになり、
    // 意図しない結果になりうるため、必要なら別途手で消す。
    if (action === 'restore') {
      const userId = body.userId;
      if (!admin.can_suspend) {
        res.status(403).json({ success: false, error: 'no_suspend_permission' });
        return;
      }
      if (!userId || !isUuid.test(userId)) {
        res.status(400).json({ success: false, error: 'bad_request' });
        return;
      }
      const now = new Date().toISOString();
      const updated = await db(`profiles?user_id=eq.${userId}`, {
        method: 'PATCH',
        body: {
          account_status: 'active',
          status_changed_at: now,
          status_reason: null,
          updated_at: now,
        },
      });
      if (!updated || updated.length === 0) {
        res.status(404).json({ success: false, error: 'user_not_found' });
        return;
      }
      await audit(myId, 'account_restore', 'profiles', userId, { status: 'active' }, null);
      res.status(200).json({ success: true });
      return;
    }

    res.status(400).json({ success: false, error: 'unknown_action' });
  } catch (e) {
    res.status(200).json({ success: false, error: 'failed' });
  }
};
