const Stripe = require('stripe');
const stripe = new Stripe('sk_test_51Tn7eiLtf2qHDiZoQGwHjK79BuhE9t4ONEkskrbWVlZ01RMuwl1BNfdARhqP00PVUw72oMxjtICuWL8d8sGI8M2t00npUyrws5');
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { user_id, email } = req.body;
    const customer = await stripe.customers.create({ metadata: { user_id: user_id || 'unknown' } });
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
    });
    res.status(200).json({ client_secret: setupIntent.client_secret, customer_id: customer.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
