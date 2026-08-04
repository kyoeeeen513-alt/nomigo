// 運営ページ（admin.html）専用の窓口。
//
// 【この作りの考え方】
// ・呼び出した人が「運営本人か」を毎回サーバー側で確認する。運営以外は何もできない。
// ・LINEの送り先と文面はサーバーが決める。ブラウザからは指定できない。
// ・操作内容は admin_audit_logs に記録する。
//
// 【必要な環境変数】すべて設定済み
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY / LINE_CHANNEL_ACCESS_TOKEN

// 運営として認める人は admin_users テーブルで管理する。
// 担当者が変わったときは、この表を変えるだけでよい（コードの修正は不要）。

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

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
      body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
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
        '📋 年齢確認の申請が届きました\n\n未対応：' + count + '件\n\n運営ページを開いて確認してください。\nhttps://nomigo-final-5.vercel.app/admin.html'
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

    const adminRows = await db(
      `admin_users?user_id=eq.${myId}&enabled=is.true&select=user_id,label,can_verify,can_reply`
    );
    const admin = adminRows && adminRows[0] ? adminRows[0] : null;
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
      });
      return;
    }

    // ── 年齢確認の承認・否認 ───────────────────────
    if (action === 'verify') {
      const userId = body.userId;
      const decision = body.decision; // 'approved' か 'rejected'
      const note = (body.note || '').trim().slice(0, 300);

      if (!admin.can_verify) {
        res.status(403).json({ success: false, error: 'no_verify_permission' });
        return;
      }
      if (!userId || !isUuid.test(userId) ||
          (decision !== 'approved' && decision !== 'rejected')) {
        res.status(400).json({ success: false, error: 'bad_request' });
        return;
      }

      const patch = {
        id_verify_status: decision,
        id_verify_note: note || null,
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

      const lineId = updated[0].line_user_id || null;
      const text =
        decision === 'approved'
          ? '✅ 年齢確認が完了しました！\n\nNomi Goを開いて、さっそく募集してみてください。'
          : '⚠️ 年齢確認ができませんでした。\n\n' +
            (note ? '理由：' + note + '\n\n' : '') +
            'Nomi Goを開いて、もう一度書類のご提出をお願いします。';
      const sent = await pushLine(lineId, text);

      await audit(myId, 'verify_' + decision, 'profiles', userId,
        { decision: decision, line_sent: sent }, note || null);

      res.status(200).json({ success: true, lineSent: sent, hasLine: !!lineId });
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

    res.status(400).json({ success: false, error: 'unknown_action' });
  } catch (e) {
    res.status(200).json({ success: false, error: 'failed' });
  }
};
