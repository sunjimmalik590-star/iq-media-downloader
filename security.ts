const encoder = new TextEncoder();
export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
function hex(buffer: ArrayBuffer): string { return Array.from(new Uint8Array(buffer), n=>n.toString(16).padStart(2,'0')).join(''); }
export async function hmac(secret: string, timestamp: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(timestamp+'.'+raw)));
}
export async function verifyHmac(secret: string, headers: Headers, raw: string, now = Date.now()): Promise<boolean> {
  const ts = headers.get('X-IQ-Timestamp') || '', sig = headers.get('X-IQ-Signature') || '';
  if (!/^\d{10}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig) || Math.abs(Math.floor(now/1000)-Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes = Uint8Array.from(sig.match(/../g)!, s=>parseInt(s,16));
  // WebCrypto performs constant-time MAC verification.
  return crypto.subtle.verify('HMAC',key,bytes,encoder.encode(ts+'.'+raw));
}
export async function secureEqual(a: string,b: string): Promise<boolean> {
  // HMAC verify avoids JS string comparison for webhook secrets too.
  const salt = 'iq-webhook-comparison';
  const sig = await hmac(salt,'0',a);
  const key = await crypto.subtle.importKey('raw',encoder.encode(salt),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  return crypto.subtle.verify('HMAC',key,Uint8Array.from(sig.match(/../g)!,s=>parseInt(s,16)),encoder.encode('0.'+b));
}
export async function signedHeaders(secret: string, raw: string): Promise<Record<string,string>> {
  const ts = String(Math.floor(Date.now()/1000));
  return {'Content-Type':'application/json','X-IQ-Timestamp':ts,'X-IQ-Signature':await hmac(secret,ts,raw)};
}
export async function readBody(request: Request, max = 131072): Promise<string> {
  if (Number(request.headers.get('content-length') || 0)>max) throw new Error('BODY_TOO_LARGE');
  const reader=request.body?.getReader(); if(!reader) return '';
  const chunks: Uint8Array[]=[]; let size=0;
  while(true) {const {value,done}=await reader.read(); if(done) break; size+=value.byteLength; if(size>max){await reader.cancel();throw new Error('BODY_TOO_LARGE');} chunks.push(value);}
  const all=new Uint8Array(size);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.length;}
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(all);
}
