// LINEからメッセージが送られてくるたびに、ここが自動で呼ばれます
// 送られてきた文字が「6桁の連携番号」と一致すれば、そのユーザーのLINE IDを保存します
//
// 【変更点】同じLINEアカウントで2つ目のNomi Goアカウントを作れないようにしました。
//   - 既に別ユーザーが使っているLINE IDなら、保存せずに理由を返信します
//   - BANされたLINEなら、連携させません
//
// 【RLS対応】RLS(行レベルセキュリティ)を有効にしたため、
//   サーバー側からの読み書きには service_role キーを使います。
//   キーはVercelの環境変数 SUPABASE_SERVICE_ROLE_KEY から読み込みます。
//
// 【署名検証の追加（8/9）】
//   これまでは、届いた通信が本当にLINEから来たものか確認していませんでした。
//   そのため、外部から偽の通信を作って「連携番号は123456です」と送りつけることができ、
//   6桁の番号を総当たりされると、他人のアカウントに攻撃者のLINEを紐づけられる状態でした。
//   紐づけに成功されると、マッチ成立の通知（お相手の情報を含む）が攻撃者に届いてしまいます。
//
//   LINEは通信のたびに X-Line-Signature という「合言葉」を付けて送ってきます。
//   これはチャネルシークレット（LINE側で発行される秘密の文字列）を使って本文から計算された値で、
//   秘密の文字列を知らない第三者には正しい値を作れません。
//   受け取った本文から同じ計算をして一致するか確かめることで、偽の通信をすべて弾きます。
//
//   合言葉の計算は「本文の1バイトも変えずに」行う必要があるため、
//   Vercelが自動でJSONに変換する機能を止め（bodyParser: false）、
//   本文を生のまま受け取ってから自分で変換しています。
//
//   必要な環境変数：LINE_CHANNEL_SECRET
//   （LINE Developers の対象チャネル > チャネル基本設定 > チャネルシークレット）
//
// 【今回の変更：番号の有効期限と試行回数の制限（8/10）】
//   署名検証により外部からの偽の通信は塞がりましたが、連携番号そのものの守りは薄いままでした。
//   6桁の番号には有効期限がなく、一度発行すると連携を完了するまで永久に使える状態だったため、
//   連携を途中でやめた人の番号が残り続け、時間をかければ当てられる余地がありました。
//
//   対策は2つです。
//   ① 有効期限：番号は発行から10分だけ有効。期限はDB側のトリガーが自動でつけるため、
//      利用者が期限を延ばすことはできません。期限切れの番号では連携できません。
//   ② 試行回数の制限：同じLINEアカウントが10分間に5回まちがえると、1時間受け付けません。
//      これにより、総当たりに現実的でない時間がかかるようになります。
//
//   件数の数え直しやロックの判定はすべてDB側の関数（line_link_check_allowed /
//   line_link_record_failure / line_link_clear_failures）で行い、
//   これらの関数は一般利用者からは呼び出せないようにしてあります。
//
// 【今回の変更：連携完了メッセージに正式スタート日を追記（8/22）】
//   TikTokでの集客を開始したが、CREDIXの開通前のため募集中の利用者がまだいない。
//   連携が完了した直後に「これからマッチ通知をお届けします」とだけ伝えると、
//   すぐに通知が来るものと受け取られ、来ないことで不信を招く。
//   正式スタートが9月1日であることをこの時点で伝え、待ってもらう。
//   PRE_LAUNCH を false にすれば、従来どおりの文面に戻る。
//   決済の販売可否とは独立した表示スイッチである。
//
// 【今回の変更：アプリを開くリンクを返信に追記（8/24）】
//   Nomi GoはWebアプリのため、スマホのホーム画面から開く習慣がつきにくく、
//   一度離れると戻ってこない。LINEはほぼ毎日開くので、そこから1タップで
//   アプリへ戻れる状態にしておく。
//   追記したのは「連携が完了したとき」と「すでに連携済みのとき」の2つ。
//   とくに後者は、登録を終えた人がLINEを開いて何か送ってきた場面であり、
//   アプリへ戻したい相手そのものにあたる。
//   まちがった番号を送ったときの返信には入れていない。あの場面で伝えるべきは
//   「番号を発行し直す」ことだけで、リンクを増やすと何をすべきか分からなくなるため。
//   URLは1か所（APP_URL）にまとめてあるので、変わったときはここだけ直せばよい。

const crypto = require('crypto');

// 正式スタート前かどうか。9月1日以降は false に戻す。
const PRE_LAUNCH = false;

// アプリのURL。返信に載せるリンク。変わったらここだけ直す。
const APP_URL = 'https://www.nomi-go.jp';

const SUPABASE_URL = 'https://dwubothomxjwfudkeepy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

// Vercelによる本文の自動変換を止める（署名計算には生の本文が必要なため）
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

// 生の本文をそのまま読み取る
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 届いた通信が本当にLINEから来たものか確かめる
function isValidSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const expected = crypto
    .createHmac('sha256', channelSecret)
    .update(rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  // 長さが違う場合は比較せずに不一致とする
  if (a.length !== b.length) return false;
  // 一致するまでの時間差から秘密を推測されないよう、専用の比較関数を使う
  return crypto.timingSafeEqual(a, b);
}

