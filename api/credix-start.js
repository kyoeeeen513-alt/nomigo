// チケット購入の「決済ページへ進む直前」に呼ばれる窓口です。
//
// 【この作りの考え方】
// ・金額はサーバー側（DBの関数）が決めます。画面からは受け取りません。
//   CREDIXの決済ページへは money をブラウザから送る仕様のため、
//   利用者が開発者ツールで 3980 を 1 に書き換えることが技術的に可能です。
//   そのため「いくらの購入を始めたか」を先にDBへ記録しておき、
//   決済結果の通知が届いたときに、その記録と金額が一致するかを必ず確かめます。
// ・sendpoint（目印）は推測できないランダムな32文字をサーバーが作ります。
//   CREDIXからの通知には署名が付かないため、この目印が
//   「その通知が本当に自分たちが始めた決済のものか」を確かめる根拠になります。
// ・購入できるのはログイン中の本人のみ、かつ男性のみです。
//   誰の購入かは画面から受け取らず、ログイン証明から特定します。
// ・決済ページへ送り出す前に、個人情報の提供に関する同意を必ず記録します。
//   記録できなかった場合は、決済へ進ませません（下の「同意の記録」を参照）。
//
// 【必要な環境変数】
//   SUPABASE_URL              … https://dwubothomxjwfudkeepy.supabase.co
//   SUPABASE_ANON_KEY         … Supabaseの anon key（アプリでも使っている公開キー）
//   SUPABASE_SERVICE_ROLE_KEY … Supabaseの service_role key（絶対に画面側に置かないこと）
//   CREDIX_IP_CODE            … CREDIXが発行したIPコード
//                               （テスト環境は 1019001348。本稼働時に本番の値へ差し替える）

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CREDIX_IP_CODE = process.env.CREDIX_IP_CODE;

// CREDIXの決済ページ（CREDIXから提供されたサンプルHTMLの送信先と同一）
const CREDIX_ACTION_URL = 'https://secure.credix-web.co.jp/cgi-bin/credit/order.cgi';

// ===== 決済前の同意について =====
//
// 【なぜサーバーで記録するのか】
//   画面のチェックボックスだけでは、あとから「同意を取った証拠」が残りません。
//   また、ブラウザ側からDBに書き込む形にすると、利用者が自由に書き換えられます。
//   そのため、サーバーだけが書き込めるテーブル（payment_consents）に、
//   このファイルが記録します。記録できなければ決済へは進ませません。
//
// 【文面を画面から受け取らない理由】
//   画面から送られた文字はブラウザで書き換えられるため、証拠になりません。
//   画面から受け取るのは「版の番号」だけで、保存する文面はここが持ちます。
//
// 【文面を変えるときの注意】
//   PAY_CONSENT_VERSION と PAY_CONSENT_TEXT を変えたら、
//   index.html の PAY_CONSENT_VERSION も必ず同じ値に変えること。
//   片方だけ変えると、利用者は購入できなくなります。
const PAY_CONSENT_VERSION = 'pc-2026-08-15';

// 実際に保存する同意文面。
// ※決済代行会社の本契約が確定したら、ここに社名を入れること（project_status No.65）。
const PAY_CONSENT_TEXT = [
  '【個人情報の提供に関する同意（決済のため）】',
  '1. 提供する先：当サービスが委託する決済代行事業者',
  '2. 提供する情報：利用者を識別するための番号、購入金額、購入日時、通信に関する記録',
  '3. 提供する目的：クレジットカード決済の処理、決済結果の照合、および不正利用の防止',
  '4. カード情報の取扱い：カード番号・有効期限・セキュリティコードは決済代行事業者が直接取得し、本サービスは受領も保存もしない',
  '5. 記録の保存：支払いに関する記録は法令に基づき7年間保存する',
  '（同意版：' + PAY_CONSENT_VERSION + '）',
].join('\n');

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
    if (!u || !u.id) return null;
    return { id: u.id };
  } catch (e) {
    return null;
  }
}

// 同意した事実をDBへ記録する。成功したら true、失敗したら false を返す。
async function recordConsent(req, userId) {
  const forwarded = req.headers['x-forwarded-for'] || '';
  const ipAddress =
    String(forwarded).split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/payment_consents`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        consent_version: PAY_CONSENT_VERSION,
        consent_text: PAY_CONSENT_TEXT,
        processor_name: null, // 決済代行会社の確定後に社名を入れる（No.65）
        ip_address: ipAddress,
        user_agent: userAgent,
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('payment_consents insert failed:', r.status, detail);
      return false;
    }
    return true;
  } catch (e) {
    console.error('payment_consents insert error:', e);
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }

  try {
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !CREDIX_IP_CODE) {
      res.status(500).json({ success: false, error: 'server_not_configured' });
      return;
    }

    // 1) ログイン中の本人を特定する（画面から利用者IDは受け取らない）
    const me = await whoAmI(req);
    if (!me) {
      res.status(401).json({ success: false, error: 'unauthorized' });
      return;
    }

    // 2) 同意の確認と記録。
    //    ここを通らないと決済ページへ進めないよう、必ず値を作る前に置くこと。
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = null;
      }
    }
    if (!body || body.consent !== true) {
      res.status(200).json({ success: false, error: 'consent_required' });
      return;
    }
    // 文面を新しくしたのに、古い画面を開いたままの人が同意してしまうのを防ぐ
    if (body.consent_version !== PAY_CONSENT_VERSION) {
      res.status(200).json({ success: false, error: 'consent_version_mismatch' });
      return;
    }
    const consentSaved = await recordConsent(req, me.id);
    if (!consentSaved) {
      res.status(200).json({ success: false, error: 'consent_save_failed' });
      return;
    }

    // 3) 購入記録と目印をDB側で作る。
    //    金額・sendid（決済用会員番号）・男性かどうかの確認は、すべてこの関数の中で行う。
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/credix_create_payment`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_user_id: me.id, p_clientip: CREDIX_IP_CODE }),
    });

    if (!r.ok) {
      const detail = await r.text();
      // 女性・プロフィール未作成などはここに来る
      if (detail.indexOf('not_male') >= 0) {
        res.status(200).json({ success: false, error: 'not_male' });
        return;
      }
      if (detail.indexOf('profile_not_found') >= 0) {
        res.status(200).json({ success: false, error: 'profile_not_found' });
        return;
      }
      res.status(200).json({ success: false, error: 'create_failed' });
      return;
    }

    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.out_sendpoint) {
      res.status(200).json({ success: false, error: 'create_failed' });
      return;
    }

    // 4) 決済ページへ送る値を画面へ返す。
    //    画面はこの4つをそのままCREDIXへPOSTするだけで、値を作ることはしない。
    res.status(200).json({
      success: true,
      action: CREDIX_ACTION_URL,
      clientip: CREDIX_IP_CODE,
      money: String(row.out_amount),
      sendid: row.out_sendid,
      sendpoint: row.out_sendpoint,
    });
  } catch (e) {
    // 中身の詳しい事情は外に出さない
    res.status(200).json({ success: false, error: 'failed' });
  }
};
