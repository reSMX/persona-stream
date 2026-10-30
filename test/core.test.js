import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema, DEFAULT_CONFIG } from '../src/config.js';
import { Store } from '../src/store.js';
import { rankPreviews, selectReads, validatePublicText, proposeActions } from '../src/ranking.js';
import { statusUrl } from '../src/browser.js';
import { Engine } from '../src/engine.js';
import { ExtensionBridge, ExtensionBrowser } from '../src/extension-bridge.js';
import { PreviewSchema, ReadSchema, TextSchema } from '../src/model.js';

const config=()=>structuredClone(DEFAULT_CONFIG);
function makeStore(){const s=new Store(':memory:');s.seed(config().topics);return s;}
const makePost=(id='1',author='author')=>({id,author,url:`https://x.com/${author}/status/${id}`,preview:'Начало',text:'Важна память с точными цитатами. Полный пост.'});
const analysis=()=>({topics:['Локальные ИИ-модели'],interest:0.9,agreement:-0.5,value:0.85,curiosity:0.8,replyDesire:0.8,likeDesire:0.2,political:false,reason:'Полезно для локального агента',authorNote:'Автор пишет о памяти агентов.',evidenceQuote:'Важна память с точными цитатами.',confidence:0.8,affinityDelta:0.05,trustDelta:0.02,newInterest:null,idea:'Память лучше привязывать к источникам.'});
function addRead(store,id='1',author='author',a=analysis(),c=config()){const p=makePost(id,author);store.rememberPreview(p,0.9,'интересно',true);store.learn(p,a,c);}