// DB側の関数を呼ぶ（総当たり対策の判定・記録）
// 失敗しても連携そのものは止めない方針だが、判定は安全側（呼べなければ許可）に倒す
async function callRpc(fnName, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    console.error(`RPC ${fnName} 失敗: ${res.status}`);
    return null;
  }
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  try {
    const channelSecret = process.env.LINE_CHANNEL_SECRET;

    // チャネルシークレットが未設定なら、検証できないので受け付けない
    if (!channelSecret) {
      console.error('LINE_CHANNEL_SECRET が設定されていません');
      res.status(401).send('Unauthorized');
      return;
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers['x-line-signature'];

    // 署名が一致しない通信はここで全て弾く
    if (!isValidSignature(rawBody, signature, channelSecret)) {
      console.error('署名が一致しない通信を拒否しました');
      res.status(401).send('Unauthorized');
      return;
    }

    // ここから先は、LINEから届いた正規の通信であることが確認できている
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      res.status(200).send('OK');
      return;
    }

    const events = (payload && payload.events) || [];

    for (const event of events) {
      if (event.type === 'message' && event.message && event.message.type === 'text') {
        const text = event.message.text.trim();
        const lineUserId = event.source.userId;

        // 送られてきた文字が6桁の数字かどうかチェック
        if (/^\d{6}$/.test(text)) {

          // --- ⓪ 短時間にまちがえすぎていないか確認（総当たりの抑止）---
          const allowed = await callRpc('line_link_check_allowed', { p_line_user_id: lineUserId });
          if (allowed === false) {
            await replyMessage(
              event.replyToken,
              '番号のまちがいが続いたため、しばらく受け付けを停止しています。\n' +
              '1時間ほど時間をおいてから、アプリで番号を発行し直してお試しください。'
            );
            continue;
          }

          // --- ① このLINEが既に別アカウントで使われていないか確認 ---
          const dupRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?line_user_id=eq.${encodeURIComponent(lineUserId)}&select=user_id&limit=1`,
            { headers: HEADERS }
          );
          const dupRows = await dupRes.json();
          const alreadyLinkedUserId =
            Array.isArray(dupRows) && dupRows.length > 0 ? dupRows[0].user_id : null;

          // --- ② 番号からユーザーを探す（有効期限内のものだけを対象とする）---
          //     期限切れの番号は、そもそも見つからない扱いになる
          const nowIso = new Date().toISOString();
          const findRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?line_link_code=eq.${text}` +
            `&line_link_code_expires_at=gt.${encodeURIComponent(nowIso)}` +
            `&select=user_id`,
            { headers: HEADERS }
          );
          const rows = await findRes.json();

          if (!Array.isArray(rows) || rows.length === 0) {
            // まちがい（または期限切れ）として記録する
            await callRpc('line_link_record_failure', { p_line_user_id: lineUserId });
            await replyMessage(
              event.replyToken,
              '番号が見つかりませんでした。\n' +
              '番号の有効期限は発行から10分です。アプリでもう一度番号を発行してからお送りください。'
            );
            continue;
          }

          const userId = rows[0].user_id;

          // --- ③ 利用停止中の本人またはLINEではないか確認 ---
          // 番号からNomi Go側の利用者を特定してから、user_id と LINE ID の両方で照合する。
          const banFilter = new URLSearchParams({
            or: `(user_id.eq.${userId},line_user_id.eq.${lineUserId})`,
            select: 'id,expires_at',
          });
          const banRes = await fetch(
            `${SUPABASE_URL}/rest/v1/blacklist?${banFilter.toString()}`,
            { headers: HEADERS }
          );
          if (!banRes.ok) {
            console.error('blacklist check failed:', banRes.status);
            await replyMessage(
              event.replyToken,
              '利用状態を確認できませんでした。時間をおいて、もう一度番号をお送りください。'
            );
            continue;
          }
          const banRows = await banRes.json();
          const now = Date.now();
          const activelyBanned = Array.isArray(banRows) && banRows.some((row) =>
            !row.expires_at || new Date(row.expires_at).getTime() > now
          );
          if (activelyBanned) {
            await replyMessage(
              event.replyToken,
              'ご利用いただけません。利用規約に違反したため、アカウントの作成を制限しています。'
            );
            continue;
          }

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
            await callRpc('line_link_clear_failures', { p_line_user_id: lineUserId });
            await replyMessage(
              event.replyToken,
              '連携はすでに完了しています。\n\n' +
              '▼ Nomi Goを開く\n' +
              APP_URL
            );
            continue;
          }

          // --- ④ 保存 ---
          // line_linked_at：いつ連携したかを記録する（2026/8/24追加）。
          //   これまで連携時刻を保存しておらず、誰がいつ連携したかを
          //   後から確認できなかった。運営が利用者の状況を把握するために使う。
          //   利用者側からは書き換えられない（DBのガードで無効化してある）。
          const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`, {
            method: 'PATCH',
            headers: { ...HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              line_user_id: lineUserId,
              line_link_code: null,
              line_linked_at: new Date().toISOString(),
            }),
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

          // 連携できたので、まちがえた回数の記録は消す
          await callRpc('line_link_clear_failures', { p_line_user_id: lineUserId });

          await replyMessage(
            event.replyToken,
            PRE_LAUNCH
              ? '連携が完了しました！\n\n' +
                'Nomi Goの正式スタートは9月1日です。\n' +
                'いまは準備期間のため、まだ募集している方がいません。\n\n' +
                '開始したらこのLINEでお知らせしますので、それまでお待ちください。\n' +
                'お相手が見つかったときも、こちらに通知が届きます。\n\n' +
                '▼ Nomi Goを開く\n' +
                APP_URL
              : '連携が完了しました！これからマッチ通知などをお届けします。\n\n' +
                '▼ Nomi Goを開く\n' +
                APP_URL
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
