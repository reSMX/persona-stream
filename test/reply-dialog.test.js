import test from 'node:test';
import assert from 'node:assert/strict';
import { xPage } from '../chrome-extension/x-page.js';

test('reply modal may change the X URL, but exact quoted post and account still permit sending',async()=>{
  const originalLocation=globalThis.location,originalDocument=globalThis.document;
  let clicks=0;
  const original='A fictional post about a new local model release';
  const reply='Думаю, сюжет можно повернуть интереснее.';
  const button={disabled:false,getClientRects:()=>[{}],getAttribute:()=>null,click:()=>{clicks++;}};
  const quoted={innerText:original};
  const dialog={innerText:`Example @example_author · 9h\n${original}\nReplying to @example_author`,querySelector:selector=>selector==='[data-testid="tweetText"]'?quoted:null,querySelectorAll:selector=>selector==='[data-testid="tweetButton"]'?[button]:[]};
  const editor={innerText:reply,closest:selector=>selector==='[role="dialog"]'?dialog:null};
  const profile={getAttribute:()=>'/bot_example'};
  globalThis.location={origin:'https://x.com',pathname:'/compose/post',href:'https://x.com/compose/post'};
  globalThis.document={querySelector:selector=>selector==='[data-testid="AppTabBar_Profile_Link"]'?profile:null,querySelectorAll:selector=>selector==='[data-testid="tweetTextarea_0"]'?[editor]:[]};
  try {
    const base={kind:'reply',post:{id:'2000000000000000001',author:'example_author',originalText:original},text:reply,account:'bot_example'};
    const sent=await xPage('commit',base);
    assert.deepEqual(sent,{ok:true,data:{clicked:true}});assert.equal(clicks,1);
    const wrong=await xPage('commit',{...base,post:{...base.post,originalText:'A different post with a different topic'}});
    assert.equal(wrong.ok,false);assert.equal(wrong.mayHaveActed,false);assert.equal(clicks,1);
    const otherAccount=await xPage('commit',{...base,account:'somebodyelse'});
    assert.equal(otherAccount.ok,false);assert.equal(otherAccount.mayHaveActed,false);assert.equal(clicks,1);
  } finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});

test('reads the main text when a quote has its own timestamp and tweetText',async()=>{
  const originalLocation=globalThis.location,originalDocument=globalThis.document;
  const id='2000000000000000002';
  const quotedTime={closest:()=>({getAttribute:()=>'/quoted/status/2000000000000000003'})};
  const targetTime={closest:()=>({getAttribute:()=>`/demo_author/status/${id}`})};
  const body={innerText:'A fictional post with a quoted video'};
  const quotedBody={innerText:'The quoted post says something entirely different'};
  const card={
    querySelector:()=>null,
    querySelectorAll:selector=>selector==='time'?[quotedTime,targetTime]:selector==='[data-testid="tweetText"]'?[quotedBody,body]:[]
  };
  const profile={getAttribute:()=>'/bot_example'};
  globalThis.location={origin:'https://x.com',pathname:`/demo_author/status/${id}`,href:`https://x.com/demo_author/status/${id}`};
  globalThis.document={
    querySelector:selector=>selector==='[data-testid="AppTabBar_Profile_Link"]'?profile:null,
    querySelectorAll:selector=>selector==='article[data-testid="tweet"]'?[card]:[]
  };
  try{
    const result=await xPage('read',{post:{id,author:'demo_author',preview:body.innerText},account:'bot_example'});
    assert.deepEqual(result,{ok:true,data:{text:body.innerText,context:[]}});
    const mismatch=await xPage('read',{post:{id,author:'demo_author',preview:'A different preview'},account:'bot_example'});
    assert.equal(mismatch.ok,false);assert.match(mismatch.error,/не совпал с превью/);
  }finally{globalThis.location=originalLocation;globalThis.document=originalDocument;}
});

test('types a reply character by character and stops if X clears the editor',async()=>{
  const originalLocation=globalThis.location,originalDocument=globalThis.document;
  const id='2000000000000000004',typed=[];
  let clearAfterTyping=false;
  const editor={innerText:'',focus(){},dispatchEvent(){throw new Error('Synthetic input event must not be sent');}};
  const replyButton={click(){}};
  const time={closest:()=>({getAttribute:()=>`/demo_author/status/${id}`})};
  const card={querySelectorAll:selector=>selector==='time'?[time]:selector==='[data-testid="reply"]'?[replyButton]:[]};
  const profile={getAttribute:()=>'/bot_example'};
  globalThis.location={origin:'https://x.com',pathname:`/demo_author/status/${id}`,href:`https://x.com/demo_author/status/${id}`};
  globalThis.document={
    querySelector:selector=>selector==='[data-testid="AppTabBar_Profile_Link"]'?profile:selector==='[data-testid="tweetTextarea_0"]'?editor:null,
    querySelectorAll:selector=>selector==='article[data-testid="tweet"]'?[card]:selector==='[data-testid="tweetTextarea_0"]'?[editor]:[],
    execCommand:(command,_ui,char)=>{
      typed.push([command,char]);editor.innerText+=char;
      if(clearAfterTyping && typed.length===3)setTimeout(()=>{editor.innerText='';},100);
      return true;
    }
  };
  try{
    const payload={kind:'reply',post:{id,author:'demo_author'},text:'да🙂',account:'bot_example'};
    assert.deepEqual(await xPage('prepare',payload),{ok:true,data:{prepared:true}});
    assert.deepEqual(typed,[['insertText','д'],['insertText','а'],['insertText','🙂']]);
    editor.innerText='';typed.length=0;clearAfterTyping=true;
    const cleared=await xPage('prepare',payload);
    assert.equal(cleared.ok,false);assert.equal(cleared.mayHaveActed,false);assert.match(cleared.error,/очистил текст/);
  }finally{globalThis.location=originalLocation;globalThis.document=originalDocument;}
});
