/* Krever Resumidor v6 - FIX DEFINITIVO ÁUDIO
   PROBLEMA: blob: URLs são revogados rápido e estão em contexto isolado
   SOLUÇÕES:
   1. Hook URL.createObjectURL + captura direta do Blob objeto (não só URL)
   2. Acesso via Store.Msg.mediaData.mediaBlob (blob já descriptografado)
   3. Auto-play mutado + tentativa de fetch
   4. Fallback manual: download + drag-and-drop
*/

(() => {
  console.log('%c[Krever v6 - Fix Definitivo Áudio]', 'background: #ff6b35; color: #fff; padding: 4px 10px; border-radius: 6px; font-weight: bold;');

  let currentChatId = null;
  let observer = null;
  let lastCount = 0;
  let capturedBlobs = new Map(); // url -> {blob, timestamp}
  let capturedBlobObjects = new Map(); // messageId aproximado -> blob
  let lastAudioBlob = null;
  let panelOpen = false;
  let storeReady = false;

  function q(sel, root = document) { try { return root.querySelector(sel); } catch { return null; } }
  function qa(sel, root = document) { try { return Array.from(root.querySelectorAll(sel)); } catch { return []; } }

  // ===== INJEÇÃO V6 - CAPTURA BLOB OBJETO DIRETO + STORE =====
  function injectHelpers() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        console.log('[Krever Injected v6] Iniciando');
        window.__kreverAudioBlobs = {};
        window.__kreverBlobObjects = {};
        window.__kreverLastAudio = null;
        window.__kreverStore = null;
        window.__kreverMsgCache = {};

        // Hook createObjectURL para capturar BLOB OBJETO (não só URL)
        try {
          const origCreateObjectURL = URL.createObjectURL;
          const origRevokeObjectURL = URL.revokeObjectURL;
          
          URL.createObjectURL = function(blob) {
            const url = origCreateObjectURL.call(this, blob);
            try {
              if (blob && blob.type && (blob.type.startsWith('audio/') || blob.type.includes('ogg') || blob.type.includes('opus') || blob.type.includes('mp3') || blob.type.includes('mpeg') || blob.size > 1000)) {
                // Só captura se parece áudio (tamanho > 1kb e tipo áudio ou tamanho grande)
                if (blob.size > 5000 || (blob.type && blob.type.startsWith('audio/'))) {
                  console.log('[Krever Injected] Audio blob OBJETO capturado:', url, blob.type, blob.size);
                  window.__kreverAudioBlobs[url] = blob;
                  window.__kreverBlobObjects[url] = blob;
                  window.__kreverLastAudio = { url, type: blob.type, size: blob.size, timestamp: Date.now(), blob };
                  // Guarda blob em si para acesso posterior mesmo se URL revogada
                  window.__kreverBlobObjects[Date.now()] = blob;
                  
                  // Tenta converter blob para base64 imediatamente e guardar
                  const reader = new FileReader();
                  reader.onload = function() {
                    try {
                      window.__kreverBlobObjects[url + '_base64'] = reader.result;
                      console.log('[Krever Injected] Blob convertido para base64, tamanho:', reader.result.length);
                    } catch(e) {}
                  };
                  reader.readAsDataURL(blob);
                  
                  window.postMessage({ type: 'KREVER_AUDIO_BLOB', url, mimeType: blob.type, size: blob.size, hasBlob: true }, '*');
                }
              }
            } catch(e) { console.warn('[Krever Injected] Erro hook', e); }
            return url;
          };

          URL.revokeObjectURL = function(url) {
            // Não revoga imediatamente se for nosso blob, guarda antes
            try {
              if (window.__kreverAudioBlobs[url]) {
                console.log('[Krever Injected] Blob URL sendo revogada, mas mantendo objeto:', url);
                // Mantém blob mesmo após revoke
              }
            } catch {}
            return origRevokeObjectURL.call(this, url);
          };
        } catch(e) { console.warn('[Krever Injected] Falha hook createObjectURL', e); }

        // Função para tentar pegar Store de várias formas
        function tryExposeStore() {
          try {
            // Método 1: window.Store
            if (window.Store && (window.Store.Chat || window.Store.Msg)) {
              window.__kreverStore = window.Store;
              console.log('[Krever Injected] window.Store encontrado:', Object.keys(window.Store));
              window.postMessage({ type: 'KREVER_STORE_READY', keys: Object.keys(window.Store), method: 'window.Store' }, '*');
              return true;
            }

            // Método 2: webpackChunk
            if (window.webpackChunkwhatsapp_web_client) {
              try {
                window.webpackChunkwhatsapp_web_client.push([['krever_v6'], {}, (e) => {
                  for (const modId in e.m) {
                    try {
                      const mod = e(modId);
                      if (!mod) continue;
                      const candidates = [mod, mod.default, mod.exports, mod.default?.default].filter(Boolean);
                      for (const cand of candidates) {
                        if (cand.Chat && cand.Msg && !window.__kreverStore) {
                          window.__kreverStore = cand;
                          console.log('[Krever Injected] Store encontrado via webpack (Chat+Msg)');
                          window.postMessage({ type: 'KREVER_STORE_READY', keys: Object.keys(cand), method: 'webpack Chat+Msg' }, '*');
                          return;
                        }
                        if (cand.Msg && cand.Msg.get && !window.__kreverStore?.Msg) {
                          window.__kreverStore = window.__kreverStore || {};
                          window.__kreverStore.Msg = cand.Msg;
                          console.log('[Krever Injected] Store.Msg encontrado via webpack');
                        }
                        if (cand.Chat && cand.Chat.get && !window.__kreverStore?.Chat) {
                          window.__kreverStore = window.__kreverStore || {};
                          window.__kreverStore.Chat = cand.Chat;
                        }
                      }
                    } catch {}
                  }
                }]);
              } catch {}
            }

            // Método 3: require
            if (window.require) {
              const reqNames = ['WAWebCollections', 'WAWebChatCollection', 'WAWebMsgCollection', 'Store'];
              for (const name of reqNames) {
                try {
                  const mod = window.require(name);
                  if (mod) {
                    console.log('[Krever Injected] require(' + name + ') encontrado:', mod);
                    window.__kreverStore = window.__kreverStore || {};
                    window.__kreverStore[name] = mod;
                  }
                } catch {}
              }
            }

            // Método 4: Procura em window
            for (const key in window) {
              try {
                const val = window[key];
                if (val && typeof val === 'object' && val.Msg && val.Chat) {
                  window.__kreverStore = val;
                  console.log('[Krever Injected] Store encontrado em window.' + key);
                  window.postMessage({ type: 'KREVER_STORE_READY', keys: Object.keys(val), method: 'window.' + key }, '*');
                  break;
                }
              } catch {}
            }

          } catch(e) { console.warn('[Krever] Erro expor Store', e); }
          return false;
        }

        // Função para pegar blob de mensagem via Store
        window.__kreverGetMsgBlob = function(messageId) {
          try {
            if (!window.__kreverStore) {
              console.log('[Krever Injected] Store não disponível para getMsgBlob');
              return null;
            }
            const Msg = window.__kreverStore.Msg || window.__kreverStore.MsgCollection || window.Store?.Msg;
            if (!Msg) {
              console.log('[Krever Injected] Msg collection não encontrada');
              return null;
            }
            
            let msg = null;
            try { msg = Msg.get(messageId); } catch {}
            if (!msg) {
              // Tenta buscar em todos os chats
              try {
                const chats = window.__kreverStore.Chat?.models || [];
                for (const chat of chats) {
                  if (chat.msgs && chat.msgs.get) {
                    msg = chat.msgs.get(messageId);
                    if (msg) break;
                  }
                }
              } catch {}
            }
            
            if (!msg) {
              console.log('[Krever Injected] Mensagem não encontrada no Store:', messageId);
              return null;
            }

            console.log('[Krever Injected] Mensagem encontrada:', msg);
            
            // Tenta pegar mediaData
            const mediaData = msg.mediaData || msg.__x_mediaData || msg.__x_data?.mediaData;
            console.log('[Krever Injected] mediaData:', mediaData);
            
            if (mediaData) {
              // mediaBlob já descriptografado
              if (mediaData.mediaBlob && mediaData.mediaBlob._blob) {
                console.log('[Krever Injected] mediaBlob._blob encontrado');
                return mediaData.mediaBlob._blob;
              }
              if (mediaData.mediaBlob && mediaData.mediaBlob.blob) {
                console.log('[Krever Injected] mediaBlob.blob encontrado');
                return mediaData.mediaBlob.blob;
              }
              if (mediaData.mediaBlob instanceof Blob) {
                console.log('[Krever Injected] mediaBlob é Blob direto');
                return mediaData.mediaBlob;
              }
              // URL direta
              if (mediaData.url || mediaData.mediaBlob?.url) {
                console.log('[Krever Injected] URL encontrada:', mediaData.url || mediaData.mediaBlob.url);
                return { url: mediaData.url || mediaData.mediaBlob.url, needsFetch: true };
              }
            }

            // Tenta pegar de outros lugares
            if (msg.__x_mediaBlob) {
              console.log('[Krever Injected] __x_mediaBlob encontrado');
              return msg.__x_mediaBlob;
            }

            return null;
          } catch(e) {
            console.warn('[Krever Injected] Erro getMsgBlob', e);
            return null;
          }
        };

        // Escuta pedidos do content script
        window.addEventListener('message', (event) => {
          if (event.source !== window) return;
          if (event.data?.type === 'KREVER_GET_MSG_BLOB') {
            const messageId = event.data.messageId;
            console.log('[Krever Injected] Pedido de blob para:', messageId);
            const result = window.__kreverGetMsgBlob(messageId);
            if (result) {
              if (result instanceof Blob) {
                console.log('[Krever Injected] Blob encontrado via Store, convertendo para base64');
                const reader = new FileReader();
                reader.onload = () => {
                  window.postMessage({ type: 'KREVER_MSG_BLOB_RESULT', messageId, success: true, base64: reader.result, mimeType: result.type, size: result.size }, '*');
                };
                reader.readAsDataURL(result);
              } else if (result.url && result.needsFetch) {
                window.postMessage({ type: 'KREVER_MSG_BLOB_RESULT', messageId, success: true, url: result.url, needsFetch: true }, '*');
              } else {
                window.postMessage({ type: 'KREVER_MSG_BLOB_RESULT', messageId, success: false, error: 'Formato desconhecido' }, '*');
              }
            } else {
              window.postMessage({ type: 'KREVER_MSG_BLOB_RESULT', messageId, success: false, error: 'Mensagem não encontrada no Store' }, '*');
            }
          }
        });

        tryExposeStore();
        setTimeout(tryExposeStore, 2000);
        setTimeout(tryExposeStore, 5000);
        setTimeout(tryExposeStore, 10000);

        document.addEventListener('play', (e) => {
          if (e.target?.tagName === 'AUDIO' && e.target.src) {
            window.postMessage({ type: 'KREVER_AUDIO_PLAY', src: e.target.src, timestamp: Date.now() }, '*');
          }
        }, true);

        console.log('[Krever Injected v6] Pronto');
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data?.type) return;
      if (data.type === 'KREVER_AUDIO_BLOB') {
        console.log('[Krever Content] Blob capturado:', data.url, data.size);
        lastAudioBlob = data;
        capturedBlobs.set(data.url, { url: data.url, timestamp: Date.now(), size: data.size });
      } else if (data.type === 'KREVER_AUDIO_PLAY') {
        lastAudioBlob = { url: data.src, timestamp: data.timestamp };
        setTimeout(() => captureAllAudioBlobs(), 300);
      } else if (data.type === 'KREVER_STORE_READY') {
        console.log('[Krever Content] Store pronto via', data.method, ':', data.keys);
        storeReady = true;
      } else if (data.type === 'KREVER_MSG_BLOB_RESULT') {
        console.log('[Krever Content] Resultado blob via Store:', data);
        // Será tratado por quem pediu
        window.dispatchEvent(new CustomEvent('krever-msg-blob-result', { detail: data }));
      }
    });
  }

  function captureAllAudioBlobs() {
    const audios = qa('audio[src^="blob:"], audio[src^="https://"]');
    for (const audio of audios) {
      if (audio.src) capturedBlobs.set(audio.src, { element: audio, timestamp: Date.now() });
    }
    qa('[src^="blob:"]').forEach(el => { if (el.src) capturedBlobs.set(el.src, { element: el, timestamp: Date.now() }); });
  }

  function getChatName() {
    const sels = ['header span[data-testid="conversation-info-header-chat-title"]', '#main header span[title]', 'header span[title]', '#main header span'];
    for (const sel of sels) {
      const el = q(sel);
      if (el) {
        const t = (el.getAttribute('title') || el.textContent || '').trim();
        if (t && t.length > 1 && t.length < 100) return t;
      }
    }
    return 'Cliente';
  }

  function getChatId() {
    const name = getChatName();
    const dataId = q('#main')?.querySelector('[data-id]')?.getAttribute('data-id') || '';
    const raw = (dataId || '') + '|' + name + '|' + location.href;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    return Math.abs(hash).toString(16).padStart(24, '0').slice(0, 24);
  }

  function extractMessages() {
    let container = q('div[data-testid="conversation-panel-messages"]') || q('#main') || document.body;
    let msgElements = [];
    let strategy = '';

    const s1 = qa('div.message-in, div.message-out', container);
    if (s1.length > 0) { msgElements = s1; strategy = 'message-in/out'; }

    if (msgElements.length < 2) {
      const s2 = qa('div[data-testid="msg-container"]', container);
      if (s2.length > msgElements.length) { msgElements = s2; strategy = 'msg-container'; }
    }

    if (msgElements.length < 2) {
      const s3 = qa('div[data-id^="true_"], div[data-id^="false_"]', container);
      if (s3.length > 0) {
        const seen = new Set(); const filtered = [];
        for (const el of s3) {
          const id = el.getAttribute('data-id');
          if (!id || seen.has(id)) continue;
          let parent = el.parentElement; let hasAncestor = false;
          while (parent && parent !== container) {
            if (parent.getAttribute && parent.getAttribute('data-id') === id) { hasAncestor = true; break; }
            parent = parent.parentElement;
          }
          if (!hasAncestor) { seen.add(id); filtered.push(el); }
        }
        if (filtered.length > msgElements.length) { msgElements = filtered; strategy = 'data-id'; }
      }
    }

    if (msgElements.length < 2) {
      const s4 = qa('#main div[data-id]', document).filter(el => {
        const id = el.getAttribute('data-id') || ''; return id.includes('_') && id.length > 10;
      });
      if (s4.length > msgElements.length) { msgElements = s4; strategy = 'qualquer-data-id'; }
    }

    if (msgElements.length === 0) return [];

    const uniqueMap = new Map();
    for (const el of msgElements) {
      const id = el.getAttribute('data-id') || el.querySelector('[data-id]')?.getAttribute('data-id') || `tmp_${uniqueMap.size}`;
      if (!uniqueMap.has(id)) uniqueMap.set(id, el);
    }
    msgElements = Array.from(uniqueMap.values());

    const entries = [];
    const now = new Date().toISOString();

    for (let idx = 0; idx < msgElements.length; idx++) {
      const el = msgElements[idx];
      try {
        const dataIdEl = el.getAttribute('data-id') ? el : el.querySelector('[data-id]');
        const dataId = dataIdEl?.getAttribute('data-id') || `msg_${idx}_${Date.now()}`;

        let isFromMe = false;
        if (el.classList.contains('message-out')) isFromMe = true;
        else if (el.classList.contains('message-in')) isFromMe = false;
        else if (dataId.startsWith('true_')) isFromMe = true;
        else if (dataId.startsWith('false_')) isFromMe = false;
        else if (el.closest('.message-out')) isFromMe = true;

        let hasAudio = false;
        const audioSels = ['audio', '[data-testid="audio-play"]', '[data-testid="ptt-play"]', 'span[data-icon="ptt"]', 'div[data-testid="ptt"]', 'canvas'];
        for (const sel of audioSels) { if (el.querySelector(sel)) { hasAudio = true; break; } }
        if (!hasAudio && el.innerHTML.includes('ptt')) hasAudio = true;

        let hasImage = false; let imgEl = null;
        if (!hasAudio) {
          const thumb = el.querySelector('[data-testid="image-thumb"]');
          if (thumb) { hasImage = true; imgEl = thumb.querySelector('img') || thumb; }
          else {
            const imgs = qa('img', el);
            for (const img of imgs) {
              if (img.closest('[data-testid="avatar"]')) continue;
              const src = img.src || '';
              if (src.includes('avatar')) continue;
              if (img.width > 0 && img.width < 60) continue;
              if (src.startsWith('blob:') || src.includes('mmg.whatsapp.net') || src.includes('pps.whatsapp.net')) {
                if (el.querySelector('[data-testid="sticker"]')) continue;
                hasImage = true; imgEl = img; break;
              }
            }
          }
        }

        let text = ''; let type = 'text'; let audioInfo = null; let imageInfo = null;

        if (hasAudio) {
          type = 'audio';
          const audioEl = el.querySelector('audio');
          let src = audioEl?.src || '';
          if (!src) { const blobEl = qa('*', el).find(e => e.src && e.src.startsWith('blob:')); src = blobEl?.src || ''; }
          text = '[Áudio]';
          let seconds = null;
          const durEl = el.querySelector('[data-testid="audio-duration"]');
          if (durEl) { const m = durEl.textContent.match(/(\d+):(\d+)/); if (m) seconds = parseInt(m[1])*60 + parseInt(m[2]); }
          audioInfo = { src: src || 'blob_pending', mimeType: 'audio/ogg', seconds, transcriptionStatus: 'pending', sourceId: dataId };
        } else if (hasImage && imgEl) {
          type = 'image'; const src = imgEl.src || ''; text = '[Imagem]';
          imageInfo = { src, mimeType: 'image/jpeg', analysisStatus: 'pending', sourceId: dataId };
        } else {
          let foundText = '';
          const textSels = ['span[data-testid="msg-text"]', 'div.copyable-text span.selectable-text', '.copyable-text'];
          for (const sel of textSels) {
            const tEl = el.querySelector(sel);
            if (tEl && tEl.innerText && tEl.innerText.trim()) {
              if (tEl.closest('[data-testid="msg-meta"]')) continue;
              foundText = tEl.innerText.trim(); if (foundText) break;
            }
          }
          if (!foundText) {
            const clone = el.cloneNode(true);
            qa('[data-testid="msg-meta"], [data-icon], button', clone).forEach(m => m.remove());
            foundText = (clone.innerText || '').trim().split('\n').filter(l => {
              const t = l.trim(); if (!t) return false;
              if (/^\d{1,2}:\d{2}$/.test(t)) return false;
              if (/^[✓✔]+$/.test(t)) return false; return true;
            }).join('\n').trim();
          }
          text = foundText.slice(0, 30000); if (!text) continue;
        }

        let timestamp = now;
        const prePlain = el.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') || el.getAttribute('data-pre-plain-text');
        if (prePlain) {
          const match = prePlain.match(/\[(\d+):(\d+), (\d+)\/(\d+)\/(\d+)\]/);
          if (match) { const [, hh, mm, dd, MM, yyyy] = match; const d = new Date(`${yyyy}-${MM}-${dd}T${hh}:${mm}:00`); if (!isNaN(d)) timestamp = d.toISOString(); }
        }

        entries.push({
          id: dataId, sourceId: dataId, timestamp, fromMe: isFromMe, sender: isFromMe ? 'Você' : getChatName(), type, text,
          conversationName: getChatName(), jid: getChatId(), audio: audioInfo, image: imageInfo
        });
      } catch (e) { console.warn('[Krever] Erro msg', e); }
    }

    return entries;
  }

  // ===== PAINEL =====
  function createPanel() {
    if (document.getElementById('krever-panel')) return q('#krever-panel');
    const panel = document.createElement('div');
    panel.id = 'krever-panel';
    panel.innerHTML = `
      <div id="krever-panel-header">
        <div>
          <span style="color:#4de0d2; font-size:10px; font-weight:800;">KREVER</span>
          <h3 style="margin:2px 0 0; font-size:14px;">Resumidor</h3>
          <p id="krever-panel-chat" style="font-size:11px; color:#9cafc9; margin:2px 0 0;">Nenhuma conversa</p>
        </div>
        <div style="display:flex; gap:6px;">
          <button id="krever-panel-refresh" title="Atualizar" style="width:28px; height:28px; border:1px solid #243a58; background:#101c2f; color:#e8f0ff; border-radius:6px; cursor:pointer;">↻</button>
          <button id="krever-panel-close" title="Fechar" style="width:28px; height:28px; border:1px solid #243a58; background:#101c2f; color:#e8f0ff; border-radius:6px; cursor:pointer;">✕</button>
        </div>
      </div>
      <div id="krever-panel-stats" style="padding:8px 12px; background:#101c2f; border-bottom:1px solid #243a58; font-size:10px; color:#9cafc9; display:flex; gap:8px; flex-wrap:wrap;">
        <span id="krever-stat-msgs">0 msgs</span>
        <span id="krever-stat-audios">0 áudios</span>
        <span id="krever-stat-blobs" style="color:#4de0d2;">0 blobs</span>
        <span id="krever-stat-store" style="color:${storeReady ? '#4ade80' : '#ff7b89'};">Store: ${storeReady ? 'OK' : 'NÃO'}</span>
      </div>
      <div style="padding:8px; background:#0f1f2f; border-bottom:1px solid #243a58;">
        <p style="font-size:10px; color:#f6c863; margin-bottom:6px;">💡 Áudio não capturou? Arraste arquivo de áudio aqui ou use botão direito no áudio > Salvar como e arraste:</p>
        <div id="krever-drop-zone" style="border:2px dashed #4de0d2; border-radius:8px; padding:12px; text-align:center; font-size:11px; color:#9cafc9; cursor:pointer; background:rgba(77,224,210,0.05);">
          📁 Arraste áudios aqui ou clique para selecionar<br>
          <span style="font-size:9px;">Suporta .ogg, .mp3, .m4a, .wav</span>
          <input type="file" id="krever-file-input" accept="audio/*" multiple style="display:none;">
        </div>
      </div>
      <div id="krever-panel-entries" style="flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:8px; background:rgba(5,13,25,0.6);"></div>
      <div id="krever-panel-actions" style="padding:10px; border-top:1px solid #243a58; background:#101c2f;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
          <button id="krever-btn-transcribe-all" class="krever-btn secondary" style="padding:8px; font-size:11px;">🎙️ Todos áudios</button>
          <button id="krever-btn-analyze-all" class="krever-btn secondary" style="padding:8px; font-size:11px;">🖼️ Todas imgs</button>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:8px;">
          <button id="krever-btn-token" class="krever-btn secondary" style="padding:8px; font-size:11px;">📊 Tokens</button>
          <button id="krever-btn-export" class="krever-btn secondary" style="padding:8px; font-size:11px;">📄 TXT</button>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:10px;">
          <button id="krever-btn-gemini" class="krever-btn secondary" style="padding:8px; font-size:11px;">🔮 Gemini</button>
          <button id="krever-btn-summarize" class="krever-btn primary" style="padding:10px; font-size:12px; font-weight:800;">✨ Gerar Resumo</button>
        </div>
        <div id="krever-token-estimate" style="font-size:10px; color:#9cafc9; margin-bottom:8px;">Tokens: -</div>
        <div id="krever-summary-output" style="background:#091525; border:1px solid #29425f; border-radius:8px; padding:10px; min-height:80px; max-height:150px; overflow-y:auto; font-size:11px; line-height:1.5; white-space:pre-wrap;">Resumo aparecerá aqui</div>
        <button id="krever-btn-copy" style="margin-top:6px; width:100%; padding:6px; background:transparent; border:1px solid #243a58; color:#e8f0ff; border-radius:6px; font-size:10px; cursor:pointer;">📋 Copiar resumo</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #krever-panel { position: fixed; top: 0; right: 0; width: 400px; height: 100vh; background: #08111f; border-left: 2px solid #243a58; z-index: 999999; display: flex; flex-direction: column; font-family: Inter, sans-serif; color: #e8f0ff; box-shadow: -10px 0 30px rgba(0,0,0,0.4); transform: translateX(100%); transition: transform 0.3s ease; }
      #krever-panel.open { transform: translateX(0); }
      #krever-panel-header { padding: 14px 12px 10px; background: linear-gradient(135deg, #101c2f, #14233a); border-bottom: 1px solid #243a58; display: flex; justify-content: space-between; }
      .krever-btn { border-radius: 8px; font-weight: 700; cursor: pointer; border: 1px solid #243a58; color: #e8f0ff; background: transparent; }
      .krever-btn.primary { background: linear-gradient(135deg, #4de0d2, #76a9ff); color: #06111f; border: none; }
      .krever-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .krever-msg { max-width: 80%; padding: 6px 10px; border-radius: 0 10px 10px 10px; background: #1f344f; border: 1px solid #2a4a6b; font-size: 11px; align-self: flex-start; }
      .krever-msg.own { align-self: flex-end; background: linear-gradient(135deg, #0f3a3f, #13424a); border-color: rgba(77,224,210,.35); border-radius: 10px 0 10px 10px; }
      .krever-msg-meta { color: #8fa5c1; font-size: 9px; margin-bottom: 3px; font-weight: 600; }
      .krever-msg.own .krever-msg-meta { color: #7dd8cf; }
      .krever-msg-text { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
      .krever-audio-badge { background: rgba(77,224,210,0.15); color: #4de0d2; font-size: 9px; font-weight: 800; padding: 3px 8px; border-radius: 12px; display: inline-flex; gap: 4px; margin-bottom: 4px; border: 1px solid rgba(77,224,210,0.2); }
      .krever-transcribe-btn { background: #4de0d2; color: #06111f; border: none; padding: 5px 10px; border-radius: 6px; font-size: 10px; font-weight: 800; cursor: pointer; margin-top: 5px; display: inline-block; }
      #krever-drop-zone.dragover { background: rgba(77,224,210,0.15) !important; border-color: #4de0d2 !important; transform: scale(1.02); }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);

    panel.querySelector('#krever-panel-close').onclick = () => togglePanel(false);
    panel.querySelector('#krever-panel-refresh').onclick = () => refreshPanel();
    panel.querySelector('#krever-btn-copy').onclick = async () => {
      const text = panel.querySelector('#krever-summary-output').textContent;
      if (text) { await navigator.clipboard.writeText(text); const btn = panel.querySelector('#krever-btn-copy'); const orig = btn.textContent; btn.textContent = '✅ Copiado!'; setTimeout(() => btn.textContent = orig, 1500); }
    };
    panel.querySelector('#krever-btn-transcribe-all').onclick = () => transcribeAllInPanel();
    panel.querySelector('#krever-btn-analyze-all').onclick = () => analyzeAllInPanel();
    panel.querySelector('#krever-btn-token').onclick = () => estimateTokensInPanel();
    panel.querySelector('#krever-btn-export').onclick = () => exportTxtInPanel();
    panel.querySelector('#krever-btn-gemini').onclick = () => prepareGeminiInPanel();
    panel.querySelector('#krever-btn-summarize').onclick = () => summarizeInPanel();

    // Drop zone para áudio manual
    const dropZone = panel.querySelector('#krever-drop-zone');
    const fileInput = panel.querySelector('#krever-file-input');
    
    dropZone.onclick = () => fileInput.click();
    
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('dragover'); };
    dropZone.ondragleave = () => dropZone.classList.remove('dragover');
    dropZone.ondrop = async (e) => {
      e.preventDefault(); dropZone.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/') || f.name.match(/\.(ogg|mp3|m4a|wav|opus)$/i));
      if (files.length) await handleManualAudioFiles(files);
    };
    
    fileInput.onchange = async (e) => {
      const files = Array.from(e.target.files);
      if (files.length) await handleManualAudioFiles(files);
    };

    return panel;
  }

  async function handleManualAudioFiles(files) {
    const panel = document.getElementById('krever-panel');
    const output = panel.querySelector('#krever-summary-output');
    output.textContent = `Transcrevendo ${files.length} arquivo(s) manual(is)...`;

    let combinedText = '';
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      output.textContent = `Transcrevendo ${i+1}/${files.length}: ${file.name}...`;
      try {
        const buf = await file.arrayBuffer();
        const res = await chrome.runtime.sendMessage({
          type: 'TRANSCRIBE_AUDIO',
          blobData: Array.from(new Uint8Array(buf)),
          mimeType: file.type || 'audio/ogg',
          fileName: file.name,
          conversationId: getChatId(),
          messageId: `manual_${Date.now()}_${i}`
        });
        if (res.success) {
          combinedText += `\n[Áudio ${file.name} transcrito] ${res.result.raw || res.result.text}\n`;
        }
      } catch (e) {
        console.warn('Erro transcrição manual', e);
      }
    }

    if (combinedText) {
      // Adiciona como mensagem na conversa
      const entries = extractMessages();
      entries.push({
        id: `manual_${Date.now()}`,
        sourceId: `manual_${Date.now()}`,
        timestamp: new Date().toISOString(),
        fromMe: false,
        sender: 'Áudios Manuais',
        type: 'text',
        text: combinedText,
        conversationName: getChatName(),
        jid: getChatId()
      });
      chrome.runtime.sendMessage({
        type: 'CONVERSATION_UPDATE',
        payload: { conversationId: getChatId(), conversationName: getChatName(), entries }
      });
      output.textContent = `Transcrição manual concluída:\n${combinedText}\n\nAgora clique em Gerar Resumo para incluir no resumo.`;
      refreshPanel();
    } else {
      output.textContent = 'Falha na transcrição manual';
    }
  }

  function togglePanel(force) {
    const panel = document.getElementById('krever-panel') || createPanel();
    if (typeof force === 'boolean') panelOpen = force; else panelOpen = !panelOpen;
    if (panelOpen) { panel.classList.add('open'); refreshPanel(); } else panel.classList.remove('open');
  }

  function refreshPanel() {
    const entries = extractMessages();
    const panel = document.getElementById('krever-panel'); if (!panel) return;
    panel.querySelector('#krever-panel-chat').textContent = getChatName();
    panel.querySelector('#krever-stat-msgs').textContent = `${entries.length} msgs`;
    panel.querySelector('#krever-stat-audios').textContent = `${entries.filter(e=>e.type==='audio').length} áudios`;
    panel.querySelector('#krever-stat-blobs').textContent = `${capturedBlobs.size} blobs`;
    const storeEl = panel.querySelector('#krever-stat-store');
    if (storeEl) { storeEl.textContent = `Store: ${storeReady ? 'OK' : 'NÃO'}`; storeEl.style.color = storeReady ? '#4ade80' : '#ff7b89'; }

    const container = panel.querySelector('#krever-panel-entries');
    container.innerHTML = '';
    if (!entries.length) { container.innerHTML = '<p style="text-align:center; color:#9cafc9; padding:20px; font-size:11px;">Nenhuma mensagem<br>Selecione conversa</p>'; return; }

    for (const entry of entries.slice(-80)) {
      const div = document.createElement('div');
      div.className = `krever-msg ${entry.fromMe ? 'own' : ''}`;
      div.dataset.messageId = entry.sourceId;
      const meta = document.createElement('div'); meta.className = 'krever-msg-meta';
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
      meta.textContent = `${entry.fromMe ? 'Você' : entry.sender} • ${time}`; div.appendChild(meta);

      if (entry.type === 'audio') {
        const badge = document.createElement('div'); badge.className = 'krever-audio-badge';
        badge.textContent = entry.audio?.transcriptionStatus === 'completed' ? '🎙️ Transcrito' : '🎙️ Áudio'; div.appendChild(badge);
        const text = document.createElement('div'); text.className = 'krever-msg-text'; text.textContent = entry.text || 'Áudio pendente'; div.appendChild(text);
        if (entry.audio?.transcriptionStatus !== 'completed') {
          const btn = document.createElement('button'); btn.className = 'krever-transcribe-btn';
          btn.textContent = '▶️ Transcrever este áudio'; btn.onclick = () => transcribeSingleAudio(entry.sourceId, btn); div.appendChild(btn);
        }
      } else if (entry.type === 'image') {
        const badge = document.createElement('div'); badge.className = 'krever-audio-badge'; badge.style.background = 'rgba(196,168,255,0.15)'; badge.style.color = '#c4a8ff';
        badge.textContent = '🖼️ Imagem'; div.appendChild(badge);
        const text = document.createElement('div'); text.className = 'krever-msg-text'; text.textContent = entry.text || '[Imagem]'; div.appendChild(text);
        if (entry.image?.analysisStatus !== 'completed') {
          const btn = document.createElement('button'); btn.className = 'krever-transcribe-btn'; btn.style.background = '#c4a8ff';
          btn.textContent = '🔍 Analisar'; btn.onclick = () => analyzeSingleImage(entry.sourceId, btn); div.appendChild(btn);
        }
      } else {
        const text = document.createElement('div'); text.className = 'krever-msg-text'; text.textContent = entry.text; div.appendChild(text);
      }
      container.appendChild(div);
    }
    container.scrollTop = container.scrollHeight;
  }

  async function transcribeSingleAudio(messageId, btn) {
    if (!messageId) return;
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '⏳ Buscando...';
    try {
      captureAllAudioBlobs();
      let blob = await getAudioBlob(messageId);
      if (!blob) { btn.textContent = '⏳ Auto-play...'; blob = await getAudioBlobWithAutoPlay(messageId); }
      if (!blob) {
        // Tenta via Store
        btn.textContent = '⏳ Tentando via Store...';
        blob = await getAudioBlobViaStore(messageId);
      }
      if (!blob) throw new Error('Não foi possível capturar. Use o método manual: arraste o arquivo de áudio na área pontilhada acima. Para baixar áudio: clique com botão direito no áudio > Salvar áudio como...');

      btn.textContent = '⏳ Transcrevendo...';
      const buf = await blob.arrayBuffer();
      const res = await chrome.runtime.sendMessage({
        type: 'TRANSCRIBE_AUDIO', blobData: Array.from(new Uint8Array(buf)), mimeType: blob.type || 'audio/ogg',
        fileName: `audio_${messageId}.ogg`, conversationId: getChatId(), messageId
      });

      if (res.success) {
        btn.textContent = '✅ Transcrito!'; btn.style.background = '#4ade80';
        const msgDiv = document.querySelector(`.krever-msg[data-message-id="${CSS.escape(messageId)}"] .krever-msg-text`);
        if (msgDiv) msgDiv.textContent = res.result.text;
        setTimeout(() => refreshPanel(), 800);
      } else throw new Error(res.error);
    } catch (e) { console.error(e); btn.textContent = '❌ Erro'; alert(`Erro: ${e.message}`); setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500); return; }
    btn.disabled = false;
  }

  async function getAudioBlobViaStore(messageId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 4000);
      
      const handler = (event) => {
        if (event.detail?.messageId === messageId) {
          window.removeEventListener('krever-msg-blob-result', handler);
          clearTimeout(timeout);
          const detail = event.detail;
          if (detail.success && detail.base64) {
            try {
              // Converte base64 para blob
              const base64Data = detail.base64.split(',')[1] || detail.base64;
              const mimeType = detail.mimeType || 'audio/ogg';
              const binary = atob(base64Data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              const blob = new Blob([bytes], { type: mimeType });
              console.log('[Krever] Blob obtido via Store:', blob.size);
              resolve(blob);
            } catch (e) {
              console.warn('[Krever] Erro converter base64 Store', e);
              resolve(null);
            }
          } else {
            resolve(null);
          }
        }
      };
      
      window.addEventListener('krever-msg-blob-result', handler);
      window.postMessage({ type: 'KREVER_GET_MSG_BLOB', messageId }, '*');
    });
  }

  async function getAudioBlobWithAutoPlay(messageId) {
    const container = q('#main');
    let msgEl = null;
    try { msgEl = container.querySelector(`div[data-id="${CSS.escape(messageId)}"]`); } catch { msgEl = qa('[data-id]', container).find(el => el.getAttribute('data-id') === messageId); }
    if (!msgEl) return null;

    const playSelectors = ['[data-testid="audio-play"]', '[data-testid="ptt-play"]', 'button[aria-label*="Reproduzir"]', 'span[data-icon="ptt"]'];
    let playBtn = null;
    for (const sel of playSelectors) { playBtn = msgEl.querySelector(sel); if (playBtn) break; }
    
    let audioEl = msgEl.querySelector('audio');
    
    if (audioEl) {
      try {
        console.log('[Krever] Auto-play mutado...');
        const wasMuted = audioEl.muted; const wasVolume = audioEl.volume;
        audioEl.muted = true; audioEl.volume = 0;
        await audioEl.play(); await new Promise(r => setTimeout(r, 1500));
        captureAllAudioBlobs();
        let blob = await getAudioBlob(messageId);
        if (!blob && audioEl.src && audioEl.src.startsWith('blob:')) {
          try { const res = await fetch(audioEl.src); blob = await res.blob(); } catch {}
        }
        audioEl.pause(); audioEl.muted = wasMuted; audioEl.volume = wasVolume;
        if (blob) return blob;
      } catch (e) { console.warn('[Krever] Auto-play falhou', e); }
    }

    if (playBtn) {
      try {
        console.log('[Krever] Clicando play mutado...');
        qa('audio').forEach(a => { a.muted = true; a.volume = 0; });
        playBtn.click(); await new Promise(r => setTimeout(r, 1800));
        captureAllAudioBlobs();
        const blob = await getAudioBlob(messageId);
        qa('audio').forEach(a => { try { a.pause(); } catch {} });
        if (blob) return blob;
      } catch (e) { console.warn('[Krever] Click play falhou', e); }
    }
    return null;
  }

  async function analyzeSingleImage(messageId, btn) {
    const orig = btn.textContent; btn.disabled = true; btn.textContent = '⏳ Analisando...';
    try {
      const container = q('#main');
      let msgEl = null;
      try { msgEl = container?.querySelector(`div[data-id="${CSS.escape(messageId)}"]`); } catch { msgEl = qa('[data-id]', container).find(el => el.getAttribute('data-id') === messageId); }
      let src = msgEl?.querySelector('img')?.src;
      if (!src) throw new Error('Imagem não encontrada');
      let base64, mimeType;
      if (src.startsWith('data:')) { const [h, b64] = src.split(','); base64 = b64; mimeType = h.split(':')[1].split(';')[0]; }
      else { const res = await fetch(src); const blob = await res.blob(); const buf = await blob.arrayBuffer(); let binary = ''; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i+0x8000)); base64 = btoa(binary); mimeType = blob.type || 'image/jpeg'; }
      const res = await chrome.runtime.sendMessage({ type: 'ANALYZE_IMAGE', base64, mimeType, conversationId: getChatId(), messageId });
      if (res.success) { btn.textContent = '✅ Analisada!'; btn.style.background = '#4ade80'; }
      else throw new Error(res.error);
    } catch (e) { btn.textContent = '❌ Erro'; alert(`Erro: ${e.message}`); setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000); return; }
    btn.disabled = false;
  }

  async function transcribeAllInPanel() {
    const entries = extractMessages().filter(e => e.type === 'audio');
    if (!entries.length) return alert('Nenhum áudio');
    if (!confirm(`Transcrever ${entries.length} áudios automaticamente? Vai dar play mutado em cada um.`)) return;
    const btn = document.getElementById('krever-btn-transcribe-all'); btn.disabled = true;
    let success = 0, fail = 0;
    for (let i = 0; i < entries.length; i++) {
      btn.textContent = `⏳ ${i+1}/${entries.length}`;
      try {
        let blob = await getAudioBlob(entries[i].sourceId);
        if (!blob) blob = await getAudioBlobWithAutoPlay(entries[i].sourceId);
        if (!blob) blob = await getAudioBlobViaStore(entries[i].sourceId);
        if (!blob) { fail++; continue; }
        const buf = await blob.arrayBuffer();
        const res = await chrome.runtime.sendMessage({
          type: 'TRANSCRIBE_AUDIO', blobData: Array.from(new Uint8Array(buf)), mimeType: blob.type,
          fileName: `audio_${entries[i].sourceId}.ogg`, conversationId: getChatId(), messageId: entries[i].sourceId
        });
        if (res.success) success++; else fail++;
      } catch { fail++; }
      await new Promise(r => setTimeout(r, 1500));
    }
    btn.disabled = false; btn.textContent = '🎙️ Todos áudios';
    alert(`Transcrição: ${success} ok, ${fail} falha. Se falhou muito, use método manual: arraste arquivos de áudio na área pontilhada.`);
    refreshPanel();
  }

  async function analyzeAllInPanel() {
    const entries = extractMessages().filter(e => e.type === 'image' && e.image?.analysisStatus !== 'completed');
    if (!entries.length) return alert('Nenhuma imagem pendente');
    if (!confirm(`Analisar ${entries.length} imagens?`)) return;
    const btn = document.getElementById('krever-btn-analyze-all'); btn.disabled = true;
    let success = 0;
    for (let i = 0; i < entries.length; i++) {
      btn.textContent = `⏳ ${i+1}/${entries.length}`;
      try {
        const src = entries[i].image?.src; if (!src) continue;
        const res = await fetch(src); const blob = await res.blob(); const buf = await blob.arrayBuffer();
        let binary = ''; const bytes = new Uint8Array(buf);
        for (let j = 0; j < bytes.length; j += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(j, j+0x8000));
        const base64 = btoa(binary);
        const result = await chrome.runtime.sendMessage({ type: 'ANALYZE_IMAGE', base64, mimeType: blob.type, conversationId: getChatId(), messageId: entries[i].sourceId });
        if (result.success) success++;
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    btn.disabled = false; btn.textContent = '🖼️ Todas imgs'; alert(`Análise: ${success} ok`); refreshPanel();
  }

  async function estimateTokensInPanel() {
    const tokenEl = document.getElementById('krever-token-estimate'); tokenEl.textContent = 'Calculando...';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TOKEN_ESTIMATE', conversationId: getChatId(), instructions: null, provider: 'groq' });
      if (res.estimatedInputTokens) tokenEl.textContent = `Tokens: ~${res.estimatedInputTokens.toLocaleString()} + ${res.outputTokenBudget} = ${res.estimatedTotalTokens.toLocaleString()}`;
      else tokenEl.textContent = 'Erro: ' + res.error;
    } catch (e) { tokenEl.textContent = 'Erro: ' + e.message; }
  }

  // Horário SEMPRE em America/Sao_Paulo no TXT/Gemini (timestamp gravado é UTC; ver lib/utils.js).
  function formatKreverTimestamp(value) {
    if (window.KreverUtils?.formatTimestampForExport) return window.KreverUtils.formatTimestampForExport(value);
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
  }

  async function exportTxtInPanel() {
    const entries = extractMessages();
    const content = entries.map(e => `[${formatKreverTimestamp(e.timestamp)}] ${e.sender}: ${e.text}`).join('\n');
    const fileName = `conversa-${getChatName().replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().slice(0,10)}.txt`;
    const blob = new Blob([`CONVERSA: ${getChatName()}\nEXPORTADO EM: ${formatKreverTimestamp(new Date())}\nFUSO HORÁRIO: America/Sao_Paulo (horários abaixo já convertidos para este fuso)\n\n${content}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = fileName; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function prepareGeminiInPanel() {
    const entries = extractMessages();
    const content = entries.map(e => `[${formatKreverTimestamp(e.timestamp)}] ${e.sender}: ${e.text}`).join('\n');
    const fileName = `conversa-${getChatName().replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().slice(0,10)}.txt`;
    const blob = new Blob([`CONVERSA: ${getChatName()}\nEXPORTADO EM: ${formatKreverTimestamp(new Date())}\nFUSO HORÁRIO: America/Sao_Paulo (horários abaixo já convertidos para este fuso)\n\n${content}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
    try {
      const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      const prompt = `Analise o arquivo TXT que vou anexar. Ele contém o histórico de uma conversa de consórcio.\n\n${config.config.instructions || ''}`;
      await navigator.clipboard.writeText(prompt);
      alert(`TXT baixado e prompt copiado!`);
      window.open(config.config.geminiChatUrl || 'https://gemini.google.com/app', '_blank');
    } catch { alert('TXT baixado.'); }
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function summarizeInPanel() {
    const panel = document.getElementById('krever-panel');
    const output = panel.querySelector('#krever-summary-output');
    const btn = panel.querySelector('#krever-btn-summarize');
    btn.disabled = true; btn.textContent = '⏳ Gerando...'; output.textContent = 'Enviando para IA...';
    try {
      const entries = extractMessages(); if (!entries.length) throw new Error('Nenhuma mensagem');
      const transcript = entries.map(e => `[${formatKreverTimestamp(e.timestamp)}] ${e.sender}: ${e.text}`).join('\n');
      const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      const res = await chrome.runtime.sendMessage({ type: 'SUMMARIZE_TEXT', text: transcript, instructions: config.config.instructions, provider: config.config.summaryProvider || 'groq' });
      if (res.success) output.textContent = res.summary; else output.textContent = 'Erro: ' + res.error;
    } catch (e) { output.textContent = 'Erro: ' + e.message; }
    btn.disabled = false; btn.textContent = '✨ Gerar Resumo';
  }

  function injectFloatingButton() {
    if (document.getElementById('krever-floating-btn')) return;
    const header = q('#main header') || q('header[data-testid="chat-info-header"]');
    if (!header) return;
    const btn = document.createElement('button');
    btn.id = 'krever-floating-btn';
    btn.textContent = '📋 Resumidor';
    btn.title = 'Abrir painel Krever - conversa organizada com transcrição manual';
    btn.style.cssText = `margin-left:12px;padding:6px 14px;background:linear-gradient(135deg,#4de0d2,#76a9ff);color:#06111f;border:none;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,0.2);`;
    btn.onclick = () => togglePanel();
    header.appendChild(btn);
  }

  function startObserver() {
    const container = q('div[data-testid="conversation-panel-messages"]') || q('#main');
    if (!container) { setTimeout(startObserver, 2000); return; }
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      const count = qa('div.message-in, div.message-out, div[data-id^="true_"], div[data-id^="false_"]', container).length;
      if (count !== lastCount) { lastCount = count; debounceExtract(); if (panelOpen) refreshPanel(); }
    });
    observer.observe(container, { childList: true, subtree: true });
  }

  let debounceTimer = null;
  function debounceExtract() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const entries = extractMessages();
      if (entries.length) {
        const chatId = getChatId();
        if (chatId !== currentChatId) {
          currentChatId = chatId;
          console.log(`[Krever] Nova conversa: ${getChatName()} id=${chatId} msgs=${entries.length}`);
        }
        chrome.runtime.sendMessage({ type: 'CONVERSATION_UPDATE', payload: { conversationId: chatId, conversationName: getChatName(), entries } }).catch(()=>{});
      }
    }, 600);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'GET_CURRENT_CHAT') {
        const entries = extractMessages();
        sendResponse({ conversationId: getChatId(), conversationName: getChatName(), entries, url: location.href });
      } else if (msg.type === 'SCROLL_FOR_HISTORY') {
        sendResponse(await scrollForHistory(msg.count || 50));
      } else if (msg.type === 'GET_AUDIO_BLOB') {
        captureAllAudioBlobs();
        let blob = await getAudioBlob(msg.messageId);
        if (!blob) blob = await getAudioBlobWithAutoPlay(msg.messageId);
        if (!blob) blob = await getAudioBlobViaStore(msg.messageId);
        if (blob) {
          const buf = await blob.arrayBuffer();
          sendResponse({ success: true, data: Array.from(new Uint8Array(buf)), mimeType: blob.type, size: blob.size });
        } else {
          sendResponse({ success: false, error: 'Não foi possível capturar áudio automaticamente. MÉTODO MANUAL 100% FUNCIONAL: 1) Clique com botão direito no áudio no WhatsApp > Salvar áudio como... 2) Arraste o arquivo salvo para a área pontilhada no painel Resumidor (dentro do WhatsApp) ou use o popup > arraste áudios.' });
        }
      } else if (msg.type === 'GET_IMAGE_BLOB') {
        sendResponse(await getImageBlob(msg.messageId, msg.src));
      } else if (msg.type === 'PING') {
        const entries = extractMessages();
        sendResponse({ ok: true, chat: getChatName(), messages: entries.length, audios: entries.filter(e=>e.type==='audio').length, images: entries.filter(e=>e.type==='image').length, blobs: capturedBlobs.size, store: storeReady, panelOpen });
      } else if (msg.type === 'DEBUG_DOM') {
        sendResponse({
          hasMain: !!q('#main'),
          mainDivs: qa('#main div').length,
          dataIds: qa('[data-id]').length,
          messageInOut: qa('div.message-in, div.message-out').length,
          audioElements: qa('audio').length,
          blobAudios: qa('audio[src^="blob:"]').length,
          capturedBlobs: capturedBlobs.size,
          lastBlob: lastAudioBlob,
          storeReady,
          chatName: getChatName(),
        });
      } else if (msg.type === 'TOGGLE_PANEL') {
        togglePanel(); sendResponse({ ok: true, panelOpen });
      }
    })();
    return true;
  });

  async function scrollForHistory(targetCount) {
    const container = q('div[data-testid="conversation-panel-messages"]') || q('#main div.copyable-area') || q('#main');
    if (!container) return { success: false, error: 'Container não encontrado' };
    const initial = extractMessages().length; let last = initial, attempts = 0;
    return new Promise(resolve => {
      const interval = setInterval(() => {
        container.scrollTop = 0;
        const parent = container.parentElement; if (parent) parent.scrollTop = 0;
        const overflow = q('#main div[tabindex="0"]'); if (overflow) overflow.scrollTop = 0;
        attempts++;
        const current = extractMessages().length;
        if (current > last) last = current;
        if (current >= initial + targetCount || attempts >= 25) {
          clearInterval(interval);
          setTimeout(() => { container.scrollTop = container.scrollHeight; }, 400);
          resolve({ success: true, initialCount: initial, finalCount: current, added: current - initial });
        }
      }, 1200);
    });
  }

  async function getAudioBlob(messageId) {
    captureAllAudioBlobs();
    const container = q('#main'); if (!container) return null;
    let msgEl = null;
    try { msgEl = container.querySelector(`div[data-id="${CSS.escape(messageId)}"]`); } catch { msgEl = qa('[data-id]', container).find(el => el.getAttribute('data-id') === messageId); }
    if (msgEl) {
      const audioEl = msgEl.querySelector('audio');
      if (audioEl && audioEl.src && audioEl.src.startsWith('blob:')) {
        try { const res = await fetch(audioEl.src); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
      }
      const blobEls = qa('[src^="blob:"]', msgEl);
      for (const el of blobEls) {
        try { const res = await fetch(el.src); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
      }
    }
    const allAudioBlobs = qa('audio[src^="blob:"]');
    for (const audio of allAudioBlobs) {
      if (!audio.paused) {
        try { const res = await fetch(audio.src); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
      }
    }
    if (allAudioBlobs.length > 0) {
      const last = allAudioBlobs[allAudioBlobs.length - 1];
      try { const res = await fetch(last.src); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
    }
    return null;
  }

  async function getImageBlob(messageId, providedSrc) {
    try {
      let src = providedSrc;
      if (!src && messageId) {
        const container = q('#main');
        let msgEl = null;
        try { msgEl = container?.querySelector(`div[data-id="${CSS.escape(messageId)}"]`); } catch { msgEl = qa('[data-id]', container).find(el => el.getAttribute('data-id') === messageId); }
        src = msgEl?.querySelector('img')?.src;
      }
      if (!src) return { success: false, error: 'Imagem não encontrada' };
      if (src.startsWith('data:')) { const [h, b64] = src.split(','); return { success: true, base64: b64, mimeType: h.split(':')[1].split(';')[0] }; }
      if (src.startsWith('blob:') || src.startsWith('http')) {
        const res = await fetch(src); const blob = await res.blob(); const buf = await blob.arrayBuffer();
        let binary = ''; const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i+0x8000));
        return { success: true, base64: btoa(binary), mimeType: blob.type || 'image/jpeg', size: blob.size, data: Array.from(bytes) };
      }
      return { success: false, error: 'Src inválido' };
    } catch (e) { return { success: false, error: e.message }; }
  }

  function init() {
    console.log('[Krever] Iniciando v6...');
    injectHelpers();
    const check = setInterval(() => {
      if (q('#main') || q('div[data-testid="chat-list"]')) {
        clearInterval(check);
        console.log('[Krever] WhatsApp detectado v6');
        createPanel();
        startObserver();
        setInterval(injectFloatingButton, 3000);
        debounceExtract();
        setInterval(debounceExtract, 3000);
        setInterval(captureAllAudioBlobs, 3000);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.KreverContent = { extractMessages, getChatName, getChatId, scrollForHistory, getAudioBlob, getImageBlob, togglePanel, refreshPanel };
})();
