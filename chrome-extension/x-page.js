// This function is injected in Chrome's isolated world. It accepts a fixed command
// vocabulary, never source code, and never reads browser cookies or credentials.
export async function xPage(op,payload={}) {
  let mayHaveActed=false;
  const diagnostics={replacements:0,steps:[]};
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
    const directTime=card=>[...card.querySelectorAll('time')].find(time=>time.closest('article[data-testid="tweet"]')===card);
    const directText=card=>[...card.querySelectorAll('[data-testid="tweetText"]')].find(body=>body.closest('article[data-testid="tweet"]')===card);
    const hasImage=card=>!!card?.querySelector?.('[data-testid="tweetPhoto"],a[href*="/photo/"],img[src*="pbs.twimg.com/media/"]');
    const feedCardFor=post=>{
      const expected=`/${post.author}/status/${post.id}`;
      const cards=[...document.querySelectorAll('article[data-testid="tweet"]')].filter(card=>directTime(card)?.closest('a')?.getAttribute('href')?.toLowerCase()===expected);
      if(cards.length>1)throw new Error('В ленте несколько копий целевого поста');
      return cards[0]||null;
    };
    const feedTextMatches=(card,preview)=>{
      const compact=value=>String(value||'').toLowerCase().replace(/\s+/g,'');
      return !!preview && compact(directText(card)?.innerText).startsWith(compact(preview).slice(0,80));
    };
    const forYouActive=()=>location.pathname==='/home' && [...document.querySelectorAll('[role="tab"]')].some(tab=>/^(For you|Для вас)$/i.test(tab.textContent.trim()) && tab.getAttribute('aria-selected')==='true');
    const feedbackItem=()=>{
      const menus=[...document.querySelectorAll('[role="menu"]')].filter(menu=>visible(menu));
      if(!menus.length)return null;
      if(menus.length!==1)throw new Error(`Меню X неоднозначно: ${menus.length}`);
      const items=[...menus[0].querySelectorAll('[role="menuitem"]')];
      const matches=items.filter(item=>/^(Not interested in this post|Не интересует этот пост|Не интересно|Неинтересно)$/i.test(item.innerText.trim().replace(/\s+/g,' ')));
      if(matches.length!==1)throw new Error(`Пункт «Не интересно» не найден. Меню: ${items.map(i=>i.innerText.trim()).join(' | ').slice(0,350)}`);
      return matches[0];
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
      if(!['post','follow','notInterested'].includes(payload.kind) && location.pathname!==`/${p.author}/status/${p.id}`)throw new Error('Адрес целевого поста изменился');
    };
    const visible=el=>!!el && el.getClientRects().length>0;
    const noteEditor=(phase,index,editor)=>{
      if(diagnostics.steps.length>=40)return;
      const button=editor?.closest?.('[role="dialog"]')?.querySelector?.('[data-testid="tweetButton"]');
      const content=editor?.innerText??'';
      diagnostics.steps.push({phase,index,length:content.length,sample:content.slice(0,80),textContent:editor?.textContent?.slice(0,80),html:editor?.innerHTML?.slice(0,300),focused:document.activeElement===editor,buttonReady:!!button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'});
    };
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
    const composerDialog=(kind,post)=>{
      // X nests dialog roles. Keep the nearest dialog for each editor so the
      // outer overlay and the actual composer are not counted twice.
      const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(d=>{
        const editor=d.querySelector('[data-testid="tweetTextarea_0"]');
        return editor&&editor.closest('[role="dialog"]')===d;
      });
      if(kind==='reply'){
        const matching=dialogs.filter(d=>replyMatchesTarget(d,post));
        if(matching.length>1){
          const focused=matching.filter(d=>d.contains(document.activeElement));
          if(focused.length===1)return focused[0];
          diagnostics.dialogs=matching.map(d=>({text:d.innerText?.slice(0,160),html:d.outerHTML?.slice(0,300),editor:d.querySelector('[data-testid="tweetTextarea_0"]')?.innerText?.slice(0,80)}));
          throw new Error('Открыто несколько окон ответа на целевой пост');
        }
        if(matching.length===1)return matching[0];
        if(dialogs.length){diagnostics.dialogs=dialogs.map(d=>({text:d.innerText?.slice(0,160),html:d.outerHTML?.slice(0,300)}));throw new Error('Окно ответа не совпадает с целевым постом');}
      }
      if(dialogs.length>1){diagnostics.dialogs=dialogs.map(d=>({text:d.innerText?.slice(0,160),html:d.outerHTML?.slice(0,300)}));throw new Error('Открыто несколько окон публикации X');}
      if(dialogs.length)return dialogs[0];
      // X sometimes renders /compose/post as a page without role="dialog".
      // Find the smallest ancestor that contains this editor, one publish
      // button, and the quoted target post.
      const candidates=[];
      for(const editor of document.querySelectorAll('[data-testid="tweetTextarea_0"]')){
        // X may render the editable host with display: contents, which gives
        // it no client rect even though its children are visible and usable.
        // It can also set aria-hidden on the surrounding page while the
        // composer is open. Require the exact target and one editor/button
        // instead of using that accessibility flag as a visibility test.
        for(let root=editor.parentElement;root && root!==document.body;root=root.parentElement){
          if(root.querySelectorAll('[data-testid="tweetTextarea_0"]').length!==1)break;
          if(root.querySelectorAll('[data-testid="tweetButton"]').length!==1)continue;
          if(kind==='reply'&&!replyMatchesTarget(root,post))continue;
          candidates.push(root);break;
        }
      }
      if(candidates.length>1)throw new Error('Несколько полей публикации подходят к целевому посту');
      return candidates[0]||null;
    };
    const focusEditorEnd=current=>{
      current.focus();
      const selection=document.getSelection?.();
      const range=document.createRange?.();
      if(selection&&range){range.selectNodeContents(current);range.collapse(false);selection.removeAllRanges();selection.addRange(range);}
    };
    blocked();
    if(op==='commit') {
      // No asynchronous wait before the outward click: the connector just checked
      // a live server lease. Account and target are rechecked in the same task.
      if(!identity())throw new Error('Аккаунт больше не подтверждён');
      const {kind,post,text}=payload;let button;
      if(kind==='like') {requireTarget();const card=cardFor(post.id);if(!card)throw new Error('Пост исчез');if(hasImage(card))throw new Error('Пост содержит изображение. Действие отменено.');button=unique('[data-testid="like"]',card);}
      else if(kind==='notInterested'){
        requireTarget();if(!forYouActive())throw new Error('Открыта не лента For you');
        const card=feedCardFor(post);if(!card)throw new Error('Пост исчез из For you');if(hasImage(card))throw new Error('Пост содержит изображение. Действие отменено.');if(!feedTextMatches(card,post.preview))throw new Error('Текст поста не совпал с превью');
        button=feedbackItem();
      }
      else if(kind==='follow') {requireTarget();if(location.pathname.toLowerCase()!==`/${post.author}`)throw new Error('Открыт другой профиль');button=unique('[data-testid$="-follow"]',followHeader());}
      else if(kind==='reply'||kind==='post') {
        if(kind==='reply') {
          if(!post || !/^\d+$/.test(post.id) || !/^[a-z0-9_]{1,15}$/.test(post.author))throw new Error('Некорректная цель ответа');
        } else if(!/^\/compose\/(post|tweet)$/.test(location.pathname))throw new Error('Открыт другой экран');
        const dialog=composerDialog(kind,post);if(!dialog)throw new Error('Не найдено окно публикации');
        if(kind==='reply' && (hasImage(dialog)||hasImage(cardFor(post.id))))throw new Error('Пост содержит изображение. Ответ отменён.');
        const editor=unique('[data-testid="tweetTextarea_0"]',dialog);
        if(editor.innerText.trim()!==text.trim())throw new Error('Текст в редакторе изменился. Отправка отменена.');
        if(kind==='reply' && !replyMatchesTarget(dialog,post))throw new Error('Не удалось подтвердить исходный пост в окне ответа. Отправка отменена.');
        button=unique('[data-testid="tweetButton"]',dialog);
      } else throw new Error('Неизвестное действие');
      if(!visible(button)||button.disabled||button.getAttribute('aria-disabled')==='true')throw new Error('Кнопка действия недоступна');
      mayHaveActed=true;button.click();return {ok:true,data:{clicked:true}};
    }
    const account=await wait(identity,'ссылка профиля текущего аккаунта');
    if(op==='status')return {ok:true,data:{account}};
    if(op==='visible'){
      if(!forYouActive())throw new Error('Открыта не лента For you');
      return {ok:true,data:[...new Set([...document.querySelectorAll('article[data-testid="tweet"]')].filter(card=>!hasImage(card)).map(card=>directTime(card)?.closest('a')?.getAttribute('href')?.match(/^\/[A-Za-z0-9_]{1,15}\/status\/(\d+)$/)?.[1]).filter(Boolean))].slice(0,100)};
    }
    if(op==='editor-check'){
      const {kind,post,expected}=payload;
      if(!['reply','post'].includes(kind)||typeof expected!=='string')throw new Error('Некорректная проверка редактора');
      for(let attempt=0;attempt<8;attempt++){
        const dialog=composerDialog(kind,post);
        if(dialog){
          const editor=unique('[data-testid="tweetTextarea_0"]',dialog);
          if(editor.innerText.trim()===expected.trim()){
            noteEditor('verified',Array.from(expected).length,editor);
            focusEditorEnd(editor);
            return {ok:true,data:{diagnostics}};
          }
          if(attempt===7){noteEditor('text-mismatch',Array.from(expected).length,editor);throw new Error(`Текст редактора изменился на символе ${Array.from(expected).length}: ожидалось ${expected.length}, видно ${editor.innerText.length}. Отправка отменена.`);}
        }
        await sleep(50);
      }
      throw new Error('Поле публикации исчезло. Отправка отменена.');
    }
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
          const href=directTime(card)?.closest('a')?.getAttribute('href');
          const match=href?.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/);
          const text=directText(card)?.innerText;
          if(!match || !text || hasImage(card) || card.querySelector('[data-testid="placementTracking"]') || match[1].toLowerCase()===account)continue;
          results.set(match[2],{id:match[2],author:match[1].toLowerCase(),url:`https://x.com/${match[1].toLowerCase()}/status/${match[2]}`,preview:text.slice(0,payload.previewChars)});
        }
        if(results.size<payload.limit){window.scrollBy(0,700);await sleep(800);}
      }
      return {ok:true,data:[...results.values()].slice(0,payload.limit)};
    }
    if(op==='read') {
      requireTarget();let card=await wait(()=>cardFor(payload.post.id),`пост ${payload.post.id} на странице`);
      if(hasImage(card))return {ok:true,data:{hasImage:true}};
      let body=mainText(card,payload.post.preview);
      const more=body.querySelector?.('[data-testid="tweet-text-show-more-link"]') ||
        (card.querySelectorAll('[data-testid="tweetText"]').length===1?card.querySelector('[data-testid="tweet-text-show-more-link"]'):null);
      if(more){more.click();await sleep(500);card=cardFor(payload.post.id);if(hasImage(card))return {ok:true,data:{hasImage:true}};body=mainText(card,payload.post.preview);if(body.querySelector?.('[data-testid="tweet-text-show-more-link"]'))throw new Error('Не удалось раскрыть полный текст');}
      const text=body.innerText;
      if(text.length>10000)throw new Error('Пост длиннее 10 000 знаков');
      const context=[];for(const other of document.querySelectorAll('article[data-testid="tweet"]')){if(other===card)break;if(hasImage(other))continue;const href=other.querySelector('time')?.closest('a')?.getAttribute('href');const content=other.querySelector('[data-testid="tweetText"]')?.innerText;if(href&&content)context.push({url:'https://x.com'+href,text:content.slice(0,700)});}
      return {ok:true,data:{text,context:context.slice(-3)}};
    }
    if(op==='prepare') {
      const {kind,post,text}=payload;
      if(kind==='like'){requireTarget();const card=await wait(()=>cardFor(post.id),`пост ${post.id} перед лайком`);if(hasImage(card))throw new Error('Пост содержит изображение. Действие отменено.');if(card.querySelector('[data-testid="unlike"]'))return {ok:true,data:{already:true,detail:'Лайк уже установлен'}};unique('[data-testid="like"]',card);}
      else if(kind==='notInterested'){
        requireTarget();if(!forYouActive())throw new Error('Открыта не лента For you');
        const card=feedCardFor(post);if(!card)throw new Error('Пост исчез из For you');if(hasImage(card))throw new Error('Пост содержит изображение. Действие отменено.');if(!feedTextMatches(card,post.preview))throw new Error('Текст поста не совпал с превью');
        const caret=[...card.querySelectorAll('[data-testid="caret"]')].filter(el=>el.closest('article[data-testid="tweet"]')===card);
        if(caret.length!==1)throw new Error('Меню целевого поста не найдено');
        caret[0].click();await wait(()=>[...document.querySelectorAll('[role="menu"]')].find(visible),'меню поста');
        feedbackItem();
      }
      else if(kind==='follow'){requireTarget();if(location.pathname.toLowerCase()!==`/${post.author}`)throw new Error('Открыт другой профиль');await wait(()=>document.querySelector('[data-testid="userActions"]'),'кнопки профиля автора');const header=followHeader();if(header.querySelector('[data-testid$="-unfollow"]'))return {ok:true,data:{already:true,detail:'Подписка уже есть'}};unique('[data-testid$="-follow"]',header);}
      else if(kind==='reply'||kind==='post') {
        if(kind==='reply'&&!composerDialog(kind,post)){requireTarget();const card=await wait(()=>cardFor(post.id),`пост ${post.id} перед ответом`);if(hasImage(card))throw new Error('Пост содержит изображение. Ответ отменён.');unique('[data-testid="reply"]',card).click();}
        let dialog;
        try{dialog=await wait(()=>composerDialog(kind,post),'окно ответа');}
        catch(e){
          const fields=[...document.querySelectorAll('[data-testid="tweetTextarea_0"]')];
          const layout=fields.map(field=>{
            const chain=[];for(let node=field.parentElement;node&&chain.length<6;node=node.parentElement)chain.push(`${node.tagName||'?'}:${node.getAttribute?.('role')||''}:${node.getAttribute?.('data-testid')||''}:${node.querySelectorAll?.('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]').length||0}`);
            return chain.join(' > ');
          }).join(' | ');
          const dialogs=[...document.querySelectorAll('[role="dialog"]')].map(d=>({text:d.innerText?.replace(/\s+/g,' ').slice(0,180),editor:!!d.querySelector('[data-testid="tweetTextarea_0"]'),button:!!d.querySelector('[data-testid="tweetButton"]')}));
          const fieldInfo=fields.map(f=>({rects:f.getClientRects().length,hidden:!!f.closest('[aria-hidden="true"]'),dialog:!!f.closest('[role="dialog"]'),text:f.parentElement?.parentElement?.innerText?.replace(/\s+/g,' ').slice(0,120)}));
          diagnostics.layout={dialogs,fields:fieldInfo};
          const links=[...document.querySelectorAll('a[href*="/status/"]')].map(a=>a.getAttribute('href')).filter(Boolean).slice(0,8);
          throw new Error(`${e.message} Редакторов: ${fields.length}, диалогов: ${dialogs.length}, кнопок: ${document.querySelectorAll('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]').length}. Снимок: ${JSON.stringify({dialogs,fields:fieldInfo,links,chain:layout.slice(0,400)}).slice(0,1500)}`);
        }
        let editor=unique('[data-testid="tweetTextarea_0"]',dialog);
        if(kind==='reply' && (hasImage(dialog)||hasImage(cardFor(post.id))))throw new Error('Пост содержит изображение. Ответ отменён.');
        if(editor.innerText.trim())throw new Error('В редакторе уже есть черновик. Не перезаписываем его.');
        noteEditor('opened',0,editor);
        focusEditorEnd(editor);
        return {ok:true,data:{prepared:true,diagnostics}};
      } else throw new Error('Неизвестное действие');
      return {ok:true,data:{prepared:true,diagnostics}};
    }
    if(op==='receipt') {
      if(payload.kind==='like'){await wait(()=>cardFor(payload.post.id)?.querySelector('[data-testid="unlike"]'),'подтверждение лайка');return {ok:true,data:{detail:'Лайк подтверждён интерфейсом X'}};}
      if(payload.kind==='notInterested'){
        await wait(()=>{
          const card=feedCardFor(payload.post);
          const toast=document.querySelector('[data-testid="toast"]')?.innerText||'';
          return !card || /not interested|fewer posts like this|не интерес|меньше подобных/i.test(toast) ? true : null;
        },'подтверждение пометки «Не интересно»');
        return {ok:true,data:{detail:'Пост скрыт из For you'}};
      }
      if(payload.kind==='follow'){await wait(()=>followHeader().querySelector('[data-testid$="-unfollow"]'),'подтверждение подписки');return {ok:true,data:{detail:'Подписка подтверждена интерфейсом X'}};}
      const link=await wait(()=>document.querySelector('[data-testid="toast"] a[href*="/status/"]'),'ссылка на опубликованный ответ');
      return {ok:true,data:{detail:'Опубликовано: '+link.href}};
    }
    throw new Error('Неизвестная операция');
  } catch(e){return {ok:false,error:e.message,mayHaveActed,diagnostics};}
}
