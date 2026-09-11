// マッチ後の初回連絡・未読・終了確認をLINEで1回ずつ送る内部ワーカー。
const SUPABASE_URL=process.env.SUPABASE_URL;
const SERVICE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const LINE_TOKEN=process.env.LINE_CHANNEL_ACCESS_TOKEN;
const APP_URL='https://www.nomi-go.jp/?openExternalBrowser=1';
const MAX_ATTEMPTS=5;
const BATCH_SIZE=20;

async function db(path,options={}){
  const headers={apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,...(options.headers||{})};
  if(options.body!==undefined)headers['Content-Type']='application/json';
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{
    method:options.method||'GET',headers,
    body:options.body===undefined?undefined:JSON.stringify(options.body)
  });
  const text=await r.text();
  if(!r.ok)throw new Error(`db_${r.status}:${text.slice(0,160)}`);
  return text?JSON.parse(text):[];
}
async function updateJob(id,body,extra=''){
  return db(`match_followup_jobs?id=eq.${encodeURIComponent(id)}${extra}&select=id,status,attempts`,{
    method:'PATCH',headers:{Prefer:'return=representation'},body
  });
}
async function pushLine(to,text){
  const r=await fetch('https://api.line.me/v2/bot/message/push',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${LINE_TOKEN}`},
    body:JSON.stringify({to,messages:[{type:'text',text}]})
  });
  if(!r.ok)throw new Error(`line_${r.status}:${(await r.text()).slice(0,160)}`);
}
function formatMeetingTime(value){
  if(!value)return 'アプリでご確認ください';
  return new Intl.DateTimeFormat('ja-JP',{
    timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',weekday:'short',
    hour:'2-digit',minute:'2-digit',hour12:false
  }).format(new Date(value));
}
function meetingLines(plan){
  if(!plan)return '';
  const time=plan.pending_time||plan.meeting_time;
  const place=plan.pending_place||plan.meeting_place;
  return `\n\n🕐 ${formatMeetingTime(time)}\n📍 ${place}`;
}
function messageFor(kind,plan,quickContent){
  if(kind==='match_created')return (
    '🍻 マッチが成立しました！\n\n'+
    '待ち合わせの初期設定はこちらです。変更したい場合だけ、アプリから変更を相談できます。'+
    meetingLines(plan)+'\n\n'+
    '▼ Nomi Goを開く\n'+APP_URL
  );
  if(kind==='meeting_change_requested')return (
    '📅 お相手から待ち合わせの変更相談が届きました'+
    meetingLines(plan)+'\n\n'+
    'Nomi Goを開いて、変更内容をご確認ください。\n\n'+
    '▼ 変更内容を確認する\n'+APP_URL
  );
  if(kind==='meeting_change_accepted')return (
    '✅ 待ち合わせの変更が承認されました'+
    meetingLines(plan)+'\n\n'+
    '▼ Nomi Goを開く\n'+APP_URL
  );
  if(kind==='meeting_change_declined')return (
    '📅 待ち合わせは元の時間・場所のままです\n\n'+
    'お相手が変更を承認しなかったため、最初に決まっていた内容で待ち合わせをお願いします。'+
    meetingLines(plan)+'\n\n'+
    '▼ Nomi Goを開く\n'+APP_URL
  );
  if(kind==='meeting_quick_message')return (
    '💬 お相手から待ち合わせの連絡です\n\n'+
    (quickContent||'Nomi Goを開いて内容をご確認ください。')+'\n\n'+
    '▼ メッセージを確認する\n'+APP_URL
  );
  if(kind==='initial_contact')return (
    '🍻 お相手へのご連絡をお願いします\n\n'+
    'マッチ成立後、まだお相手へのメッセージ送信が確認できていません。\n\n'+
    'Nomi Goを開き、待ち合わせ場所や時間についてお相手とご相談ください。\n\n'+
    'ご都合が変わった場合は、無断で連絡を絶たず、お相手へのご連絡とキャンセル手続きをお願いいたします。\n\n'+
    '無断キャンセルはお相手へのご迷惑となるため、状況によっては今後Nomi Goをご利用いただけなくなる場合があります。\n\n'+
    '▼ Nomi Goを開く\n'+APP_URL
  );
  if(kind==='unread_message')return (
    '💬 お相手から新しいメッセージが届いています\n\n'+
    '待ち合わせに関する内容の可能性がありますので、Nomi Goを開いてメッセージをご確認ください。\n\n'+
    '※内容を確認するだけで問題ありません。返信が不要な場合は、そのままで構いません。\n\n'+
    '▼ メッセージを確認する\n'+APP_URL
  );
  return (
    '🍺 飲み会は終了しましたか？\n\n'+
    'Nomi Goを開き、今回の結果をお知らせください。\n'+
    '片方の回答だけで、お相手がドタキャン扱いになることはありません。\n\n'+
    '▼ 結果を回答する\n'+APP_URL
  );
}
module.exports=async(req,res)=>{
  if(req.method!=='GET'&&req.method!=='POST')return res.status(405).json({success:false});
  if(!SUPABASE_URL||!SERVICE_KEY||!LINE_TOKEN)return res.status(500).json({success:false,error:'server_not_configured'});
  let sent=0,skipped=0,failed=0;
  try{
    await db('match_followup_jobs?status=eq.processing&locked_at=lt.'+
      encodeURIComponent(new Date(Date.now()-5*60*1000).toISOString())+
      `&attempts=lt.${MAX_ATTEMPTS}`,{method:'PATCH',body:{status:'queued',locked_at:null}});
    const jobs=await db('match_followup_jobs?status=eq.queued'+
      `&attempts=lt.${MAX_ATTEMPTS}`+
      '&select=id,match_id,user_id,kind,source_message_id,attempts&order=created_at.asc'+
      `&limit=${BATCH_SIZE}`);
    for(const job of jobs){
      const claimed=await updateJob(job.id,{
        status:'processing',attempts:Number(job.attempts||0)+1,
        locked_at:new Date().toISOString(),last_error:null
      },'&status=eq.queued');
      if(!claimed.length)continue;
      try{
        const profiles=await db('profiles?user_id=eq.'+encodeURIComponent(job.user_id)+
          '&account_status=eq.active&select=line_user_id&limit=1');
        const lineId=profiles[0]&&profiles[0].line_user_id;
        if(!lineId){
          await updateJob(job.id,{status:'skipped',locked_at:null,last_error:'line_not_linked'});
          skipped++;continue;
        }
        let plan=null;
        if(job.kind==='match_created'||job.kind.indexOf('meeting_change_')===0){
          const plans=await db('match_meeting_plans?match_id=eq.'+encodeURIComponent(job.match_id)+
            '&select=meeting_time,meeting_place,pending_time,pending_place&limit=1');
          plan=plans[0]||null;
        }
        let quickContent=null;
        if(job.kind==='meeting_quick_message'&&job.source_message_id){
          const messages=await db('messages?id=eq.'+encodeURIComponent(job.source_message_id)+
            '&select=content&limit=1');
          quickContent=messages[0]&&messages[0].content;
        }
        await pushLine(lineId,messageFor(job.kind,plan,quickContent));
        await updateJob(job.id,{status:'sent',sent_at:new Date().toISOString(),locked_at:null,last_error:null});
        sent++;
      }catch(e){
        const attempts=Number(job.attempts||0)+1;
        await updateJob(job.id,{
          status:attempts>=MAX_ATTEMPTS?'failed':'queued',locked_at:null,
          last_error:String(e&&e.message).slice(0,500)
        });
        failed++;
      }
    }
    res.status(200).json({success:true,sent,skipped,failed});
  }catch(e){
    res.status(200).json({success:false,error:String(e&&e.message).slice(0,200),sent,skipped,failed});
  }
};
