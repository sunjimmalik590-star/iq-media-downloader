import type {Env,Context,QueueBatch} from './runtime.ts';
import type {QueueWork,TelegramUpdate} from '../../shared/contracts.ts';
import {assertConfiguration,config} from './config.ts';
import {secureEqual,verifyHmac,readBody} from './security.ts';
import {Repository} from './repository.ts';
import {BotService} from './service.ts';
import {Telegram} from './telegram.ts';
import {validateCallback} from './worker-client.ts';
import {broadcastTick} from './broadcast.ts';
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function handleRequest(request:Request,env:Env,ctx:Context):Promise<Response> {
  const path=new URL(request.url).pathname;
  if(path==='/health'&&request.method==='GET') {
    let database=false,telegram=false;
    try{database=Boolean(await new Repository(env.DB).one('SELECT 1 ok'));}catch{/* safe degraded response */}
    try{const me=await new Telegram(env.TELEGRAM_BOT_TOKEN).call('getMe',{});telegram=me.username?.toLowerCase()==='iqtlbot';}catch{/* no token/details exposed */}
    const worker_configured=Boolean(env.DOWNLOAD_WORKER_URL&&env.DOWNLOAD_WORKER_SECRET);
    return json({status:database&&telegram&&worker_configured?'ok':'degraded',telegram,database,worker_configured},database&&telegram&&worker_configured?200:503);
  }
  if(!['/telegramWebhook','/workerCallback'].includes(path)||request.method!=='POST')return json({error:'not_found'},404);
  try{assertConfiguration(env);}catch{return json({error:'configuration_unavailable'},503);}
  if(path==='/telegramWebhook') {
    if(!await secureEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token')||'',env.TELEGRAM_WEBHOOK_SECRET))return json({error:'forbidden'},403);
    let raw:string,update:TelegramUpdate;
    try{raw=await readBody(request);update=JSON.parse(raw);if(!Number.isSafeInteger(update.update_id)||update.update_id<0)throw new Error();}catch{return json({error:'invalid_update'},400);}
    try {
      const service=new BotService(env);
      if(await service.repo.ingest(update.update_id,raw))ctx.waitUntil(service.enqueue({type:'update',id:update.update_id}));
      return json({ok:true});
    }catch{return json({error:'temporarily_unavailable'},503);}
  }
  let raw:string;try{raw=await readBody(request);}catch{return json({error:'invalid_body'},400);}
  if(!await verifyHmac(env.DOWNLOAD_WORKER_SECRET,request.headers,raw))return json({error:'forbidden'},403);
  let callback;
  try{callback=validateCallback(JSON.parse(raw),env.DOWNLOAD_WORKER_URL,config(env).maxFileSize);}catch{return json({error:'invalid_callback'},400);}
  try {
    const service=new BotService(env);
    // Commit callback before acknowledging. Consumer delivery runs after this response.
    if(await service.repo.acceptCallback(callback))ctx.waitUntil(service.enqueue({type:'deliver',id:callback.job_id}));
    return json({ok:true});
  }catch{return json({error:'temporarily_unavailable'},503);}
}
export default {
  fetch:handleRequest,
  async queue(batch:QueueBatch<QueueWork>,env:Env) {
    assertConfiguration(env);const service=new BotService(env);
    for(const message of batch.messages) {
      try {
        const w=message.body;
        if(w.type==='update')await service.processUpdate(w.id);
        else if(w.type==='metadata')await service.metadata(w.id);
        else if(w.type==='dispatch')await service.dispatch(w.id);
        else if(w.type==='deliver')await service.deliver(w.id);
        message.ack();
      }catch{message.retry({delaySeconds:60});}
    }
  },
  async scheduled(_event:unknown,env:Env,ctx:Context) {
    assertConfiguration(env);const service=new BotService(env);
    ctx.waitUntil((async()=>{await service.cleanup();await broadcastTick(service);})());
  }
};
