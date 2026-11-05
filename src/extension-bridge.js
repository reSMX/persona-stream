import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { statusUrl } from './browser.js';

const handle=z.string().regex(/^[a-z0-9_]{1,15}$/);
const Post=z.object({id:z.string().regex(/^\d+$/),author:handle,url:z.string(),preview:z.string().max(600)});
const equal=(a,b)=>typeof a==='string' && typeof b==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class ExtensionBridge {
  constructor(){this.code=null;this.token=null;this.extensionId=null;this.lastSeen=0;this.pending=null;this.account=null;}
  pairingCode(){this.code={value:String(randomInt(100000,1000000)),expires:Date.now()+300000,attempts:0};return {code:this.code.value,expiresAt:new Date(this.code.expires).toISOString()};}
  pair(code,extensionId){
    if(!/^[a-p]{32}$/.test(extensionId))throw new Error('Некорректный идентификатор расширения');
    if(!this.code || this.code.expires<Date.now() || ++this.code.attempts>10 || !equal(code,this.code.value))throw new Error('Код не совпал или истёк. Получи новый код в панели.');
    this.disconnect('Подключена новая вкладка');this.code=null;this.token=randomBytes(32).toString('hex');this.extensionId=extensionId;this.lastSeen=Date.now();return {token:this.token};
  }
  authenticate(token,extensionId){return !!this.token && equal(token,this.token) && extensionId===this.extensionId;}
  connected(){return !!this.token && Date.now()-this.lastSeen<90000;}
  info(){return {connected:this.connected(),account:this.account,pending:!!this.pending};}
  poll(){this.lastSeen=Date.now();if(!this.pending || this.pending.delivered)return null;this.pending.delivered=true;return {id:this.pending.id,op:this.pending.op,payload:this.pending.payload};}
  async next(){
    const ready=this.poll();if(ready)return ready;
    await new Promise(resolve=>{const timer=setTimeout(done,20000);const previous=this.wake;this.wake=done;previous?.();function done(){clearTimeout(timer);resolve();}});
    this.wake=null;return this.poll();
  }
  cancel(message='Операция остановлена'){
    if(this.pending){const p=this.pending;this.pending=null;clearTimeout(p.timer);const e=new Error(message);e.mayHaveActed=p.delivered && p.op==='perform';p.reject(e);}
    this.wake?.();
  }
  result(id,result){
    this.lastSeen=Date.now();const p=this.pending;if(!p || p.id!==id)return false;
    this.pending=null;clearTimeout(p.timer);
    if(result.ok){if(p.op==='status')this.account=result.data?.account || null;p.resolve(result.data);}
    else {const e=new Error(String(result.error||'Ошибка расширения').slice(0,1000));e.mayHaveActed=!!result.mayHaveActed;p.reject(e);}
    return true;
  }
  disconnect(message='Расширение отключено'){
    this.cancel(message);
    this.token=null;this.extensionId=null;this.lastSeen=0;this.account=null;
  }
  request(op,payload={}){
    if(!this.connected())throw new Error('Открой соединитель Persona Stream в нужном профиле Chrome и подключи вкладку X.');
    if(this.pending)throw new Error('Расширение ещё выполняет предыдущую операцию.');
    return new Promise((resolve,reject)=>{
      const p={id:randomUUID(),op,payload,resolve,reject,delivered:false};
      p.timer=setTimeout(()=>{if(this.pending===p)this.pending=null;const e=new Error('Расширение не ответило. Проверь вкладку соединителя и X.');e.mayHaveActed=p.delivered && op==='perform';reject(e);},65000);
      this.pending=p;
      this.wake?.();
    });
  }
}

export class ExtensionBrowser {
  constructor(bridge,getConfig){this.bridge=bridge;this.getConfig=getConfig;this.identity=null;}
  get context(){return this.bridge.connected()?true:null;}
  async open(){if(!this.bridge.connected())throw new Error('Для существующего Chrome получи код подключения и открой расширение в нужном профиле.');await this.ready();}
  async close(){this.bridge.disconnect();this.identity=null;}
  async ready(){
    const r=z.object({account:handle}).parse(await this.bridge.request('status'));
    this.identity=r.account;
    const expected=this.getConfig().browser.account.replace(/^@/,'').toLowerCase();
    if(!expected || expected!==r.account)throw new Error(`Вкладка открыта под @${r.account}, ожидается @${expected || 'не задан'}.`);
    return r.account;
  }
  async inspect(){try{await this.ready();return {open:true,ready:true,account:this.identity};}catch(e){return {open:!!this.context,ready:false,account:this.identity,error:e.message};}}
  async scan({limit,previewChars,signal,exclude=()=>false}){
    signal?.throwIfAborted();
    const data=z.array(Post).max(100).parse(await this.bridge.request('scan',{limit:Math.min(limit*3,48),previewChars,account:this.getConfig().browser.account}));
    signal?.throwIfAborted();
    for(const post of data){const u=statusUrl(post.url);if(!u.pathname.endsWith('/status/'+post.id) || u.pathname.split('/')[1].toLowerCase()!==post.author)throw new Error('Идентификатор поста не совпал с адресом');}
    return data.filter(p=>!exclude(p.id) && p.author!==this.identity).slice(0,limit);
  }
  async visiblePostIds(signal){
    signal?.throwIfAborted();
    const ids=z.array(z.string().regex(/^\d+$/)).max(100).parse(await this.bridge.request('visible',{account:this.getConfig().browser.account}));
    signal?.throwIfAborted();return ids;
  }
  async read(post,signal){
    statusUrl(post.url);signal?.throwIfAborted();
    const data=z.union([z.object({hasImage:z.literal(true)}),z.object({text:z.string().min(1).max(10000),context:z.array(z.object({text:z.string().max(700),url:z.string().max(250)})).max(3)})]).parse(await this.bridge.request('read',{post,account:this.getConfig().browser.account}));
    signal?.throwIfAborted();return {...post,...data};
  }
  async perform(kind,post,text,signal){
    signal?.throwIfAborted();
    if(!['like','reply','follow','post','notInterested'].includes(kind))throw new Error('Неизвестное действие');
    if(['like','reply','notInterested'].includes(kind))statusUrl(post.url);
    const data=await this.bridge.request('perform',{kind,post:{id:post.id,author:post.author,url:post.url,preview:String(post.preview||'').slice(0,600),originalText:String(post.text||'').slice(0,160)},text,account:this.getConfig().browser.account});
    return z.object({detail:z.string().max(1000)}).parse(data).detail;
  }
}

export class BrowserRouter {
  constructor(managed,extension,getConfig){Object.assign(this,{managed,extension,getConfig});}
  get active(){return this.getConfig().browser.connection==='extension'?this.extension:this.managed;}
  get context(){return this.active.context;}
  get identity(){return this.active.identity;}
  open(...args){return this.active.open(...args);}
  ready(...args){return this.active.ready(...args);}
  inspect(...args){return this.active.inspect(...args);}
  scan(...args){return this.active.scan(...args);}
  visiblePostIds(...args){return this.active.visiblePostIds(...args);}
  read(...args){return this.active.read(...args);}
  perform(...args){return this.active.perform(...args);}
  async close(){await this.managed.close();await this.extension.close();}
}
