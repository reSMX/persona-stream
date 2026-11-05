import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

export class BrowserAttention extends Error {}
export function normalizeHandle(value) { return value.replace(/^@/,'').toLowerCase(); }
export function statusUrl(value) {
  const u = new URL(value);
  if(u.origin!=='https://x.com' || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+$/.test(u.pathname) || u.search || u.hash) throw new Error('Недопустимый адрес поста');
  return u;
}
const checkAbort = signal => signal?.throwIfAborted();

export class XBrowser {
  constructor(profileDir,getConfig) { this.profileDir=profileDir; this.getConfig=getConfig; this.context=null; this.feed=null; this.identity=null; }
  async open() {
    if(this.context && this.feed && !this.feed.isClosed()) { await this.feed.bringToFront(); return; }
    if(this.context) await this.close();
    mkdirSync(this.profileDir,{recursive:true});
    const channel = this.getConfig().browser.channel;
    this.context = await chromium.launchPersistentContext(this.profileDir,{headless:false,channel:channel==='chromium'?undefined:channel,viewport:{width:1280,height:900},acceptDownloads:false});
    this.context.on('close',()=>{this.context=null;this.feed=null;this.identity=null;});
    this.feed=this.context.pages()[0] || await this.context.newPage();
    this.feed.setDefaultTimeout(12000);
    await this.feed.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:45000});
  }
  async close() { const c=this.context; this.context=null;this.feed=null;this.identity=null; if(c) await c.close(); }
  async ready(page=this.feed) {
    if(!page || page.isClosed()) throw new BrowserAttention('Открой браузер X и войди в аккаунт.');
    if(/\/i\/(flow\/login|flow\/signup)|\/account\/access|captcha|challenge/i.test(page.url())) throw new BrowserAttention('X требует входа или проверки. Заверши её самостоятельно в окне браузера.');
    if(await page.locator('iframe[src*="captcha"], iframe[src*="arkoselabs"], [data-testid="ocfEnterTextTextInput"]').count()) throw new BrowserAttention('В браузере появилась проверка X. Автоматизация остановлена.');
    const profile = page.getByTestId('AppTabBar_Profile_Link');
    try { await profile.waitFor({state:'visible',timeout:15000}); }
    catch { throw new BrowserAttention('Не удалось подтвердить вход в X. Проверь открытое окно браузера.'); }
    if(await profile.count()!==1) throw new BrowserAttention('Не удалось подтвердить вход в X. Проверь открытое окно браузера.');
    const href=await profile.getAttribute('href');
    const handle=normalizeHandle(href?.split('/').filter(Boolean)[0] || '');
    if(!/^[a-z0-9_]{1,15}$/.test(handle)) throw new BrowserAttention('Не удалось определить аккаунт X.');
    this.identity=handle;
    const expected=normalizeHandle(this.getConfig().browser.account);
    if(!expected) throw new BrowserAttention(`Открыт @${handle}. Укажи этот аккаунт в настройках подключения.`);
    if(expected!==handle) throw new BrowserAttention(`Открыт @${handle}, а в настройках указан @${expected}. Действия остановлены.`);
    return handle;
  }
  async inspect() {
    try { await this.ready(); return {open:true,ready:true,account:this.identity}; }
    catch(e) { return {open:!!this.context,ready:false,account:this.identity,error:e.message}; }
  }
  async scan({limit,previewChars,signal,exclude=()=>false}) {
    checkAbort(signal);
    await this.ready();
    const destination='https://x.com/home';
    if(this.feed.url()!==destination) await this.feed.goto(destination,{waitUntil:'domcontentloaded',timeout:45000});
    else await this.feed.reload({waitUntil:'domcontentloaded',timeout:45000});
    await this.ready();
    const forYou=this.feed.getByRole('tab',{name:/^(For you|Для вас)$/i});
    try { await forYou.waitFor({state:'visible',timeout:15000}); }
    catch { throw new BrowserAttention('В X не найдена вкладка For you / Для вас. Лента не читается, чтобы не перепутать её с Following.'); }
    if(await forYou.count()!==1) throw new BrowserAttention('Вкладка For you / Для вас определена неоднозначно.');
    if(await forYou.getAttribute('aria-selected')!=='true') await forYou.click();
    await this.feed.waitForFunction(()=>[...document.querySelectorAll('[role="tab"]')].some(t=>/^(For you|Для вас)$/i.test(t.textContent.trim()) && t.getAttribute('aria-selected')==='true'),null,{timeout:10000});
    await this.feed.locator('article[data-testid="tweet"]').first().waitFor({timeout:20000});
    const found=new Map();
    for(let round=0;round<6 && found.size<limit;round++) {
      checkAbort(signal);
      const rows=await this.feed.locator('article[data-testid="tweet"]').evaluateAll((cards,{chars})=>cards.map(card=>{
        const time=[...card.querySelectorAll('time')].find(t=>t.closest('article[data-testid="tweet"]')===card);
        const link=time?.closest('a');
        const match=link?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)$/);
        const text=[...card.querySelectorAll('[data-testid="tweetText"]')].find(t=>t.closest('article[data-testid="tweet"]')===card)?.innerText || '';
        const ad=!!card.querySelector('[data-testid="placementTracking"]') || /^(Ad|Реклама|Promoted)$/.test(card.querySelector('[data-testid="socialContext"]')?.innerText || '');
        return match && !ad && text ? {id:match[2],author:match[1].toLowerCase(),url:`https://x.com/${match[1]}/status/${match[2]}`,preview:text.slice(0,chars),hasMedia:!!card.querySelector('[data-testid="tweetPhoto"],video')} : null;
      }).filter(Boolean),{chars:previewChars});
      for(const row of rows) if(row.author!==this.identity && !exclude(row.id)) found.set(row.id,row);
      if(found.size<limit) { await this.feed.mouse.wheel(0,700); await this.feed.waitForTimeout(1000); }
    }
    return [...found.values()].slice(0,limit);
  }
  async visiblePostIds(signal){
    checkAbort(signal);await this.ready();
    if(new URL(this.feed.url()).pathname!=='/home')throw new BrowserAttention('Открыта не лента For you');
    const selected=await this.feed.getByRole('tab',{name:/^(For you|Для вас)$/i}).getAttribute('aria-selected');
    if(selected!=='true')throw new BrowserAttention('Вкладка For you не выбрана');
    return this.feed.locator('article[data-testid="tweet"]').evaluateAll(cards=>[...new Set(cards.map(card=>[...card.querySelectorAll('time')].find(t=>t.closest('article[data-testid="tweet"]')===card)?.closest('a')?.getAttribute('href')?.match(/^\/[A-Za-z0-9_]{1,15}\/status\/(\d+)$/)?.[1]).filter(Boolean))].slice(0,100));
  }
  async notInterested(post,signal){
    statusUrl(post.url);checkAbort(signal);await this.ready();
    if(new URL(this.feed.url()).pathname!=='/home')throw new BrowserAttention('Открыта не лента For you');
    const selected=await this.feed.getByRole('tab',{name:/^(For you|Для вас)$/i}).getAttribute('aria-selected');
    if(selected!=='true')throw new BrowserAttention('Вкладка For you не выбрана');
    const card=this.feed.locator('article[data-testid="tweet"]').filter({has:this.feed.locator(`a[href="/${post.author}/status/${post.id}"] time`)});
    if(await card.count()!==1)throw new BrowserAttention('Целевой пост исчез из For you или показан неоднозначно');
    const identity=await card.evaluate(el=>[...el.querySelectorAll('time')].find(t=>t.closest('article[data-testid="tweet"]')===el)?.closest('a')?.getAttribute('href')?.toLowerCase());
    if(identity!==`/${post.author}/status/${post.id}`)throw new BrowserAttention('Целевой пост не является основным постом карточки');
    const text=await card.evaluate(el=>[...el.querySelectorAll('[data-testid="tweetText"]')].find(t=>t.closest('article[data-testid="tweet"]')===el)?.innerText||'');
    const compact=value=>String(value||'').toLowerCase().replace(/\s+/g,'');
    if(!post.preview || !compact(text).startsWith(compact(post.preview).slice(0,80)))throw new BrowserAttention('Текст поста в ленте не совпал с превью');
    const caret=card.locator('[data-testid="caret"]');
    if(await caret.count()!==1)throw new BrowserAttention('Меню целевого поста неоднозначно');
    await caret.click();
    const menu=this.feed.getByRole('menu');await menu.waitFor({timeout:10000});
    if(await menu.count()!==1)throw new BrowserAttention('Меню X неоднозначно');
    const item=menu.getByRole('menuitem',{name:/^(Not interested in this post|Не интересует этот пост|Не интересно|Неинтересно)$/i});
    if(await item.count()!==1)throw new BrowserAttention('В меню нет пункта «Не интересно»');
    let mayHaveActed=false;
    try{
      await this.ready();checkAbort(signal);mayHaveActed=true;
      await item.click();
      await this.feed.waitForFunction(({id,author})=>{
        const href=`/${author}/status/${id}`;
        const present=[...document.querySelectorAll('article[data-testid="tweet"]')].some(card=>[...card.querySelectorAll('time')].find(t=>t.closest('article[data-testid="tweet"]')===card)?.closest('a')?.getAttribute('href')?.toLowerCase()===href);
        const toast=document.querySelector('[data-testid="toast"]')?.innerText||'';
        return !present || /not interested|fewer posts like this|не интерес|меньше подобных/i.test(toast);
      },{id:post.id,author:post.author},{timeout:15000});
      return 'Пост скрыт из For you';
    }catch(e){e.mayHaveActed=mayHaveActed;throw e;}
  }
  async card(page,id) {
    const cards=page.locator('article[data-testid="tweet"]').filter({has:page.locator(`a[href$="/status/${id}"] time`)});
    await cards.first().waitFor({timeout:20000});
    if(await cards.count()!==1) throw new BrowserAttention('Не удалось однозначно определить пост. Разметка X могла измениться.');
    return cards;
  }
  async read(post,signal) {
    statusUrl(post.url); checkAbort(signal);
    const page=await this.context.newPage();
    try {
      await page.goto(post.url,{waitUntil:'domcontentloaded',timeout:45000});
      await this.ready(page);
      const card=await this.card(page,post.id);
      const textBlocks=card.getByTestId('tweetText');
      const mainIndex=()=>textBlocks.evaluateAll((blocks,preview)=>{
        const compact=value=>String(value||'').toLowerCase().replace(/\s+/g,'');
        const expected=compact(preview).slice(0,80);
        return expected?blocks.findIndex(el=>compact(el.innerText).startsWith(expected)):-1;
      },post.preview);
      let index=await mainIndex();
      if(index<0)throw new BrowserAttention(`Текст выбранного поста не совпал с превью (текстовых блоков: ${await textBlocks.count()}).`);
      let body=textBlocks.nth(index);
      let more=body.getByTestId('tweet-text-show-more-link');
      if(await more.count()===0 && await textBlocks.count()===1)more=card.getByTestId('tweet-text-show-more-link');
      if(await more.count()===1){await more.click();index=await mainIndex();if(index<0)throw new BrowserAttention('После раскрытия текста пост не совпал с превью.');body=textBlocks.nth(index);}
      if(await body.getByTestId('tweet-text-show-more-link').count())throw new BrowserAttention('X не раскрыл полный текст. Пост пропущен.');
      const text=await body.innerText();
      if(text.length>10000) throw new Error('Пост длиннее лимита полного чтения (10 000 знаков). Увеличивать контекст автоматически не будем.');
      // Visible preceding cards are context, never instructions or a source of tool calls.
      const context=await page.locator('article[data-testid="tweet"]').evaluateAll((cards,id)=>{
        const result=[];
        for(const card of cards) {
          const href=card.querySelector('time')?.closest('a')?.getAttribute('href') || '';
          if([...card.querySelectorAll('time')].some(t=>t.closest('a')?.getAttribute('href')?.endsWith(`/status/${id}`))) break;
          const text=card.querySelector('[data-testid="tweetText"]')?.innerText;
          if(text) result.push({url:`https://x.com${href}`,text:text.slice(0,700)});
        }
        return result.slice(-3);
      },post.id);
      checkAbort(signal);
      return {...post,text,context};
    } finally { await page.close(); }
  }
  async perform(kind,post,text,signal) {
    checkAbort(signal);
    if(kind==='notInterested')return this.notInterested(post,signal);
    const page=await this.context.newPage();
    let mayHaveActed=false;
    try {
      let url='https://x.com/compose/post';
      if(kind==='follow') {
        if(!/^[a-z0-9_]{1,15}$/.test(post.author)) throw new Error('Недопустимый автор');
        url=`https://x.com/${post.author}`;
      } else if(kind!=='post') { statusUrl(post.url); url=post.url; }
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
      await this.ready(page);
      if(kind==='like') {
        const card=await this.card(page,post.id);
        if(await card.getByTestId('unlike').count()) return 'Лайк уже установлен';
        checkAbort(signal); mayHaveActed=true;
        await card.getByTestId('like').click();
        await card.getByTestId('unlike').waitFor({state:'visible',timeout:12000});
        return 'Лайк подтверждён интерфейсом X';
      }
      if(kind==='follow') {
        const userActions=page.getByTestId('userActions');
        await userActions.waitFor({timeout:15000});
        if(await userActions.count()!==1) throw new Error('Кнопки профиля неоднозначны');
        const header=userActions.locator('..');
        if(await header.locator('[data-testid$="-unfollow"]').count()) return 'Подписка уже есть';
        const follow=header.locator('[data-testid$="-follow"]');
        if(await follow.count()!==1) throw new Error('Не найдена однозначная кнопка подписки в шапке профиля');
        checkAbort(signal); mayHaveActed=true;
        await follow.click();
        await header.locator('[data-testid$="-unfollow"]').waitFor({state:'visible',timeout:12000});
        return 'Подписка подтверждена интерфейсом X';
      }
      if(kind==='reply') {
        const card=await this.card(page,post.id);
        checkAbort(signal); await card.getByTestId('reply').click();
      }
      const dialog=page.getByRole('dialog');
      const editor=page.getByTestId('tweetTextarea_0');
      await editor.waitFor({timeout:15000});
      if(await editor.count()!==1) throw new Error('Поле публикации неоднозначно');
      await editor.fill(text);
      const button=dialog.getByTestId('tweetButton');
      if(await button.count()!==1 || !await button.isEnabled()) throw new Error('Кнопка публикации не готова');
      await this.ready(page); checkAbort(signal); mayHaveActed=true;
      await button.click();
      // A success toast with a status link proves publication. A closed composer alone does not.
      const receipt=page.locator('[data-testid="toast"] a[href*="/status/"]');
      await receipt.first().waitFor({state:'visible',timeout:15000});
      const href=await receipt.first().getAttribute('href');
      return `Опубликовано: ${new URL(href,'https://x.com').href}`;
    } catch(e) { e.mayHaveActed=mayHaveActed; throw e; }
    finally { await page.close(); }
  }
}
