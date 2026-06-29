const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { number, exp_month, exp_year, cvc, amount, description } = req.body;

    // PAY.JP REST APIで直接トークン作成
    const tokenData = new URLSearchParams({
      'card[number]': number,
      'card[exp_month]': exp_month,
      'card[exp_year]': exp_year,
      'card[cvc]': cvc
    }).toString();

    const tokenRes = await makeRequest('POST', '/v1/tokens', tokenData, 'pk_test_5d6152d2f055a7440fccb417');
    const tokenJson = JSON.parse(tokenRes);

    if (tokenJson.error) {
      return res.status(400).json({ error: tokenJson.error.message });
    }

    // トークンで決済
    const chargeData = new URLSearchParams({
      amount: amount || 3000,
      currency: 'jpy',
      card: tokenJson.id,
      description: description || 'Nomi Go 参加費',
      capture: 'true'
    }).toString();

    const chargeRes = await makeRequest('POST', '/v1/charges', chargeData, 'sk_test_7f09390eddd254b2f420dea8');
    const chargeJson = JSON.parse(chargeRes);

    if (chargeJson.error) {
      return res.status(400).json({ error: chargeJson.error.message });
    }

    res.status(200).json({ success: true, charge_id: chargeJson.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

function makeRequest(method, path, data, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.pay.jp',
      port: 443,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
