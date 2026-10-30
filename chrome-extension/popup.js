document.querySelector('#connect').addEventListener('click',async()=>{
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.url || new URL(tab.url).origin!=='https://x.com')throw new Error('Сначала открой нужную вкладку https://x.com и снова нажми значок расширения.');
    await chrome.tabs.create({url:chrome.runtime.getURL('connector.html')+'?tab='+tab.id});
    window.close();
  } catch(e){document.querySelector('#error').textContent=e.message;}
});
