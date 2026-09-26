// TEST ONLY: Telegram and worker doubles are never imported by production code.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Repository} from '../cloudflare/src/repository.ts';
import {BotService} from '../cloudflare/src/service.ts';
import type {Env,SqlDatabase,SqlResult,SqlStatement} from '../cloudflare/src/runtime.ts';
import type {QueueWork} from '../shared/contracts.ts';
export const metadataFixture={title:'TEST FIXTURE',artist:'Fixture artist',duration:32,media_type:'video',formats:[{id:'123456789012345678901234',kind:'video',quality:'720p',ext:'mp4',filesize:4},{id:'223456789012345678901234',kind:'audio',quality:'Audio',ext:'mp3',filesize:4}]};
export class SQLiteAdapter implements SqlDatabase {
  connection:DatabaseSync;
  constructor(path=':memory:'){this.connection=new DatabaseSync(path);this.connection.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql',import.meta.url),'utf8'));}
  prepare(sql:string):SqlStatement {
    const db=this.connection;let args:unknown[]=[];
    const statement:SqlStatement={bind(...values){args=values;return statement;},async first<T>(){return (db.prepare(sql).get(...args as any[]) as T)||null;},async all<T>(){return {results:db.prepare(sql).all(...args as any[]) as T[],meta:{changes:0}};},async run(){const r=db.prepare(sql).run(...args as any[]);return {results:[],meta:{changes:Number(r.changes)}};}};return statement;
  }
  async batch(statements:SqlStatement[]):Promise<SqlResult[]> {this.connection.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());this.connection.exec('COMMIT');return r;}catch(e){this.connection.exec('ROLLBACK');throw e;}}
}
export function harness() {
  const db=new SQLiteAdapter(),queue:QueueWork[]=[],calls:{method:string;payload:any}[]=[],workerCalls:{path:string;body:any}[]=[];
  const env:Env={DB:db,EVENTS:{async send(body){queue.push(body as QueueWork);}},TELEGRAM_BOT_TOKEN:'TEST_ONLY_TOKEN',TELEGRAM_WEBHOOK_SECRET:'test_webhook_secret_12345',DOWNLOAD_WORKER_URL:'https://worker.example.com',DOWNLOAD_WORKER_SECRET:'TEST_ONLY_'+'x'.repeat(40),APP_BASE_URL:'https://bot.example.com',ADMIN_TELEGRAM_IDS:'42'};
  const tg={async call(method:string,payload:any){calls.push({method,payload});return {message_id:1,username:'iqTLbot'};},async text(chat:string,text:string,markup?:unknown){calls.push({method:'sendMessage',payload:{chat,text,markup}});return {message_id:1};},async upload(method:any,chat:string,source:Response,size:number,mime:string){const data=await source.arrayBuffer();if(data.byteLength!==size)throw new Error('size');calls.push({method,payload:{chat,size,mime}});const field=method==='sendVideo'?'video':method==='sendAudio'?'audio':'document';return {[field]:{file_id:'TEST_FILE_ID',file_unique_id:'TEST_UNIQUE_ID'}};}};
  const worker={async post<T>(path:string,body:any):Promise<T>{workerCalls.push({path,body});return (path==='/metadata'?structuredClone(metadataFixture):path==='/download'?{worker_job_id:body.job_id}:path==='/health'?{status:'ok',yt_dlp:true,ffmpeg:true,temp_writable:true}:{ok:true}) as T;},async file(){return new Response(new Uint8Array([1,2,3,4]),{headers:{'content-length':'4','content-type':'video/mp4'}});}};
  const repo=new Repository(db),service=new BotService(env,{repo,tg,worker});
  async function drain(){let n=0;while(queue.length){if(++n>100)throw new Error('queue loop');const w=queue.shift()!;if(w.type==='update')await service.processUpdate(w.id);else if(w.type==='metadata')await service.metadata(w.id);else if(w.type==='dispatch')await service.dispatch(w.id);else await service.deliver(w.id);}}
  return {db,env,repo,service,queue,calls,workerCalls,tg,worker,drain};
}
export function update(id:number,text:string,user=1){return {update_id:id,message:{message_id:id,from:{id:user},chat:{id:user,type:'private'},text}};}
export async function selected(h:ReturnType<typeof harness>) {
  const u=await h.repo.user('1','1');await h.service.newRequest(u,'https://youtube.com/watch?v=fixture');await h.drain();
  const job=(await h.repo.all<any>('SELECT * FROM download_jobs'))[0];
  await h.service.callback(u,`fmt:${job.id}:0`);await h.drain();return (await h.repo.job(job.id))!;
}
export function success(id:string){return {job_id:id,status:'completed' as const,file_url:`https://worker.example.com/files/${id}/${'a'.repeat(43)}`,mime_type:'video/mp4',file_size:4,title:'TEST FIXTURE',artist:'',duration:32};}
