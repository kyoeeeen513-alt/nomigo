const payjp = require('payjp')('sk_test_7f09390eddd254b2f420dea8');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { token, amount, description } = req.body;

    const charge = await payjp.charges.create({
      amount: amount || 3000,
      currency: 'jpy',
      card: token,
      description: description || 'Nomi Go 参加費',
      capture: true,
    });

    res.status(200).json({ success: true, charge_id: charge.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