test('config validates limits, protocols and duplicate topics',()=>{
  assert.doesNotThrow(()=>ConfigSchema.parse(config()));
  const c=config();c.model.url='file:///C:/secret';assert.throws(()=>ConfigSchema.parse(c));
  const c2=config();c2.topics.push(c2.topics[0]);assert.throws(()=>ConfigSchema.parse(c2));
  const c3=config();c3.actions.minGapSeconds=-1;assert.throws(()=>ConfigSchema.parse(c3));
});
test('preview ranking uses only matching interest weights and rejects duplicate indices',()=>{
  const c=config(),posts=[makePost('1'),makePost('2')],topics=makeStore().topics();
  const r={items:[{index:0,interest:.9,novelty:.8,curiosity:.9,topics:['Локальные ИИ-модели'],reason:'a'},{index:1,interest:.1,novelty:.1,curiosity:.1,topics:[],reason:'b'}]};
  const ranked=rankPreviews(posts,r,c,topics,{},()=>1);
  assert.equal(ranked[0].id,'1');assert.equal(selectReads(ranked,c).length,1);
  assert.throws(()=>rankPreviews(posts,{items:[r.items[0],r.items[0]]},c,topics,{}));
  assert.throws(()=>rankPreviews(posts,{items:[r.items[0]]},c,topics,{}));
});
test('exploration reserves space without reading the whole batch',()=>{
  const c=config();c.reading.fullReads=2;
  const ranked=[{id:'a',score:.9},{id:'b',score:.8},{id:'new',score:.2,explore:true}];
  assert.deepEqual(selectReads(ranked,c).map(p=>p.id),['a','new']);
});
test('one post cannot duplicate author memory or interest updates',()=>{
  const s=makeStore();addRead(s);const before=s.author('author');const weight=s.topics().find(t=>t.name==='Локальные ИИ-модели').weight;
  assert.equal(s.learn(makePost(),analysis(),config()),false);
  assert.equal(s.author('author').encounters,before.encounters);assert.equal(s.author('author').memories.length,1);
  assert.equal(s.topics().find(t=>t.name==='Локальные ИИ-модели').weight,weight);s.close();
});
test('a selected post can be reconsidered after reading fails, but a read post cannot',()=>{
  const s=makeStore(),post=makePost('77');
  s.rememberPreview(post,0.8,'first selection',true);
  assert.equal(s.seen(post.id),false);
  s.rememberPreview({...post,preview:'updated preview'},0.7,'second selection',true);
  assert.equal(s.get('SELECT preview FROM posts WHERE id=?',post.id).preview,'updated preview');
  s.learn(post,analysis(),config());
  assert.equal(s.seen(post.id),true);
  s.rememberPreview(post,0.9,'should not overwrite',true);
  assert.equal(s.get('SELECT status FROM posts WHERE id=?',post.id).status,'read');
  s.close();
});
test('invented quotes cannot create trusted author impressions',()=>{
  const s=makeStore(),a=analysis();a.evidenceQuote='Это придумано';addRead(s,'1','author',a);
  const author=s.author('author');assert.equal(author.affinity,0);assert.equal(author.summary,'');assert.equal(author.memories[0].confidence,0);s.close();
});
test('pinned interests stay fixed; changed settings preserve learned weights unless explicitly changed',()=>{
  const c=config();c.topics[4].pinned=true;const s=new Store(':memory:');s.seed(c.topics);
  const a=analysis();a.topics=['Общество и политика'];addRead(s,'1','author',a,c);
  assert.equal(s.topics().find(t=>t.name==='Общество и политика').weight,c.topics[4].weight);
  addRead(s,'2');const learned=s.topics().find(t=>t.name==='Локальные ИИ-модели').weight;
  s.seed(c.topics,c.topics);assert.equal(s.topics().find(t=>t.name==='Локальные ИИ-модели').weight,learned);
  const next=structuredClone(c.topics);next[3].weight=.3;s.seed(next,c.topics);assert.equal(s.topics().find(t=>t.name==='Локальные ИИ-модели').weight,.3);s.close();
});
test('new interests need three sources and at least two authors',()=>{
  const s=makeStore(),a=analysis();a.newInterest={name:'Японский язык',keyword:'японский язык'};
  addRead(s,'1','a',a);addRead(s,'2','a',a);addRead(s,'3','a',a);
  assert.equal(s.topics().some(t=>t.name==='Японский язык'),false);
  addRead(s,'4','b',a);assert.equal(s.topics().some(t=>t.name==='Японский язык'),true);s.close();
});
test('positive interest does not produce a like when content is opposed',()=>{
  const a=analysis();a.likeDesire=.95;a.agreement=-.9;
  assert.equal(proposeActions(a,null,config()).includes('like'),false);
  assert.equal(proposeActions(a,null,config()).includes('reply'),true);
});
test('daily budgets, warmup, author cooldown and unresolved actions are enforced',()=>{
  const s=makeStore(),c=config();assert.equal(s.canAct('like','a',c),'Знакомство с лентой');
  c.actions.warmupReads=0;c.actions.maxLikesDay=1;
  const id=s.action('like','1','a','');s.finishAction(id,'success','ok');
  assert.equal(s.canAct('like','b',c),'Лимит за 24 часа');
  assert.equal(s.canAct('reply','a',c),'Пауза между действиями');
  assert.equal(s.canAct('reply','a',c,Date.now()+181000),null);
  const reply=s.action('reply','2','a','Ответ');s.finishAction(reply,'success','ok');
  assert.equal(s.canAct('reply','a',c,Date.now()+181000),'Автор уже получил ответ за последние 24 часа');
  const pending=s.action('follow','b','b','');assert.equal(s.canAct('post','',c),'Есть действие без подтверждённого результата');
  s.finishAction(pending,'unknown','timeout');assert.equal(s.canAct('post','',c),'Есть действие без подтверждённого результата');s.close();
});
test('action ledger deduplicates repeated submissions and survives restart',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'persona-test-'));const file=path.join(dir,'memory.sqlite');
  try{let s=new Store(file);assert.ok(s.action('reply','1','a','Ответ'));assert.equal(s.action('reply','1','a','Ответ'),null);s.close();s=new Store(file);assert.equal(s.get('SELECT status FROM actions').status,'unknown');s.close();}
  finally{rmSync(dir,{recursive:true,force:true});}
});
test('tweet validation uses weighted length and blocks accidental local data or mentions',()=>{
  assert.equal(validatePublicText('Мне интересна память локальных моделей.'),'Мне интересна память локальных моделей.');
  assert.throws(()=>validatePublicText('а'.repeat(281)));
  assert.throws(()=>validatePublicText('😀'.repeat(141)));
  assert.throws(()=>validatePublicText('Моя модель на http://192.168.1.2:11434'));
  assert.throws(()=>validatePublicText('Слушай @someone'));
  assert.throws(()=>validatePublicText('   '));
});
test('only canonical X post URLs are executable',()=>{
  assert.equal(statusUrl('https://x.com/name/status/123').hostname,'x.com');
  for(const url of ['https://evil.test/name/status/123','https://x.com.evil.test/name/status/123','file:///etc/passwd','https://x.com/name/status/123?url=x'])assert.throws(()=>statusUrl(url));
});
test('model schemas reject out of range and missing decisions',()=>{
  assert.doesNotThrow(()=>ReadSchema.parse(analysis()));
  assert.throws(()=>ReadSchema.parse({...analysis(),affinityDelta:3}));
  assert.throws(()=>TextSchema.parse({text:'Привет'}));
});

