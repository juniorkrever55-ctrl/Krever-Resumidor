/* Krever Resumidor - Content Script v4
   FIXES:
   - Áudio: captura blob via hook de URL.createObjectURL + busca global
   - Botão Resumidor: abre painel lateral dentro do WhatsApp Web
   - Transcrição manual por áudio no painel
*/

(() => {
  console.log('%c[Krever] Content script v4 - Painel + Blob Capture', 'background: #4de0d2; color: #000; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;');

  let currentChatId = null;
  let observer = null;
  let lastCount = 0;
  let capturedBlobs = new Map(); // url -> blob
  let lastAudioBlob = null;
  let panelOpen = false;

  // Helpers
  function q(sel, root = document) { try { return root.querySelector(sel); } catch { return null; } }
  function qa(sel, root = document) { try { return Array.from(root.querySelectorAll(sel)); } catch { return []; } }

  // ===== BLOB CAPTURE - Injeta no contexto da página =====
  function injectBlobCapture() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        console.log('[Krever Injected] Hook de blob iniciado');
        window.__kreverAudioBlobs = window.__kreverAudioBlobs || {};
        window.__kreverLastAudio = null;
        window.__kreverBlobMap = {};

        // Hook URL.createObjectURL
        const originalCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function(blob) {
          const url = originalCreateObjectURL.call(this, blob);
          try {
            if (blob && blob.type && blob.type.startsWith('audio/')) {
              console.log('[Krever Injected] Audio blob capturado:', url, blob.type, blob.size);
              window.__kreverAudioBlobs[url] = blob;
              window.__kreverLastAudio = { url, type: blob.type, size: blob.size, timestamp: Date.now() };
              window.__kreverBlobMap[url] = { blob, timestamp: Date.now() };
              window.postMessage({ type: 'KREVER_AUDIO_BLOB', url, mimeType: blob.type, size: blob.size }, '*');
            }
          } catch(e) {}
          return url;
        };

        // Hook para capturar quando áudio começa a tocar
        document.addEventListener('play', function(e) {
          if (e.target && e.target.tagName === 'AUDIO') {
            const src = e.target.src;
            if (src && src.startsWith('blob:')) {
              console.log('[Krever Injected] Audio play detectado:', src);
              window.postMessage({ type: 'KREVER_AUDIO_PLAY', src, timestamp: Date.now() }, '*');
            }
          }
        }, true);

        // Observa novos elementos audio
        const observer = new MutationObserver((mutations) => {
          for (const mut of mutations) {
            for (const node of mut.addedNodes) {
              if (node.tagName === 'AUDIO' && node.src && node.src.startsWith('blob:')) {
                console.log('[Krever Injected] Novo audio element com blob:', node.src);
                window.postMessage({ type: 'KREVER_AUDIO_ELEMENT', src: node.src }, '*');
              }
              if (node.querySelectorAll) {
                const audios = node.querySelectorAll('audio[src^=\"blob:\"]');
                audios.forEach(a => {
                  console.log('[Krever Injected] Audio encontrado em mutação:', a.src);
                  window.postMessage({ type: 'KREVER_AUDIO_ELEMENT', src: a.src }, '*');
                });
              }
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        console.log('[Krever Injected] Hook pronto');
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();

    // Escuta mensagens do script injetado
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.type === 'KREVER_AUDIO_BLOB') {
        console.log('[Krever Content] Blob capturado via postMessage:', event.data.url);
        lastAudioBlob = event.data;
      } else if (event.data?.type === 'KREVER_AUDIO_PLAY') {
        console.log('[Krever Content] Play detectado:', event.data.src);
        lastAudioBlob = { url: event.data.src, timestamp: event.data.timestamp };
        // Tenta capturar blob imediatamente
        setTimeout(() => captureAllAudioBlobs(), 500);
      } else if (event.data?.type === 'KREVER_AUDIO_ELEMENT') {
        console.log('[Krever Content] Audio element detectado:', event.data.src);
        captureAllAudioBlobs();
      }
    });
  }

  function captureAllAudioBlobs() {
    const audios = qa('audio[src^="blob:"]');
    console.log(`[Krever] Capturando ${audios.length} blobs de áudio do DOM`);
    for (const audio of audios) {
      const src = audio.src;
      if (src && src.startsWith('blob:')) {
        capturedBlobs.set(src, { element: audio, timestamp: Date.now() });
      }
    }
    // Também procura qualquer elemento com src blob:
    const allBlobSrc = qa('[src^="blob:"]');
    for (const el of allBlobSrc) {
      const src = el.src;
      if (src && src.startsWith('blob:')) {
        capturedBlobs.set(src, { element: el, timestamp: Date.now() });
      }
    }
    console.log(`[Krever] Total blobs capturados: ${capturedBlobs.size}`);
  }

  // ===== CHAT INFO =====
  function getChatName() {
    const selectors = [
      'header span[data-testid="conversation-info-header-chat-title"]',
      '#main header span[title]',
      'div[data-testid="chat-info-drawer"] span[title]',
      '#main header div[data-testid="conversation-info-header"] span',
      'header span[title]',
      '#main header span',
      'header div span',
    ];
    for (const sel of selectors) {
      const el = q(sel);
      if (el) {
        const t = (el.getAttribute('title') || el.textContent || '').trim();
        if (t && t.length > 1 && t.length < 100 && !t.includes('clique') && !t.includes('mensagem')) {
          return t;
        }
      }
    }
    return 'Cliente';
  }

  function getChatId() {
    const name = getChatName();
    const main = q('#main');
    const dataId = main?.querySelector('[data-id]')?.getAttribute('data-id') || '';
    const raw = (dataId || '') + '|' + name + '|' + (window.location.href || '');
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    return Math.abs(hash).toString(16).padStart(24, '0').slice(0, 24);
  }

  // ===== EXTRAÇÃO ULTRA ROBUSTA =====
  function extractMessages() {
    let container = null;
    const containerSelectors = [
      'div[data-testid="conversation-panel-messages"]',
      '#main div[data-testid="conversation-panel-messages"]',
      '#main div.copyable-area',
      '#main',
      'div#main',
    ];
    for (const sel of containerSelectors) {
      const el = q(sel);
      if (el) { container = el; break; }
    }
    if (!container) container = document.body;

    let msgElements = [];
    let strategyUsed = '';

    const strategyA = qa('div.message-in, div.message-out', container);
    if (strategyA.length > 0) { msgElements = strategyA; strategyUsed = 'A-message-in/out'; }

    if (msgElements.length < 3) {
      const strategyB = qa('div[data-testid="msg-container"]', container);
      if (strategyB.length > msgElements.length) { msgElements = strategyB; strategyUsed = 'B-msg-container'; }
    }

    if (msgElements.length < 3) {
      const strategyC = qa('div[data-id^="true_"], div[data-id^="false_"]', container);
      if (strategyC.length > 0) {
        const seen = new Set(); const filtered = [];
        for (const el of strategyC) {
          const id = el.getAttribute('data-id');
          if (!id || seen.has(id)) continue;
          let parent = el.parentElement; let hasAncestor = false;
          while (parent && parent !== container && parent !== document.body) {
            if (parent.getAttribute && parent.getAttribute('data-id') === id) { hasAncestor = true; break; }
            parent = parent.parentElement;
          }
          if (!hasAncestor) { seen.add(id); filtered.push(el); }
        }
        if (filtered.length > msgElements.length) { msgElements = filtered; strategyUsed = 'C-data-id'; }
      }
    }

    if (msgElements.length < 3) {
      const allDataId = qa('#main div[data-id]', document).filter(el => {
        const id = el.getAttribute('data-id') || ''; return id.includes('_') && id.length > 10;
      });
      if (allDataId.length > msgElements.length) { msgElements = allDataId; strategyUsed = 'D-qualquer-data-id'; }
    }

    if (msgElements.length < 3) {
      const textSpans = qa('span[data-testid="msg-text"], div.copyable-text', container);
      const parents = new Set(); const filtered = [];
      for (const span of textSpans) {
        let parent = span.parentElement; let depth = 0;
        while (parent && depth < 8) {
          if (parent.getAttribute && parent.getAttribute('data-id')) {
            const id = parent.getAttribute('data-id');
            if (!parents.has(id)) { parents.add(id); filtered.push(parent); }
            break;
          }
          if (parent.classList && (parent.classList.contains('message-in') || parent.classList.contains('message-out'))) {
            const id = parent.getAttribute('data-id') || `text_parent_${filtered.length}`;
            if (!parents.has(id)) { parents.add(id); filtered.push(parent); }
            break;
          }
          parent = parent.parentElement; depth++;
        }
      }
      if (filtered.length > msgElements.length) { msgElements = filtered; strategyUsed = 'E-text-parent'; }
    }

    if (msgElements.length === 0) {
      console.warn('[Krever] Nenhuma mensagem encontrada');
      return [];
    }

    const uniqueMap = new Map();
    for (const el of msgElements) {
      const id = el.getAttribute('data-id') || el.querySelector('[data-id]')?.getAttribute('data-id') || `tmp_${Math.random().toString(36).slice(2)}_${uniqueMap.size}`;
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
        else if (el.closest('.message-in')) isFromMe = false;

        // ÁUDIO
        let hasAudio = false;
        const audioSelectors = ['audio', '[data-testid="audio-play"]', '[data-testid="ptt-play"]', 'span[data-icon="ptt"]', 'span[data-icon="audio-play"]', 'div[data-testid="audio-player"]', 'div[data-testid="ptt"]', 'canvas'];
        for (const sel of audioSelectors) { if (el.querySelector(sel)) { hasAudio = true; break; } }
        if (!hasAudio) {
          const html = el.innerHTML || '';
          if (html.includes('data-icon="ptt"') || html.includes('audio-play')) hasAudio = true;
        }

        // IMAGEM
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
          const textSels = ['span[data-testid="msg-text"]', 'div.copyable-text span.selectable-text', '.copyable-text', 'span.selectable-text'];
          for (const sel of textSels) {
            const tEl = el.querySelector(sel);
            if (tEl && tEl.innerText && tEl.innerText.trim()) {
              if (tEl.closest('[data-testid="msg-meta"]')) continue;
              foundText = tEl.innerText.trim(); if (foundText) break;
            }
          }
          if (!foundText) {
            const clone = el.cloneNode(true);
            qa('[data-testid="msg-meta"], [data-testid="msg-info"], [data-icon], button', clone).forEach(m => m.remove());
            foundText = (clone.innerText || '').trim();
            foundText = foundText.split('\n').filter(l => {
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

        const sender = isFromMe ? 'Você' : getChatName();

        entries.push({
          id: dataId, sourceId: dataId, timestamp, fromMe: isFromMe, sender, type, text,
          conversationName: getChatName(), jid: getChatId(), audio: audioInfo, image: imageInfo
        });
      } catch (e) { console.warn('[Krever] Erro extrair msg', e); }
    }

    console.log(`[Krever] Extração: ${entries.length} msgs (${entries.filter(e=>e.type==='text').length} texto, ${entries.filter(e=>e.type==='audio').length} áudio, ${entries.filter(e=>e.type==='image').length} imagem) via ${strategyUsed}`);
    return entries;
  }

  // ===== PAINEL LATERAL RESUMIDOR DENTRO DO WHATSAPP =====
  function createResumidorPanel() {
    if (document.getElementById('krever-panel')) return document.getElementById('krever-panel');

    const panel = document.createElement('div');
    panel.id = 'krever-panel';
    panel.innerHTML = `
      <div id="krever-panel-header">
        <div>
          <span style="color:#4de0d2; font-size:10px; font-weight:800; letter-spacing:0.1em;">KREVER</span>
          <h3 style="margin:2px 0 0; font-size:14px;">Resumidor</h3>
          <p id="krever-panel-chat" style="font-size:11px; color:#9cafc9; margin:2px 0 0;">Nenhuma conversa</p>
        </div>
        <div style="display:flex; gap:6px;">
          <button id="krever-panel-refresh" title="Atualizar" style="width:28px; height:28px; border:1px solid #243a58; background:#101c2f; color:#e8f0ff; border-radius:6px; cursor:pointer;">↻</button>
          <button id="krever-panel-close" title="Fechar" style="width:28px; height:28px; border:1px solid #243a58; background:#101c2f; color:#e8f0ff; border-radius:6px; cursor:pointer;">✕</button>
        </div>
      </div>
      <div id="krever-panel-stats" style="padding:8px 12px; background:#101c2f; border-bottom:1px solid #243a58; font-size:10px; color:#9cafc9; display:flex; gap:10px;">
        <span id="krever-stat-msgs">0 msgs</span>
        <span id="krever-stat-audios">0 áudios</span>
        <span id="krever-stat-images">0 imgs</span>
      </div>
      <div id="krever-panel-entries" style="flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:8px; background:rgba(5,13,25,0.6);">
        <p style="text-align:center; color:#9cafc9; padding:20px; font-size:11px;">Carregando conversa...</p>
      </div>
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
        <div id="krever-summary-output" style="background:#091525; border:1px solid #29425f; border-radius:8px; padding:10px; min-height:80px; max-height:150px; overflow-y:auto; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-word;">Resumo aparecerá aqui</div>
        <button id="krever-btn-copy" style="margin-top:6px; width:100%; padding:6px; background:transparent; border:1px solid #243a58; color:#e8f0ff; border-radius:6px; font-size:10px; cursor:pointer;">📋 Copiar resumo</button>
      </div>
    `;

    // Estilos do painel
    const style = document.createElement('style');
    style.textContent = `
      #krever-panel {
        position: fixed;
        top: 0;
        right: 0;
        width: 380px;
        height: 100vh;
        background: #08111f;
        border-left: 2px solid #243a58;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        font-family: Inter, sans-serif;
        color: #e8f0ff;
        box-shadow: -10px 0 30px rgba(0,0,0,0.4);
        transform: translateX(100%);
        transition: transform 0.3s ease;
      }
      #krever-panel.open { transform: translateX(0); }
      #krever-panel-header {
        padding: 14px 12px 10px;
        background: linear-gradient(135deg, #101c2f, #14233a);
        border-bottom: 1px solid #243a58;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .krever-btn {
        border-radius: 8px;
        font-weight: 700;
        cursor: pointer;
        border: 1px solid #243a58;
        text-align: center;
        color: #e8f0ff;
        background: transparent;
      }
      .krever-btn.primary {
        background: linear-gradient(135deg, #4de0d2, #76a9ff);
        color: #06111f;
        border: none;
      }
      .krever-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .krever-msg {
        max-width: 80%;
        padding: 6px 10px;
        border-radius: 0 10px 10px 10px;
        background: #1f344f;
        border: 1px solid #2a4a6b;
        font-size: 11px;
        align-self: flex-start;
        position: relative;
      }
      .krever-msg.own {
        align-self: flex-end;
        background: linear-gradient(135deg, #0f3a3f, #13424a);
        border-color: rgba(77,224,210,.35);
        border-radius: 10px 0 10px 10px;
      }
      .krever-msg-meta { color: #8fa5c1; font-size: 9px; margin-bottom: 3px; font-weight: 600; }
      .krever-msg.own .krever-msg-meta { color: #7dd8cf; }
      .krever-msg-text { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
      .krever-audio-badge {
        background: rgba(77,224,210,0.15);
        color: #4de0d2;
        font-size: 9px;
        font-weight: 800;
        padding: 3px 8px;
        border-radius: 12px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 4px;
        border: 1px solid rgba(77,224,210,0.2);
      }
      .krever-transcribe-btn {
        background: #4de0d2;
        color: #06111f;
        border: none;
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 9px;
        font-weight: 800;
        cursor: pointer;
        margin-top: 4px;
        display: inline-block;
      }
      .krever-transcribe-btn:hover { filter: brightness(1.1); }
      .krever-transcribe-btn:disabled { opacity: 0.5; cursor: wait; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);

    // Event listeners do painel
    panel.querySelector('#krever-panel-close').onclick = () => togglePanel(false);
    panel.querySelector('#krever-panel-refresh').onclick = () => refreshPanel();
    panel.querySelector('#krever-btn-copy').onclick = async () => {
      const text = panel.querySelector('#krever-summary-output').textContent;
      if (text) {
        await navigator.clipboard.writeText(text);
        const btn = panel.querySelector('#krever-btn-copy');
        const orig = btn.textContent;
        btn.textContent = '✅ Copiado!';
        setTimeout(() => btn.textContent = orig, 1500);
      }
    };

    // Botões de ação - delega para background via chrome.runtime
    panel.querySelector('#krever-btn-transcribe-all').onclick = () => transcribeAllInPanel();
    panel.querySelector('#krever-btn-analyze-all').onclick = () => analyzeAllInPanel();
    panel.querySelector('#krever-btn-token').onclick = () => estimateTokensInPanel();
    panel.querySelector('#krever-btn-export').onclick = () => exportTxtInPanel();
    panel.querySelector('#krever-btn-gemini').onclick = () => prepareGeminiInPanel();
    panel.querySelector('#krever-btn-summarize').onclick = () => summarizeInPanel();

    return panel;
  }

  function togglePanel(force) {
    const panel = document.getElementById('krever-panel') || createResumidorPanel();
    if (typeof force === 'boolean') panelOpen = force;
    else panelOpen = !panelOpen;
    
    if (panelOpen) {
      panel.classList.add('open');
      refreshPanel();
    } else {
      panel.classList.remove('open');
    }
  }

  function refreshPanel() {
    const entries = extractMessages();
    const panel = document.getElementById('krever-panel');
    if (!panel) return;

    const chatName = getChatName();
    panel.querySelector('#krever-panel-chat').textContent = chatName;
    panel.querySelector('#krever-stat-msgs').textContent = `${entries.length} msgs`;
    panel.querySelector('#krever-stat-audios').textContent = `${entries.filter(e=>e.type==='audio').length} áudios`;
    panel.querySelector('#krever-stat-images').textContent = `${entries.filter(e=>e.type==='image').length} imgs`;

    const entriesContainer = panel.querySelector('#krever-panel-entries');
    entriesContainer.innerHTML = '';

    if (!entries.length) {
      entriesContainer.innerHTML = '<p style="text-align:center; color:#9cafc9; padding:20px; font-size:11px;">Nenhuma mensagem encontrada<br>Selecione uma conversa no WhatsApp</p>';
      return;
    }

    const toShow = entries.slice(-80);
    for (const entry of toShow) {
      const div = document.createElement('div');
      div.className = `krever-msg ${entry.fromMe ? 'own' : ''}`;
      div.dataset.messageId = entry.sourceId;

      const meta = document.createElement('div');
      meta.className = 'krever-msg-meta';
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
      meta.textContent = `${entry.fromMe ? 'Você' : entry.sender} • ${time}`;

      div.appendChild(meta);

      if (entry.type === 'audio') {
        const badge = document.createElement('div');
        badge.className = 'krever-audio-badge';
        const isDone = entry.audio?.transcriptionStatus === 'completed';
        badge.textContent = isDone ? '🎙️ Transcrito' : '🎙️ Áudio';
        div.appendChild(badge);

        const text = document.createElement('div');
        text.className = 'krever-msg-text';
        text.textContent = entry.text || (isDone ? entry.text : 'Áudio pendente');
        div.appendChild(text);

        // Botão transcrever individual
        if (!isDone) {
          const btn = document.createElement('button');
          btn.className = 'krever-transcribe-btn';
          btn.textContent = '▶️ Transcrever este áudio';
          btn.onclick = () => transcribeSingleAudio(entry.sourceId, btn);
          div.appendChild(btn);
        }
      } else if (entry.type === 'image') {
        const badge = document.createElement('div');
        badge.className = 'krever-audio-badge';
        badge.style.background = 'rgba(196,168,255,0.15)';
        badge.style.color = '#c4a8ff';
        badge.textContent = entry.image?.analysisStatus === 'completed' ? '🖼️ Analisada' : '🖼️ Imagem';
        div.appendChild(badge);

        const text = document.createElement('div');
        text.className = 'krever-msg-text';
        text.textContent = entry.text || '[Imagem]';
        div.appendChild(text);

        if (entry.image?.analysisStatus !== 'completed') {
          const btn = document.createElement('button');
          btn.className = 'krever-transcribe-btn';
          btn.style.background = '#c4a8ff';
          btn.textContent = '🔍 Analisar esta imagem';
          btn.onclick = () => analyzeSingleImage(entry.sourceId, btn);
          div.appendChild(btn);
        }
      } else {
        const text = document.createElement('div');
        text.className = 'krever-msg-text';
        text.textContent = entry.text;
        div.appendChild(text);
      }

      entriesContainer.appendChild(div);
    }
    entriesContainer.scrollTop = entriesContainer.scrollHeight;
  }

  // ===== TRANSCRIÇÃO INDIVIDUAL NO PAINEL =====
  async function transcribeSingleAudio(messageId, btn) {
    if (!messageId) return;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Capturando...';

    try {
      // Primeiro tenta capturar blob atual
      captureAllAudioBlobs();
      
      // Tenta pegar blob de várias formas
      let blob = await getAudioBlob(messageId);
      
      // Se não achou, tenta pegar último blob capturado (pode ser do play)
      if (!blob && lastAudioBlob) {
        console.log('[Krever] Tentando último blob capturado:', lastAudioBlob);
        // Tenta buscar blob pelo URL do último play
        const lastUrl = lastAudioBlob.url || lastAudioBlob.src;
        if (lastUrl) {
          try {
            const res = await fetch(lastUrl);
            blob = await res.blob();
          } catch {}
        }
      }

      // Se ainda não achou, tenta pegar qualquer blob de áudio no DOM
      if (!blob) {
        const allAudios = qa('audio[src^="blob:"]');
        if (allAudios.length > 0) {
          // Pega o mais recente ou o que está tocando
          const playing = allAudios.find(a => !a.paused) || allAudios[allAudios.length - 1];
          if (playing && playing.src) {
            try {
              const res = await fetch(playing.src);
              blob = await res.blob();
              console.log('[Krever] Usando blob de áudio tocando:', playing.src);
            } catch {}
          }
        }
      }

      if (!blob) {
        throw new Error('Blob não encontrado. Dê PLAY no áudio no WhatsApp Web primeiro, aguarde 1 segundo tocando, pause e tente novamente.');
      }

      btn.textContent = '⏳ Transcrevendo...';
      console.log(`[Krever] Blob encontrado: ${blob.size} bytes, ${blob.type}`);

      const arrayBuffer = await blob.arrayBuffer();
      const res = await chrome.runtime.sendMessage({
        type: 'TRANSCRIBE_AUDIO',
        blobData: Array.from(new Uint8Array(arrayBuffer)),
        mimeType: blob.type || 'audio/ogg',
        fileName: `audio_${messageId}.ogg`,
        conversationId: getChatId(),
        messageId: messageId
      });

      if (res.success) {
        btn.textContent = '✅ Transcrito!';
        btn.style.background = '#4ade80';
        // Atualiza texto na mensagem
        const msgDiv = document.querySelector(`.krever-msg[data-message-id="${CSS.escape(messageId)}"] .krever-msg-text`);
        if (msgDiv) msgDiv.textContent = res.result.text;
        // Atualiza no storage
        setTimeout(() => refreshPanel(), 1000);
      } else {
        throw new Error(res.error);
      }
    } catch (e) {
      console.error('[Krever] Erro transcrição individual', e);
      btn.textContent = '❌ Erro';
      alert(`Erro ao transcrever: ${e.message}\n\nDica: Dê play no áudio no WhatsApp, deixe tocar 1s, pause e tente novamente.`);
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
      return;
    }
    btn.disabled = false;
  }

  async function analyzeSingleImage(messageId, btn) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Analisando...';
    try {
      const container = q('#main');
      let msgEl = null;
      try { msgEl = container.querySelector(`div[data-id="${CSS.escape(messageId)}"]`); } catch { msgEl = qa('[data-id]', container).find(el => el.getAttribute('data-id') === messageId); }
      let src = msgEl?.querySelector('img')?.src;
      if (!src) throw new Error('Imagem não encontrada');

      let base64, mimeType;
      if (src.startsWith('data:')) {
        const [h, b64] = src.split(','); base64 = b64; mimeType = h.split(':')[1].split(';')[0];
      } else {
        const res = await fetch(src); const blob = await res.blob(); const buf = await blob.arrayBuffer();
        let binary = ''; const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i+0x8000));
        base64 = btoa(binary); mimeType = blob.type || 'image/jpeg';
      }

      const res = await chrome.runtime.sendMessage({
        type: 'ANALYZE_IMAGE',
        base64, mimeType,
        conversationId: getChatId(),
        messageId
      });

      if (res.success) {
        btn.textContent = '✅ Analisada!';
        btn.style.background = '#4ade80';
        const msgDiv = document.querySelector(`.krever-msg[data-message-id="${CSS.escape(messageId)}"] .krever-msg-text`);
        if (msgDiv) msgDiv.textContent = `[Imagem analisada] ${res.analysis}`;
      } else throw new Error(res.error);
    } catch (e) {
      btn.textContent = '❌ Erro';
      alert(`Erro: ${e.message}`);
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
      return;
    }
    btn.disabled = false;
  }

  // Funções do painel que chamam background
  async function transcribeAllInPanel() {
    const entries = extractMessages().filter(e => e.type === 'audio' && e.audio?.transcriptionStatus !== 'completed');
    if (!entries.length) return alert('Nenhum áudio pendente');
    if (!confirm(`Transcrever ${entries.length} áudios? Consome créditos Groq.`)) return;
    
    const btn = document.getElementById('krever-btn-transcribe-all');
    btn.disabled = true;
    let success = 0, fail = 0;
    for (let i = 0; i < entries.length; i++) {
      btn.textContent = `⏳ ${i+1}/${entries.length}`;
      const entry = entries[i];
      try {
        const blob = await getAudioBlob(entry.sourceId);
        if (!blob) { fail++; continue; }
        const buf = await blob.arrayBuffer();
        const res = await chrome.runtime.sendMessage({
          type: 'TRANSCRIBE_AUDIO',
          blobData: Array.from(new Uint8Array(buf)),
          mimeType: blob.type,
          fileName: `audio_${entry.sourceId}.ogg`,
          conversationId: getChatId(),
          messageId: entry.sourceId
        });
        if (res.success) success++; else fail++;
      } catch { fail++; }
      await new Promise(r => setTimeout(r, 1200));
    }
    btn.disabled = false;
    btn.textContent = '🎙️ Todos áudios';
    alert(`Transcrição: ${success} ok, ${fail} falha`);
    refreshPanel();
  }

  async function analyzeAllInPanel() {
    const entries = extractMessages().filter(e => e.type === 'image' && e.image?.analysisStatus !== 'completed');
    if (!entries.length) return alert('Nenhuma imagem pendente');
    if (!confirm(`Analisar ${entries.length} imagens?`)) return;
    const btn = document.getElementById('krever-btn-analyze-all');
    btn.disabled = true;
    let success = 0;
    for (let i = 0; i < entries.length; i++) {
      btn.textContent = `⏳ ${i+1}/${entries.length}`;
      try {
        const src = entries[i].image?.src;
        if (!src) continue;
        const res = await fetch(src); const blob = await res.blob(); const buf = await blob.arrayBuffer();
        let binary = ''; const bytes = new Uint8Array(buf);
        for (let j = 0; j < bytes.length; j += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(j, j+0x8000));
        const base64 = btoa(binary);
        const result = await chrome.runtime.sendMessage({
          type: 'ANALYZE_IMAGE', base64, mimeType: blob.type,
          conversationId: getChatId(), messageId: entries[i].sourceId
        });
        if (result.success) success++;
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    btn.disabled = false;
    btn.textContent = '🖼️ Todas imgs';
    alert(`Análise: ${success} ok`);
    refreshPanel();
  }

  async function estimateTokensInPanel() {
    const panel = document.getElementById('krever-panel');
    const tokenEl = panel.querySelector('#krever-token-estimate');
    tokenEl.textContent = 'Calculando...';
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TOKEN_ESTIMATE',
        conversationId: getChatId(),
        instructions: null,
        provider: 'groq'
      });
      if (res.estimatedInputTokens) {
        tokenEl.textContent = `Tokens: ~${res.estimatedInputTokens.toLocaleString()} entrada + ${res.outputTokenBudget} saída = ${res.estimatedTotalTokens.toLocaleString()}`;
      } else tokenEl.textContent = 'Erro: ' + res.error;
    } catch (e) { tokenEl.textContent = 'Erro: ' + e.message; }
  }

  async function exportTxtInPanel() {
    const entries = extractMessages();
    const content = entries.map(e => `[${e.timestamp}] ${e.sender}: ${e.text}`).join('\n');
    const fileName = `conversa-${getChatName().replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().slice(0,10)}.txt`;
    const blob = new Blob([`CONVERSA: ${getChatName()}\nEXPORTADO: ${new Date().toLocaleString('pt-BR')}\n\n${content}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function prepareGeminiInPanel() {
    const entries = extractMessages();
    const content = entries.map(e => `[${e.timestamp}] ${e.sender}: ${e.text}`).join('\n');
    const fileName = `conversa-${getChatName().replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().slice(0,10)}.txt`;
    const blob = new Blob([`CONVERSA: ${getChatName()}\nEXPORTADO: ${new Date().toLocaleString('pt-BR')}\n\n${content}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
    
    try {
      const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      const prompt = `Analise o arquivo TXT que vou anexar. Ele contém o histórico de uma conversa de consórcio.\n\n${config.config.instructions || ''}`;
      await navigator.clipboard.writeText(prompt);
      alert(`TXT baixado e prompt copiado! Abra gemini.google.com, anexe o TXT e cole o prompt.`);
      window.open(config.config.geminiChatUrl || 'https://gemini.google.com/app', '_blank');
    } catch (e) {
      alert('TXT baixado. Copie o prompt manualmente.');
    }
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function summarizeInPanel() {
    const panel = document.getElementById('krever-panel');
    const output = panel.querySelector('#krever-summary-output');
    const btn = panel.querySelector('#krever-btn-summarize');
    btn.disabled = true;
    btn.textContent = '⏳ Gerando...';
    output.textContent = 'Enviando para IA...';
    try {
      const entries = extractMessages();
      if (!entries.length) throw new Error('Nenhuma mensagem');
      const transcript = entries.map(e => `[${e.timestamp}] ${e.sender}: ${e.text}`).join('\n');
      const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      const res = await chrome.runtime.sendMessage({
        type: 'SUMMARIZE_TEXT',
        text: transcript,
        instructions: config.config.instructions,
        provider: config.config.summaryProvider || 'groq'
      });
      if (res.success) output.textContent = res.summary;
      else output.textContent = 'Erro: ' + res.error;
    } catch (e) {
      output.textContent = 'Erro: ' + e.message;
    }
    btn.disabled = false;
    btn.textContent = '✨ Gerar Resumo';
  }

  // ===== BOTÃO FLUTUANTE =====
  function injectFloatingButton() {
    if (document.getElementById('krever-floating-btn')) return;
    const header = q('#main header') || q('header[data-testid="chat-info-header"]');
    if (!header) return;
    const btn = document.createElement('button');
    btn.id = 'krever-floating-btn';
    btn.textContent = '📋 Resumidor';
    btn.title = 'Abrir painel Krever Resumidor';
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
        chrome.runtime.sendMessage({
          type: 'CONVERSATION_UPDATE',
          payload: { conversationId: chatId, conversationName: getChatName(), entries }
        }).catch(()=>{});
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
        const blob = await getAudioBlob(msg.messageId);
        if (blob) {
          const buf = await blob.arrayBuffer();
          sendResponse({ success: true, data: Array.from(new Uint8Array(buf)), mimeType: blob.type, size: blob.size });
        } else {
          sendResponse({ success: false, error: 'Blob não encontrado. Dê PLAY no áudio no WhatsApp (deixe tocar 1s) e tente novamente. O WhatsApp só cria o blob após play.' });
        }
      } else if (msg.type === 'GET_IMAGE_BLOB') {
        sendResponse(await getImageBlob(msg.messageId, msg.src));
      } else if (msg.type === 'PING') {
        const entries = extractMessages();
        sendResponse({ ok: true, chat: getChatName(), messages: entries.length, audios: entries.filter(e=>e.type==='audio').length, images: entries.filter(e=>e.type==='image').length, blobs: capturedBlobs.size, panelOpen });
      } else if (msg.type === 'DEBUG_DOM') {
        sendResponse({
          hasMain: !!q('#main'),
          mainDivs: qa('#main div').length,
          dataIds: qa('[data-id]').length,
          messageInOut: qa('div.message-in, div.message-out').length,
          msgContainer: qa('div[data-testid="msg-container"]').length,
          trueFalse: qa('div[data-id^="true_"], div[data-id^="false_"]').length,
          copyable: qa('#main .copyable-text').length,
          audioElements: qa('audio').length,
          blobAudios: qa('audio[src^="blob:"]').length,
          capturedBlobs: capturedBlobs.size,
          chatName: getChatName(),
        });
      } else if (msg.type === 'TOGGLE_PANEL') {
        togglePanel();
        sendResponse({ ok: true, panelOpen });
      }
    })();
    return true;
  });

  async function scrollForHistory(targetCount) {
    const container = q('div[data-testid="conversation-panel-messages"]') || q('#main div.copyable-area') || q('#main');
    if (!container) return { success: false, error: 'Container não encontrado' };
    const initial = extractMessages().length;
    let last = initial, attempts = 0;
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
    console.log(`[Krever] getAudioBlob para ${messageId}, blobs capturados: ${capturedBlobs.size}`);
    captureAllAudioBlobs();

    const container = q('#main');
    if (!container) return null;

    // Tenta achar mensagem específica
    let msgEl = null;
    try { msgEl = container.querySelector(`div[data-id="${CSS.escape(messageId)}"]`); } catch { msgEl = qa('[data-id]', container).find(el => el.getAttribute('data-id') === messageId); }
    if (!msgEl) msgEl = qa('div.message-in, div.message-out', container).find(el => el.querySelector(`[data-id="${messageId}"]`));

    if (msgEl) {
      // Procura dentro da mensagem
      const audioEl = msgEl.querySelector('audio');
      if (audioEl && audioEl.src && audioEl.src.startsWith('blob:')) {
        try { const res = await fetch(audioEl.src); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
      }
      const blobEls = qa('[src^="blob:"]', msgEl);
      for (const el of blobEls) {
        try { const res = await fetch(el.src); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
      }
    }

    // Fallback: procura qualquer áudio blob no documento (especialmente se deu play)
    const allAudioBlobs = qa('audio[src^="blob:"]');
    console.log(`[Krever] Audios com blob no DOM: ${allAudioBlobs.length}`);
    for (const audio of allAudioBlobs) {
      // Se tem um tocando, prioriza
      if (!audio.paused) {
        try { const res = await fetch(audio.src); const blob = await res.blob(); if (blob.size > 100) { console.log('[Krever] Usando áudio que está tocando:', audio.src); return blob; } } catch {}
      }
    }
    // Pega o mais recente
    if (allAudioBlobs.length > 0) {
      const last = allAudioBlobs[allAudioBlobs.length - 1];
      try { const res = await fetch(last.src); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
    }

    // Tenta do mapa de blobs capturados
    if (capturedBlobs.size > 0) {
      const lastEntry = Array.from(capturedBlobs.values()).pop();
      if (lastEntry?.element?.src) {
        try { const res = await fetch(lastEntry.element.src); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
      }
    }

    // Último recurso: tenta pegar via último blob capturado via hook
    if (lastAudioBlob?.url) {
      try { const res = await fetch(lastAudioBlob.url); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
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
    console.log('[Krever] Iniciando v4 com painel e blob capture...');
    injectBlobCapture();
    const check = setInterval(() => {
      if (q('#main') || q('div[data-testid="chat-list"]')) {
        clearInterval(check);
        console.log('[Krever] WhatsApp detectado v4');
        createResumidorPanel();
        startObserver();
        setInterval(injectFloatingButton, 3000);
        debounceExtract();
        setInterval(debounceExtract, 3000);
        setInterval(captureAllAudioBlobs, 5000);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.KreverContent = { extractMessages, getChatName, getChatId, scrollForHistory, getAudioBlob, getImageBlob, togglePanel, refreshPanel };
})();
