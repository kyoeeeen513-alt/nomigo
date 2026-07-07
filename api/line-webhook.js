// LINEからメッセージが送られてくるたびに、ここが自動で呼ばれます
// 送られてきた文字が「6桁の連携番号」と一致すれば、そのユーザーのLINE IDを保存します

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://dwubothomxjwfudkeepy.supabase.co',
  'sb_publishable_vpUd5hulLV1-gI1wsAkgWA_hrB9ZOJ9'
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();
        const lineUserId = event.source.userId;

        // 送られてきた文字が6桁の数字かどうかチェック
        if (/^\d{6}$/.test(text)) {
          const { data, error } = await supabase
            .from('profiles')
            .select('user_id')
            .eq('line_link_code', text)
            .single();

          if (data && !error) {
            await supabase
              .from('profiles')
              .update({ line_user_id: lineUserId, line_link_code: null })
              .eq('user_id', data.user_id);

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
