const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const percent=value=>`${Math.round((value||0)*100)}%`;
const time=value=>new Date(value).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const date=value=>new Date(value).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
let state=null,mode='demo',tab='overview',initialized=false,loading=false,activeAuthor=null;
let toastTimer;
const dataset=()=>mode==='demo'?'demo':'live';
const titles={overview:['Сначала интерес.<br><span>Потом разговор.</span>','Наблюдай, что привлекает персонажа и почему он решает ответить.'],persona:['Свой характер.<br><span>Свой голос.</span>','Биография задаёт основу. Новые впечатления постепенно меняют отношение к миру.'],interests:['Что цепляет.<br><span>Что меняется.</span>','Новые темы, привычные увлечения и история обучения на прочитанном.'],memory:['Не просто ник.<br><span>История встреч.</span>','Каждая заметка опирается на прочитанный пост. Впечатления могут меняться.'],actions:['От впечатления<br><span>к действию.</span>','Что персонаж решил сделать и какой результат удалось подтвердить.'],settings:['Твоя модель.<br><span>Твои настройки.</span>','Подключение к Ollama, отдельный браузер и темп работы персонажа.']};
const kindLabel={reply:'Ответ',like:'Лайк',follow:'Подписка',post:'Публикация'};
const statusLabel={success:'Подтверждено',pending:'Выполняется',unknown:'Нужно проверить',failed:'Не выполнено'};

