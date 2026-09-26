import type {Metadata,WorkerCallback} from '../../shared/contracts.ts';
import {ERROR_CODES} from '../../shared/contracts.ts';
import {signedHeaders,readBody} from './security.ts';
export class WorkerError extends Error {code:string;constructor(code:string){super(code);this.code=code;}}
export interface WorkerPort {post<T>(path:string,body:unknown):Promise<T>; file(url:string):Promise<Response>}
export class WorkerClient implements WorkerPort {
  base:string; secret:string;
  constructor(base:string,secret:string){this.base=base.replace(/\/$/,'');this.secret=secret;}
  async post<T>(path:string,payload:unknown):Promise<T> {
    const raw=JSON.stringify(payload);
    const res=await fetch(this.base+path,{method:'POST',headers:await signedHeaders(this.secret,raw),body:raw,redirect:'error',signal:AbortSignal.timeout(path==='/metadata'?95000:15000)});
    const data=JSON.parse(await readBody(new Request('https://response.invalid',{method:'POST',body:res.body,duplex:'half'} as RequestInit),262144));
    if(!res.ok) throw new WorkerError(ERROR_CODES.includes(data.error_code)?data.error_code:'MEDIA_UNAVAILABLE');
    return data as T;
  }
  file(url:string) {return fetch(url,{redirect:'error',signal:AbortSignal.timeout(180000)});}
}
export function validateMetadata(value:unknown):Metadata {
  const m=value as Metadata;
  if(!m || typeof m.title!=='string' || typeof m.artist!=='string' || !['video','audio'].includes(m.media_type) || (m.duration!==null && (!Number.isFinite(m.duration)||m.duration<0)) || !Array.isArray(m.formats) || !m.formats.length || m.formats.length>30) throw new WorkerError('FORMAT_UNAVAILABLE');
  const seen=new Set<string>();
  for(const f of m.formats) {
    if(typeof f.id!=='string'||!f.id||f.id.length>200||seen.has(f.id)||!['video','audio'].includes(f.kind)||typeof f.quality!=='string'||f.quality.length>60||!['mp4','webm','m4a','mp3','ogg','opus','wav','aac','mov','mkv','m4v'].includes(f.ext)||(f.filesize!==null&&(!Number.isSafeInteger(f.filesize)||f.filesize<=0)))throw new WorkerError('FORMAT_UNAVAILABLE');
    seen.add(f.id);
  }
  return {...m,title:m.title.slice(0,300),artist:m.artist.slice(0,200)};
}
const mimeTypes=new Set(['video/mp4','video/webm','video/quicktime','video/x-matroska','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/aac']);
export function validateCallback(value:unknown,workerOrigin:string,max:number):WorkerCallback {
  const c=value as WorkerCallback;
  if(!c || typeof c.job_id!=='string'||!/^[0-9a-f-]{36}$/.test(c.job_id))throw new Error('INVALID_CALLBACK');
  if(c.status==='failed') {if(!ERROR_CODES.includes(c.error_code))throw new Error('INVALID_CALLBACK');return {job_id:c.job_id,status:'failed',error_code:c.error_code};}
  if(c.status!=='completed'||!Number.isSafeInteger(c.file_size)||c.file_size<=0||c.file_size>max||!mimeTypes.has(c.mime_type)||typeof c.title!=='string'||typeof c.artist!=='string'||(c.duration!==null&&(!Number.isFinite(c.duration)||c.duration<0)))throw new Error('INVALID_CALLBACK');
  const u=new URL(c.file_url);
  if(u.protocol!=='https:'||u.origin!==new URL(workerOrigin).origin||u.username||u.password||u.search||u.hash||!new RegExp(`^/files/${c.job_id}/[A-Za-z0-9_-]{40,100}$`).test(u.pathname))throw new Error('INVALID_FILE_URL');
  return {...c,title:c.title.slice(0,300),artist:c.artist.slice(0,200)};
}
