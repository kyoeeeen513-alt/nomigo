// アプリ側から呼び出され、指定したメールアドレスにメールを送ります

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
      res.status(400).json({ success: false, error: '必要な情報が足りません' });
      return;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Nomi Go <noreply@nomi-go.jp>',
        to: [to],
        subject: subject,
        text: message,
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
