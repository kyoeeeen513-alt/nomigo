// CREDIXから決済結果が届く窓口です。
//
// 【いちばん大事な決まり】
//   どんな場合でも必ず HTTP 200 と本文 ok を返します。
//   404 や 500 を返すと、CREDIXは再送を行いません（仕様書に明記）。
//   通知が失われると「入金済みなのにチケットが付かない」事故になります。
//   したがって、条件を満たさない通知であっても、拒否ではなく ok を返し、
//   付与しなかった理由を credix_notify_logs に記録します。
//   なお仕様書に「返答は ok / ng 等の簡潔な内容にし、htmlは記述しないこと」との
//   指示があるため、本文は ok の文字だけを返します。
//
// 【届き方】
//   GET形式で、次の値がURLに付いて届きます（CREDIXの実送信で確認済み）。
//     clientip … CREDIXが発行したIPコード
//     money    … 決済金額（半角数字のみ。カンマや「円」は付かない）
//     result   … ok（決済完了）または ng（決済失敗）
//     sendid   … こちらが渡した決済用会員番号
//     sendpoint… こちらが渡した推測できない目印
//
// 【チケットを付ける条件（すべて満たす場合のみ）】
//   ① 送信元IPが CREDIX のものであること
//   ② result が ok であること
//   ③ sendpoint がDBの購入記録に存在すること
//   ④ その記録がまだ未処理（pending）であること
//   ⑤ money がその記録の金額と完全に一致すること
//   ⑥ sendid・clientip がその記録と一致すること
//   判定と付与は DB側の関数 credix_apply_notification が
//   ひとつのまとまりとして行うため、同じ通知が同時に2回届いても
//   チケットが二重に付くことはありません。
//
// 【必要な環境変数】
//   SUPABASE_URL              … https://dwubothomxjwfudkeepy.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY … Supabaseの service_role key（絶対に画面側に置かないこと）
//   CREDIX_ALLOWED_IPS        … 通知を受け付ける送信元IP（カンマ区切り）
//                               CREDIXの仕様書で指定された2つを設定する。
//                               仕様書上このIPは非公開扱いのため、環境変数で持つ。

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_IPS = String(process.env.CREDIX_ALLOWED_IPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// 送信元のIPアドレスを取り出す。
// Vercelは実際の送信元を x-forwarded-for の先頭に入れて渡してくる。
function getSourceIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return String(xff[0]).split(',')[0].trim();
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length > 0) return real.trim();
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return '';
}

// 必ず ok だけを返す
function replyOk(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send('ok');
}

module.exports = async (req, res) => {
  // 何が起きても ok を返せるよう、全体を囲む
  try {
    // GETで届く仕様だが、POSTで届いても受け取れるようにしておく
    const q = (req.query && Object.keys(req.query).length > 0) ? req.query : (req.body || {});

    const pick = (v) => {
      if (Array.isArray(v)) return v.length > 0 ? String(v[0]) : null;
      if (v === undefined || v === null) return null;
      return String(v);
    };

    const clientip = pick(q.clientip);
    const money = pick(q.money);
    const result = pick(q.result);
    const sendid = pick(q.sendid);
    const sendpoint = pick(q.sendpoint);

    const sourceIp = getSourceIp(req);
    const ipOk = ALLOWED_IPS.indexOf(sourceIp) >= 0;

    // 届いた内容をそのまま残す（後から調べられるように）
    let rawQuery = '';
    try {
      rawQuery = String(req.url || '');
    } catch (e) {
      rawQuery = '';
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      // 設定漏れでもCREDIXには ok を返す（再送が止まると通知が失われるため）。
      // 記録は残らないため、CREDIXの決済結果通知メールから手動で復旧する。
      console.error('credix-notify: server_not_configured');
      replyOk(res);
      return;
    }

    // 判定・付与・記録はDB側の関数がまとめて行う
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/credix_apply_notification`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_ip_ok: ipOk,
        p_source_ip: sourceIp,
        p_clientip: clientip,
        p_money: money,
        p_result: result,
        p_sendid: sendid,
        p_sendpoint: sendpoint,
        p_raw_query: rawQuery,
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error('credix-notify: rpc_failed', r.status, detail);
    } else {
      const outcome = await r.text();
      console.log('credix-notify: outcome=' + outcome + ' ip=' + sourceIp);
    }

    replyOk(res);
  } catch (e) {
    console.error('credix-notify: error', e && e.message ? e.message : e);
    replyOk(res);
  }
};
