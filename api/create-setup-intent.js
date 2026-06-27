const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const stripe = Stripe(const stripe = Stripe('sk_test_51TmkVPCG9UHvLerJVQiQOS5yGiTkL1YKKRbDleR0x8EycFF96q6DOgPxyeQjpdhZjJvkUUBvWGe1pYYiXiUH0YGO004GdiXE4L'););
    const { user_id, email } = req.body;

    // 既存のStripe顧客を検索、なければ作成
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { user_id }
      });
    }

    // SetupIntent作成（カード情報を登録するための仕組み）
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      metadata: { user_id }
    });

    res.status(200).json({
      client_secret: setupIntent.client_secret,
      customer_id: customer.id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
