import {BotService} from './service.ts';
import {TelegramError} from './telegram.ts';
export async function broadcastTick(service:BotService,sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))) {
  const {repo,tg,p}=service;
  if(!await repo.lease('broadcast',90000))return;
  // A worker crash after a send is ambiguous; mark the recipient failed instead of resending.
  await repo.run("UPDATE broadcast_recipients SET status='failed',updated_at=? WHERE status='sending' AND updated_at<?",Date.now(),Date.now()-120000);
  const broadcasts=await repo.all<{id:string;text:string}>("SELECT id,text FROM broadcasts WHERE status IN ('queued','sending') ORDER BY created_at LIMIT 1");
  const b=broadcasts[0];if(!b)return;
  await repo.run("UPDATE broadcasts SET status='sending',updated_at=? WHERE id=? AND status='queued'",Date.now(),b.id);
  const recipients=await repo.all<{user_id:string;chat_id:string;attempts:number}>("SELECT user_id,chat_id,attempts FROM broadcast_recipients WHERE broadcast_id=? AND status='pending' AND next_at<=? LIMIT ?",b.id,Date.now(),p.broadcastBatch);
  for(const r of recipients) {
    if(!await repo.run("UPDATE broadcast_recipients SET status='sending',attempts=attempts+1,updated_at=? WHERE broadcast_id=? AND user_id=? AND status='pending' AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND status='sending')",Date.now(),b.id,r.user_id,b.id))continue;
    let status='sent',next=0;
    try {
      const user=await repo.getUser(r.user_id);
      if(user?.blocked)status='blocked';else await tg.text(r.chat_id,b.text);
    }catch(e) {
      status=e instanceof TelegramError&&e.code===403?'blocked':'failed';
      if(e instanceof TelegramError&&e.code===429&&r.attempts<5){status='pending';next=Date.now()+Math.max(1,e.retryAfter)*1000;}
      if(status==='blocked')await repo.run('UPDATE bot_users SET blocked=1 WHERE id=?',r.user_id);
    }
    await repo.run('UPDATE broadcast_recipients SET status=?,next_at=?,updated_at=? WHERE broadcast_id=? AND user_id=?',status,next,Date.now(),b.id,r.user_id);
    if(status==='pending')break;
    await sleep(1100); // Conservative free broadcast pace; never enables paid broadcasts.
  }
  await repo.run(`UPDATE broadcasts SET
    sent_count=(SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id=? AND status='sent'),
    failed_count=(SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id=? AND status='failed'),
    blocked_count=(SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id=? AND status='blocked'),
    pending_count=(SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id=? AND status IN ('pending','sending')),updated_at=? WHERE id=?`,b.id,b.id,b.id,b.id,Date.now(),b.id);
  await repo.run("UPDATE broadcasts SET status='completed' WHERE id=? AND status='sending' AND pending_count=0",b.id);
}
