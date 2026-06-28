const Stripe = require('stripe');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const stripe = new Stripe('sk_test_51Tn7eiLtf2qHDiZoQGwHjK79BuhE9t4ONEkskrbWVlZ01RMuwl1BNfdARhqP00PVUw72oMxjtICuWL8d8sGI8M2t00npUyrws5');
    const { payment_method_id, amount, description } = req.body;

    // 1. Stripe顧客を新規作成
    const customer = await stripe.customers.create();

    // 2. カード(PaymentMethod)をその顧客に紐付け
    await stripe.paymentMethods.attach(payment_method_id, { customer: customer.id });

    // 3. 即時決済
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount || 3000,
      currency: 'jpy',
      customer: customer.id,
      payment_method: payment_method_id,
      description: description || 'Nomi Go 参加費',
      confirm: true,
      off_session: true,
    });

    res.status(200).json({
      success: true,
      payment_intent_id: paymentIntent.id,
      customer_id: customer.id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
