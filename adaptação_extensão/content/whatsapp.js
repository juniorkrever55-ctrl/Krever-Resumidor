/* Krever Resumidor - Content Script para WhatsApp Web
   Lê DOM do WhatsApp Web, extrai mensagens, áudios, imagens e envia para background
   v2 - Correção de detecção áudio/imagem e layout
*/

(() => {
  console.log('[Krever] Content script v2 carregado');

  let currentChatId = null;
  let observer = null;
  let lastExtractedCount = 0;

  const SELECTORS = {
    chatList: ['div[data-testid="chat-list"]', '#pane-side'],
    main: ['div[data-testid="conversation-panel-messages"]', '#main div[data-testid="conversation-panel-wrapper"]', '#main'],
    headerTitle: [
      'header span[data-testid="conversation-info-header-chat-title"]',
      '#main header span[title]',
      '#main header div[data-testid="conversation-info-header"] span',
      'header span[title]'
    ],
    header: ['#main header', 'header[data-testid="chat-info-header"]'],
  };

  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function getChatName() {
    const el = queryFirst(SELECTORS.headerTitle);
    if (el) {
      const title = el.getAttribute('title') || el.textContent;
      return (title || '').trim().slice(0, 100) || 'Cliente';
    }
    const header = queryFirst(SELECTORS.header);
    if (header) {
      const span = header.querySelector('span');
      if (span) return (span.textContent || '').trim().slice(0, 100) || 'Cliente';
    }
    return 'Cliente';
  }

  function getChatId() {
    const name = getChatName();
    try {
      const main = document.querySelector('#main');
      const dataId = main?.getAttribute('data-id') || main?.querySelector('[data-id]')?.getAttribute('data-id') || '';
      if (dataId) {
        // tenta hash estável
        return btoa(dataId + '|' + name).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
      }
    } catch {}
    const raw = name + '|' + window.location.href;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    return Math.abs(hash).toString(16).padStart(24, '0').slice(0, 24);
  }

  // NOVA LÓGICA DE EXTRAÇÃO - muito mais precisa
  function extractMessages() {
    const container = queryFirst(SELECTORS.main);
    if (!container) return [];

    // Pega apenas mensagens top-level: div.message-in e div.message-out
    // Essas são as mais confiáveis no WhatsApp Web atual
    let msgRows = Array.from(container.querySelectorAll('div.message-in, div.message-out'));
    
    // Fallback: se não achou, tenta data-id
    if (msgRows.length < 3) {
      const allDataId = Array.from(container.querySelectorAll('div[data-id^="true_"], div[data-id^="false_"]'));
      // Filtra apenas os que não estão dentro de outro com data-id (pega o mais externo)
      const seen = new Set();
      const filtered = [];
      for (const el of allDataId) {
        const id = el.getAttribute('data-id');
        if (!id || seen.has(id)) continue;
        // verifica se tem ancestral com mesmo data-id? Se sim, ignora interno
        let parent = el.parentElement;
        let hasAncestorWithSameId = false;
        while (parent && parent !== container) {
          if (parent.getAttribute && parent.getAttribute('data-id') === id) {
            hasAncestorWithSameId = true;
            break;
          }
          parent = parent.parentElement;
        }
        if (!hasAncestorWithSameId) {
          seen.add(id);
          filtered.push(el);
        }
      }
      if (filtered.length > msgRows.length) msgRows = filtered;
    }

    // Deduplica por data-id
    const uniqueMap = new Map();
    for (const el of msgRows) {
      const id = el.getAttribute('data-id') || el.querySelector('[data-id]')?.getAttribute('data-id') || `tmp_${Math.random()}`;
      if (!uniqueMap.has(id)) uniqueMap.set(id, el);
    }
    msgRows = Array.from(uniqueMap.values());

    const entries = [];
    const now = new Date().toISOString();

    for (let idx = 0; idx < msgRows.length; idx++) {
      const el = msgRows[idx];
      try {
        // data-id pode estar no próprio elemento ou em filho
        const dataIdEl = el.getAttribute('data-id') ? el : el.querySelector('[data-id]');
        const dataId = dataIdEl?.getAttribute('data-id') || `msg_${idx}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        
        // fromMe: message-out = você, message-in = cliente
        const isFromMe = el.classList.contains('message-out') || 
                         dataId.startsWith('true_') ||
                         !!el.closest('.message-out') ||
                         el.querySelector('.message-out') !== null ||
                         (dataIdEl && dataIdEl.classList.contains('message-out'));

        // ===== DETECÇÃO DE ÁUDIO - PRIORIDADE MÁXIMA =====
        // WhatsApp Web áudio tem estrutura muito específica
        const audioIndicators = [
          el.querySelector('audio'),
          el.querySelector('[data-testid="audio-play"]'),
          el.querySelector('[data-testid="ptt-play"]'),
          el.querySelector('[data-testid="audio-play-button"]'),
          el.querySelector('button[aria-label*="Reproduzir"]'),
          el.querySelector('span[data-icon="ptt"]'),
          el.querySelector('span[data-icon="audio-play"]'),
          el.querySelector('span[data-icon="ptt-out"]'),
          el.querySelector('span[data-icon="ptt-in"]'),
          el.querySelector('div[data-testid="audio-player"]'),
          el.querySelector('div[data-testid="ptt"]'),
          // waveform
          el.querySelector('canvas'),
          // ícone de microfone em áudio
          el.querySelector('[data-icon="mic"]'),
        ].filter(Boolean);

        // Também verifica se tem classe ou estrutura típica de áudio
        const hasAudioByClass = el.innerHTML.includes('data-icon="ptt"') || 
                                el.innerHTML.includes('audio-play') ||
                                el.querySelector('[role="button"][aria-label*="áudio" i]') ||
                                el.querySelector('[role="button"][aria-label*="audio" i]');

        const hasAudio = audioIndicators.length > 0 || hasAudioByClass;

        // ===== DETECÇÃO DE IMAGEM - SÓ SE NÃO FOR ÁUDIO =====
        let hasImage = false;
        let imgEl = null;
        if (!hasAudio) {
          // Imagem tem data-testid="image-thumb" ou é img grande de whatsapp.net
          const imageThumb = el.querySelector('[data-testid="image-thumb"]');
          if (imageThumb) {
            hasImage = true;
            imgEl = imageThumb.querySelector('img') || imageThumb;
          } else {
            // Procura img que não seja avatar e seja grande
            const allImgs = Array.from(el.querySelectorAll('img'));
            for (const img of allImgs) {
              const src = img.src || '';
              // Ignora avatares, ícones pequenos, etc
              if (img.closest('[data-testid="avatar"]')) continue;
              if (src.includes('avatar')) continue;
              if (img.width > 0 && img.width < 50) continue;
              if (img.height > 0 && img.height < 50) continue;
              // Imagem real do WhatsApp: blob: ou mmg.whatsapp.net ou pps
              if (src.startsWith('blob:') || src.includes('mmg.whatsapp.net') || src.includes('pps.whatsapp.net') || src.includes('whatsapp.net') && (img.naturalWidth > 100 || img.width > 100)) {
                // Verifica se não é sticker pequeno
                if (el.querySelector('[data-testid="sticker"]')) continue;
                hasImage = true;
                imgEl = img;
                break;
              }
              // Fallback: img com data-testid image
              if (img.getAttribute('data-testid') === 'image-thumb' || img.closest('[data-testid="image"]')) {
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
          // Tenta pegar src do áudio
          const audioEl = el.querySelector('audio');
          let src = audioEl?.src || '';
          if (!src) {
            // Tenta pegar de qualquer elemento com blob:
            const blobEl = Array.from(el.querySelectorAll('*')).find(e => e.src && e.src.startsWith('blob:'));
            src = blobEl?.src || '';
          }
          text = '[Áudio]';
          // Tenta extrair duração
          const durationEl = el.querySelector('[data-testid="audio-duration"], span[data-testid="audio-play"] + span, div[data-testid="msg-meta"]');
          let seconds = null;
          if (durationEl) {
            const m = durationEl.textContent.match(/(\d+):(\d+)/);
            if (m) seconds = parseInt(m[1])*60 + parseInt(m[2]);
          }
          audioInfo = {
            src: src || 'blob_pending',
            mimeType: 'audio/ogg; codecs=opus',
            seconds,
            transcriptionStatus: 'pending',
            sourceId: dataId
          };
        } else if (hasImage && imgEl) {
          type = 'image';
          const src = imgEl.src || imgEl.getAttribute('src') || '';
          text = '[Imagem]';
          imageInfo = {
            src: src,
            mimeType: src.startsWith('data:') ? (src.split(';')[0].split(':')[1] || 'image/jpeg') : 'image/jpeg',
            analysisStatus: 'pending',
            sourceId: dataId
          };
        } else {
          // TEXTO
          const textSelectors = [
            'span[data-testid="msg-text"]',
            'div.copyable-text span.selectable-text',
            'div[data-testid="msg-container"] span.selectable-text',
            '.copyable-text'
          ];
          let foundText = '';
          for (const sel of textSelectors) {
            const tEl = el.querySelector(sel);
            if (tEl && tEl.innerText && tEl.innerText.trim().length > 0) {
              // Evita pegar meta
              if (tEl.closest('[data-testid="msg-meta"]')) continue;
              foundText = tEl.innerText.trim();
              if (foundText) break;
            }
          }
          if (!foundText) {
            // fallback: pega texto da mensagem removendo meta
            const clone = el.cloneNode(true);
            // Remove elementos de meta, ícones, etc
            clone.querySelectorAll('[data-testid="msg-meta"], [data-testid="msg-info"], .message-meta, [data-icon]').forEach(m => m.remove());
            foundText = (clone.innerText || '').trim();
            // Remove linhas que são só hora ou checkmarks
            foundText = foundText.split('\n').filter(line => {
              const l = line.trim();
              if (!l) return false;
              if (/^\d{1,2}:\d{2}$/.test(l)) return false;
              if (/^[✓✔]+$/.test(l)) return false;
              return true;
            }).join('\n').trim();
          }
          text = foundText.slice(0, 30000);
          if (!text) continue; // ignora vazias (pode ser só imagem/áudio sem caption)
        }

        // Timestamp
        let timestamp = now;
        const prePlain = el.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') ||
                         el.getAttribute('data-pre-plain-text') ||
                         el.querySelector('[data-pre-plain-text]')?.parentElement?.getAttribute('data-pre-plain-text');
        if (prePlain) {
          const match = prePlain.match(/\[(\d+):(\d+), (\d+)\/(\d+)\/(\d+)\]/);
          if (match) {
            const [, hh, mm, dd, MM, yyyy] = match;
            const d = new Date(`${yyyy}-${MM}-${dd}T${hh}:${mm}:00`);
            if (!isNaN(d)) timestamp = d.toISOString();
          }
        } else {
          // tenta pegar hora do meta
          const meta = el.querySelector('[data-testid="msg-meta"]');
          if (meta) {
            const timeMatch = meta.textContent.match(/(\d{1,2}):(\d{2})/);
            if (timeMatch) {
              const today = new Date();
              today.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
              timestamp = today.toISOString();
            }
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
        console.warn('[Krever] Erro ao extrair mensagem', e, el);
      }
    }

    // Ordena por timestamp se possível, senão mantém ordem DOM
    return entries;
  }

  function injectFloatingButton() {
    if (document.getElementById('krever-floating-btn')) return;
    const header = queryFirst(SELECTORS.header);
    if (!header) return;

    const btn = document.createElement('button');
    btn.id = 'krever-floating-btn';
    btn.textContent = '📋 Resumidor';
    btn.title = 'Abrir Krever Resumidor';
    btn.style.cssText = `
      margin-left: 12px;
      padding: 6px 12px;
      background: linear-gradient(135deg, #4de0d2, #76a9ff);
      color: #06111f;
      border: none;
      border-radius: 8px;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      z-index: 9999;
    `;
    btn.addEventListener('click', () => {
      alert('Krever Resumidor: Clique no ícone da extensão na barra superior para resumir esta conversa!\n\nConversa detectada: ' + getChatName() + '\nMensagens encontradas: ' + extractMessages().length);
    });
    header.appendChild(btn);
  }

  function startObserver() {
    const container = queryFirst(SELECTORS.main);
    if (!container) {
      setTimeout(startObserver, 2000);
      return;
    }
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      const currentCount = container.querySelectorAll('div.message-in, div.message-out, div[data-id^="true_"], div[data-id^="false_"]').length;
      if (currentCount !== lastExtractedCount) {
        lastExtractedCount = currentCount;
        debounceExtract();
      }
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
          console.log('[Krever] Nova conversa detectada:', getChatName(), chatId, 'msgs:', entries.length, 'audios:', entries.filter(e=>e.type==='audio').length, 'imgs:', entries.filter(e=>e.type==='image').length);
        }
        chrome.runtime.sendMessage({
          type: 'CONVERSATION_UPDATE',
          payload: {
            conversationId: chatId,
            conversationName: getChatName(),
            entries: entries
          }
        }).catch(() => {});
      }
    }, 800);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'GET_CURRENT_CHAT') {
        const entries = extractMessages();
        console.log('[Krever] GET_CURRENT_CHAT', entries.length, 'audios:', entries.filter(e=>e.type==='audio').length);
        sendResponse({
          conversationId: getChatId(),
          conversationName: getChatName(),
          entries,
          url: window.location.href
        });
      } else if (msg.type === 'SCROLL_FOR_HISTORY') {
        const count = msg.count || 50;
        const result = await scrollForHistory(count);
        sendResponse(result);
      } else if (msg.type === 'GET_AUDIO_BLOB') {
        const { messageId } = msg;
        const blob = await getAudioBlob(messageId);
        if (blob) {
          const arrayBuffer = await blob.arrayBuffer();
          sendResponse({ success: true, data: Array.from(new Uint8Array(arrayBuffer)), mimeType: blob.type || 'audio/ogg', size: blob.size });
        } else {
          sendResponse({ success: false, error: 'Áudio não encontrado. Tente reproduzir o áudio no WhatsApp antes.' });
        }
      } else if (msg.type === 'GET_IMAGE_BLOB') {
        const { messageId, src } = msg;
        const result = await getImageBlob(messageId, src);
        sendResponse(result);
      } else if (msg.type === 'PING') {
        const entries = extractMessages();
        sendResponse({ ok: true, chat: getChatName(), messages: entries.length, audios: entries.filter(e=>e.type==='audio').length, images: entries.filter(e=>e.type==='image').length });
      }
    })();
    return true;
  });

  async function scrollForHistory(targetCount) {
    const container = queryFirst(SELECTORS.main);
    if (!container) return { success: false, error: 'Container não encontrado' };

    const scrollable = container.querySelector('div[data-testid="conversation-panel-messages"]') || 
                      container.querySelector('.copyable-area') ||
                      container;

    const initialCount = extractMessages().length;
    let lastCount = initialCount;
    let attempts = 0;
    const maxAttempts = 25;

    return new Promise(resolve => {
      const interval = setInterval(() => {
        scrollable.scrollTop = 0;
        const parent = scrollable.parentElement;
        if (parent) parent.scrollTop = 0;
        // tenta também scroll no elemento com overflow
        const overflowEl = document.querySelector('#main div[tabindex="0"]');
        if (overflowEl) overflowEl.scrollTop = 0;

        attempts++;
        const currentCount = extractMessages().length;
        
        if (currentCount > lastCount) {
          lastCount = currentCount;
          console.log(`[Krever] Histórico carregado: ${currentCount} mensagens`);
        }

        if (currentCount >= initialCount + targetCount || attempts >= maxAttempts) {
          clearInterval(interval);
          setTimeout(() => {
            scrollable.scrollTop = scrollable.scrollHeight;
            if (parent) parent.scrollTop = parent.scrollHeight;
          }, 500);
          resolve({ 
            success: true, 
            initialCount, 
            finalCount: currentCount, 
            added: currentCount - initialCount 
          });
        }
      }, 1300);
    });
  }

  async function getAudioBlob(messageId) {
    const container = queryFirst(SELECTORS.main);
    if (!container) return null;

    // Encontra elemento da mensagem
    let msgEl = null;
    try {
      msgEl = container.querySelector(`div[data-id="${CSS.escape(messageId)}"]`);
    } catch {
      msgEl = Array.from(container.querySelectorAll('[data-id]')).find(el => el.getAttribute('data-id') === messageId);
    }
    if (!msgEl) {
      // tenta por closest message-in/out que contém data-id
      msgEl = Array.from(container.querySelectorAll('div.message-in, div.message-out')).find(el => {
        const inner = el.querySelector(`[data-id="${messageId}"]`) || el.getAttribute('data-id') === messageId;
        return !!inner;
      });
    }
    
    if (!msgEl) {
      console.warn('[Krever] msgEl não encontrado para', messageId);
      return null;
    }

    // Procura audio element ou blob src dentro da mensagem
    const candidates = [
      msgEl.querySelector('audio'),
      msgEl.querySelector('audio source'),
      ...Array.from(msgEl.querySelectorAll('*')).filter(e => e.src && e.src.startsWith('blob:'))
    ].filter(Boolean);

    for (const cand of candidates) {
      const src = cand.src || cand.getAttribute('src');
      if (src && src.startsWith('blob:')) {
        try {
          const res = await fetch(src);
          const blob = await res.blob();
          if (blob.size > 100) return blob;
        } catch (e) {
          console.warn('[Krever] Erro fetch blob', e);
        }
      }
    }

    // Se não achou blob, tenta clicar no play para forçar carregamento do blob
    // (WhatsApp só cria blob após interação)
    const playBtn = msgEl.querySelector('[data-testid="audio-play"], [data-testid="ptt-play"], button[aria-label*="Reproduzir"]');
    if (playBtn) {
      console.log('[Krever] Tentando clicar play para carregar blob');
      // Não clica automaticamente pra não tocar áudio, mas avisa usuário
    }

    return null;
  }

  async function getImageBlob(messageId, providedSrc) {
    try {
      let src = providedSrc;
      if (!src && messageId) {
        const container = queryFirst(SELECTORS.main);
        let msgEl = null;
        try {
          msgEl = container?.querySelector(`div[data-id="${CSS.escape(messageId)}"]`);
        } catch {
          msgEl = Array.from(container?.querySelectorAll('[data-id]') || []).find(el => el.getAttribute('data-id') === messageId);
        }
        src = msgEl?.querySelector('img')?.src || msgEl?.querySelector('[data-testid="image-thumb"] img')?.src;
      }
      if (!src) return { success: false, error: 'Imagem não encontrada' };

      if (src.startsWith('data:')) {
        const [header, base64] = src.split(',');
        const mime = header.split(':')[1].split(';')[0];
        return { success: true, base64, mimeType: mime, isBase64: true };
      }

      if (src.startsWith('blob:') || src.startsWith('http')) {
        const res = await fetch(src);
        const blob = await res.blob();
        const arrayBuffer = await blob.arrayBuffer();
        // base64 seguro para blobs grandes
        let binary = '';
        const bytes = new Uint8Array(arrayBuffer);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        return { 
          success: true, 
          base64, 
          mimeType: blob.type || 'image/jpeg', 
          size: blob.size,
          data: Array.from(bytes)
        };
      }

      return { success: false, error: 'Src inválido: ' + src.slice(0, 100) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function init() {
    console.log('[Krever] Iniciando v2...');
    const check = setInterval(() => {
      const chatList = queryFirst(SELECTORS.chatList);
      const main = queryFirst(SELECTORS.main);
      if (chatList || main) {
        clearInterval(check);
        console.log('[Krever] WhatsApp Web detectado v2');
        startObserver();
        setInterval(injectFloatingButton, 3000);
        debounceExtract();
        setInterval(debounceExtract, 4000);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.KreverContent = {
    extractMessages,
    getChatName,
    getChatId,
    scrollForHistory,
    getAudioBlob,
    getImageBlob
  };
})();
