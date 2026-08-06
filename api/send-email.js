// メール送信の窓口。
//
// 【この作りの考え方】
// ・宛先と文面は、外から一切受け取りません。サーバーが自分で決めます。
// ・受け取るのは「どの種類のメールか(action)」だけ。
// ・確認コードはサーバーが作り、サーバーが照合します。画面側はコードを知りません。
//
// 【必要な環境変数】
//   RESEND_API_KEY            … 既に設定済みのもの
//   SUPABASE_URL              … https://dwubothomxjwfudkeepy.supabase.co
//   SUPABASE_ANON_KEY         … Supabaseの anon key（アプリでも使っている公開キー）
//   SUPABASE_SERVICE_ROLE_KEY … Supabaseの service_role key（絶対に画面側に置かないこと）

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

// 運営の受信先。ここ以外には運営宛メールを送りません。
const ADMIN_TO = 'info@nomi-go.jp';
// 確認コードの有効時間（分）
const CODE_MINUTES = 10;

// Supabaseを運営権限で読み書きする共通処理
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

// メールを1通送る
async function sendMail(to, subject, message) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from: 'Nomi Go <noreply@nomi-go.jp>',
        to: [to],
        subject: subject,
        text: message,
      }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// ログイン中の本人を確認する。確認できなければ null を返す
async function whoAmI(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: auth },
    });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || !u.id || !u.email) return null;
    return { id: u.id, email: u.email };
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }

  try {
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !RESEND_KEY) {
      res.status(500).json({ success: false, error: 'server_not_configured' });
      return;
    }

    const body = req.body || {};
    const action = body.action;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // ── ① お問い合わせが届いたことを運営に知らせる ──────────
    // 未ログインの方も問い合わせできるため、ここではログイン確認をしない。
    // ただし宛先は運営の受信先で固定。実際に保存された問い合わせが無ければ何も送らない。
    if (action === 'inquiry_notice') {
      const inquiryId = body.inquiryId;
      if (!inquiryId || !isUuid.test(inquiryId)) {
        res.status(400).json({ success: false, error: 'bad_request' });
        return;
      }

      const rows = await db(
        `inquiries?id=eq.${inquiryId}&select=id,name,email,content,created_at`
      );
      if (!rows || rows.length === 0) {
        res.status(404).json({ success: false, error: 'not_found' });
        return;
      }
      const q = rows[0];

      // 古い問い合わせを何度も通知させない（作成から5分以内のものだけ）
      const ageMs = Date.now() - new Date(q.created_at).getTime();
      if (!(ageMs >= 0 && ageMs < 5 * 60 * 1000)) {
        res.status(200).json({ success: true, skipped: true });
        return;
      }

      const text =
        'お問い合わせが届きました。\n\n' +
        'お名前：' + (q.name || '（未入力）') + '\n' +
        'メール：' + (q.email || '（未入力）') + '\n\n' +
        '内容：\n' + (q.content || '') + '\n\n' +
        '――――――\n運営ページから返信してください。\n' +
        'https://nomigo-final-5.vercel.app/admin.html';

      const sent = await sendMail(ADMIN_TO, '【Nomi Go】お問い合わせが届きました', text);
      res.status(200).json({ success: sent });
      return;
    }

    // ── ② 確認コードを送る ─────────────────────────
    // 宛先はログイン中のご本人のメールアドレス。画面から指定はできない。
    if (action === 'verify_code') {
      const me = await whoAmI(req);
      if (!me) {
        res.status(401).json({ success: false, error: 'unauthorized' });
        return;
      }

      // コードはサーバーが作る。画面側には返さない。
      const code = String(Math.floor(100000 + Math.random() * 900000));

      await db(`email_verifications?user_id=eq.${me.id}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      await db('email_verifications', {
        method: 'POST',
        prefer: 'return=minimal',
        body: { user_id: me.id, code: code },
      });

      const sent = await sendMail(
        me.email,
        '【Nomi Go】確認コード',
        '確認コードは ' + code + ' です。\n' +
          'アプリの画面に入力してください。\n\n' +
          'このコードは' + CODE_MINUTES + '分間有効です。\n' +
          'お心当たりのない場合は、このメールは破棄してください。'
      );

      res.status(200).json({ success: sent });
      return;
    }

    // ── ③ 入力された確認コードを照合する ────────────────
    // 照合はサーバー側で行う。画面側は正解のコードを受け取らない。
    if (action === 'verify_check') {
      const me = await whoAmI(req);
      if (!me) {
        res.status(401).json({ success: false, error: 'unauthorized' });
        return;
      }
      const input = String(body.code || '').trim();
      if (!/^\d{6}$/.test(input)) {
        res.status(200).json({ success: false, error: 'bad_code' });
        return;
      }

      const rows = await db(
        `email_verifications?user_id=eq.${me.id}&select=id,code,created_at&order=created_at.desc&limit=1`
      );
      if (!rows || rows.length === 0) {
        res.status(200).json({ success: false, error: 'no_code' });
        return;
      }
      const rec = rows[0];

      const ageMs = Date.now() - new Date(rec.created_at).getTime();
      if (ageMs > CODE_MINUTES * 60 * 1000) {
        await db(`email_verifications?user_id=eq.${me.id}`, {
          method: 'DELETE',
          prefer: 'return=minimal',
        });
        res.status(200).json({ success: false, error: 'expired' });
        return;
      }

      if (String(rec.code) !== input) {
        res.status(200).json({ success: false, error: 'mismatch' });
        return;
      }

      await db(`email_verifications?user_id=eq.${me.id}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
      res.status(200).json({ success: true });
      return;
    }

    res.status(400).json({ success: false, error: 'unknown_action' });
  } catch (e) {
    // 中身の詳しい事情は外に出さない
    res.status(200).json({ success: false, error: 'failed' });
  }
};
