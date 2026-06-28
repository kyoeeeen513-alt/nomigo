const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const stripe = new Stripe('sk_test_51TmkVPCG9UHvLerJVQiQOS5yGiTkL1YKKRbDleR0x8EycFF96q6DOgPxyeQjpdhZjJvkUUBvWGe1pYYiXiUH0YGO004GdiXE4L');
    const { payment_intent_id } = req.body;

    const refund = await stripe.refunds.create({
      payment_intent: payment_intent_id,
    });

    res.status(200).json({ success: true, refund_id: refund.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
