import test from 'node:test';
import assert from 'node:assert/strict';
import { xPage } from '../chrome-extension/x-page.js';

test('For you feedback selects the exact post and confirms it was hidden',async()=>{
  const previousLocation=globalThis.location,previousDocument=globalThis.document;
  const id='2000000000000000099',preview='A fictional recommendation about phones';
  let menuOpen=false,hidden=false,clicks=0;
  const profile={getAttribute:()=>'/bot_example'};
  const tab={textContent:'For you',getAttribute:()=> 'true'};
  const text={innerText:preview,closest:selector=>selector==='article[data-testid="tweet"]'?card:null};
  const time={closest:selector=>selector==='article[data-testid="tweet"]'?card:selector==='a'?{getAttribute:()=>`/demo_author/status/${id}`}:null};
  const item={innerText:'Not interested in this post',getClientRects:()=>[{}],getAttribute:()=>null,disabled:false,click(){clicks++;hidden=true;menuOpen=false;}};
  const menu={getClientRects:()=>[{}],querySelectorAll:selector=>selector==='[role="menuitem"]'?[item]:[]};
  const caret={closest:()=>card,click(){menuOpen=true;}};
  const card={querySelector:selector=>selector==='time'?time:null,querySelectorAll:selector=>selector==='time'?[time]:selector==='[data-testid="tweetText"]'?[text]:selector==='[data-testid="caret"]'?[caret]:[]};
  globalThis.location={origin:'https://x.com',pathname:'/home',href:'https://x.com/home'};
  globalThis.document={
    querySelector:selector=>selector==='[data-testid="AppTabBar_Profile_Link"]'?profile:null,
    querySelectorAll:selector=>selector==='[role="tab"]'?[tab]:selector==='article[data-testid="tweet"]'?(hidden?[]:[card]):selector==='[role="menu"]'?(menuOpen?[menu]:[]):[]
  };
  try{
    const payload={kind:'notInterested',post:{id,author:'demo_author',preview},account:'bot_example'};
    assert.deepEqual((await xPage('visible',{account:'bot_example'})).data,[id]);
    assert.equal((await xPage('prepare',{...payload,post:{...payload.post,preview:'Different post'}})).ok,false);
    assert.equal(menuOpen,false);
    assert.equal((await xPage('prepare',payload)).ok,true);
    assert.equal(menuOpen,true);
    const sent=await xPage('commit',payload);
    assert.equal(sent.ok,true);assert.equal(clicks,1);
    const receipt=await xPage('receipt',payload);
    assert.equal(receipt.ok,true);assert.match(receipt.data.detail,/For you/);
  }finally{globalThis.location=previousLocation;globalThis.document=previousDocument;}
});