const waitEngine=async e=>{for(let n=0;n<300 && e.status.busy;n++)await new Promise(r=>setTimeout(r,10));assert.equal(e.status.busy,false);};
test('demo pipeline sends only previews first, updates isolated memory and never calls browser',async()=>{
  const c=config();c.actions.warmupReads=0;c.reading.batchSize=2;c.reading.fullReads=1;
  const stores={demo:makeStore(),live:makeStore()};let calls=0,browserActions=0;
  const model={check:async()=>{},json:async(task,input,schema)=>{
    calls++;
    if(schema===PreviewSchema){assert.equal(input.posts[0].text,undefined);assert.ok(input.posts[0].preview.length<=c.reading.previewChars);return {items:input.posts.map((p,i)=>({index:i,interest:.9,novelty:.9,curiosity:.9,topics:['Локальные ИИ-модели'],reason:'интерес'}))};}
    if(schema===ReadSchema){const a=analysis();a.evidenceQuote=input.post.text.slice(0,30);return a;}
    return {text:'Память с источниками полезнее бесконечной истории сообщений.',abstain:false,reason:'мысль'};
  }};
  const e=new Engine({stores,config:{value:c},model,browser:{perform:async()=>{browserActions++;}}});
  await e.start('demo',true);await waitEngine(e);
  assert.equal(e.status.error,null);assert.equal(stores.demo.readCount(),1);assert.equal(stores.live.readCount(),0);assert.equal(browserActions,0);assert.equal(stores.demo.snapshot().actions[0].status,'success');assert.equal(calls,3);
  Object.values(stores).forEach(s=>s.close());
});
test('stop cancels in-flight model work before any publication',async()=>{
  const stores={demo:makeStore(),live:makeStore()},c=config();let entered;const started=new Promise(r=>entered=r);
  const model={check:async()=>{},json:async(task,input,schema,signal)=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};
  const e=new Engine({stores,config:{value:c},model,browser:{}});await e.start('demo',true);await started;e.stop();await waitEngine(e);
  assert.equal(stores.demo.snapshot().actions.length,0);assert.equal(e.status.error,null);Object.values(stores).forEach(s=>s.close());
});
test('observe mode reads and learns without outward actions',async()=>{
  const c=config();c.actions.warmupReads=0;c.browser.account='mybot';c.reading.fullReads=1;
  const stores={demo:makeStore(),live:makeStore()};let actions=0,scanArguments;
  const browser={ready:async()=>{},scan:async args=>{scanArguments=args;return [makePost()];},read:async p=>p,perform:async()=>{actions++;}};
  const model={check:async()=>{},json:async(task,input,schema)=>schema===PreviewSchema?{items:[{index:0,interest:1,novelty:1,curiosity:1,topics:['Локальные ИИ-модели'],reason:'a'}]}:analysis()};
  const e=new Engine({stores,config:{value:c},model,browser});await e.start('observe',true);await waitEngine(e);
  assert.equal(e.status.error,null);assert.equal(stores.live.readCount(),1);assert.equal(actions,0);assert.equal(stores.live.snapshot().actions.length,0);
  assert.equal(Object.hasOwn(scanArguments,'query'),false);
  Object.values(stores).forEach(s=>s.close());
});
test('uncertain publication stops and cannot be repeated automatically',async()=>{
  const c=config();c.actions.warmupReads=0;const stores={demo:makeStore(),live:makeStore()};let attempts=0;
  const e=new Engine({stores,config:{value:c},model:{},browser:{perform:async()=>{attempts++;const x=new Error('timeout');x.mayHaveActed=true;throw x;}}});e.status.mode='live';
  const signal=new AbortController().signal;
  await assert.rejects(()=>e.execute('reply',makePost(),'Текст',signal));
  assert.equal(stores.live.snapshot().actions[0].status,'unknown');await e.execute('reply',makePost(),'Текст',signal);assert.equal(attempts,1);Object.values(stores).forEach(s=>s.close());
});
test('Chrome bridge pairs once and returns only a matching task result',async()=>{
  const b=new ExtensionBridge();const code=b.pairingCode().code;const ext='a'.repeat(32);
  assert.throws(()=>b.pair('000000',ext));
  const {token}=b.pair(code,ext);
  assert.ok(b.authenticate(token,ext));assert.equal(b.authenticate(token,'b'.repeat(32)),false);
  assert.throws(()=>b.pair(code,ext));
  const result=b.request('status');const task=await b.next();
  assert.equal(task.op,'status');assert.equal(b.result('not-matching',{ok:true,data:{account:'bot_example'}}),false);
  assert.equal(b.result(task.id,{ok:true,data:{account:'bot_example'}}),true);
  assert.deepEqual(await result,{account:'bot_example'});assert.equal(b.info().account,'bot_example');
  b.disconnect();assert.equal(b.info().connected,false);
});
test('Chrome bridge interruption keeps outward action result uncertain',async()=>{
  const b=new ExtensionBridge();b.pair(b.pairingCode().code,'a'.repeat(32));
  const result=b.request('perform',{kind:'reply'});const task=await b.next();assert.equal(task.op,'perform');
  b.cancel('Остановлено');await assert.rejects(result,e=>e.mayHaveActed===true);
});
test('Chrome adapter verifies selected account before work',async()=>{
  const b=new ExtensionBridge(),c=config();c.browser.account='bot_example';const adapter=new ExtensionBrowser(b,()=>c);
  b.pair(b.pairingCode().code,'a'.repeat(32));const check=adapter.ready();const task=await b.next();b.result(task.id,{ok:true,data:{account:'otherbot'}});
  await assert.rejects(check,/ожидается @bot_example/);
});
