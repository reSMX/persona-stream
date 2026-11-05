import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { z } from 'zod';
import { ConfigFile } from './config.js';
import { Store } from './store.js';
import { Ollama } from './model.js';
import { XBrowser } from './browser.js';
import { Engine } from './engine.js';
import { validatePublicText } from './ranking.js';
import { ExtensionBridge, ExtensionBrowser, BrowserRouter } from './extension-bridge.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA=path.resolve(process.env.PERSONA_DATA_DIR || path.join(ROOT,'data'));
const PORT=Number(process.env.PORT || 4317);
mkdirSync(DATA,{recursive:true});
const config=new ConfigFile(DATA);
const stores={live:new Store(path.join(DATA,'memory.sqlite')),demo:new Store(path.join(DATA,'demo.sqlite'))};
for(const store of Object.values(stores)) store.seed(config.value.topics);
const model=new Ollama(()=>config.value);
const bridge=new ExtensionBridge();
const browser=new BrowserRouter(new XBrowser(path.join(DATA,'x-browser'),()=>config.value),new ExtensionBrowser(bridge,()=>config.value),()=>config.value);
const engine=new Engine({stores,config,model,browser});
const app=express();
let browserBusy=false;
app.disable('x-powered-by');
app.use((req,res,next)=>{
  const validHosts=[`127.0.0.1:${PORT}`,`localhost:${PORT}`];
  if(!validHosts.includes(req.headers.host)) return res.status(403).json({error:'Панель доступна только локально.'});
  if(req.path.startsWith('/bridge/')) {
    const origin=req.headers.origin;
    if(origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))return res.status(403).json({error:'Доступ только для расширения'});
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Persona-Bridge, X-Extension-Id');return res.sendStatus(204);}
    if(req.method!=='POST'||req.headers['x-persona-bridge']!=='1')return res.status(403).json({error:'Неверный запрос соединителя'});
    if(origin && origin!=='chrome-extension://'+req.headers['x-extension-id'])return res.status(403).json({error:'Источник расширения не совпал'});
    res.setHeader('Cache-Control','no-store');return next();
  }
  if(!['GET','HEAD'].includes(req.method)) {
    const validOrigins=validHosts.map(h=>`http://${h}`);
    if((req.headers.origin && !validOrigins.includes(req.headers.origin)) || req.headers['x-local-request']!=='1') return res.status(403).json({error:'Запрос разрешён только из локальной панели.'});
  }
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  if(req.path.startsWith('/api')) res.setHeader('Cache-Control','no-store');
  next();
});
app.use(express.json({limit:'150kb'}));
const selectStore=req=>stores[req.query.dataset==='live'?'live':'demo'];
function idle() { if(engine.status.busy || engine.status.running || browserBusy) { const e=new Error('Останови агента и дождись текущей операции браузера перед изменениями.');e.status=409;throw e; } }
async function browserOperation(fn) { idle();browserBusy=true;try{return await fn();}finally{browserBusy=false;} }

