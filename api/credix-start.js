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
//   記録できなかった場合は、決済へ進ませません。
//
// 【2回目以降の購入について（2026/8/17 追加）】
//   CREDIXには2つの決済方式があります。
//     初回/毎回決済 … 毎回カード番号を入力する
//     リピーター決済 … CREDIXが保存しているカード情報を使う（番号の入力が不要）
//
//   このファイルは、まずリピーター決済を試し、使えなければ初回決済に回します。
//
//   なぜこの順番なのか：
//     「この人のカードが保存されているか」を自分たちのDBで管理すると、
//     CREDIX側の実態とズレたときに購入できなくなります。
//     （例：カードの有効期限が切れてCREDIX側から使えなくなったのに、
//      こちらは「保存済み」と思い込んで、番号を入力させずに決済しようとする）
//     CREDIXに問い合わせれば必ず正しい答えが返るため、
//     こちらでは何も覚えず、毎回CREDIXに聞く形にしています。
//
//   リピーター決済が使えない場合、CREDIXは次のような理由を返します。
//     Member data not found … カード情報が保存されていない（初回の人）
//     Card has expired      … 保存されているカードの有効期限が切れている
//   どちらの場合も、仕様書の指示どおり初回決済に回します。
//   利用者から見ると、ただカード番号の入力欄が出るだけで、失敗にはなりません。
//
// 【必要な環境変数】
//   SUPABASE_URL              … https://dwubothomxjwfudkeepy.supabase.co
//   SUPABASE_ANON_KEY         … Supabaseの anon key（アプリでも使っている公開キー）
//   SUPABASE_SERVICE_ROLE_KEY … Supabaseの service_role key（絶対に画面側に置かないこと）
//   CREDIX_IP_CODE            … CREDIXが発行したIPコード
//                               （テスト環境は 1019001348。本稼働時に本番の値へ差し替える）
//   CREDIX_ZKEY               … CREDIXが発行した認証キー（リピーター決済のセッション発行に必須）
//                               テスト用と本番用で異なるため、IPコードと必ずセットで差し替えること

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CREDIX_IP_CODE = process.env.CREDIX_IP_CODE;
const CREDIX_ZKEY = process.env.CREDIX_ZKEY;

// CREDIXの決済ページ（初回決済・リピーター決済のどちらも最終的にここへ送る）
const CREDIX_ACTION_URL = 'https://secure.credix-web.co.jp/cgi-bin/credit/order.cgi';

// リピーター決済のセッションを発行してもらう窓口（仕様書P.13）
const CREDIX_REPEATER_URL = 'https://secure.credix-web.co.jp/cgi-bin/credit/repeater.cgi';

// セッション発行の待ち時間の上限。
// ここで長く待つと、利用者は「押したのに何も起きない」状態になる。
// 待ちきれなかった場合は初回決済に回すため、購入できなくなることはない。
const REPEATER_TIMEOUT_MS = 8000;

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
//
// 【2026/8/21 pc-2026-08-15 → pc-2026-08-21】
//   退会後も決済代行事業者にカード情報が残る旨を「4. カード情報の取扱い」へ追記した。
//   えそら法律事務所より「規約類への記載は法的には不要」との回答を得たが、
//   利用者から見ればNomi Goを使った結果としてカード情報が残るため、
//   何も知らせないより明示するほうが誠実であるという判断による（奈良の決定）。
//   保持期間を「一定の期間」とし年数を書いていないのは、
//   7年の起算点（カード登録日・最終決済日・退会日のいずれか）がCREDIXに未確認のため。
//   確かめていない数字を書くと、あとで実態と食い違う（project_status No.110）。
const PAY_CONSENT_VERSION = 'pc-2026-08-21';

