// This function is injected in Chrome's isolated world. It accepts a fixed command
// vocabulary, never source code, and never reads browser cookies or credentials.
export async function xPage(op,payload={}) {
  let mayHaveActed=false;
  try {
    if(location.origin!=='https://x.com')throw new Error('Выбранная вкладка больше не на x.com');
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const unique=(selector,root=document)=>{const list=[...root.querySelectorAll(selector)];if(list.length!==1)throw new Error(`Неоднозначный элемент X: ${selector}`);return list[0];};
    const wait=async (fn,label='элемент интерфейса')=>{const end=Date.now()+15000;while(Date.now()<end){const result=fn();if(result)return result;await sleep(250);}throw new Error(`Не дождались: ${label}. Экран: ${location.pathname}.`);};
    const blocked=()=>{
      if(/\/i\/(flow\/login|flow\/signup)|\/account\/access|captcha|challenge/i.test(location.href)||document.querySelector('iframe[src*="captcha"],iframe[src*="arkoselabs"],[data-testid="ocfEnterTextTextInput"]'))throw new Error('X требует входа или проверки. Выполни её самостоятельно.');
    };
    const identity=()=>{
      blocked();const href=document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
      const account=href?.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1]?.toLowerCase();
      if(!account)return null;
      if(payload.account && account!==payload.account.replace(/^@/,'').toLowerCase())throw new Error(`Открыт @${account}, ожидается @${payload.account}`);
      return account;
    };
    const cardFor=id=>{
      // A quoted post may contain the first <time> in the outer article. Look
      // through every permalink belonging to this article instead.
      const cards=[...document.querySelectorAll('article[data-testid="tweet"]')].filter(c=>
        [...c.querySelectorAll('time')].some(t=>t.closest('a')?.getAttribute('href')?.match(new RegExp(`^/[A-Za-z0-9_]{1,15}/status/${id}$`)))
      );
      if(cards.length>1)throw new Error('На странице несколько копий целевого поста');return cards[0]||null;
    };
    const mainText=(card,preview)=>{
      const compact=value=>String(value||'').toLowerCase().replace(/\s+/g,'');
      const expected=compact(preview).slice(0,80);
      const blocks=[...card.querySelectorAll('[data-testid="tweetText"]')];
      const match=expected && blocks.find(el=>compact(el.innerText).startsWith(expected));
      if(!match)throw new Error(`Текст выбранного поста не совпал с превью (текстовых блоков: ${blocks.length}).`);
      return match;
    };
    const requireTarget=()=>{
      const p=payload.post;
      if(!p || !/^\d+$/.test(p.id) || !/^[a-z0-9_]{1,15}$/.test(p.author))throw new Error('Некорректная цель');
      if(!['post','follow'].includes(payload.kind) && location.pathname!==`/${p.author}/status/${p.id}`)throw new Error('Адрес целевого поста изменился');
    };
    const visible=el=>!!el && el.getClientRects().length>0;
    const followHeader=()=>unique('[data-testid="userActions"]').parentElement;
    const replyMatchesTarget=(dialog,post)=>{
      const quotedLinks=[...dialog.querySelectorAll('a[href*="/status/"]')];
      if(quotedLinks.some(a=>{
        try {const u=new URL(a.getAttribute('href'),location.origin);return u.origin===location.origin && u.pathname.toLowerCase()===`/${post.author}/status/${post.id}`;}catch{return false;}
      }))return true;
      // X can replace /user/status/id with /compose/post when the reply modal opens.
      // In that case require both the target handle and an exact excerpt of the
      // quoted post. Never infer the target from the compose route alone.
      const original=String(post.originalText||'').replace(/\s+/g,' ').trim();
      const quoted=String(dialog.querySelector('[data-testid="tweetText"]')?.innerText||dialog.innerText||'').replace(/\s+/g,' ').trim();
      return original.length>=24 && quoted.includes(original.slice(0,Math.min(45,original.length))) &&
        new RegExp(`(^|[^A-Za-z0-9_])@${post.author}([^A-Za-z0-9_]|$)`,'i').test(dialog.innerText||'');
    };
    blocked();
    if(op==='commit') {
      // No asynchronous wait before the outward click: the connector just checked
      // a live server lease. Account and target are rechecked in the same task.
      if(!identity())throw new Error('Аккаунт больше не подтверждён');
      const {kind,post,text}=payload;let button;
      if(kind==='like') {requireTarget();const card=cardFor(post.id);if(!card)throw new Error('Пост исчез');button=unique('[data-testid="like"]',card);}
      else if(kind==='follow') {requireTarget();if(location.pathname.toLowerCase()!==`/${post.author}`)throw new Error('Открыт другой профиль');button=unique('[data-testid$="-follow"]',followHeader());}
      else if(kind==='reply'||kind==='post') {
        if(kind==='reply') {
          if(!post || !/^\d+$/.test(post.id) || !/^[a-z0-9_]{1,15}$/.test(post.author))throw new Error('Некорректная цель ответа');
        } else if(!/^\/compose\/(post|tweet)$/.test(location.pathname))throw new Error('Открыт другой экран');
        const editor=unique('[data-testid="tweetTextarea_0"]');
        if(editor.innerText.trim()!==text.trim())throw new Error('Текст в редакторе изменился. Отправка отменена.');
        const dialog=editor.closest('[role="dialog"]');if(!dialog)throw new Error('Не найдено окно публикации');
        if(kind==='reply' && !replyMatchesTarget(dialog,post))throw new Error('Не удалось подтвердить исходный пост в окне ответа. Отправка отменена.');
        button=unique('[data-testid="tweetButton"]',dialog);
      } else throw new Error('Неизвестное действие');
      if(!visible(button)||button.disabled||button.getAttribute('aria-disabled')==='true')throw new Error('Кнопка действия недоступна');
      mayHaveActed=true;button.click();return {ok:true,data:{clicked:true}};
    }
    const account=await wait(identity,'ссылка профиля текущего аккаунта');
    if(op==='status')return {ok:true,data:{account}};
    if(op==='scan') {
      if(location.pathname!=='/home')throw new Error('Открыта не главная лента X');
      const forYou=await wait(()=>{
        const tabs=[...document.querySelectorAll('[role="tab"]')].filter(t=>/^(For you|Для вас)$/i.test(t.textContent.trim()));
        if(tabs.length>1)throw new Error('Неоднозначная вкладка For you');
        return tabs[0];
      },'вкладка For you');
      if(forYou.getAttribute('aria-selected')!=='true')forYou.click();
      await wait(()=>[...document.querySelectorAll('[role="tab"]')].some(t=>/^(For you|Для вас)$/i.test(t.textContent.trim()) && t.getAttribute('aria-selected')==='true'),'переключение на For you');
      await wait(()=>document.querySelector('article[data-testid="tweet"]'),'первый пост в ленте');const results=new Map();
      for(let n=0;n<6 && results.size<payload.limit;n++) {
        blocked();if(identity()!==account)throw new Error('Аккаунт изменился');
        for(const card of document.querySelectorAll('article[data-testid="tweet"]')) {
          const href=card.querySelector('time')?.closest('a')?.getAttribute('href');
          const match=href?.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/);
          const text=card.querySelector('[data-testid="tweetText"]')?.innerText;
          if(!match || !text || card.querySelector('[data-testid="placementTracking"]') || match[1].toLowerCase()===account)continue;
          results.set(match[2],{id:match[2],author:match[1].toLowerCase(),url:`https://x.com/${match[1].toLowerCase()}/status/${match[2]}`,preview:text.slice(0,payload.previewChars)});
        }
        if(results.size<payload.limit){window.scrollBy(0,700);await sleep(800);}
      }
      return {ok:true,data:[...results.values()].slice(0,payload.limit)};
    }
    if(op==='read') {
      requireTarget();let card=await wait(()=>cardFor(payload.post.id),`пост ${payload.post.id} на странице`);
      let body=mainText(card,payload.post.preview);
      const more=body.querySelector?.('[data-testid="tweet-text-show-more-link"]') ||
        (card.querySelectorAll('[data-testid="tweetText"]').length===1?card.querySelector('[data-testid="tweet-text-show-more-link"]'):null);
      if(more){more.click();await sleep(500);card=cardFor(payload.post.id);body=mainText(card,payload.post.preview);if(body.querySelector?.('[data-testid="tweet-text-show-more-link"]'))throw new Error('Не удалось раскрыть полный текст');}
      const text=body.innerText;
      if(text.length>10000)throw new Error('Пост длиннее 10 000 знаков');
      const context=[];for(const other of document.querySelectorAll('article[data-testid="tweet"]')){if(other===card)break;const href=other.querySelector('time')?.closest('a')?.getAttribute('href');const content=other.querySelector('[data-testid="tweetText"]')?.innerText;if(href&&content)context.push({url:'https://x.com'+href,text:content.slice(0,700)});}
      return {ok:true,data:{text,context:context.slice(-3)}};
    }
    if(op==='prepare') {
      const {kind,post,text}=payload;
      if(kind==='like'){requireTarget();const card=await wait(()=>cardFor(post.id),`пост ${post.id} перед лайком`);if(card.querySelector('[data-testid="unlike"]'))return {ok:true,data:{already:true,detail:'Лайк уже установлен'}};unique('[data-testid="like"]',card);}
      else if(kind==='follow'){requireTarget();if(location.pathname.toLowerCase()!==`/${post.author}`)throw new Error('Открыт другой профиль');await wait(()=>document.querySelector('[data-testid="userActions"]'),'кнопки профиля автора');const header=followHeader();if(header.querySelector('[data-testid$="-unfollow"]'))return {ok:true,data:{already:true,detail:'Подписка уже есть'}};unique('[data-testid$="-follow"]',header);}
      else if(kind==='reply'||kind==='post') {
        if(kind==='reply'){requireTarget();const card=await wait(()=>cardFor(post.id),`пост ${post.id} перед ответом`);unique('[data-testid="reply"]',card).click();}
        const editor=await wait(()=>document.querySelector('[data-testid="tweetTextarea_0"]'),'редактор ответа');
        if(editor.innerText.trim())throw new Error('В редакторе уже есть черновик. Не перезаписываем его.');
        editor.focus();
        for(const char of text){
          const current=unique('[data-testid="tweetTextarea_0"]');
          if(current!==editor)throw new Error('X заменил поле публикации во время ввода. Отправка отменена.');
          const command=char==='\n'?'insertLineBreak':'insertText';
          if(!document.execCommand(command,false,char==='\n'?null:char))throw new Error('X не принял ввод в поле публикации. Отправка отменена.');
          await sleep(25);
        }
        if(editor.innerText.trim()!==text.trim())throw new Error('Текст в редакторе не совпал с подготовленным ответом. Отправка отменена.');
        await sleep(700);
        if(unique('[data-testid="tweetTextarea_0"]').innerText.trim()!==text.trim())throw new Error('X очистил текст ответа до отправки. Отправка отменена.');
      } else throw new Error('Неизвестное действие');
      return {ok:true,data:{prepared:true}};
    }
    if(op==='receipt') {
      if(payload.kind==='like'){await wait(()=>cardFor(payload.post.id)?.querySelector('[data-testid="unlike"]'),'подтверждение лайка');return {ok:true,data:{detail:'Лайк подтверждён интерфейсом X'}};}
      if(payload.kind==='follow'){await wait(()=>followHeader().querySelector('[data-testid$="-unfollow"]'),'подтверждение подписки');return {ok:true,data:{detail:'Подписка подтверждена интерфейсом X'}};}
      const link=await wait(()=>document.querySelector('[data-testid="toast"] a[href*="/status/"]'),'ссылка на опубликованный ответ');
      return {ok:true,data:{detail:'Опубликовано: '+link.href}};
    }
    throw new Error('Неизвестная операция');
  } catch(e){return {ok:false,error:e.message,mayHaveActed};}
}
