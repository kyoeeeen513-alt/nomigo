console.log("charge loaded");
const payjp = require('payjp')('sk_test_7f09390eddd254b2f420dea8');
module.exports = async (req, res) => {
  console.log("charge called", req.method);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { mode, token, amount, description, customer_id } = req.body;

    // 顧客登録（カードをPAY.JP顧客として保存）
    if (mode === 'register_card') {
      if (!token) {
        return res.status(400).json({ error: 'トークンがありません' });
      }
      const customer = await payjp.customers.create({
        card: token,
        description: description || 'Nomi Go user',
      });
      return res.status(200).json({ success: true, customer_id: customer.id });
    }

    // 保存済み顧客IDで決済
    if (mode === 'charge_customer') {
      if (!customer_id) {
        return res.status(400).json({ error: '顧客IDがありません' });
      }
      const charge = await payjp.charges.create({
        amount: amount || 3000,
        currency: 'jpy',
        customer: customer_id,
        description: description || 'Nomi Go チケット購入',
        capture: true,
      });
      return res.status(200).json({ success: true, charge_id: charge.id });
    }

    // 従来通り：トークン単発決済（互換性維持）
    if (!token) {
      return res.status(400).json({ error: 'トークンがありません' });
    }
    const charge = await payjp.charges.create({
      amount: amount || 3000,
      currency: 'jpy',
      card: token,
      description: description || 'Nomi Go 参加費',
      capture: true,
    });
    res.status(200).json({ success: true, charge_id: charge.id });
  } catch (err) {
    console.log("charge error", err.message);
    res.status(500).json({ error: err.message });
  }
};
