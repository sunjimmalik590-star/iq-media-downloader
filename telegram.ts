import type {SendMethod} from '../../shared/contracts.ts';
import type {FixedLengthStreamType} from './runtime.ts';
export class TelegramError extends Error {
  code: number; retryAfter: number; staleFileId: boolean;
  constructor(code:number,description:string,retryAfter=0) {
    super('TELEGRAM_REQUEST_FAILED'); this.code=code;this.retryAfter=retryAfter;
    this.staleFileId=code===400 && /wrong file identifier|file_id|file identifier|file reference.*expired/i.test(description);
  }
}
export type TelegramResult = {message_id?:number; username?:string; video?:TelegramFile; audio?:TelegramFile; document?:TelegramFile};
export interface TelegramFile {file_id:string; file_unique_id:string; file_size?:number; mime_type?:string}
export interface TelegramPort {
  call(method:string,payload:Record<string,unknown>):Promise<TelegramResult>;
  text(chat:string,text:string,markup?:unknown):Promise<TelegramResult>;
  upload(method:SendMethod,chat:string,source:Response,size:number,mime:string,caption:string,notifications:boolean):Promise<TelegramResult>;
}
export class Telegram implements TelegramPort {
  token:string; fetcher:typeof fetch;
  constructor(token:string,fetcher:typeof fetch=fetch){this.token=token;this.fetcher=fetcher;}
  private async result(response:Response):Promise<TelegramResult> {
    const body=await response.json() as {ok:boolean; result:TelegramResult; error_code?:number; description?:string; parameters?:{retry_after?:number}};
    if(!body.ok) throw new TelegramError(body.error_code||response.status,body.description||'',body.parameters?.retry_after||0);
    return body.result;
  }
  async call(method:string,payload:Record<string,unknown>):Promise<TelegramResult> {
    const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
    return this.result(response);
  }
  text(chat:string,text:string,markup?:unknown) {return this.call('sendMessage',{chat_id:chat,text:text.slice(0,4096),...(markup?{reply_markup:markup}:{})});}
  async upload(method:SendMethod,chat:string,source:Response,size:number,mime:string,caption:string,notifications:boolean):Promise<TelegramResult> {
    if(!source.body) throw new Error('EMPTY_MEDIA');
    const boundary='iq'+crypto.randomUUID().replaceAll('-','');
    const name=method==='sendVideo'?'video':method==='sendAudio'?'audio':'document';
    const fields:Record<string,string>={chat_id:chat,caption:caption.slice(0,900),disable_notification:String(!notifications)};
    if(method==='sendVideo') fields.supports_streaming='true';
    const ext:Record<string,string>={'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','video/x-matroska':'mkv','audio/mpeg':'mp3','audio/mp4':'m4a','audio/ogg':'ogg','audio/wav':'wav','audio/aac':'aac'};
    const enc=new TextEncoder();
    const head=enc.encode(Object.entries(fields).map(([k,v])=>`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')+`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="media.${ext[mime]||'bin'}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const tail=enc.encode(`\r\n--${boundary}--\r\n`);
    const reader=source.body.getReader();let stage=0,count=0;
    const stream=new ReadableStream<Uint8Array>({
      async pull(controller){
        try {
          if(stage===0){stage=1;controller.enqueue(head);return;}
          const {value,done}=await reader.read();
          if(!done){count+=value.byteLength;if(count>size)throw new Error('MEDIA_SIZE_MISMATCH');controller.enqueue(value);return;}
          if(count!==size)throw new Error('MEDIA_SIZE_MISMATCH');controller.enqueue(tail);controller.close();
        }catch(e){await reader.cancel();controller.error(e);}
      },cancel(reason){return reader.cancel(reason);}
    });
    // FixedLengthStream sets Content-Length in Workers without buffering the file.
    const Fixed=(globalThis as unknown as {FixedLengthStream?:FixedLengthStreamType}).FixedLengthStream;
    let body:ReadableStream<Uint8Array>=stream, pump:Promise<void>|undefined;
    if(Fixed){const fixed=new Fixed(head.length+size+tail.length);body=fixed.readable;pump=stream.pipeTo(fixed.writable);pump.catch(()=>{});}
    try {
      const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},body,signal:AbortSignal.timeout(180000),duplex:'half'} as RequestInit);
      const result=await this.result(response);if(pump)await pump;return result;
    } finally {reader.releaseLock();}
  }
}
export const mediaField=(method:SendMethod)=>method==='sendVideo'?'video':method==='sendAudio'?'audio':'document';
