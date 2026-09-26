// Real local workerd + D1 smoke tests; no Telegram network request is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('real workerd: database migration, authenticated webhook, dedupe, signed callback, streaming',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'iq-workerd-'));
  const file=join(dir,'worker.mjs');
  await build({entryPoints:['tests/runtime-worker.ts'],outfile:file,bundle:true,format:'esm',platform:'neutral',target:'es2022'});
  const bindings={TELEGRAM_BOT_TOKEN:'TEST_ONLY_INVALID_TOKEN',TELEGRAM_WEBHOOK_SECRET:'test_webhook_secret_12345',DOWNLOAD_WORKER_SECRET:'TEST_ONLY_'+'x'.repeat(40),APP_BASE_URL:'https://bot.example.com',DOWNLOAD_WORKER_URL:'https://worker.example.com',ADMIN_TELEGRAM_IDS:''};
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'iq-test-only',modules:true,script:await readFile(file,'utf8'),compatibilityDate:'2026-09-26',bindings,d1Databases:{DB:'iq-test-db'},queueProducers:{EVENTS:'iq-test-events'}}],host:'127.0.0.1',port:0}));
  try {
    const db=await mf.getD1Database('DB');
    const statements=JSON.parse(execFileSync('python3',['-c',String.raw`import sqlite3,json
from pathlib import Path
statements=[]; current=''
for line in Path('cloudflare/migrations/0001_initial.sql').read_text().splitlines():
 current+=line+'\n'
 if sqlite3.complete_statement(current): statements.append(current); current=''
print(json.dumps(statements))`],{encoding:'utf8'}));
    for(const statement of statements)await db.prepare(statement).run();
    await t.test('real D1 migration creates domain tables',async()=>{const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();assert(rows.results.some(r=>r.name==='media_cache'));});
    await t.test('webhook invalid secret returns 403',async()=>{const response=await mf.dispatchFetch('https://bot.example.com/telegramWebhook',{method:'POST',body:'{"update_id":99}'});assert.equal(response.status,403);});
    await t.test('valid duplicate update writes exactly one inbox row',async()=>{for(let i=0;i<2;i++){const response=await mf.dispatchFetch('https://bot.example.com/telegramWebhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':bindings.TELEGRAM_WEBHOOK_SECRET},body:'{"update_id":99}'});assert.equal(response.status,200);}const row=await db.prepare('SELECT COUNT(*) n FROM telegram_updates WHERE update_id=99').first();assert.equal(row.n,1);});
    await t.test('signed unknown callback safely returns success without job mutation',async()=>{const body='{"job_id":"00000000-0000-0000-0000-000000000010","status":"failed","error_code":"MEDIA_UNAVAILABLE"}';const ts=String(Math.floor(Date.now()/1000));const sig=createHmac('sha256',bindings.DOWNLOAD_WORKER_SECRET).update(ts+'.'+body).digest('hex');const response=await mf.dispatchFetch('https://bot.example.com/workerCallback',{method:'POST',body,headers:{'X-IQ-Timestamp':ts,'X-IQ-Signature':sig}});assert.equal(response.status,200);const row=await db.prepare('SELECT COUNT(*) n FROM download_jobs').first();assert.equal(row.n,0);});
    await t.test('FixedLengthStream multipart works inside workerd (MOCK Telegram HTTP)',async()=>{const response=await mf.dispatchFetch('https://bot.example.com/__test_stream');assert.equal(response.status,200);const result=await response.json();assert.equal(result.fixedLengthStream,true);assert.equal(result.hasFile,true);assert.equal(result.hasMultipart,true);assert.equal(result.id,'TEST_ONLY_ID');});
  } finally {await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
