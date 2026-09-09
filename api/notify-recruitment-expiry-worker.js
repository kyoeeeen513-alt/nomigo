// 募集が期限切れで終了した利用者へ、LINEを1回だけ送る内部ワーカーです。
// 宛先・募集内容・文面はすべてサーバー側で決定し、外部入力は使用しません。

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const APP_URL = 'https://www.nomi-go.jp/?openExternalBrowser=1';
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 10;

async function db(path, options = {}) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    ...(options.headers || {}),
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`db_${response.status}:${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : [];
}

async function updateJob(id, body, extraFilter = '') {
  return db(
    `recruitment_expiry_notify_jobs?id=eq.${encodeURIComponent(id)}${extraFilter}&select=id,status,attempts`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body,
    }
  );
}

async function pushLine(lineUserId, text) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: 'text', text }],
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`line_${response.status}:${detail.slice(0, 160)}`);
  }
}

function messageFor(job) {
  const areaNames = { shinjuku: '新宿', susukino: 'すすきの' };
  const area = job.area_id ? (areaNames[job.area_id] || String(job.area_id)) : '';
  const slot = job.slot ? String(job.slot) : '';
  const summary = [area, slot].filter(Boolean).join('・');
  return (
    '🍺 募集が終了しました\n' +
    (summary ? summary + '\n' : '') +
    '今回はマッチが成立しませんでした。\n' +
    'また飲みたいタイミングで募集してください。\n\n' +
    '▼ Nomi Goを開く\n' +
    APP_URL
  );
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ success: false });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY || !LINE_TOKEN) {
    res.status(500).json({ success: false, error: 'server_not_configured' });
    return;
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  try {
    // 送信途中で処理が止まった行を、5分後に再試行できる状態へ戻す。
    await db(
      'recruitment_expiry_notify_jobs?status=eq.processing&locked_at=lt.' +
        encodeURIComponent(new Date(Date.now() - 5 * 60 * 1000).toISOString()) +
        `&attempts=lt.${MAX_ATTEMPTS}`,
      { method: 'PATCH', body: { status: 'queued', locked_at: null } }
    );

    const jobs = await db(
      'recruitment_expiry_notify_jobs?status=eq.queued' +
        `&attempts=lt.${MAX_ATTEMPTS}` +
        '&select=id,registration_id,user_id,area_id,slot,attempts' +
        `&order=created_at.asc&limit=${BATCH_SIZE}`
    );

    for (const job of jobs) {
      // queued の行だけを processing にできた処理が送信権を持つ。
      const claimed = await updateJob(
        job.id,
        {
          status: 'processing',
          attempts: Number(job.attempts || 0) + 1,
          locked_at: new Date().toISOString(),
          last_error: null,
        },
        '&status=eq.queued'
      );
      if (!claimed.length) continue;

      try {
        const profiles = await db(
          'profiles?user_id=eq.' +
            encodeURIComponent(job.user_id) +
            '&account_status=eq.active&select=line_user_id&limit=1'
        );
        const lineUserId = profiles[0] && profiles[0].line_user_id;
        if (!lineUserId) {
          await updateJob(job.id, {
            status: 'skipped',
            locked_at: null,
            last_error: 'line_not_linked',
          });
          skipped++;
          continue;
        }

        await pushLine(lineUserId, messageFor(job));
        await updateJob(job.id, {
          status: 'sent',
          sent_at: new Date().toISOString(),
          locked_at: null,
          last_error: null,
        });
        sent++;
      } catch (error) {
        const attempts = Number(job.attempts || 0) + 1;
        await updateJob(job.id, {
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
          locked_at: null,
          last_error: String(error && error.message).slice(0, 500),
        });
        failed++;
      }
    }

    res.status(200).json({ success: true, sent, skipped, failed });
  } catch (error) {
    res.status(200).json({
      success: false,
      error: String(error && error.message).slice(0, 200),
      sent,
      skipped,
      failed,
    });
  }
};
