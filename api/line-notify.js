// アプリ側から呼び出され、マッチの参加者にLINEメッセージを送ります。
//
// 【この作りの考え方】
// ・送り先のLINE IDと文面は、外から一切受け取りません。サーバーが自分で決めます。
// ・受け取るのは「どのマッチか(matchId)」と「どの種類の通知か(kind)」の2つだけ。
// ・呼び出した本人がそのマッチの参加者かどうかを、必ずサーバー側で確認します。
//
// 【Vercelに設定が必要な環境変数（4つ）】
//   LINE_CHANNEL_ACCESS_TOKEN … 既に設定済みのもの
//   SUPABASE_URL              … https://dwubothomxjwfudkeepy.supabase.co
//   SUPABASE_ANON_KEY         … Supabaseの anon key（アプリでも使っている公開キー）
//   SUPABASE_SERVICE_ROLE_KEY … Supabaseの service_role key（絶対に画面側に置かないこと）

// 送れる文面はこの3種類だけ。ここに無い kind は拒否します。
const MESSAGES = {
  match: '🍻 マッチが成立しました！Nomi Goアプリを開いてチャットを確認してください。',
  finish_reminder:
    '🍺 今夜の飲み会はいかがでしたか？\nNomi Goを開いて「飲み終わった」から評価をお願いします。',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Supabaseのデータを、運営権限で読み出すための共通処理
async function db(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error('db_error');
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false });
    return;
  }

  try {
    // 設定漏れがあれば、何も送らずに終了する
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
      res.status(500).json({ success: false, error: 'server_not_configured' });
      return;
    }

    const body = req.body || {};
    const matchId = body.matchId;
    const kind = body.kind;

    // 1) 受け取った内容が正しい形かを確認する
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!matchId || !isUuid.test(matchId) || !MESSAGES[kind]) {
      res.status(400).json({ success: false, error: 'bad_request' });
      return;
    }

    // 2) ログイン中の本人かどうかを確認する（ログイン証明が無ければ拒否）
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
    const myUserId = (await me.json()).id;
    if (!myUserId) {
      res.status(401).json({ success: false, error: 'unauthorized' });
      return;
    }

    // 3) そのマッチの参加者を調べ、本人が含まれているかを確認する
    const members = await db(
      `match_members?match_id=eq.${matchId}&select=user_id`
    );
    const memberIds = members.map((m) => m.user_id);
    if (!memberIds.includes(myUserId)) {
      // 参加していないマッチへの通知はここで止まる
      res.status(403).json({ success: false, error: 'forbidden' });
      return;
    }

    // 4) 参加者のLINE IDを、サーバー側だけで取り出す
    const profiles = await db(
      `profiles?user_id=in.(${memberIds.join(',')})&select=line_user_id`
    );
    const lineIds = profiles
      .map((p) => p.line_user_id)
      .filter((v) => typeof v === 'string' && v.length > 0);

    if (lineIds.length === 0) {
      res.status(200).json({ success: true, sent: 0 });
      return;
    }

    // 5) 決められた文面だけを送る
    const text = MESSAGES[kind];
    let sent = 0;
    for (const to of lineIds) {
      const r = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
      });
      if (r.ok) sent++;
    }

    res.status(200).json({ success: true, sent });
  } catch (e) {
    // 中身の詳しい事情は外に出さない
    res.status(200).json({ success: false, error: 'failed' });
  }
};
