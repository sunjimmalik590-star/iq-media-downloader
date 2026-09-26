// TEST ENTRYPOINT ONLY. Production entrypoint is cloudflare/src/index.ts.
import application from '../cloudflare/src/index.ts';
import {Telegram} from '../cloudflare/src/telegram.ts';
import type {Env,Context} from '../cloudflare/src/runtime.ts';
export default {
  ...application,
  async fetch(request:Request,env:Env,ctx:Context) {
    if(new URL(request.url).pathname==='/__test_stream') {
      let count=0,content='';
      const mockFetch:typeof fetch=async(_url,init)=>{
        const body=await new Response(init?.body).arrayBuffer();count=body.byteLength;content=new TextDecoder().decode(body);
        return Response.json({ok:true,result:{video:{file_id:'TEST_ONLY_ID',file_unique_id:'TEST_ONLY_UNIQUE'}}});
      };
      const client=new Telegram('TEST_ONLY',mockFetch);
      const result=await client.upload('sendVideo','1',new Response('data'),4,'video/mp4','Fixture',true);
      return Response.json({count,hasFile:content.includes('data'),hasMultipart:content.includes('name="video"'),id:result.video?.file_id,fixedLengthStream:typeof (globalThis as any).FixedLengthStream==='function'});
    }
    return application.fetch(request,env,ctx);
  }
};
