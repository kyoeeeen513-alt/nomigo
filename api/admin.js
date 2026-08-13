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

    // ── 問い合わせ一覧を返す ────────────────────────
    if (action === 'list_inquiries') {
      if (!admin.can_reply) {
        res.status(403).json({ success: false, error: 'no_reply_permission' });
        return;
      }
      const rows = await db(
        'inquiries?select=id,user_id,name,email,content,handled,reply_content,replied_at,created_at' +
        '&order=created_at.desc&limit=100'
      );
      res.status(200).json({ success: true, list: rows || [] });
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

    res.status(400).json({ success: false, error: 'unknown_action' });
  } catch (e) {
    res.status(200).json({ success: false, error: 'failed' });
  }
};
