import type {MediaFormat,Metadata} from '../../shared/contracts.ts';
export type Button={text:string;callback_data:string};
export const keyboard=(rows:Button[][])=>({inline_keyboard:rows});
export const button=(text:string,data:string):Button=>({text,callback_data:data});
export const home=keyboard([[button('🔗 Download Media','menu:download'),button('📜 My Downloads','menu:history')],[button('❓ Help','menu:help'),button('⚙️ Settings','menu:settings')]]);
export const adminMenu=keyboard([
  [button('📊 Dashboard','admin:dashboard'),button('👥 Users','admin:users')],
  [button('📥 Downloads','admin:downloads'),button('⚠️ Failed Jobs','admin:failed')],
  [button('📡 Worker Status','admin:worker'),button('📣 Broadcast','admin:broadcast')],
  [button('🚫 Block User','admin:block'),button('🛠 Maintenance','admin:maintenance')],
  [button('⚙️ Settings','admin:settings'),button('📜 Audit Logs','admin:audit')]
]);
export function formatButtons(id:string,formats:MediaFormat[],quality='best') {
  const indexed=formats.map((f,i)=>({f,i}));
  indexed.sort((a,b)=>Number(b.f.quality===quality)-Number(a.f.quality===quality));
  return keyboard([...indexed.map(({f,i})=>[button(`${f.kind==='audio'?'🎵':'🎬'} ${f.quality}${f.ext?' · '+f.ext:''}`,`fmt:${id}:${i}`)]),[button('❌ Cancel',`cancel:${id}`)]]);
}
export function mediaText(platform:string,m:Metadata) {
  const duration=m.duration===null?'Unknown':`${Math.floor(m.duration/60).toString().padStart(2,'0')}:${Math.floor(m.duration%60).toString().padStart(2,'0')}`;
  return `🎬 Media Found\n\n${m.title}\nPlatform: ${platform}\nType: ${m.media_type}\nDuration: ${duration}\n\nChoose a format:`;
}
