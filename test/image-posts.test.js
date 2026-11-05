import test from 'node:test';
import assert from 'node:assert/strict';
import { xPage } from '../chrome-extension/x-page.js';

test('For you ignores image posts and refuses to read or like one',async()=>{
  const previousLocation=globalThis.location,previousDocument=globalThis.document,previousWindow=globalThis.window;
  const id='2000000000000000141',plainId='2000000000000000142';
  const profile={getAttribute:()=>'/bot_example'};
  const tab={textContent:'For you',getAttribute:()=> 'true'};
  const makeCard=(postId,image)=>{
    const card={};
    const time={closest:selector=>selector==='article[data-testid="tweet"]'?card:selector==='a'?{getAttribute:()=>`/demo_author/status/${postId}`}:null};
    const body={innerText:'A fictional text post',closest:selector=>selector==='article[data-testid="tweet"]'?card:null};
    card.querySelectorAll=selector=>selector==='time'?[time]:selector==='[data-testid="tweetText"]'?[body]:[];
    card.querySelector=selector=>selector.includes('tweetPhoto')?image?{}:null:null;
    return card;
  };
  const imageCard=makeCard(id,true),plainCard=makeCard(plainId,false);
  globalThis.location={origin:'https://x.com',pathname:'/home',href:'https://x.com/home'};
  globalThis.document={querySelector:selector=>selector==='[data-testid="AppTabBar_Profile_Link"]'?profile:selector==='article[data-testid="tweet"]'?imageCard:null,
    querySelectorAll:selector=>selector==='[role="tab"]'?[tab]:selector==='article[data-testid="tweet"]'?[imageCard,plainCard]:[]};
  globalThis.window={scrollBy(){throw new Error('Unexpected scroll');}};
  try {
    const scan=await xPage('scan',{account:'bot_example',limit:1,previewChars:100});
    assert.deepEqual(scan.data.map(post=>post.id),[plainId]);
    globalThis.location.pathname=`/demo_author/status/${id}`;
    const post={id,author:'demo_author',preview:'A fictional text post'};
    const read=await xPage('read',{account:'bot_example',post});
    assert.deepEqual(read.data,{hasImage:true});
    const like=await xPage('prepare',{account:'bot_example',kind:'like',post});
    assert.equal(like.ok,false);assert.equal(like.mayHaveActed,false);assert.match(like.error,/содержит изображение/);
  } finally {globalThis.location=previousLocation;globalThis.document=previousDocument;globalThis.window=previousWindow;}
});