// 実際に保存する同意文面。
// ※決済代行会社の本契約が確定したら、ここに社名を入れること（project_status No.65）。
const PAY_CONSENT_TEXT = [
  '【個人情報の提供に関する同意（決済のため）】',
  '1. 提供する先：当サービスが委託する決済代行事業者',
  '2. 提供する情報：利用者を識別するための番号、購入金額、購入日時、通信に関する記録',
  '3. 提供する目的：クレジットカード決済の処理、決済結果の照合、および不正利用の防止',
  '4. カード情報の取扱い：カード番号・有効期限・セキュリティコードは決済代行事業者が直接取得し、本サービスは受領も保存もしない。なお決済代行事業者では、カード業界の安全基準にもとづき、退会後も一定の期間カード情報が保管される',
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

// 画面のスイッチは書き換えられるため、販売可否はDBの運営設定を正とする。
async function isTicketSalesOpen() {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/app_settings?key=eq.ticket_sales_open&select=bool_value&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return false;
    const value = rows[0].bool_value;
    return value === true || value === 'true';
  } catch (e) {
    return false;
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

// どちらの方式で決済を始めたかをDBに記録する。
// 記録に失敗しても決済自体は続行する（記録は障害調査のためのものであり、
// ここで止めると購入できなくなる方が損害が大きいため）。
async function recordMode(sendpoint, mode, sessionId) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/credix_set_payment_mode`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_sendpoint: sendpoint,
        p_mode: mode,
        p_session_id: sessionId || null,
      }),
    });
  } catch (e) {
    console.error('credix-start: record_mode_failed', e && e.message ? e.message : e);
  }
}

// CREDIXの返答を読み取る。
// 返答は key=value を & でつないだ形式（例：result=ok&sid=Z104b12c75cf6a04）。
// エラーメッセージはURIエンコードされている（仕様書P.16）。
function parseCredixResponse(text) {
  const out = {};
  if (!text) return out;
  const body = String(text).trim();
  body.split('&').forEach(function (pair) {
    const i = pair.indexOf('=');
    if (i < 0) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (!k) return;
    try {
      out[k] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch (e) {
      out[k] = v;
    }
  });
  return out;
}

// リピーター決済のセッション発行を試みる。
// 成功したらセッションID（sid）を返し、使えない場合は null を返す。
async function issueRepeaterSession(row, sendpoint) {
  if (!CREDIX_ZKEY) {
    // 認証キーが未設定なら、そもそもリピーター決済は使えない。
    // 初回決済に回るだけなので購入は可能。
    console.warn('credix-start: zkey_not_configured');
    return null;
  }

  // 送るパラメータ（仕様書P.14〜15）
  const params = new URLSearchParams();
  params.set('clientip', CREDIX_IP_CODE);
  params.set('zkey', CREDIX_ZKEY);
  params.set('money', String(row.out_amount));
  // search_type=2 … IPコードとカードIDだけで会員を探す。
  // 1にすると電話番号も必要になるが、Nomi Goは電話番号を持っていないため2を使う。
  params.set('search_type', '2');
  params.set('sendid', row.out_sendid);
  // 決済結果の通知でこの目印が返ってくる。どの購入かを見分けるために使う。
  params.set('sendpoint', sendpoint);
  // セキュリティコードの入力欄を出す。不正利用を防ぐため必ず有効にする。
  params.set('use_seccode', 'yes');
  // 決済完了メールを利用者へ送る。
  // 【なぜ必要か 2026/8/17 追加】
  //   このパラメータを送らないとメールが送信されない（仕様書P.14 No.8）。
  //   初回決済ではCREDIXの画面で利用者がメールアドレスを入力するため
  //   自動的に送られるが、リピーター決済では画面で入力しないため、
  //   ここで指定しないと2回目以降の購入で控えが一切届かなくなる。
  //   実際、8/17のテストで1回目のみメールが届き2回目以降は届かなかった。
  // 【送信先について】
  //   email パラメータは送らない。送らない場合、CREDIXが保存している
  //   会員データのメールアドレス（＝初回決済時に利用者自身が入力したもの）へ送られる。
  //   アプリ側の登録アドレスを渡すこともできるが、
  //   決済前の同意画面で利用者に示している提供項目は
  //   「識別番号・購入金額・購入日時・通信記録」であり、メールアドレスを含んでいない。
  //   同意していない情報を新たに提供することになるため送らない。
  //   （メールアドレスも提供する形に変えたい場合は、
  //     先に同意文面とその版番号を改める必要がある）
  params.set('send_email', 'yes');
  // 決済が終わったら自動でアプリへ戻す（成功・失敗のどちらでも）。
  // 以前は 0（戻らない）にしていたが、それだと利用者が完了画面のリンクを
  // 自分で押す必要があり、押し方が分からないまま離脱する恐れがあった。
  // 3秒あれば「完了しました」の表示は読めるため、redirect_sec は 3 とする。
  // ※利用者のブラウザによっては自動で戻らない場合があると仕様書に注記があるため、
  //   戻り先のリンク（success_url / failure_url）も併せて必ず送る。
  params.set('redirect_type', '1');
  params.set('redirect_sec', '3');
  params.set('success_url', 'https://www.nomi-go.jp/');
  params.set('failure_url', 'https://www.nomi-go.jp/');
  // ※success_str / failure_str（リンクに表示する文字）は送らない。
  //   これらはShift-JISで送る決まりになっており（仕様書の改定履歴）、
  //   文字コードを変換するための追加の部品が必要になる。
  //   送らなければCREDIX側の既定文言「サイトに戻る」が表示されるため実害がない。
  //   ここは複雑にしないことを優先する。

  // 時間がかかりすぎたら諦めるための仕掛け
  const ctrl = new AbortController();
  const timer = setTimeout(function () {
    ctrl.abort();
  }, REPEATER_TIMEOUT_MS);

  try {
    const r = await fetch(CREDIX_REPEATER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      console.warn('credix-start: repeater_http_error', r.status);
      return null;
    }

    const text = await r.text();
    const data = parseCredixResponse(text);

    if (data.result === 'ok' && data.sid) {
      return data.sid;
    }

    // 使えなかった理由を残す。
    // Member data not found / Card has expired は初回の人・期限切れの人であり、
    // 異常ではない。初回決済に回れば購入できる。
    // それ以外（zkey is invalid、clientip is not found、Access Denied など）は
    // 設定の誤りなので、ログを見て直す必要がある。
    console.warn(
      'credix-start: repeater_unavailable reason=' + (data.error_message || 'unknown')
    );
    return null;
  } catch (e) {
    clearTimeout(timer);
    // 通信の失敗やタイムアウト。初回決済に回るため購入は可能。
    console.warn('credix-start: repeater_failed', e && e.message ? e.message : e);
    return null;
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

    // 審査・開通前は、URLを直接呼ばれても購入を開始しない。
    if (!(await isTicketSalesOpen())) {
      res.status(200).json({ success: false, error: 'sales_closed' });
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
    //    金額・sendid（カードID）・男性かどうかの確認は、すべてこの関数の中で行う。
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

    // 4) まずリピーター決済を試す。
    //    使えればカード番号の入力が不要になる。
    //    使えなければ null が返るだけで、そのまま初回決済に進む。
    const sid = await issueRepeaterSession(row, row.out_sendpoint);

    if (sid) {
      await recordMode(row.out_sendpoint, 'repeater', sid);
      // リピーター決済では、決済ページへ送るのは2つだけ（仕様書P.18）。
      // 金額もカードIDもCREDIX側がセッションとして持っているため。
      res.status(200).json({
        success: true,
        mode: 'repeater',
        action: CREDIX_ACTION_URL,
        clientip: CREDIX_IP_CODE,
        sid: sid,
      });
      return;
    }

    // 5) 初回/毎回決済。カード番号の入力画面へ送る。
    await recordMode(row.out_sendpoint, 'first', null);
    res.status(200).json({
      success: true,
      mode: 'first',
      action: CREDIX_ACTION_URL,
      clientip: CREDIX_IP_CODE,
      money: String(row.out_amount),
      sendid: row.out_sendid,
      sendpoint: row.out_sendpoint,
    });
  } catch (e) {
    // 中身の詳しい事情は外に出さない
    console.error('credix-start: error', e && e.message ? e.message : e);
    res.status(200).json({ success: false, error: 'failed' });
  }
};