function toast(message,error=false){clearTimeout(toastTimer);$('#toast').hidden=false;$('#toast').className=error?'error':'';$('#toast').textContent=message;toastTimer=setTimeout(()=>$('#toast').hidden=true,error?10000:5000);}
async function api(url,body){
  const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Local-Request':'1'},body:JSON.stringify(body)});
  const data=await r.json();if(!r.ok) throw new Error(data.error||`Ошибка ${r.status}`);return data;
}
async function action(fn,button){if(button)button.disabled=true;try{await fn();await refresh();}catch(e){toast(e.message,true);}finally{if(button)button.disabled=false;renderStatus();}}
async function refresh(){
  if(loading)return;loading=true;
  try{state=await api(`/api/state?dataset=${dataset()}`);if(state.status.running||state.status.busy)mode=state.status.mode;render();if(!initialized){fillForms();initialized=true;}}
  catch(e){$('#phase').textContent='Панель потеряла связь с приложением';$('#error-box').hidden=false;$('#error-box').textContent=e.message;}
  finally{loading=false;}
}
function switchTab(name){
  tab=name;$$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  $('#page-title').innerHTML=titles[name][0];$('#page-subtitle').textContent=titles[name][1];
  const button=$(`.nav-item[data-tab="${name}"]`);$('#breadcrumb').innerHTML=`Рабочее пространство <span>/</span> ${esc(button.textContent.replace(/0\d/,'').replace(/[◉◇⌁◎↗⚙]/g,'').trim())}`;
  if(name==='interests')renderTopicEditor();
}
function renderStatus(){
  if(!state)return;const s=state.status;const busy=s.running||s.busy;
  $('#start').disabled=busy;$('#stop').disabled=!busy;$('#one-batch').disabled=busy;
  $$('[data-mode]').forEach(b=>{b.classList.toggle('selected',b.dataset.mode===mode);b.disabled=busy;});
  $('#run-state').textContent=s.busy?'Работает':s.running?'Между пачками':s.error?'Нужна проверка':'На паузе';
  $('#phase').textContent=s.phase;$('#activity-dot').classList.toggle('busy',s.busy);
  $('#error-box').hidden=!s.error;$('#error-box').textContent=s.error||'';
  $('#next-run').textContent=s.nextRun?`Дальше в ${time(s.nextRun)}`:'';
  $('#dataset-badge').textContent=mode==='demo'?'УЧЕБНАЯ ПАМЯТЬ':'ПАМЯТЬ X';
  $('#mode-description').textContent={demo:'Вымышленные посты · без действий в X',observe:'Чтение настоящей ленты · без публикаций',live:'Настоящий аккаунт · автоматические действия включены'}[mode];
  $('#actions-caption').textContent=mode==='demo'?'только учебная симуляция':'подтверждённые действия в X';
  $('#actions-description').textContent=mode==='demo'?'Учебные действия никогда не отправляются в X.':'Неоднозначный результат требует ручной проверки. Автоматического повтора нет.';
}
function render(){
  renderStatus();$('#sidebar-name').textContent=state.config.persona.name;
  for(const name of ['seen','read','authors','actions'])$(`#metric-${name}`).textContent=state.counts[name];
  $('#metric-ratio').textContent=state.counts.seen?`${Math.round(state.counts.read/state.counts.seen*100)}% от просмотренного`:'отбор ещё не начат';
  $('#interest-bars').innerHTML=state.topics.slice(0,7).map(t=>`<div class="interest-row"><div><span>${esc(t.name)}</span><strong>${percent(t.weight)}</strong></div><div class="bar"><span style="width:${percent(t.weight)}"></span></div></div>`).join('');
  if(state.posts.length)$('#feed-list').innerHTML=state.posts.map(p=>`<article class="post ${p.status==='skipped'?'skipped':''}"><div class="post-top"><strong>@${esc(p.author)}</strong><span class="status">${{skipped:'пропущен',selected:'выбран',read:'прочитан'}[p.status]||esc(p.status)}</span><span class="score">${percent(p.score)} интерес</span></div><p>${esc(p.preview)}</p><div class="reason">${esc(p.analysis?.reason||p.reason)}</div>${p.body?`<details><summary>Полный текст и решение</summary><p>${esc(p.body)}</p><p>Согласие: ${Math.round(p.analysis.agreement*100)}% · Ценность: ${percent(p.analysis.value)} · Желание ответить: ${percent(p.analysis.replyDesire)}</p></details>`:''}</article>`).join('');
  else $('#feed-list').innerHTML='<div class="empty"><div class="empty-symbol">⌁</div><h3>Здесь появится ход чтения</h3><p>Запусти одну пачку. Модель выберет посты по интересам и создаст первые заметки.</p></div>';
  $('#events').innerHTML=state.events.length?state.events.map(e=>`<div class="event ${esc(e.level)}"><time>${time(e.created)}</time><span>${esc(e.text)}${e.data?`<details class="event-details"><summary>Подробности</summary><pre>${esc(JSON.stringify(JSON.parse(e.data),null,2))}</pre></details>`:''}</span></div>`).join(''):'<p class="muted">Событий пока нет.</p>';
  if(state.model){$('#model-speed').textContent=`Последний запрос: ${state.model.seconds} с · ${state.model.answerTokens||0} токенов` ;$('#model-label').textContent='Модель · подключена';$('#model-dot').classList.add('online');}
  $('#changes-list').innerHTML=state.changes.length?state.changes.map(c=>`<div class="change"><span>${esc(c.topic)}</span><span class="delta ${c.new<c.old?'negative':''}">${percent(c.old)} → ${percent(c.new)}</span><p>${esc(c.reason)} <small>· ${date(c.created)}</small></p></div>`).join(''):'<p class="muted">После полного чтения здесь появятся изменения с объяснением.</p>';
  renderAuthors();renderActions();
}
function renderAuthors(){
  if(!state)return;const q=$('#author-search').value.toLowerCase();
  const authors=state.authors.filter(a=>(a.handle+' '+a.summary).toLowerCase().includes(q));
  $('#author-count').textContent=state.counts.authors;
  $('#author-list').innerHTML=authors.length?authors.map(a=>`<button class="author-card" data-author="${esc(a.handle)}"><strong>@${esc(a.handle)}</strong><p>${esc(a.summary||'Первые наблюдения ещё собираются.')}</p><small>${a.encounters} встреч · отношение ${a.affinity>=0?'+':''}${Math.round(a.affinity*100)} · доверие ${percent(a.trust)}</small></button>`).join(''):'<div class="empty"><p>Знакомых авторов пока нет.</p></div>';
}
async function showAuthor(handle){
  activeAuthor=handle;const a=await api(`/api/authors/${encodeURIComponent(handle)}?dataset=${dataset()}`);
  $('#author-detail').innerHTML=`<div class="panel-title"><h2>@${esc(a.handle)}</h2><span class="badge">ПАМЯТЬ АВТОРА</span></div><p>${esc(a.summary)}</p><div class="author-stats"><span>${a.encounters} встреч</span><span>Отношение ${a.affinity>=0?'+':''}${Math.round(a.affinity*100)}</span><span>Доверие ${percent(a.trust)}</span></div>${a.memories.map(m=>`<div class="memory-note"><small>${date(m.created)} · уверенность ${percent(m.confidence)}</small><p>${esc(m.note)}</p>${m.quote?`<blockquote>${esc(m.quote)}</blockquote>`:''}<small>${esc(m.topics.join(' · '))}</small>${/^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/.test(m.url)?` · <a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">Источник ↗</a>`:''}</div>`).join('')}`;
}
function renderActions(){
  $('#action-list').innerHTML=state.actions.length?state.actions.map(a=>`<article class="action-item"><header><strong>${kindLabel[a.kind]} ${a.author?'@'+esc(a.author):''} · №${a.id}</strong><span class="${a.status}">${statusLabel[a.status]}</span></header>${a.text?`<p>${esc(a.text)}</p>`:''}<small>${date(a.created)} · ${esc(a.detail)}${/^\d+$/.test(a.target)&&/^[a-z0-9_]{1,15}$/.test(a.author)?` · <a href="https://x.com/${a.author}/status/${a.target}" target="_blank" rel="noopener noreferrer">Целевой пост ↗</a>`:''}</small>${a.status==='unknown'?`<div class="resolve-actions"><button class="button secondary" data-resolve="${a.id}" data-result="success">Проверил: выполнено</button><button class="button stop" data-resolve="${a.id}" data-result="failed">Проверил: не выполнено</button></div>`:''}</article>`).join(''):'<div class="empty"><div class="empty-symbol">↗</div><h3>Сначала наблюдение</h3><p>Первые действия появятся, когда персонаж прочитает достаточно постов и найдёт повод отреагировать.</p></div>';
}
function fillForms(){
  for(const el of $('#persona-form').elements)if(el.name)el.value=state.config.persona[el.name];
  for(const el of $('#settings-form').elements)if(el.name){const [group,key]=el.name.split('.');if(el.type==='checkbox')el.checked=state.config[group][key];else el.value=state.config[group][key];}
  renderConnection();
}
function renderConnection(){
  const isExtension=$('[name="browser.connection"]').value==='extension';
  $('#extension-setup').hidden=!isExtension;
  $('#open-browser').hidden=isExtension;
}
function topicRow(t){return `<div class="topic-edit"><label>Тема<input class="topic-name" value="${esc(t.name)}" required maxlength="100"></label><label>Исходный вес<input class="topic-weight" type="number" min="0" max="1" step="0.01" value="${t.baseline??t.weight}" required><div class="topic-current">Сейчас ${percent(t.weight)}</div></label><label>Ключевые слова<input class="topic-keywords" value="${esc(t.keywords.join(', '))}" placeholder="Через запятую"></label><label class="toggle"><input class="topic-pinned" type="checkbox" ${t.pinned?'checked':''}> Закрепить</label><button type="button" class="remove-topic" aria-label="Удалить тему">×</button></div>`;}
function renderTopicEditor(){if(state)$('#topic-editor').innerHTML=state.topics.map(topicRow).join('');}

