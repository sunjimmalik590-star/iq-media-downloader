import type {Platform,TelegramMessage} from '../../shared/contracts.ts';
const providers: [Platform,string[]][] = [
  ['TikTok',['tiktok.com']],['Instagram',['instagram.com']],['Facebook',['facebook.com','fb.watch','fb.com']],
  ['YouTube',['youtube.com','youtu.be']],['X / Twitter',['x.com','twitter.com','t.co']],
  ['Reddit',['reddit.com','redd.it']],['Pinterest',['pinterest.com','pin.it']]
];
export function normalizeUrl(input: string): string {
  if(input.length>4096 || /[\u0000-\u0020\u007f\\]/.test(input)) throw new Error('BLOCKED_URL');
  let u: URL; try{u=new URL(input);}catch{throw new Error('UNSUPPORTED_LINK');}
  const host=u.hostname.toLowerCase().replace(/\.$/,'');
  if(!['http:','https:'].includes(u.protocol) || u.username || u.password || (u.port && u.port !== (u.protocol==='https:'?'443':'80')) || host==='localhost' || !host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost') || host.includes(':') || /^\d+(\.\d+){3}$/.test(host) || host==='metadata.google.internal' || host==='metadata.azure.internal') throw new Error('BLOCKED_URL');
  u.hostname=host;u.hash='';
  // Preserve query order and signed query parameters; remove known tracking only on named platforms.
  if(providers.some(([,domains])=>domains.some(d=>host===d || host.endsWith('.'+d)))) {
    for(const key of [...u.searchParams.keys()]) if(/^utm_/i.test(key)||['fbclid','gclid','igshid','si','feature'].includes(key)) u.searchParams.delete(key);
  }
  return u.toString();
}
export function detectPlatform(url: string): Platform {
  const u=new URL(url);
  for(const [p,domains] of providers) if(domains.some(d=>u.hostname===d || u.hostname.endsWith('.'+d))) return p;
  if(/\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|opus|wav)$/i.test(u.pathname)) return 'Direct';
  throw new Error('UNSUPPORTED_LINK');
}
export function extractUrls(message: TelegramMessage): string[] {
  const text=message.text ?? message.caption ?? '';
  const entities=message.entities ?? message.caption_entities ?? [];
  const result=entities.flatMap(e=>e.type==='text_link' && e.url ? [e.url] : e.type==='url' ? [text.slice(e.offset,e.offset+e.length)] : []);
  result.push(...(text.match(/https?:\/\/[^\s<>]+/gi)||[]).map(s=>s.replace(/[),.!?;]+$/,'')));
  return [...new Set(result)];
}
