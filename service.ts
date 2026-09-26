import type {Env,WorkQueue} from './runtime.ts';
import type {Metadata,QueueWork,SendMethod,TelegramUpdate,WorkerCallback} from '../../shared/contracts.ts';
import {config} from './config.ts';
import {Repository,type Cache,type Job,type User} from './repository.ts';
import {sha256} from './security.ts';
import {extractUrls,normalizeUrl,detectPlatform} from './urls.ts';
import {en,translate} from './i18n.ts';
import {Telegram,TelegramError,mediaField,type TelegramPort} from './telegram.ts';
import {WorkerClient,WorkerError,validateMetadata,type WorkerPort} from './worker-client.ts';
import {home,adminMenu,button,keyboard,formatButtons,mediaText} from './ui.ts';
export class BotService {
  env:Env;repo:Repository;tg:TelegramPort;worker:WorkerPort;queue:WorkQueue;p:ReturnType<typeof config>;
  constructor(env:Env,deps?:{repo?:Repository;tg?:TelegramPort;worker?:WorkerPort}) {
    this.env=env;this.repo=deps?.repo||new Repository(env.DB);this.tg=deps?.tg||new Telegram(env.TELEGRAM_BOT_TOKEN);this.worker=deps?.worker||new WorkerClient(env.DOWNLOAD_WORKER_URL,env.DOWNLOAD_WORKER_SECRET);this.queue=env.EVENTS;this.p=config(env);
  }
  isAdmin(id:string){return this.p.admins.has(id);}
  async enqueue(work:QueueWork) {
    // The database row is a durable outbox; cron recovers enqueue failures.
    try{await this.queue.send(work);}catch{await this.repo.audit('queue_enqueue_failed',null,null,work.type);}
  }
  async notify(user:User,text:string,markup?:unknown){return this.tg.text(user.chat_id,text,markup);}
  async processUpdate(id:number) {
    const record=await this.repo.claimUpdate(id);if(!record)return;
    try {await this.handle(JSON.parse(record.body));await this.repo.finishUpdate(id);}
    catch{await this.repo.finishUpdate(id,'failed');await this.repo.audit('update_processing_failed',null,null,String(id));}
  }
  async handle(update:TelegramUpdate) {
    const cb=update.callback_query, message=cb?.message||update.message||update.edited_message;
    const from=cb?.from||message?.from;
    if(!message||!from)return;
    const uid=String(from.id),chat=String(message.chat.id);
    // Keep downloads, preferences and administrator tools in the user's private bot chat.
    if(message.chat.type && message.chat.type!=='private') {await this.tg.text(chat,'Please open @iqTLbot in a private chat.');return;}
    const user=await this.repo.user(uid,chat,from.username||null);
    if(cb) {try{await this.tg.call('answerCallbackQuery',{callback_query_id:cb.id});}catch{/* no duplicate media side effects */}}
    if(cb?.data?.startsWith('admin:')) {if(!this.isAdmin(uid)){await this.notify(user,'Administrator access required.');return;} await this.admin(user,cb.data.slice(6));return;}
    if(user.blocked&&!this.isAdmin(uid)){await this.notify(user,'Your access is restricted.');return;}
    if(await this.repo.settings('maintenance')==='true'&&!this.isAdmin(uid)){await this.notify(user,en.maintenance);return;}
    if(cb?.data) {await this.callback(user,cb.data);return;}
    const text=(message.text||'').trim();const command=text.split(/\s/)[0].split('@')[0].toLowerCase();
    if(command==='/start'){await this.notify(user,translate(user.language).start,home);return;}
    if(command==='/help'){await this.notify(user,en.help,home);return;}
    if(command==='/history'){await this.history(user);return;}
    if(command==='/settings'){await this.settings(user);return;}
    if(command==='/admin'){if(this.isAdmin(uid))await this.notify(user,'IQ Administration',adminMenu);else await this.notify(user,'Administrator access required.');return;}
    if(['/broadcast','/block','/unblock'].includes(command)) {
      if(!this.isAdmin(uid)){await this.notify(user,'Administrator access required.');return;}
      if(command==='/broadcast') {
        const content=text.slice(text.indexOf(' ')+1).trim();if(!text.includes(' ')||!content||content.length>3500){await this.notify(user,'Use /broadcast followed by a message of up to 3500 characters.');return;}
        const bid=crypto.randomUUID(),now=Date.now();
        await this.repo.run("INSERT INTO broadcasts(id,creator_id,text,status,created_at,updated_at) VALUES (?,?,?,'draft',?,?)",bid,uid,content,now,now);
        await this.notify(user,`Broadcast draft:\n\n${content}`,keyboard([[button('📣 Queue broadcast',`admin:bq:${bid}`),button('❌ Cancel',`admin:bc:${bid}`)]]));return;
      }
      const target=text.split(/\s+/)[1];if(!/^\d+$/.test(target||'')||this.isAdmin(target)){await this.notify(user,'Provide a non-admin Telegram user ID.');return;}
      const changed=await this.repo.run('UPDATE bot_users SET blocked=? WHERE id=?',command==='/block'?1:0,target);
      await this.repo.audit(command.slice(1),uid,null,target);await this.notify(user,changed?'User access updated.':'User not found.');return;
    }
    const urls=extractUrls(message);if(urls.length!==1){await this.notify(user,'Send one public media URL at a time.',home);return;}
    await this.newRequest(user,urls[0]);
  }
  async callback(user:User,data:string) {
    if(data==='menu:download'){await this.notify(user,'Send one public media link.');return;}
    if(data==='menu:help'){await this.notify(user,en.help,home);return;}
    if(data==='menu:history'){await this.history(user);return;}
    if(data==='history:clear'){await this.repo.clearHistory(user.id);await this.notify(user,'Your download history is cleared.');return;}
    if(data==='menu:settings'||data.startsWith('setting:')){await this.settings(user,data);return;}
    if(data.startsWith('cancel:')) {
      const id=data.slice(7),changed=await this.repo.cancel(id,user.id);
      if(changed)try{await this.worker.post('/cancel',{job_id:id});}catch{/* TTL is the fallback */}
      await this.notify(user,changed?'Request cancelled.':'This request cannot be cancelled. Uploading and completed requests cannot be cancelled.');return;
    }
    if(data.startsWith('fmt:')) {
      const [,id,index]=data.split(':');const job=await this.repo.job(id);
      if(!job||job.user_id!==user.id||job.status!=='awaiting_format'||job.expires_at<Date.now()){await this.notify(user,'This selection has expired or was already used.');return;}
      const m=JSON.parse(job.metadata||'{}') as Metadata;const f=/^\d{1,2}$/.test(index)?m.formats?.[Number(index)]:undefined;
      if(!f){await this.notify(user,'Invalid format selection.');return;}
      const key=await sha256(`${job.normalized_url}|${f.kind}|${f.quality}`);
      if(!await this.repo.choose(id,user.id,f,key))return;
      await this.enqueue({type:'dispatch',id});await this.notify(user,'Your request is queued.',keyboard([[button('❌ Cancel',`cancel:${id}`)]]));
    }
  }
  async newRequest(user:User,raw:string) {
    let url:string,platform:string;
    try{url=normalizeUrl(raw);platform=detectPlatform(url);}catch(e){await this.notify(user,this.errorText(e));return;}
    const id=crypto.randomUUID(),hash=await sha256(url);
    const rejection=await this.repo.createJob({id,user,url,hash,platform},this.p);if(rejection){await this.notify(user,rejection);return;}
    await this.enqueue({type:'metadata',id});
  }
  async metadata(id:string) {
    const j=await this.repo.job(id);if(!j||j.status!=='queued')return;
    const user=(await this.repo.getUser(j.user_id))!;
    try {
      const cache=(await this.repo.cachedFor(j.source_url_hash)).filter(c=>c.file_size<=this.p.maxFileSize);
      // Previously delivered formats are real evidence. Repeat links need no worker metadata call.
      const m:Metadata=cache.length?{title:'Previously downloaded media',artist:'',duration:null,media_type:cache.some(c=>c.format==='video')?'video':'audio',formats:cache.map(c=>({id:'cache:'+c.cache_key,kind:c.format as 'audio'|'video',quality:c.quality,ext:c.mime_type==='audio/mpeg'?'mp3':c.mime_type==='audio/mp4'?'m4a':c.mime_type==='video/webm'?'webm':c.format==='audio'?'ogg':'mp4',filesize:c.file_size}))}:validateMetadata(await this.worker.post('/metadata',{source_url:j.normalized_url,platform:j.platform,max_file_size:this.p.maxFileSize}));
      if(await this.repo.setMetadata(id,m))await this.notify(user,mediaText(j.platform,m),formatButtons(id,m.formats,user.default_quality));
    }catch(e){await this.repo.fail(id,this.errorCode(e),this.p);await this.notify(user,this.errorText(e));}
  }
  async dispatch(id:string) {
    let j=await this.repo.job(id);if(!j||j.status!=='processing'||!await this.repo.claimDispatch(id))return;
    const cache=j.cache_key?await this.repo.cache(j.cache_key):null;
    if(cache&&cache.file_size<=this.p.maxFileSize) {
      if(await this.repo.run("UPDATE download_jobs SET status='uploading',cache_hit=1,callback=?,updated_at=? WHERE id=? AND status='processing'",JSON.stringify({cache:cache.cache_key}),Date.now(),id))await this.enqueue({type:'deliver',id});return;
    }
    try {
      if(j.format_id?.startsWith('cache:')) {
        const m=validateMetadata(await this.worker.post('/metadata',{source_url:j.normalized_url,platform:j.platform,max_file_size:this.p.maxFileSize}));
        const f=m.formats.find(f=>f.kind===j!.format&&f.quality===j!.quality);if(!f)throw new WorkerError('FORMAT_UNAVAILABLE');
        await this.repo.run("UPDATE download_jobs SET format_id=? WHERE id=? AND status='processing'",f.id,id);j=(await this.repo.job(id))!;
      }
      const data=await this.worker.post<{worker_job_id:string}>('/download',{job_id:j.id,source_url:j.normalized_url,platform:j.platform,requested_format:j.format,requested_quality:j.quality,format_id:j.format_id,max_file_size:this.p.maxFileSize,max_redirects:5,timeout_ms:this.p.timeoutMs,callback_url:this.env.APP_BASE_URL.replace(/\/$/,'')+'/workerCallback'});
      if(data.worker_job_id!==id)throw new WorkerError('MEDIA_UNAVAILABLE');
      await this.repo.run("UPDATE download_jobs SET worker_job_id=? WHERE id=? AND status='processing'",data.worker_job_id,id);
    }catch(e) {
      // Transport outcome can be ambiguous. Re-dispatch with the same job ID via cron.
      if(e instanceof WorkerError){await this.repo.fail(id,e.code,this.p);await this.tg.text(j.chat_id,this.errorText(e));}
      else await this.repo.audit('worker_dispatch_retry',j.user_id,id);
    }
  }
  async workerCallback(cb:WorkerCallback) {
    if(await this.repo.acceptCallback(cb))await this.enqueue({type:'deliver',id:cb.job_id});
  }
  async deliver(id:string) {
    const j=await this.repo.job(id);if(!j||j.status!=='uploading'||!await this.repo.claimDelivery(id))return;
    const user=(await this.repo.getUser(j.user_id))!;
    const cb=JSON.parse(j.callback||'{}') as WorkerCallback & {cache?:string};
    if(cb.status==='failed'){await this.repo.fail(id,cb.error_code,this.p);await this.notify(user,this.errorText(new WorkerError(cb.error_code)));return;}
    let sendStarted=false;
    try {
      if(cb.cache) {
        const cache=await this.repo.cache(cb.cache);
        if(!cache) {await this.staleCache(j);return;}
        sendStarted=true;
        try {
          await this.tg.call(cache.send_method,{chat_id:j.chat_id,[mediaField(cache.send_method)]:cache.telegram_file_id,caption:'⚡ IQ Media Downloader · Download. Fast. Simple.',disable_notification:!user.notifications});
        }catch(e){if(e instanceof TelegramError&&e.staleFileId){await this.repo.removeCache(cb.cache);await this.staleCache(j);return;}throw e;}
        await this.repo.complete(j,cache,true);await this.repo.audit('cache_hit',j.user_id,id);return;
      }
      if(cb.status!=='completed')throw new Error('INVALID_CALLBACK');
      const response=await this.worker.file(cb.file_url);
      if(!response.ok||Number(response.headers.get('content-length'))!==cb.file_size||response.headers.get('content-type')?.split(';')[0]!==cb.mime_type) {await response.body?.cancel();throw new Error('MEDIA_VALIDATION_FAILED');}
      const method:SendMethod=user.send_mode==='document'?'sendDocument':cb.mime_type==='video/mp4'?'sendVideo':['audio/mpeg','audio/mp4'].includes(cb.mime_type)?'sendAudio':'sendDocument';
      sendStarted=true;
      const sent=await this.tg.upload(method,j.chat_id,response,cb.file_size,cb.mime_type,`⚡ ${cb.title}\nIQ Media Downloader`,Boolean(user.notifications));
      const file=sent[mediaField(method)];if(!file?.file_id||!file.file_unique_id)throw new Error('MISSING_TELEGRAM_FILE_ID');
      const c:Cache={cache_key:j.cache_key!,source_url_hash:j.source_url_hash,platform:j.platform,format:j.format!,quality:j.quality!,send_method:method,telegram_file_id:file.file_id,telegram_file_unique_id:file.file_unique_id,mime_type:cb.mime_type,file_size:cb.file_size,hit_count:0,created_at:Date.now(),last_used_at:Date.now()};
      await this.repo.complete(j,c,false);await this.repo.audit('telegram_delivery_completed',j.user_id,id);
    }catch(e) {
      const uncertain=sendStarted && !(e instanceof TelegramError);
      await this.repo.fail(id,uncertain?'DELIVERY_UNCERTAIN':'TELEGRAM_DELIVERY_FAILED',this.p);
      await this.repo.audit(uncertain?'delivery_uncertain':'delivery_failed',j.user_id,id);
      // Telegram has no idempotency key. Never blindly retry a potentially successful media send.
      try{await this.notify(user,uncertain?'Delivery could not be confirmed. Check your chat before requesting again.':en.UNKNOWN);}catch{/* audit retained */}
    }finally {if(!cb.cache)try{await this.worker.post('/release',{job_id:id});}catch{/* automatic worker expiry */}}
  }
  async staleCache(j:Job) {
    await this.repo.run("UPDATE download_jobs SET status='processing',cache_hit=0,delivery_started=NULL,callback=NULL,dispatch_started=NULL,worker_job_id=NULL,updated_at=? WHERE id=? AND status='uploading' AND cache_hit=1",Date.now(),j.id);
    await this.repo.audit('stale_cache_fallback',j.user_id,j.id);await this.enqueue({type:'dispatch',id:j.id});
  }
  errorCode(e:unknown):string {return e instanceof WorkerError?e.code:e instanceof Error&&e.message in en?e.message:'MEDIA_UNAVAILABLE';}
  errorText(e:unknown):string {const key=this.errorCode(e) as keyof typeof en;return en[key]||en.UNKNOWN;}
  async history(user:User) {
    const jobs=await this.repo.all<Job>('SELECT * FROM download_jobs WHERE user_id=? AND hidden_history=0 ORDER BY created_at DESC LIMIT 10',user.id);
    await this.notify(user,jobs.length?'📜 My Downloads\n\n'+jobs.map(j=>`${j.platform} · ${j.quality||'—'} · ${j.status}${j.cache_hit?' · cached':''}\n${new Date(j.created_at).toISOString().slice(0,16).replace('T',' ')}`).join('\n\n'):'No downloads yet.',keyboard([[button('🗑 Clear History','history:clear')]]));
  }
  async settings(user:User,data='') {
    if(data.startsWith('setting:')) {
      const [,key,value]=data.split(':');
      if(key==='language')await this.notify(user,'English is currently available. More languages can be added.');
      const allowed:Record<string,string[]>={default_quality:['best','360p','720p','1080p'],send_mode:['media','document'],notifications:['0','1']};
      if(allowed[key]?.includes(value))await this.repo.run(`UPDATE bot_users SET ${key}=? WHERE id=?`,value,user.id);
      user=(await this.repo.getUser(user.id))!;
    }
    const qualities=['best','360p','720p','1080p'];const next=qualities[(qualities.indexOf(user.default_quality)+1)%qualities.length];
    await this.notify(user,'⚙️ Settings\nDefault quality highlights a matching available format; it never creates formats. Cached media keeps its original Telegram send type.',keyboard([
      [button('🌐 Language: English','setting:language:en')],
      [button(`🎬 Default Quality: ${user.default_quality}`,`setting:default_quality:${next}`)],
      [button(`📁 Send Mode: ${user.send_mode}`,`setting:send_mode:${user.send_mode==='media'?'document':'media'}`)],
      [button(`🔔 Notifications: ${user.notifications?'On':'Off'}`,`setting:notifications:${user.notifications?'0':'1'}`)]
    ]));
  }
  async admin(user:User,action:string) {
    // Defense in depth: every entry, including forged/stale admin buttons, re-checks current config.
    if(!this.isAdmin(user.id)){await this.notify(user,'Administrator access required.');return;}
    const [name,id]=action.split(':');
    if(name==='maintenance') {
      await this.notify(user,`Maintenance: ${await this.repo.settings('maintenance')==='true'?'ON':'OFF'}`,keyboard([[button('Enable','admin:maint_on'),button('Disable','admin:maint_off')]]));return;
    }
    if(name==='maint_on'||name==='maint_off') {await this.repo.setSetting('maintenance',name==='maint_on'?'true':'false');await this.repo.audit(name,user.id);await this.notify(user,'Maintenance updated.',adminMenu);return;}
    if(name==='worker') {try{const h=await this.worker.post<{status:string;yt_dlp:boolean;ffmpeg:boolean;temp_writable:boolean}>('/health',{});await this.notify(user,`Worker: ${h.status}\nyt-dlp: ${h.yt_dlp}\nFFmpeg: ${h.ffmpeg}\nTemporary storage: ${h.temp_writable}`);}catch{await this.notify(user,'Worker health check failed.');}return;}
    if(name==='settings'){await this.notify(user,`Requests/min: ${this.p.requestsPerMinute}\nActive jobs: ${this.p.globalJobs}\nMax bytes: ${this.p.maxFileSize}\nCooldown seconds: ${this.p.cooldown}\nEdit deployment environment variables to change system limits.`,adminMenu);return;}
    if(name==='block'){await this.notify(user,'Use /block TELEGRAM_USER_ID or /unblock TELEGRAM_USER_ID. Administrator IDs are protected.');return;}
    if(name==='broadcast') {
      const rows=await this.repo.all<{id:string;status:string;total_recipients:number;sent_count:number;failed_count:number;blocked_count:number;pending_count:number}>('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 5');
      await this.notify(user,'Create a draft with /broadcast Your message\n\n'+rows.map(b=>`${b.status} · total ${b.total_recipients} · sent ${b.sent_count} · failed ${b.failed_count} · blocked ${b.blocked_count} · pending ${b.pending_count}`).join('\n'),keyboard(rows.filter(b=>['draft','queued','sending'].includes(b.status)).map(b=>[button(`Cancel ${b.id.slice(0,8)}`,`admin:bc:${b.id}`)])));return;
    }
    if(name==='bq') {
      await this.repo.db.batch([
        this.repo.stmt("INSERT OR IGNORE INTO broadcast_recipients(broadcast_id,user_id,chat_id,updated_at) SELECT ?,id,chat_id,? FROM bot_users WHERE blocked=0 AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND status='draft')",id,Date.now(),id),
        this.repo.stmt("UPDATE broadcasts SET status='queued',total_recipients=(SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id=?),pending_count=(SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id=?),updated_at=? WHERE id=? AND status='draft'",id,id,Date.now(),id)
      ]);await this.repo.audit('broadcast_queued',user.id,null,id);await this.notify(user,'Broadcast queued.');return;
    }
    if(name==='bc') {await this.repo.run("UPDATE broadcasts SET status='cancelled',updated_at=? WHERE id=? AND status IN ('draft','queued','sending')",Date.now(),id);await this.repo.audit('broadcast_cancelled',user.id,null,id);await this.notify(user,'Broadcast cancelled. A message already in flight may finish.');return;}
    if(name==='dashboard') {
      const users=await this.repo.one<{n:number}>('SELECT COUNT(*) n FROM bot_users');const jobs=await this.repo.all<{status:string;n:number}>('SELECT status,COUNT(*) n FROM download_jobs GROUP BY status');
      await this.notify(user,`📊 IQ Dashboard\nUsers: ${users?.n||0}\n`+jobs.map(j=>`${j.status}: ${j.n}`).join('\n'),adminMenu);return;
    }
    if(name==='users') {const rows=await this.repo.all<User>('SELECT * FROM bot_users ORDER BY last_seen_at DESC LIMIT 15');await this.notify(user,rows.map(u=>`${u.id} · ${u.username||'no username'} · ${u.blocked?'blocked':'active'}`).join('\n')||'No users.');return;}
    if(name==='downloads'||name==='failed') {
      const rows=await this.repo.all<Job>(`SELECT * FROM download_jobs ${name==='failed'?"WHERE status IN ('failed','expired')":''} ORDER BY updated_at DESC LIMIT 15`);
      await this.notify(user,rows.map(j=>`${j.id.slice(0,8)} · ${j.platform} · ${j.status} · ${j.error_code||'—'}`).join('\n')||'No jobs.');return;
    }
    if(name==='audit'){const rows=await this.repo.all<{event:string;actor_id:string;created_at:number}>('SELECT event,actor_id,created_at FROM audit_logs ORDER BY id DESC LIMIT 20');await this.notify(user,rows.map(r=>`${new Date(r.created_at).toISOString()} · ${r.event} · ${r.actor_id||'system'}`).join('\n')||'No audit records.');return;}
    await this.notify(user,'IQ Administration',adminMenu);
  }
  async cleanup() {
    const stale=await this.repo.cleanup(this.p);
    for(const j of stale)try{await this.worker.post('/cancel',{job_id:j.id});}catch{/* worker TTL cleanup */}
    const updates=await this.repo.all<{update_id:number}>("SELECT update_id FROM telegram_updates WHERE status='queued' ORDER BY created_at LIMIT 50");
    for(const u of updates)await this.enqueue({type:'update',id:u.update_id});
    const jobs=await this.repo.all<Job>("SELECT * FROM download_jobs WHERE status IN ('queued','processing','uploading') ORDER BY created_at LIMIT 50");
    for(const j of jobs) {
      if(j.status==='queued')await this.enqueue({type:'metadata',id:j.id});
      if(j.status==='processing'&&!j.worker_job_id)await this.enqueue({type:'dispatch',id:j.id});
      if(j.status==='uploading'&&!j.delivery_started)await this.enqueue({type:'deliver',id:j.id});
    }
  }
}
