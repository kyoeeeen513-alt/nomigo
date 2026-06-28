const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const stripe = new Stripe('sk_test_51Tn7eiLtf2qHDiZoQGwHjK79BuhE9t4ONEkskrbWVlZ01RMuwl1BNfdARhqP00PVUw72oMxjtICuWL8d8sGI8M2t00npUyrws5');
    const { customer_id, amount, description } = req.body;

    // 顧客のデフォルトカードを取得
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customer_id,
      type: 'card',
    });

    if (paymentMethods.data.length === 0) {
      res.status(400).json({ error: 'カード情報が登録されていません' });
      return;
    }

    const pm = paymentMethods.data[0];

    // 即時決済
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount || 3000,
      currency: 'jpy',
      customer: customer_id,
      payment_method: pm.id,
      description: description || 'Nomi Go 参加費',
      confirm: true,
      off_session: true,
    });

    res.status(200).json({ success: true, payment_intent_id: paymentIntent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
