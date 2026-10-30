import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

test('local HTTP panel: configuration persistence, static UI, origin guard and export',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'persona-http-'));
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port),PERSONA_DATA_DIR:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const url=`http://127.0.0.1:${port}`;let output='';server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
  try {
    let ready=false;
    for(let i=0;i<100;i++){try{const r=await fetch(url+'/api/state');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
    assert.ok(ready,output);
    const state=await (await fetch(url+'/api/state')).json();assert.equal(state.counts.read,0);
    const page=await fetch(url);assert.ok((await page.text()).includes('Авторы и память'));assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.equal((await fetch(url+'/app.js')).status,200);assert.equal((await fetch(url+'/style.css')).status,200);
    assert.equal((await fetch(url+'/api/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(url+'/api/stop',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Request':'1',Origin:'https://evil.test'},body:'{}'})).status,403);
    const headers={'Content-Type':'application/json','X-Local-Request':'1'};
    assert.equal((await fetch(url+'/api/config',{method:'POST',headers,body:'{}'})).status,400);
    state.config.persona.name='Проверка';const save=await fetch(url+'/api/config',{method:'POST',headers,body:JSON.stringify(state.config)});assert.equal(save.status,200);
    const saved=await (await fetch(url+'/api/state')).json();assert.equal(saved.config.persona.name,'Проверка');
    const start=await fetch(url+'/api/start',{method:'POST',headers,body:JSON.stringify({mode:'live',once:true})});assert.equal(start.status,500);assert.match((await start.json()).error,/аккаунт/);
    const exported=await (await fetch(url+'/api/export')).json();assert.equal(exported.version,1);assert.equal(exported.dataset,'demo');assert.ok(Array.isArray(exported.memories));
    assert.equal((await fetch(url+'/api/authors/nobody')).status,404);
    assert.equal((await fetch(url+'/api/demo/reset',{method:'POST',headers,body:'{}'})).status,200);
    const codeResponse=await fetch(url+'/api/browser/pair-code',{method:'POST',headers,body:'{}'});
    assert.equal(codeResponse.status,200);
    const code=(await codeResponse.json()).code;
    const extensionId='a'.repeat(32),origin='chrome-extension://'+extensionId;
    const bridgeHeaders={'Content-Type':'application/json','X-Persona-Bridge':'1','X-Extension-Id':extensionId,Origin:origin};
    assert.equal((await fetch(url+'/bridge/pair',{method:'POST',headers:{...bridgeHeaders,Origin:'https://evil.test'},body:JSON.stringify({code})})).status,403);
    assert.equal((await fetch(url+'/bridge/pair',{method:'POST',headers:bridgeHeaders,body:JSON.stringify({code})})).status,409);
    const pair=await fetch(url+'/bridge/pair',{method:'POST',headers:bridgeHeaders,body:JSON.stringify({code,version:3})});assert.equal(pair.status,200);
    const token=(await pair.json()).token;
    assert.equal((await fetch(url+'/bridge/lease',{method:'POST',headers:{...bridgeHeaders,Authorization:'Bearer wrong'},body:'{}'})).status,401);
    const lease=await fetch(url+'/bridge/lease',{method:'POST',headers:{...bridgeHeaders,Authorization:'Bearer '+token},body:'{}'});
    assert.equal(lease.status,200);assert.equal((await lease.json()).valid,false);
    const disconnect=await fetch(url+'/bridge/disconnect',{method:'POST',headers:{...bridgeHeaders,Authorization:'Bearer '+token},body:'{}'});assert.equal(disconnect.status,200);
  } finally {
    const closed=once(server,'exit');server.kill();await closed;rmSync(dir,{recursive:true,force:true});
  }
});
