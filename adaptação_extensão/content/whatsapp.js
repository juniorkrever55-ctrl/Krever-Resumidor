/* Krever Resumidor - Content Script v3 - ULTRA ROBUSTO
   Corrige: não encontra nenhuma conversa
   Testado para WhatsApp Web 2024/2025 com múltiplos fallbacks
*/

(() => {
  console.log('%c[Krever] Content script v3 ULTRA ROBUSTO carregado', 'background: #4de0d2; color: #000; padding: 2px 6px; border-radius: 4px; font-weight: bold;');

  let currentChatId = null;
  let observer = null;
  let lastCount = 0;

  // Helpers
  function q(sel, root = document) { try { return root.querySelector(sel); } catch { return null; } }
  function qa(sel, root = document) { try { return Array.from(root.querySelectorAll(sel)); } catch { return []; } }

  function getChatName() {
    // Tenta vários seletores de nome, em ordem de confiabilidade
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
    // Tenta pegar algo único da conversa
    const main = q('#main');
    const dataId = main?.querySelector('[data-id]')?.getAttribute('data-id') || '';
    const raw = (dataId || '') + '|' + name + '|' + (window.location.href || '');
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    return Math.abs(hash).toString(16).padStart(24, '0').slice(0, 24);
  }

  // V3: EXTRAÇÃO ULTRA ROBUSTA COM 5 ESTRATÉGIAS
  function extractMessages() {
    console.log('[Krever] Iniciando extração v3...');
    
    // Estratégia 1: Encontra container principal de várias formas
    let container = null;
    const containerSelectors = [
      'div[data-testid="conversation-panel-messages"]',
      '#main div[data-testid="conversation-panel-messages"]',
      '#main div.copyable-area',
      '#main',
      'div#main',
      'div[data-testid="chat"]',
    ];
    for (const sel of containerSelectors) {
      const el = q(sel);
      if (el) {
        container = el;
        console.log(`[Krever] Container encontrado via: ${sel}`, el);
        break;
      }
    }
    if (!container) {
      console.warn('[Krever] Nenhum container encontrado, usando document.body como fallback');
      container = document.body;
    }

    // Estratégia 2: Tenta 6 formas diferentes de pegar mensagens
    let msgElements = [];
    let strategyUsed = '';

    // Estratégia A: div.message-in / div.message-out (mais confiável quando existe)
    const strategyA = qa('div.message-in, div.message-out', container);
    console.log(`[Krever] Estratégia A (message-in/out): ${strategyA.length} encontradas`);
    if (strategyA.length > 0) {
      msgElements = strategyA;
      strategyUsed = 'A-message-in/out';
    }

    // Estratégia B: div[data-testid="msg-container"]
    if (msgElements.length < 3) {
      const strategyB = qa('div[data-testid="msg-container"]', container);
      console.log(`[Krever] Estratégia B (msg-container): ${strategyB.length} encontradas`);
      if (strategyB.length > msgElements.length) {
        msgElements = strategyB;
        strategyUsed = 'B-msg-container';
      }
    }

    // Estratégia C: div[data-id^="true_"] e false_ (ID de mensagem do WhatsApp)
    if (msgElements.length < 3) {
      const strategyC = qa('div[data-id^="true_"], div[data-id^="false_"]', container);
      console.log(`[Krever] Estratégia C (data-id true_/false_): ${strategyC.length} encontradas`);
      if (strategyC.length > msgElements.length) {
        // Filtra para pegar apenas os mais externos (sem ancestral com mesmo data-id)
        const seen = new Set();
        const filtered = [];
        for (const el of strategyC) {
          const id = el.getAttribute('data-id');
          if (!id || seen.has(id)) continue;
          // Verifica ancestral
          let parent = el.parentElement;
          let hasAncestor = false;
          while (parent && parent !== container && parent !== document.body) {
            if (parent.getAttribute && parent.getAttribute('data-id') === id) {
              hasAncestor = true;
              break;
            }
            parent = parent.parentElement;
          }
          if (!hasAncestor) {
            seen.add(id);
            filtered.push(el);
          }
        }
        console.log(`[Krever] Estratégia C filtrada: ${filtered.length} únicas`);
        msgElements = filtered;
        strategyUsed = 'C-data-id-true/false';
      }
    }

    // Estratégia D: Qualquer div[data-id] dentro de #main que parece mensagem
    if (msgElements.length < 3) {
      const allDataId = qa('#main div[data-id]', document);
      const filtered = allDataId.filter(el => {
        const id = el.getAttribute('data-id') || '';
        // ID de mensagem tem formato true_xxx ou false_xxx ou contém _
        return id.includes('_') && id.length > 10;
      });
      console.log(`[Krever] Estratégia D (qualquer data-id em #main): ${filtered.length} encontradas`);
      if (filtered.length > msgElements.length) {
        msgElements = filtered;
        strategyUsed = 'D-qualquer-data-id';
      }
    }

    // Estratégia E: Busca por spans de texto e sobe até achar container de mensagem
    if (msgElements.length < 3) {
      const textSpans = qa('span[data-testid="msg-text"], div.copyable-text', container);
      console.log(`[Krever] Estratégia E (text spans): ${textSpans.length} encontradas`);
      const parents = new Set();
      const filtered = [];
      for (const span of textSpans) {
        let parent = span.parentElement;
        let depth = 0;
        while (parent && depth < 8) {
          if (parent.getAttribute && parent.getAttribute('data-id')) {
            const id = parent.getAttribute('data-id');
            if (!parents.has(id)) {
              parents.add(id);
              filtered.push(parent);
            }
            break;
          }
          if (parent.classList && (parent.classList.contains('message-in') || parent.classList.contains('message-out'))) {
            const id = parent.getAttribute('data-id') || `text_parent_${filtered.length}`;
            if (!parents.has(id)) {
              parents.add(id);
              filtered.push(parent);
            }
            break;
          }
          parent = parent.parentElement;
          depth++;
        }
      }
      console.log(`[Krever] Estratégia E pais únicos: ${filtered.length}`);
      if (filtered.length > msgElements.length) {
        msgElements = filtered;
        strategyUsed = 'E-text-parent';
      }
    }

    // Estratégia F: Último recurso - pega tudo que tem selectable-text dentro de #main
    if (msgElements.length < 3) {
      const selectable = qa('#main .selectable-text, #main [data-testid="msg-text"]', document);
      console.log(`[Krever] Estratégia F (selectable-text): ${selectable.length} encontradas`);
      if (selectable.length > 0) {
        const parents = new Map();
        for (const el of selectable) {
          let p = el;
          for (let i = 0; i < 10; i++) {
            if (!p) break;
            if (p.getAttribute && p.getAttribute('data-id')) {
              const id = p.getAttribute('data-id');
              if (!parents.has(id)) parents.set(id, p);
              break;
            }
            p = p.parentElement;
          }
        }
        msgElements = Array.from(parents.values());
        strategyUsed = 'F-selectable-parent';
      }
    }

    console.log(`[Krever] Estratégia final usada: ${strategyUsed} com ${msgElements.length} elementos`);

    if (msgElements.length === 0) {
      console.warn('[Krever] NENHUMA mensagem encontrada com nenhuma estratégia! Tentando debug do DOM...');
      console.log('[Krever] #main existe?', !!q('#main'));
      console.log('[Krever] #main HTML sample:', q('#main')?.innerHTML?.slice(0, 500));
      console.log('[Krever] Total divs em #main:', qa('#main div').length);
      console.log('[Krever] Total [data-id] no doc:', qa('[data-id]').length);
      return [];
    }

    // Deduplica por data-id
    const uniqueMap = new Map();
    for (const el of msgElements) {
      const id = el.getAttribute('data-id') || el.querySelector('[data-id]')?.getAttribute('data-id') || `tmp_${Math.random().toString(36).slice(2)}_${uniqueMap.size}`;
      if (!uniqueMap.has(id)) uniqueMap.set(id, el);
    }
    msgElements = Array.from(uniqueMap.values());
    console.log(`[Krever] Após deduplicação: ${msgElements.length} únicas`);

    const entries = [];
    const now = new Date().toISOString();

    for (let idx = 0; idx < msgElements.length; idx++) {
      const el = msgElements[idx];
      try {
        const dataIdEl = el.getAttribute('data-id') ? el : el.querySelector('[data-id]');
        const dataId = dataIdEl?.getAttribute('data-id') || `msg_${idx}_${Date.now()}`;

        // fromMe: message-out = você
        let isFromMe = false;
        if (el.classList.contains('message-out')) isFromMe = true;
        else if (el.classList.contains('message-in')) isFromMe = false;
        else if (dataId.startsWith('true_')) isFromMe = true;
        else if (dataId.startsWith('false_')) isFromMe = false;
        else if (el.closest('.message-out')) isFromMe = true;
        else if (el.closest('.message-in')) isFromMe = false;
        else {
          // Tenta inferir por posição ou estilo (mensagens da direita são suas)
          const rect = el.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          if (rect.left > containerRect.left + containerRect.width / 2) isFromMe = true;
        }

        // ===== ÁUDIO =====
        const audioSelectors = [
          'audio',
          '[data-testid="audio-play"]',
          '[data-testid="ptt-play"]',
          '[data-testid="audio-play-button"]',
          'span[data-icon="ptt"]',
          'span[data-icon="audio-play"]',
          'span[data-icon="ptt-out"]',
          'span[data-icon="ptt-in"]',
          'div[data-testid="audio-player"]',
          'div[data-testid="ptt"]',
          'canvas',
        ];
        let hasAudio = false;
        for (const sel of audioSelectors) {
          if (el.querySelector(sel)) { hasAudio = true; break; }
        }
        if (!hasAudio) {
          const html = el.innerHTML || '';
          if (html.includes('data-icon="ptt"') || html.includes('audio-play') || html.includes('audio-player')) hasAudio = true;
        }

        // ===== IMAGEM =====
        let hasImage = false;
        let imgEl = null;
        if (!hasAudio) {
          const thumb = el.querySelector('[data-testid="image-thumb"]');
          if (thumb) {
            hasImage = true;
            imgEl = thumb.querySelector('img') || thumb;
          } else {
            const imgs = qa('img', el);
            for (const img of imgs) {
              if (img.closest('[data-testid="avatar"]')) continue;
              const src = img.src || '';
              if (src.includes('avatar')) continue;
              if (img.width > 0 && img.width < 60) continue;
              if (src.startsWith('blob:') || src.includes('mmg.whatsapp.net') || src.includes('pps.whatsapp.net')) {
                if (el.querySelector('[data-testid="sticker"]')) continue;
                hasImage = true;
                imgEl = img;
                break;
              }
            }
          }
        }

        let text = '';
        let type = 'text';
        let audioInfo = null;
        let imageInfo = null;

        if (hasAudio) {
          type = 'audio';
          const audioEl = el.querySelector('audio');
          let src = audioEl?.src || '';
          if (!src) {
            const blobEl = qa('*', el).find(e => e.src && e.src.startsWith('blob:'));
            src = blobEl?.src || '';
          }
          text = '[Áudio]';
          let seconds = null;
          const durEl = el.querySelector('[data-testid="audio-duration"]');
          if (durEl) {
            const m = durEl.textContent.match(/(\d+):(\d+)/);
            if (m) seconds = parseInt(m[1])*60 + parseInt(m[2]);
          }
          audioInfo = { src: src || 'blob_pending', mimeType: 'audio/ogg', seconds, transcriptionStatus: 'pending', sourceId: dataId };
        } else if (hasImage && imgEl) {
          type = 'image';
          const src = imgEl.src || '';
          text = '[Imagem]';
          imageInfo = { src, mimeType: 'image/jpeg', analysisStatus: 'pending', sourceId: dataId };
        } else {
          // TEXTO - tenta vários seletores
          let foundText = '';
          const textSels = [
            'span[data-testid="msg-text"]',
            'div.copyable-text span.selectable-text',
            '.copyable-text',
            'span.selectable-text',
          ];
          for (const sel of textSels) {
            const tEl = el.querySelector(sel);
            if (tEl && tEl.innerText && tEl.innerText.trim()) {
              if (tEl.closest('[data-testid="msg-meta"]')) continue;
              foundText = tEl.innerText.trim();
              if (foundText) break;
            }
          }
          if (!foundText) {
            const clone = el.cloneNode(true);
            qa('[data-testid="msg-meta"], [data-testid="msg-info"], [data-icon], button', clone).forEach(m => m.remove());
            foundText = (clone.innerText || '').trim();
            foundText = foundText.split('\n').filter(l => {
              const t = l.trim();
              if (!t) return false;
              if (/^\d{1,2}:\d{2}$/.test(t)) return false;
              if (/^[✓✔]+$/.test(t)) return false;
              return true;
            }).join('\n').trim();
          }
          text = foundText.slice(0, 30000);
          if (!text) continue;
        }

        let timestamp = now;
        const prePlain = el.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') || el.getAttribute('data-pre-plain-text');
        if (prePlain) {
          const match = prePlain.match(/\[(\d+):(\d+), (\d+)\/(\d+)\/(\d+)\]/);
          if (match) {
            const [, hh, mm, dd, MM, yyyy] = match;
            const d = new Date(`${yyyy}-${MM}-${dd}T${hh}:${mm}:00`);
            if (!isNaN(d)) timestamp = d.toISOString();
          }
        }

        const sender = isFromMe ? 'Você' : getChatName();

        entries.push({
          id: dataId,
          sourceId: dataId,
          timestamp,
          fromMe: isFromMe,
          sender,
          type,
          text,
          conversationName: getChatName(),
          jid: getChatId(),
          audio: audioInfo,
          image: imageInfo
        });
      } catch (e) {
        console.warn('[Krever] Erro ao extrair msg', e);
      }
    }

    console.log(`[Krever] Extração final: ${entries.length} msgs (${entries.filter(e=>e.type==='text').length} texto, ${entries.filter(e=>e.type==='audio').length} áudio, ${entries.filter(e=>e.type==='image').length} imagem) via ${strategyUsed}`);
    return entries;
  }

  function injectButton() {
    if (document.getElementById('krever-floating-btn')) return;
    const header = q('#main header') || q('header[data-testid="chat-info-header"]');
    if (!header) return;
    const btn = document.createElement('button');
    btn.id = 'krever-floating-btn';
    btn.textContent = '📋 Resumidor';
    btn.style.cssText = `margin-left:12px;padding:6px 12px;background:linear-gradient(135deg,#4de0d2,#76a9ff);color:#06111f;border:none;border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;z-index:9999;`;
    btn.onclick = () => alert(`Krever: ${getChatName()}\nMensagens: ${extractMessages().length}\n\nClique no ícone da extensão para resumir!`);
    header.appendChild(btn);
  }

  function startObserver() {
    const container = q('div[data-testid="conversation-panel-messages"]') || q('#main');
    if (!container) { setTimeout(startObserver, 2000); return; }
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      const count = qa('div.message-in, div.message-out, div[data-id^="true_"], div[data-id^="false_"]', container).length;
      if (count !== lastCount) { lastCount = count; debounceExtract(); }
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
    }, 700);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'GET_CURRENT_CHAT') {
        const entries = extractMessages();
        sendResponse({ conversationId: getChatId(), conversationName: getChatName(), entries, url: location.href, debug: { strategies: 'v3 ultra robusto' } });
      } else if (msg.type === 'SCROLL_FOR_HISTORY') {
        const result = await scrollForHistory(msg.count || 50);
        sendResponse(result);
      } else if (msg.type === 'GET_AUDIO_BLOB') {
        const blob = await getAudioBlob(msg.messageId);
        if (blob) {
          const buf = await blob.arrayBuffer();
          sendResponse({ success: true, data: Array.from(new Uint8Array(buf)), mimeType: blob.type, size: blob.size });
        } else {
          sendResponse({ success: false, error: 'Blob não encontrado. Dê play no áudio no WhatsApp antes.' });
        }
      } else if (msg.type === 'GET_IMAGE_BLOB') {
        sendResponse(await getImageBlob(msg.messageId, msg.src));
      } else if (msg.type === 'PING') {
        const entries = extractMessages();
        sendResponse({ ok: true, chat: getChatName(), messages: entries.length, audios: entries.filter(e=>e.type==='audio').length, images: entries.filter(e=>e.type==='image').length, strategy: 'v3' });
      } else if (msg.type === 'DEBUG_DOM') {
        const debug = {
          hasMain: !!q('#main'),
          mainDivs: qa('#main div').length,
          dataIds: qa('[data-id]').length,
          messageInOut: qa('div.message-in, div.message-out').length,
          msgContainer: qa('div[data-testid="msg-container"]').length,
          trueFalse: qa('div[data-id^="true_"], div[data-id^="false_"]').length,
          copyable: qa('#main .copyable-text').length,
          chatName: getChatName(),
        };
        sendResponse(debug);
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
        const parent = container.parentElement;
        if (parent) parent.scrollTop = 0;
        const overflow = q('#main div[tabindex="0"]');
        if (overflow) overflow.scrollTop = 0;
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
    const container = q('#main');
    if (!container) return null;
    let msgEl = null;
    try { msgEl = container.querySelector(`div[data-id="${CSS.escape(messageId)}"]`); } catch { msgEl = qa('[data-id]', container).find(el => el.getAttribute('data-id') === messageId); }
    if (!msgEl) msgEl = qa('div.message-in, div.message-out', container).find(el => el.querySelector(`[data-id="${messageId}"]`));
    if (!msgEl) return null;
    const candidates = [msgEl.querySelector('audio'), ...qa('*', msgEl).filter(e => e.src && e.src.startsWith('blob:'))].filter(Boolean);
    for (const cand of candidates) {
      const src = cand.src;
      if (src && src.startsWith('blob:')) {
        try { const res = await fetch(src); const blob = await res.blob(); if (blob.size > 100) return blob; } catch {}
      }
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
      if (src.startsWith('data:')) {
        const [h, b64] = src.split(','); return { success: true, base64: b64, mimeType: h.split(':')[1].split(';')[0] };
      }
      if (src.startsWith('blob:') || src.startsWith('http')) {
        const res = await fetch(src); const blob = await res.blob(); const buf = await blob.arrayBuffer();
        let binary = ''; const bytes = new Uint8Array(buf); const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk));
        return { success: true, base64: btoa(binary), mimeType: blob.type || 'image/jpeg', size: blob.size, data: Array.from(bytes) };
      }
      return { success: false, error: 'Src inválido' };
    } catch (e) { return { success: false, error: e.message }; }
  }

  function init() {
    console.log('[Krever] Iniciando v3 ULTRA...');
    const check = setInterval(() => {
      if (q('#main') || q('div[data-testid="chat-list"]')) {
        clearInterval(check);
        console.log('[Krever] WhatsApp detectado v3');
        startObserver();
        setInterval(injectButton, 3000);
        debounceExtract();
        setInterval(debounceExtract, 3500);
        // Debug inicial
        setTimeout(() => {
          console.log('[Krever] Debug DOM inicial:', {
            main: !!q('#main'),
            divs: qa('#main div').length,
            dataId: qa('[data-id]').length,
            msgInOut: qa('div.message-in, div.message-out').length,
            msgContainer: qa('div[data-testid="msg-container"]').length,
          });
        }, 2000);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.KreverContent = { extractMessages, getChatName, getChatId, scrollForHistory, getAudioBlob, getImageBlob };
})();
