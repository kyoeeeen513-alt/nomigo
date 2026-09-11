// 本人確認画像専用アップロード窓口。
// スマホのブラウザからSupabase Storageへ直接送る際の失敗を避けるため、
// ログイン確認後にサーバーから非公開バケットへ保存する。
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
]);

module.exports.config = { api: { bodyParser: false } };

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function getUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  return r.json();
}

async function isActiveUser(userId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&account_status=eq.active&select=user_id&limit=1`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
      }
    }
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length === 1;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    console.error('id-photo-upload: missing environment variables');
    return reply(res, 500, { error: 'server_configuration' });
  }

  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return reply(res, 401, { error: 'session_expired' });

  const user = await getUser(token);
  if (!user || !user.id) return reply(res, 401, { error: 'session_expired' });
  if (!(await isActiveUser(user.id))) return reply(res, 403, { error: 'account_unavailable' });

  const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!ALLOWED_TYPES.has(type)) return reply(res, 415, { error: 'unsupported_image' });

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return reply(res, e && e.code === 'too_large' ? 413 : 400, {
      error: e && e.code === 'too_large' ? 'image_too_large' : 'invalid_body'
    });
  }
  if (!body.length) return reply(res, 400, { error: 'empty_image' });

  const extByType = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif'
  };
  const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extByType[type]}`;
  const upload = await fetch(
    `${SUPABASE_URL}/storage/v1/object/id_photos/${path}`,
    {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': type,
        'x-upsert': 'false',
        'Cache-Control': 'no-store'
      },
      body
    }
  );

  if (!upload.ok) {
    const detail = await upload.text().catch(() => '');
    console.error('id-photo-upload: storage failed', upload.status, detail.slice(0, 500));
    return reply(res, 502, { error: 'storage_upload_failed' });
  }
  return reply(res, 200, { success: true, path });
};
