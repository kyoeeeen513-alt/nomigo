// LINEからメッセージが送られてくるたびに、ここが自動で呼ばれます
// 送られてきた文字が「6桁の連携番号」と一致すれば、そのユーザーのLINE IDを保存します

const SUPABASE_URL = 'https://dwubothomxjwfudkeepy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vpUd5hulLV1-gI1wsAkgWA_hrB9ZOJ9';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  try {
    const events = (req.body && req.body.events) || [];

    for (const event of events) {
      if (event.type === 'message' && event.message && event.message.type === 'text') {
        const text = event.message.text.trim();
        const lineUserId = event.source.userId;

        // 送られてきた文字が6桁の数字かどうかチェック
        if (/^\d{6}$/.test(text)) {
          const findRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?line_link_code=eq.${text}&select=user_id`,
            {
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
              },
            }
          );
          const rows = await findRes.json();

          if (Array.isArray(rows) && rows.length > 0) {
            const userId = rows[0].user_id;
            await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`, {
              method: 'PATCH',
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ line_user_id: lineUserId, line_link_code: null }),
            });
            await replyMessage(event.replyToken, '連携が完了しました！これからマッチ通知などをお届けします。');
          } else {
            await replyMessage(event.replyToken, '番号が見つかりませんでした。アプリでもう一度番号を発行してください。');
          }
        }
      }
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error(e);
    res.status(200).send('OK');
  }
};

// LINEに返信メッセージを送る
async function replyMessage(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
}
