import { xPage } from './x-page.js';
const BASE='http://127.0.0.1:4317';
const tabId=Number(new URLSearchParams(location.search).get('tab'));
const $=s=>document.querySelector(s);
let token=null,stopped=true,currentTask=null;
const log=text=>{$('#log').textContent=`${new Date().toLocaleTimeString()} · ${text}\n`+$('#log').textContent.slice(0,4000);};
async function request(path,body={}) {
  const r=await fetch(BASE+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Persona-Bridge':'1','X-Extension-Id':chrome.runtime.id,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(path==='next'?25000:10000)});
  const data=await r.json();if(!r.ok)throw new Error(data.error||'Ошибка соединения');return data;
}
async function target(){if(!Number.isInteger(tabId)||tabId<1)throw new Error('Вкладка X не выбрана');const t=await chrome.tabs.get(tabId);if(!t.url || new URL(t.url).origin!=='https://x.com')throw new Error('Выбранная вкладка закрыта или ушла с x.com. Подключи её заново.');return t;}
async function inject(op,payload){await target();const results=await chrome.scripting.executeScript({target:{tabId},func:xPage,args:[op,payload]});const r=results[0]?.result;if(!r?.ok){const e=new Error(r?.error||'Нет ответа от вкладки X');e.mayHaveActed=!!r?.mayHaveActed;e.diagnostics=r?.diagnostics;throw e;}return r.data;}
async function navigate(url){
  const u=new URL(url);if(u.origin!=='https://x.com')throw new Error('Разрешён только x.com');await target();
  await chrome.tabs.update(tabId,{url});
  const end=Date.now()+20000;
  while(Date.now()<end){const t=await target();if(t.status==='complete' && new URL(t.url).pathname===u.pathname)return;await new Promise(r=>setTimeout(r,200));}
  throw new Error('X не завершил загрузку страницы');
}
async function typeThroughBrowser(payload,diagnostics){
  await target();const debuggee={tabId};let attached=false,typed='';
  try{
    await chrome.debugger.attach(debuggee,'1.3');attached=true;
    for(const char of payload.text){
      await target();
      if(char==='\n'){
        await chrome.debugger.sendCommand(debuggee,'Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
        await chrome.debugger.sendCommand(debuggee,'Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
      }else await chrome.debugger.sendCommand(debuggee,'Input.insertText',{text:char});
      typed+=char;
      const checked=await inject('editor-check',{kind:payload.kind,post:payload.post,expected:typed,account:payload.account});
      if(Array.from(typed).length%20===0 && diagnostics.steps.length<40)diagnostics.steps.push(...checked.diagnostics.steps);
    }
    await new Promise(r=>setTimeout(r,700));
    const checked=await inject('editor-check',{kind:payload.kind,post:payload.post,expected:typed,account:payload.account});
    diagnostics.steps.push(...checked.diagnostics.steps);
    return diagnostics;
  }finally{if(attached)await chrome.debugger.detach(debuggee).catch(()=>{});}
}
async function run(task){
  const p=task.payload;let mayHaveActed=false,stage='получение задачи',diagnostics=null;const trace=[];
  const mark=label=>{stage=label;trace.push(label);$('#status').textContent=label;};
  const done=data=>({ok:true,data,stage,trace,diagnostics,mayHaveActed});
  try {
    if(task.op==='status'){mark('Проверяю аккаунт X');return done(await inject('status',p));}
    if(task.op==='scan') {mark('Открываю For you');await navigate('https://x.com/home');mark('Собираю посты из For you');return done(await inject('scan',p));}
    if(task.op==='visible'){mark('Проверяю посты, оставшиеся в For you');return done(await inject('visible',p));}
    if(task.op==='read'){mark(`Открываю пост @${p.post.author} (${p.post.id})`);await navigate(p.post.url);mark(`Читаю пост @${p.post.author} (${p.post.id})`);return done(await inject('read',p));}
    if(task.op!=='perform')throw new Error('Неизвестная команда соединителя');
    const destination=p.kind==='notInterested'?'https://x.com/home':p.kind==='post'?'https://x.com/compose/post':p.kind==='follow'?`https://x.com/${p.post.author}`:p.post.url;
    mark(`Открываю цель действия ${p.kind}: ${destination}`);
    if(p.kind==='notInterested')await target();else await navigate(destination);
    mark(`Готовлю действие ${p.kind} для @${p.post.author||'своего аккаунта'}`);
    const prepared=await inject('prepare',p);diagnostics=prepared.diagnostics||null;if(prepared.already)return done({detail:prepared.detail});
    if(p.kind==='reply'||p.kind==='post'){mark(`Ввожу текст ${p.kind} посимвольно`);diagnostics=await typeThroughBrowser(p,diagnostics);}
    mark(`Проверяю разрешение на действие ${p.kind}`);
    const lease=await request('lease',{id:task.id});
    if(!lease.valid || stopped)throw new Error('Операция отменена до отправки');
    mark(`Отправляю действие ${p.kind}`);
    await inject('commit',p);mayHaveActed=true;
    mark(`Проверяю результат действия ${p.kind}`);
    const receipt=await inject('receipt',p);
    if(p.kind==='reply'){
      mark('Возвращаюсь на главную X после ответа');
      try{await target();await chrome.tabs.update(tabId,{url:'https://x.com/home'});}
      catch(e){trace.push(`Ответ опубликован, но переход на главную не удался: ${e.message}`);}
    }
    return done(receipt);
  } catch(e){return {ok:false,error:`${stage}: ${e.message}`,stage,trace,diagnostics:e.diagnostics||diagnostics,mayHaveActed:mayHaveActed||!!e.mayHaveActed};}
}
async function loop(){
  while(!stopped){
    try {
      await target();const {task}=await request('next');if(stopped)break;if(!task)continue;
      currentTask=task.id;$('#status').textContent={status:'Проверяю аккаунт…',scan:'Просматриваю начала постов…',read:'Читаю выбранный пост…',perform:'Выполняю действие…'}[task.op]||'Работаю…';
      log(`Задача: ${task.op}${task.payload.kind?' · '+task.payload.kind:''}${task.payload.post?.url?' · '+task.payload.post.url:''}`);
      const result=await run(task);await request('result',{id:task.id,result});currentTask=null;
      log(result.ok?'Операция завершена':result.error);$('#status').textContent=result.ok?'Подключено · ожидаю следующую задачу':result.error;
    }catch(e){stopped=true;$('#status').textContent=e.message;log(e.message);$('#pair').disabled=false;$('#disconnect').disabled=true;}
  }
}
$('#pair-form').addEventListener('submit',async e=>{
  e.preventDefault();$('#pair').disabled=true;
  try{await target();const identity=await inject('status',{});const pair=await request('pair',{code:$('#code').value.trim(),version:13});token=pair.token;stopped=false;$('#code').value='';$('#status').textContent=`Подключено: @${identity.account}`;$('#disconnect').disabled=false;log(`Выбрана вкладка @${identity.account}`);loop();}
  catch(e){$('#status').textContent=e.message;$('#pair').disabled=false;}
});
$('#disconnect').addEventListener('click',async()=>{stopped=true;try{await request('disconnect');}catch{}token=null;$('#pair').disabled=false;$('#disconnect').disabled=true;$('#status').textContent='Отключено. Вкладка X оставлена открытой.';});
