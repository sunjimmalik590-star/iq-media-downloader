import type {JobState,Metadata,MediaFormat,SendMethod,WorkerCallback} from '../../shared/contracts.ts';
import type {SqlDatabase,SqlStatement} from './runtime.ts';
import type {config} from './config.ts';
export type Policy = ReturnType<typeof config>;
export interface User {id: string; chat_id: string; username: string|null; language: string; default_quality: string; send_mode: 'media'|'document'; notifications: number; blocked: number; cooldown_until: number}
export interface Job {id: string; user_id: string; chat_id: string; normalized_url: string; source_url_hash: string; platform: string; status: JobState; metadata: string|null; format: string|null; quality: string|null; format_id: string|null; cache_key: string|null; cache_hit: number; worker_job_id: string|null; dispatch_started: number|null; dispatch_attempts: number; callback: string|null; delivery_started: number|null; send_method: SendMethod|null; telegram_file_id: string|null; telegram_file_unique_id: string|null; created_at: number; updated_at: number; expires_at: number; error_code: string|null}
export interface Cache {cache_key: string; source_url_hash: string; platform: string; format: string; quality: string; send_method: SendMethod; telegram_file_id: string; telegram_file_unique_id: string; mime_type: string; file_size: number; hit_count: number; created_at: number; last_used_at: number}
export class Repository {
  db: SqlDatabase;
  constructor(db: SqlDatabase) {this.db=db;}
  stmt(sql: string,...args: unknown[]): SqlStatement {return this.db.prepare(sql).bind(...args);}
  async run(sql: string,...args: unknown[]): Promise<number> {return (await this.stmt(sql,...args).run()).meta.changes;}
  async one<T>(sql: string,...args: unknown[]): Promise<T|null> {return this.stmt(sql,...args).first<T>();}
  async all<T>(sql: string,...args: unknown[]): Promise<T[]> {return (await this.stmt(sql,...args).all<T>()).results;}
  async audit(event: string,actor: string|null=null,job: string|null=null,detail: string|null=null,now=Date.now()) {await this.run('INSERT INTO audit_logs(actor_id,event,job_id,detail,created_at) VALUES (?,?,?,?,?)',actor,event,job,detail,now);}
  async user(id: string,chat: string,username: string|null=null,now=Date.now()): Promise<User> {
    await this.run('INSERT INTO bot_users(id,chat_id,username,created_at,last_seen_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id,username=excluded.username,last_seen_at=excluded.last_seen_at',id,chat,username,now,now);
    return (await this.one<User>('SELECT * FROM bot_users WHERE id=?',id))!;
  }
  getUser(id: string) {return this.one<User>('SELECT * FROM bot_users WHERE id=?',id);}
  async settings(key: string) {return (await this.one<{value:string}>('SELECT value FROM bot_settings WHERE key=?',key))?.value;}
  async setSetting(key: string,value: string) {await this.run('INSERT INTO bot_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,value);}
  async ingest(id: number,body: string,now=Date.now()) {return Boolean(await this.run('INSERT OR IGNORE INTO telegram_updates(update_id,body,created_at,updated_at) VALUES (?,?,?,?)',id,body,now,now));}
  async claimUpdate(id: number,now=Date.now()) {
    if(!await this.run("UPDATE telegram_updates SET status='processing',updated_at=? WHERE update_id=? AND status='queued'",now,id)) return null;
    return this.one<{body:string}>('SELECT body FROM telegram_updates WHERE update_id=?',id);
  }
  async finishUpdate(id: number,status='done') {await this.run('UPDATE telegram_updates SET status=?,updated_at=? WHERE update_id=?',status,Date.now(),id);}
  job(id: string) {return this.one<Job>('SELECT * FROM download_jobs WHERE id=?',id);}
  async createJob(input: {id:string; user:User; url:string; hash:string; platform:string},p:Policy,now=Date.now()): Promise<string|null> {
    const {id,user,url,hash,platform}=input;
    // One serialized SQL write enforces rate/cooldown/capacity and active-link uniqueness under races.
    const n=await this.run(`INSERT OR IGNORE INTO download_jobs(id,user_id,chat_id,normalized_url,source_url_hash,platform,status,created_at,updated_at,expires_at)
      SELECT ?,?,?,?,?,?,'queued',?,?,? WHERE
      EXISTS(SELECT 1 FROM bot_users WHERE id=? AND blocked=0 AND cooldown_until<=?) AND
      (SELECT COUNT(*) FROM download_jobs WHERE user_id=? AND created_at>?)<? AND
      (SELECT COUNT(*) FROM download_jobs WHERE status IN ('queued','awaiting_format','processing','uploading'))<?`,
      id,user.id,user.chat_id,url,hash,platform,now,now,now+p.jobTtl*1000,user.id,now,user.id,now-60000,p.requestsPerMinute,p.globalJobs);
    if(n) return null;
    if(await this.one('SELECT id FROM download_jobs WHERE user_id=? AND source_url_hash=? AND status IN (\'queued\',\'awaiting_format\',\'processing\',\'uploading\')',user.id,hash)) return 'This link already has an active request.';
    const latest=await this.getUser(user.id);
    if(latest?.cooldown_until && latest.cooldown_until>now) return 'Please wait for the cooldown to finish.';
    return 'Request limit reached or all download slots are busy. Please try again later.';
  }
  async setMetadata(id:string,metadata:Metadata,now=Date.now()) {return Boolean(await this.run("UPDATE download_jobs SET status='awaiting_format',metadata=?,updated_at=? WHERE id=? AND status='queued'",JSON.stringify(metadata),now,id));}
  async choose(id:string,user:string,f:MediaFormat,key:string,now=Date.now()) {return Boolean(await this.run("UPDATE download_jobs SET status='processing',format=?,quality=?,format_id=?,cache_key=?,updated_at=? WHERE id=? AND user_id=? AND status='awaiting_format'",f.kind,f.quality,f.id,key,now,id,user));}
  async cancel(id:string,user:string,now=Date.now()) {return Boolean(await this.run("UPDATE download_jobs SET status='cancelled',updated_at=? WHERE id=? AND user_id=? AND status IN ('queued','awaiting_format','processing')",now,id,user));}
  async fail(id:string,code:string,p:Policy,now=Date.now()) {
    const row=await this.job(id); if(!row) return;
    if(await this.run("UPDATE download_jobs SET status='failed',error_code=?,updated_at=? WHERE id=? AND status IN ('queued','awaiting_format','processing','uploading')",code,now,id)) {
      await this.run(`UPDATE bot_users SET cooldown_until=? WHERE id=? AND
        (SELECT COUNT(*) FROM download_jobs WHERE user_id=? AND status='failed' AND updated_at>?)>=?`,now+p.cooldown*1000,row.user_id,row.user_id,now-p.failureWindow*1000,p.failureThreshold);
      await this.audit('job_failed',row.user_id,id,code,now);
    }
  }
  async acceptCallback(cb:WorkerCallback,now=Date.now()) {
    return Boolean(await this.run("UPDATE download_jobs SET status='uploading',callback=?,updated_at=? WHERE id=? AND status='processing'",JSON.stringify(cb),now,cb.job_id));
  }
  async claimDelivery(id:string,now=Date.now()) {return Boolean(await this.run("UPDATE download_jobs SET delivery_started=?,updated_at=? WHERE id=? AND status='uploading' AND delivery_started IS NULL",now,now,id));}
  async claimDispatch(id:string,now=Date.now()) {return Boolean(await this.run("UPDATE download_jobs SET dispatch_started=?,dispatch_attempts=dispatch_attempts+1 WHERE id=? AND status='processing' AND worker_job_id IS NULL AND (dispatch_started IS NULL OR dispatch_started<?) AND dispatch_attempts<5",now,id,now-120000));}
  cache(key:string) {return this.one<Cache>('SELECT * FROM media_cache WHERE cache_key=?',key);}
  cachedFor(hash:string) {return this.all<Cache>('SELECT * FROM media_cache WHERE source_url_hash=? ORDER BY last_used_at DESC LIMIT 20',hash);}
  async removeCache(key:string) {await this.run('DELETE FROM media_cache WHERE cache_key=?',key);}
  async complete(job:Job,cache:Cache,cacheHit:boolean,now=Date.now()) {
    // Atomic cache+ledger commit in D1's transactional batch. No network calls inside this transaction.
    await this.db.batch([
      this.stmt(`INSERT INTO media_cache(cache_key,source_url_hash,platform,format,quality,send_method,telegram_file_id,telegram_file_unique_id,mime_type,file_size,hit_count,created_at,last_used_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET send_method=excluded.send_method,telegram_file_id=excluded.telegram_file_id,telegram_file_unique_id=excluded.telegram_file_unique_id,mime_type=excluded.mime_type,file_size=excluded.file_size,hit_count=media_cache.hit_count+?,last_used_at=excluded.last_used_at`,cache.cache_key,cache.source_url_hash,cache.platform,cache.format,cache.quality,cache.send_method,cache.telegram_file_id,cache.telegram_file_unique_id,cache.mime_type,cache.file_size,cacheHit?1:0,now,now,cacheHit?1:0),
      this.stmt("UPDATE download_jobs SET status='completed',send_method=?,telegram_file_id=?,telegram_file_unique_id=?,cache_hit=?,updated_at=? WHERE id=? AND status='uploading'",cache.send_method,cache.telegram_file_id,cache.telegram_file_unique_id,cacheHit?1:0,now,job.id)
    ]);
  }
  async clearHistory(user:string) {await this.run('UPDATE download_jobs SET hidden_history=1 WHERE user_id=?',user);}
  async lease(name:string,duration:number,now=Date.now()) {return Boolean(await this.run('INSERT INTO leases(name,until_at) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET until_at=excluded.until_at WHERE leases.until_at<?',name,now+duration,now));}
  async cleanup(p:Policy,now=Date.now()) {
    const stale=await this.all<Job>("SELECT * FROM download_jobs WHERE (expires_at<? AND status IN ('queued','awaiting_format','processing')) OR (status='uploading' AND updated_at<?)",now,now-15*60000);
    for(const j of stale) {
      await this.run("UPDATE download_jobs SET status='expired',error_code=?,updated_at=? WHERE id=? AND status IN ('queued','awaiting_format','processing','uploading')",j.delivery_started?'DELIVERY_UNCERTAIN':'DOWNLOAD_TIMEOUT',now,j.id);
      await this.audit(j.delivery_started?'delivery_uncertain':'job_expired',j.user_id,j.id,null,now);
    }
    await this.run("UPDATE telegram_updates SET status='failed',updated_at=? WHERE status='processing' AND updated_at<?",now,now-10*60000);
    await this.run("DELETE FROM telegram_updates WHERE created_at<? AND status IN ('done','failed')",now-p.updateTtl*1000);
    return stale;
  }
}
