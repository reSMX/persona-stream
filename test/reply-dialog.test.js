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
  const editor={innerText:reply,getClientRects:()=>[],closest:selector=>selector==='[role="dialog"]'?dialog:null};
  const inlineEditor={innerText:'Unrelated inline draft'};
  const dialog={innerText:`Example @example_author · 9h\n${original}\nReplying to @example_author`,getClientRects:()=>[],querySelector:selector=>selector==='[data-testid="tweetText"]'?quoted:selector==='[data-testid="tweetTextarea_0"]'?editor:null,querySelectorAll:selector=>selector==='[data-testid="tweetButton"]'?[button]:selector==='[data-testid="tweetTextarea_0"]'?[editor]:[]};
  const profile={getAttribute:()=>'/bot_example'};
  globalThis.location={origin:'https://x.com',pathname:'/compose/post',href:'https://x.com/compose/post'};
  globalThis.document={querySelector:selector=>selector==='[data-testid="AppTabBar_Profile_Link"]'?profile:null,querySelectorAll:selector=>selector==='[role="dialog"]'?[dialog]:selector==='[data-testid="tweetTextarea_0"]'?[inlineEditor,editor]:[]};
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

test('reply composer can be a full page without a dialog role',async()=>{
  const previousLocation=globalThis.location,previousDocument=globalThis.document;
  const id='2000000000000000098',original='A fictional post about Japanese writing',reply='Интересная мысль.';
  let clicks=0;
  const link={getAttribute:()=>`/demo_author/status/${id}`};
  const button={disabled:false,getClientRects:()=>[{}],getAttribute:()=>null,click:()=>{clicks++;}};
  const root={innerText:`@demo_author ${original}`,querySelectorAll:selector=>selector==='a[href*="/status/"]'?[link]:selector==='[data-testid="tweetTextarea_0"]'?[editor]:selector==='[data-testid="tweetButton"]'?[button]:[],querySelector:selector=>selector==='[data-testid="tweetText"]'?{innerText:original}:null};
  const editor={innerText:reply,parentElement:root,getClientRects:()=>[{}],focus(){},closest:()=>null};
  const profile={getAttribute:()=>'/bot_example'};
  globalThis.location={origin:'https://x.com',pathname:'/compose/post',href:'https://x.com/compose/post'};
  globalThis.document={body:{},querySelector:selector=>selector==='[data-testid="AppTabBar_Profile_Link"]'?profile:null,querySelectorAll:selector=>selector==='[role="dialog"]'?[]:selector==='[data-testid="tweetTextarea_0"]'?[editor]:[]};
  try{
    const payload={kind:'reply',post:{id,author:'demo_author',originalText:original},text:reply,account:'bot_example'};
    const result=await xPage('commit',payload);
    assert.equal(result.ok,true);assert.equal(clicks,1);
  }finally{globalThis.location=previousLocation;globalThis.document=previousDocument;}
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

test('prepares the target editor and verifies browser-typed characters',async()=>{
  const originalLocation=globalThis.location,originalDocument=globalThis.document;
  const id='2000000000000000004';
  const makeEditor=innerText=>({innerText,getClientRects:()=>[{}],closest:selector=>selector==='[role="dialog"]'?dialog:null,focus(){globalThis.document.activeElement=this;},dispatchEvent(){throw new Error('Synthetic input event must not be sent');}});
  let editor=makeEditor('');
  const dialog={getClientRects:()=>[{}],querySelector:selector=>selector==='[data-testid="tweetTextarea_0"]'?editor:null,querySelectorAll:selector=>selector==='[data-testid="tweetTextarea_0"]'?[editor]:selector==='a[href*="/status/"]'?[{getAttribute:()=>`/demo_author/status/${id}`}]:[]};
  const replyButton={click(){}};
  const time={closest:()=>({getAttribute:()=>`/demo_author/status/${id}`})};
  const card={querySelectorAll:selector=>selector==='time'?[time]:selector==='[data-testid="reply"]'?[replyButton]:[]};
  const profile={getAttribute:()=>'/bot_example'};
  globalThis.location={origin:'https://x.com',pathname:`/demo_author/status/${id}`,href:`https://x.com/demo_author/status/${id}`};
  globalThis.document={
    querySelector:selector=>selector==='[data-testid="AppTabBar_Profile_Link"]'?profile:selector==='[data-testid="tweetTextarea_0"]'?editor:null,
    querySelectorAll:selector=>selector==='article[data-testid="tweet"]'?[card]:selector==='[role="dialog"]'?[dialog]:selector==='[data-testid="tweetTextarea_0"]'?[editor]:[],
    execCommand:()=>{throw new Error('Draft.js duplicates execCommand input');}
  };
  try{
    const payload={kind:'reply',post:{id,author:'demo_author'},text:'да🙂',account:'bot_example'};
    const prepared=await xPage('prepare',payload);
    assert.equal(prepared.ok,true);assert.equal(prepared.data.prepared,true);assert.equal(editor.innerText,'');
    for(const expected of ['д','да','да🙂']){
      editor=makeEditor(expected);
      const checked=await xPage('editor-check',{...payload,expected});
      assert.equal(checked.ok,true);
    }
    editor=makeEditor('');
    const cleared=await xPage('editor-check',{...payload,expected:'да🙂'});
    assert.equal(cleared.ok,false);assert.equal(cleared.mayHaveActed,false);assert.match(cleared.error,/Текст редактора изменился/);
    assert.ok(cleared.diagnostics.steps.some(step=>step.phase==='text-mismatch'));
  }finally{globalThis.location=originalLocation;globalThis.document=originalDocument;}
});