app.get('/api/state',(req,res)=>res.json({config:config.value,status:engine.status,model:model.last,browser:{open:!!browser.context,account:browser.identity,connection:config.value.browser.connection,extension:bridge.info()},...selectStore(req).snapshot()}));
app.post('/api/browser/pair-code',(req,res)=>{idle();res.json({...bridge.pairingCode(),extensionPath:path.join(ROOT,'chrome-extension')});});
app.post('/bridge/pair',(req,res)=>{
  idle();const code=z.string().regex(/^\d{6}$/).parse(req.body.code);
  if(req.body.version!==12)return res.status(409).json({error:'Обнови расширение Persona Stream в chrome://extensions и подключи вкладку X заново.'});
  res.json(bridge.pair(code,String(req.headers['x-extension-id']||'')));
});
app.use('/bridge',(req,res,next)=>{
  const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
  if(!bridge.authenticate(token,req.headers['x-extension-id']))return res.status(401).json({error:'Подключение истекло. Получи новый код в панели.'});
  next();
});
app.post('/bridge/next',async(req,res)=>res.json({task:await bridge.next()}));
app.post('/bridge/result',(req,res)=>{
  const diagnostics=z.object({
    replacements:z.number().int().min(0).max(1000),
    steps:z.array(z.object({phase:z.string().max(40),index:z.number().int().min(0).max(1000),length:z.number().int().min(-1).max(10000),sample:z.string().max(80).optional(),textContent:z.string().max(80).optional(),html:z.string().max(300).optional(),focused:z.boolean(),buttonReady:z.boolean()})).max(40),
    dialogs:z.array(z.object({text:z.string().max(160).optional(),html:z.string().max(300).optional(),editor:z.string().max(80).optional()})).max(10).optional()
  });
  const body=z.object({id:z.string().uuid(),result:z.object({ok:z.boolean(),data:z.unknown().optional(),error:z.string().max(2000).optional(),mayHaveActed:z.boolean().optional(),stage:z.string().max(200).optional(),trace:z.array(z.string().max(200)).max(12).optional(),diagnostics:diagnostics.nullable().optional()})}).parse(req.body);
  const task=bridge.pending?.id===body.id?bridge.pending:null;
  const accepted=bridge.result(body.id,body.result);
  if(accepted && task && task.op!=='status'){
    const target=task.payload?.post?.url||null;
    const label=task.op==='perform'?`Действие ${task.payload.kind}`:task.op==='read'?'Чтение поста':'Просмотр For you';
    stores.live.event(`${label}: ${body.result.ok?'готово':body.result.error}`,body.result.ok?'info':'error',{target,stage:body.result.stage,trace:body.result.trace,editor:body.result.diagnostics,mayHaveActed:!!body.result.mayHaveActed});
  }
  res.json({accepted});
});
app.post('/bridge/lease',(req,res)=>res.json({valid:!!bridge.pending && bridge.pending.id===req.body.id && (engine.status.busy||browserBusy) && !engine.controller?.signal.aborted}));
app.post('/bridge/disconnect',(req,res)=>{engine.stop();bridge.disconnect();res.json({ok:true});});
app.post('/api/config',(req,res)=>{
  idle();
  const old=config.value;
  const next=config.save(req.body);
  for(const store of Object.values(stores)) store.seed(next.topics,old.topics);
  res.json({ok:true,config:next});
});
app.post('/api/model/check',async(req,res)=>res.json(await model.check()));
app.post('/api/browser/open',async(req,res)=>res.json(await browserOperation(async()=>{await browser.open();return browser.inspect();})));
app.post('/api/browser/check',async(req,res)=>res.json(await browserOperation(()=>browser.inspect())));
app.post('/api/browser/close',async(req,res)=>res.json(await browserOperation(async()=>{await browser.close();return {ok:true};})));
app.post('/api/start',async(req,res)=>{
  idle();
  const body=z.object({mode:z.enum(['demo','observe','live']),once:z.boolean().default(false)}).parse(req.body);
  await engine.start(body.mode,body.once);res.json({ok:true});
});
app.post('/api/stop',(req,res)=>{engine.stop();bridge.cancel('Остановлено оператором');res.json({ok:true});});
app.post('/api/shutdown',(req,res)=>{res.json({ok:true});setTimeout(shutdown,50);});
app.get('/api/authors/:handle',(req,res)=>{
  const author=selectStore(req).author(req.params.handle);
  if(!author) return res.status(404).json({error:'Автор ещё не запомнен'});
  const memories=selectStore(req).all('SELECT m.*,p.url FROM memories m JOIN posts p ON p.id=m.post_id WHERE m.author=? ORDER BY m.id DESC LIMIT 100',req.params.handle).map(m=>({...m,topics:JSON.parse(m.topics)}));
  res.json({...author,memories});
});
app.post('/api/actions/:id/resolve',(req,res)=>{
  idle();
  const status=z.enum(['success','failed']).parse(req.body.status);
  const store=selectStore(req);
  const row=store.get("SELECT id FROM actions WHERE id=? AND status='unknown'",Number(req.params.id));
  if(!row) return res.status(404).json({error:'Нет такого неподтверждённого действия'});
  store.finishAction(row.id,status,'Результат проверен оператором вручную.');
  store.event(`Оператор отметил результат действия №${row.id}: ${status}`);
  res.json({ok:true});
});
app.post('/api/actions/:id/retry-failed-reply',async(req,res)=>{
  idle();
  if(req.query.dataset!=='live'||config.value.browser.connection!=='extension'||req.body?.acknowledgePublicReply!==true) return res.status(400).json({error:'Нужны память X, расширение и явное подтверждение пробного ответа.'});
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Некорректный номер действия'});
  const row=stores.live.get('SELECT * FROM actions WHERE id=?',id);
  if(!row||row.kind!=='reply'||row.status!=='failed'||!['Готовлю действие reply ','Ввожу текст reply '].some(prefix=>row.detail.startsWith(prefix)))return res.status(409).json({error:'Повтор доступен только для ответа, который точно не был отправлен.'});
  const post=stores.live.get("SELECT * FROM posts WHERE id=? AND author=? AND status='read'",row.target,row.author);
  if(!post||!post.body)return res.status(409).json({error:'Исходный прочитанный пост не найден.'});
  const blocked=stores.live.canAct('reply',row.author,config.value);
  if(blocked)return res.status(409).json({error:blocked});
  try{validatePublicText(row.text);}catch(e){return res.status(409).json({error:e.message});}
  browserBusy=true;let started=false;
  try{
    await browser.ready();
    stores.live.run("UPDATE actions SET status='pending',detail='Пробный повтор: готовится отправка.' WHERE id=?",id);started=true;
    stores.live.event(`Пробный повтор ответа №${id} @${row.author}`,'info',{actionId:id,url:post.url,text:row.text});
    const detail=await browser.perform('reply',{...post,text:post.body},row.text);
    stores.live.finishAction(id,'success',detail);
    stores.live.event(`Пробный ответ №${id}: ${detail}`,'info',{actionId:id,url:post.url});
    res.json({ok:true,detail});
  }catch(e){
    if(started){stores.live.finishAction(id,e.mayHaveActed?'unknown':'failed',e.message);stores.live.event(`Пробный ответ №${id}: ${e.message}`,'error',{actionId:id,mayHaveActed:!!e.mayHaveActed});}
    res.status(409).json({error:e.mayHaveActed?'Нажатие могло состояться. Проверь X перед любой новой попыткой.':e.message});
  }finally{browserBusy=false;}
});
app.post('/api/demo/reset',(req,res)=>{
  idle();stores.demo.close();
  const stamp=Date.now();
  for(const suffix of ['','-wal','-shm']) {
    const file=path.join(DATA,'demo.sqlite'+suffix);
    if(existsSync(file)) renameSync(file,path.join(DATA,`demo.backup-${stamp}.sqlite${suffix}`));
  }
  stores.demo=new Store(path.join(DATA,'demo.sqlite'));stores.demo.seed(config.value.topics);
  res.json({ok:true});
});
app.get('/api/export',(req,res)=>{
  const store=selectStore(req);
  const data={version:1,exportedAt:new Date().toISOString(),dataset:req.query.dataset==='live'?'live':'demo',config:config.value};
  for(const table of ['topics','posts','authors','memories','changes','actions','events','candidates','state']) data[table]=store.all(`SELECT * FROM ${table}`);
  res.setHeader('Content-Disposition','attachment; filename="persona-memory.json"');res.json(data);
});
app.use(express.static(path.join(ROOT,'public')));
app.use((err,req,res,next)=>{
  console.error(err.message);
  res.status(err.status || (err instanceof z.ZodError?400:500)).json({error:err instanceof z.ZodError?err.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '):err.message});
});
const server=app.listen(PORT,'127.0.0.1',()=>console.log(`Persona Stream: http://127.0.0.1:${PORT}`));
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Панель уже запущена или порт 4317 занят.':e.message);process.exitCode=1;});
async function shutdown(){engine.stop();server.close();await browser.close();setTimeout(()=>process.exit(0),500).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
