// Offscreen document - mantém alive durante jobs longos
// Chrome MV3 desliga service worker após 30s, offscreen evita isso

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_KEEP_ALIVE') {
    console.log('[Krever Offscreen] keep alive');
    sendResponse({ ok: true });
  }
  return true;
});

// Ping periódico
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }).catch(()=>{});
}, 20000);
