// 新規登録・プロフィール編集の顔写真専用アップロード窓口。
// 端末からStorageへ直接送らず、ログイン本人を確認してサーバーから保存する。
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);

module.exports.config = { api: { bodyParser: false } };

function reply(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.end(JSON.stringify(body));
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    req.on('data',chunk=>{
      size+=chunk.length;
      if(size>MAX_BYTES){
        reject(Object.assign(new Error('too_large'),{code:'too_large'}));
        req.destroy();return;
      }
      chunks.push(chunk);
    });
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}
async function getUser(token){
  const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{
    headers:{apikey:ANON_KEY,Authorization:`Bearer ${token}`}
  });
  return r.ok?r.json():null;
}
async function existingAccountStatus(userId){
  const r=await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=account_status&limit=1`,
    {headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}}
  );
  if(!r.ok)return {error:true,status:null};
  const rows=await r.json();
  return {error:false,status:Array.isArray(rows)&&rows[0]?rows[0].account_status:null};
}

module.exports=async function handler(req,res){
  if(req.method!=='POST')return reply(res,405,{error:'method_not_allowed'});
  if(!SUPABASE_URL||!ANON_KEY||!SERVICE_KEY)return reply(res,500,{error:'server_configuration'});

  const auth=String(req.headers.authorization||'');
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  if(!token)return reply(res,401,{error:'session_expired'});
  const user=await getUser(token);
  if(!user||!user.id)return reply(res,401,{error:'session_expired'});

  // 新規登録時はprofilesがまだ無いので許可する。既存の退会・停止者だけ拒否する。
  const account=await existingAccountStatus(user.id);
  if(account.error)return reply(res,503,{error:'account_check_failed'});
  if(account.status&&account.status!=='active')return reply(res,403,{error:'account_unavailable'});

  const type=String(req.headers['content-type']||'').split(';')[0].toLowerCase();
  if(!ALLOWED_TYPES.has(type))return reply(res,415,{error:'unsupported_image'});
  let body;
  try{body=await readBody(req);}
  catch(e){return reply(res,e&&e.code==='too_large'?413:400,{error:e&&e.code==='too_large'?'image_too_large':'invalid_body'});}
  if(!body.length)return reply(res,400,{error:'empty_image'});

  const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webpp','image/heic':'heic','image/heif':'heif'}[type];
  const path=`${user.id}/${Date.now()}-${Math.random().toString(36).slice(2,10)}.${ext}`;
  const upload=await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}`,{
    method:'POST',
    headers:{
      apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,
      'Content-Type':type,'x-upsert':'false','Cache-Control':'no-store'
    },
    body
  });
  if(!upload.ok){
    const detail=await upload.text().catch(()=>'');
    console.error('profile-photo-upload: storage failed',upload.status,detail.slice(0,500));
    return reply(res,502,{error:'storage_upload_failed'});
  }
  const publicUrl=`${SUPABASE_URL}/storage/v1/object/public/avatars/${path}`;
  return reply(res,200,{success:true,path,publicUrl});
};
