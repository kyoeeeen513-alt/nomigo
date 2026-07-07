// アプリ側から呼び出され、指定したLINEユーザーにメッセージを送ります

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    const { lineUserId, message } = req.body;

    if (!lineUserId || !message) {
      res.status(400).json({ success: false, error: '必要な情報が足りません' });
      return;
    }

    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: lineUserId,
        messages: [{ type: 'text', text: message }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(200).json({ success: false, error: errText });
      return;
    }

    res.status(200).json({ success: true });
  } catch (e) {
    res.status(200).json({ success: false, error: e.message });
  }
};
