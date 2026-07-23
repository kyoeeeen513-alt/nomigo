// LINEからメッセージが送られてくるたびに、ここが自動で呼ばれます
// 送られてきた文字が「6桁の連携番号」と一致すれば、そのユーザーのLINE IDを保存します
//
// 【変更点】同じLINEアカウントで2つ目のNomi Goアカウントを作れないようにしました。
//   - 既に別ユーザーが使っているLINE IDなら、保存せずに理由を返信します
//   - BANされたLINEなら、連携させません
//
// 【今回の変更】RLS(行レベルセキュリティ)を有効にしたため、
//   サーバー側からの読み書きには service_role キーを使います。
//   キーはVercelの環境変数 SUPABASE_SERVICE_ROLE_KEY から読み込みます。
const SUPABASE_URL = 'https://dwubothomxjwfudkeepy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }
  try {
    const events = (req.body && req.body.events) || [];
    for (const event of events) {
      if (event.type === 'message' && event.message && event.message.type === 'text') {
        const text = event.message.text.trim();
        const lineUserId = event.source.userId;

        // 送られてきた文字が6桁の数字かどうかチェック
        if (/^\d{6}$/.test(text)) {

          // --- ① このLINEがBANされていないか確認 ---
          const banRes = await fetch(
            `${SUPABASE_URL}/rest/v1/blacklist?line_user_id=eq.${encodeURIComponent(lineUserId)}&select=id&limit=1`,
            { headers: HEADERS }
          );
          const banRows = await banRes.json();
          if (Array.isArray(banRows) && banRows.length > 0) {
            await replyMessage(
              event.replyToken,
              'ご利用いただけません。利用規約に違反したため、アカウントの作成を制限しています。'
            );
            continue;
          }

          // --- ② このLINEが既に別アカウントで使われていないか確認 ---
          const dupRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?line_user_id=eq.${encodeURIComponent(lineUserId)}&select=user_id&limit=1`,
            { headers: HEADERS }
          );
          const dupRows = await dupRes.json();
          const alreadyLinkedUserId =
            Array.isArray(dupRows) && dupRows.length > 0 ? dupRows[0].user_id : null;

          // --- ③ 番号からユーザーを探す ---
          const findRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?line_link_code=eq.${text}&select=user_id`,
            { headers: HEADERS }
          );
          const rows = await findRes.json();

          if (!Array.isArray(rows) || rows.length === 0) {
            await replyMessage(
              event.replyToken,
              '番号が見つかりませんでした。アプリでもう一度番号を発行してください。'
            );
            continue;
          }

          const userId = rows[0].user_id;

          // 既に別のアカウントに紐づいている場合は保存しない
          if (alreadyLinkedUserId && alreadyLinkedUserId !== userId) {
            await replyMessage(
              event.replyToken,
              'このLINEアカウントは、すでに別のNomi Goアカウントで連携されています。\n' +
              'Nomi Goは、お一人につき1アカウントまでのご利用となります。'
            );
            continue;
          }

          // 同じユーザーが再度送ってきた場合は、そのまま完了扱い
          if (alreadyLinkedUserId === userId) {
            await replyMessage(event.replyToken, '連携はすでに完了しています。');
            continue;
          }

          // --- ④ 保存 ---
          const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`, {
            method: 'PATCH',
            headers: { ...HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ line_user_id: lineUserId, line_link_code: null }),
          });

          if (!patchRes.ok) {
            // ユニーク制約に引っかかった場合など
            await replyMessage(
              event.replyToken,
              'このLINEアカウントは、すでに別のNomi Goアカウントで連携されています。\n' +
              'Nomi Goは、お一人につき1アカウントまでのご利用となります。'
            );
            continue;
          }

          await replyMessage(
            event.replyToken,
            '連携が完了しました！これからマッチ通知などをお届けします。'
          );
        }
      }
    }
    res.status(200).send('OK');
  } catch (e) {
    console.error(e);
    res.status(200).send('OK');
  }
};

// LINEに返信メッセージを送る
async function replyMessage(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
}
