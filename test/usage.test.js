import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Ollama } from '../src/model.js';
import { Store } from '../src/store.js';

test('Ollama usage records successful and rejected responses and survives restart',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'persona-usage-'));
  const file=path.join(dir,'memory.sqlite');
  const originalFetch=globalThis.fetch;
  let store=new Store(file);
  const model=new Ollama(()=>({model:{url:'http://127.0.0.1:11434',name:'test-model',context:4096,timeoutSeconds:30},persona:{}}),row=>store.recordModelUsage(row));
  const schema=z.object({answer:z.string()});
  try {
    let response={message:{content:'{"answer":"ok"}'},prompt_eval_count:100,eval_count:20,total_duration:2_000_000_000,load_duration:100_000_000,prompt_eval_duration:400_000_000,eval_duration:1_000_000_000};
    globalThis.fetch=async()=>new Response(JSON.stringify(response),{status:200,headers:{'Content-Type':'application/json'}});
    assert.deepEqual(await model.json('task',{},schema,undefined,false,{stage:'preview'}),{answer:'ok'});
    response={...response,message:{content:'not json'},prompt_eval_count:75,eval_count:12};
    await assert.rejects(model.json('task',{},schema,undefined,false,{stage:'read'}),/вне схемы/);
    globalThis.fetch=async()=>new Response('server error',{status:503});
    await assert.rejects(model.json('task',{},schema,undefined,false,{stage:'reply'}),/HTTP 503/);
    const usage=store.modelUsage();
    assert.deepEqual({requests:usage.total.requests,successes:usage.total.successes,failures:usage.total.failures,prompt:usage.total.promptTokens,answer:usage.total.answerTokens,unmetered:usage.total.unmetered},
      {requests:3,successes:1,failures:2,prompt:175,answer:32,unmetered:1});
    assert.equal(usage.total.answerTokensPerSecond,16);
    assert.equal(usage.last24Hours.requests,3);
    assert.deepEqual(usage.byStage.map(row=>row.stage),['preview','read','reply']);
    assert.equal(usage.recent[0].outcome,'http_error');
    assert.equal(usage.recent[1].outcome,'invalid_response');
    assert.equal(usage.recent[2].totalMs,2000);
    store.close();store=new Store(file);
    assert.equal(store.modelUsage().total.totalTokens,207);
  } finally {
    globalThis.fetch=originalFetch;
    store.close();rmSync(dir,{recursive:true,force:true});
  }
});