$$('.nav-item').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
$$('[data-go]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.go)));
$$('[data-mode]').forEach(b=>b.addEventListener('click',()=>action(async()=>{mode=b.dataset.mode;activeAuthor=null;$('#author-detail').innerHTML='<div class="empty"><h3>Выбери автора</h3><p>У учебного режима и X разная память.</p></div>';await refresh();if(tab==='interests')renderTopicEditor();})));
$('#start').addEventListener('click',e=>action(()=>api('/api/start',{mode,once:false}),e.currentTarget));
$('#stop').addEventListener('click',e=>action(()=>api('/api/stop',{}),e.currentTarget));
$('#one-batch').addEventListener('click',e=>action(()=>api('/api/start',{mode,once:true}),e.currentTarget));
$('#check-model').addEventListener('click',e=>action(async()=>{const r=await api('/api/model/check',{});$('#model-result').textContent=`Доступна ${r.name} · ${r.details?.parameter_size||''}`;$('#model-label').textContent='Модель · подключена';$('#model-dot').classList.add('online');toast('Подключение к модели работает');},e.currentTarget));
$('#open-browser').addEventListener('click',e=>action(async()=>{const r=await api('/api/browser/open',{});$('#browser-result').textContent=r.ready?`Вход подтверждён: @${r.account}`:r.error;toast('Окно X открыто. Войди в аккаунт самостоятельно.');},e.currentTarget));
$('#check-browser').addEventListener('click',e=>action(async()=>{const r=await api('/api/browser/check',{});$('#browser-result').textContent=r.ready?`Вход подтверждён: @${r.account}`:r.error;toast(r.ready?'Аккаунт подтверждён':r.error,!r.ready);},e.currentTarget));
$('[name="browser.connection"]').addEventListener('change',renderConnection);
$('#pair-extension').addEventListener('click',e=>action(async()=>{
  const next=structuredClone(state.config);next.browser.connection='extension';await api('/api/config',next);
  const r=await api('/api/browser/pair-code',{});
  $('#pair-code').textContent=r.code;$('#extension-path').textContent=r.extensionPath;
  $('#pair-hint').textContent='Введи этот код во вкладке соединителя. Код действует 5 минут.';
},e.currentTarget));
$('#persona-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const next=structuredClone(state.config);for(const el of e.target.elements)if(el.name)next.persona[el.name]=el.value;await api('/api/config',next);toast('Личность сохранена');},e.submitter);});
$('#settings-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const next=structuredClone(state.config);for(const el of e.target.elements)if(el.name){const [group,key]=el.name.split('.');next[group][key]=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value;}await api('/api/config',next);toast('Настройки сохранены');},e.submitter);});
$('#topics-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{const next=structuredClone(state.config);next.topics=$$('.topic-edit').map(row=>({name:row.querySelector('.topic-name').value.trim(),weight:Number(row.querySelector('.topic-weight').value),keywords:row.querySelector('.topic-keywords').value.split(',').map(s=>s.trim()).filter(Boolean),pinned:row.querySelector('.topic-pinned').checked}));await api('/api/config',next);toast('Интересы сохранены');},e.submitter);});
$('#add-topic').addEventListener('click',()=>$('#topic-editor').insertAdjacentHTML('beforeend',topicRow({name:'',weight:0.5,keywords:[],pinned:false})));
$('#topic-editor').addEventListener('click',e=>{const b=e.target.closest('.remove-topic');if(b)b.closest('.topic-edit').remove();});
$('#author-search').addEventListener('input',renderAuthors);
$('#author-list').addEventListener('click',e=>{const b=e.target.closest('[data-author]');if(b)action(()=>showAuthor(b.dataset.author));});
$('#action-list').addEventListener('click',e=>{const b=e.target.closest('[data-resolve]');if(b)action(()=>api(`/api/actions/${b.dataset.resolve}/resolve?dataset=${dataset()}`,{status:b.dataset.result}),b);});
$('#export').addEventListener('click',()=>{const a=document.createElement('a');a.href=`/api/export?dataset=${dataset()}`;a.download='persona-memory.json';a.click();});
$('#reset-demo').addEventListener('click',e=>action(async()=>{await api('/api/demo/reset',{});toast('Учебная память сброшена. Резервная копия сохранена.');},e.currentTarget));
setInterval(()=>$('#clock').textContent=new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),1000);
setInterval(refresh,4000);refresh();
