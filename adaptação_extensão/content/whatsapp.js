/* Krever Resumidor - Content Script para WhatsApp Web
   Lê DOM do WhatsApp Web, extrai mensagens, áudios, imagens e envia para background
*/

(() => {
  console.log('[Krever] Content script carregado');

  let currentChatId = null;
  let observer = null;
  let lastExtractedCount = 0;
  let isExtracting = false;

  // --- Utils de DOM robustos (tenta vários seletores por causa de mudanças do WhatsApp) ---
  const SELECTORS = {
    chatList: ['div[data-testid="chat-list"]', '#pane-side', 'div[aria-label="Lista de conversas"]'],
    chat: ['div[data-testid="chat"]', 'div[data-testid="chat-list"] > div > div', '#pane-side div[role="listitem"]'],
    main: ['div[data-testid="conversation-panel-messages"]', '#main', 'div#main div[data-testid="conversation-panel-wrapper"]'],
    messageContainer: ['div[data-testid="conversation-panel-messages"]', '#main div.copyable-area', 'div[data-testid="msg-container"]'],
    messages: [
      'div[data-testid="msg-container"]',
      'div.message-in, div.message-out',
      'div[data-id^="true_"], div[data-id^="false_"]',
      '#main div[data-id]'
    ],
    headerTitle: [
      'header span[data-testid="conversation-info-header-chat-title"]',
      '#main header span[title]',
      '#main header div[data-testid="conversation-info-header"] span',
      'header span[title]'
    ],
    header: ['#main header', 'header[data-testid="chat-info-header"]'],
    msgText: ['span[data-testid="msg-text"]', 'div.copyable-text span', 'span.selectable-text'],
    audio: ['audio', 'span[data-testid="audio-play"]', 'button[data-testid="audio-play"]', 'div[data-testid="ptt"]'],
    image: ['img[data-testid="image-thumb"]', '#main img[src^="blob:"]', '#main img[src^="https://pps"]', 'div[data-testid="image"] img', 'img[src*="mmg.whatsapp.net"]'],
    time: ['span[data-testid="msg-meta"]', 'div[data-testid="msg-meta"] span', 'span[data-pre-plain-text]']
  };

  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function queryAll(selectors, root = document) {
    for (const sel of selectors) {
      const els = root.querySelectorAll(sel);
      if (els.length) return Array.from(els);
    }
    return [];
  }

  function getChatName() {
    const el = queryFirst(SELECTORS.headerTitle);
    if (el) {
      const title = el.getAttribute('title') || el.textContent;
      return (title || '').trim().slice(0, 100) || 'Cliente';
    }
    // fallback: tenta pegar do header
    const header = queryFirst(SELECTORS.header);
    if (header) {
      const span = header.querySelector('span');
      if (span) return (span.textContent || '').trim().slice(0, 100) || 'Cliente';
    }
    return 'Cliente';
  }

  function getChatId() {
    // Tenta extrair ID da URL ou do data-id da conversa ativa
    // URL: https://web.whatsapp.com/ -> chat id não está na URL, mas podemos usar nome + hash como ID
    const name = getChatName();
    // Tenta pegar JID via Store se disponível
    try {
      const jid = window.Store?.Chat?.models?.[0]?.__x_id?._serialized || 
                  document.querySelector('#main')?.getAttribute('data-id') ||
                  '';
      if (jid) return btoa(jid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    } catch {}
    // fallback: hash do nome + timestamp da última mensagem
    const raw = name + '|' + window.location.href;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    return Math.abs(hash).toString(16).padStart(24, '0').slice(0, 24);
  }

  function extractMessages() {
    const container = queryFirst(SELECTORS.main);
    if (!container) return [];

    // Pega todos os containers de mensagem
    let msgElements = [];
    for (const sel of SELECTORS.messages) {
      const found = container.querySelectorAll(sel);
      if (found.length > 5) { // precisa ter algumas mensagens
        msgElements = Array.from(found);
        break;
      }
    }
    if (!msgElements.length) {
      // fallback: pega divs com data-id que parecem mensagens
      msgElements = Array.from(container.querySelectorAll('div[data-id]')).filter(el => {
        const id = el.getAttribute('data-id');
        return id && (id.startsWith('true_') || id.startsWith('false_'));
      });
    }

    const entries = [];
    const now = new Date().toISOString();

    msgElements.forEach((el, idx) => {
      try {
        const dataId = el.getAttribute('data-id') || `msg_${idx}_${Date.now()}`;
        const isFromMe = el.classList.contains('message-out') || dataId.startsWith('true_') || el.querySelector('.message-out') !== null;
        
        // Verifica se é áudio
        const hasAudio = el.querySelector('audio') || el.querySelector('[data-testid="audio-play"]') || el.querySelector('span[data-icon="ptt"]') || el.textContent.includes('Áudio');
        // Verifica se é imagem
        const imgEl = el.querySelector('img');
        const hasImage = imgEl && (
          imgEl.src.startsWith('blob:') || 
          imgEl.src.includes('whatsapp.net') ||
          el.querySelector('[data-testid="image-thumb"]') ||
          el.querySelector('[data-testid="sticker"]') === null && imgEl.width > 100
        );

        let text = '';
        let type = 'text';
        let audioInfo = null;
        let imageInfo = null;

        if (hasAudio) {
          type = 'audio';
          const audioEl = el.querySelector('audio');
          const src = audioEl?.src || el.querySelector('button')?.getAttribute('src') || '';
          text = '[Áudio recebido — clique em Transcrever na extensão]';
          audioInfo = {
            src: src || 'blob_pending',
            mimeType: 'audio/ogg',
            seconds: null,
            transcriptionStatus: 'pending',
            sourceId: dataId
          };
        } else if (hasImage && imgEl) {
          type = 'image';
          const src = imgEl.src;
          text = '[Imagem recebida — será analisada ao gerar resumo]';
          imageInfo = {
            src: src,
            mimeType: src.startsWith('data:') ? src.split(';')[0].split(':')[1] : 'image/jpeg',
            analysisStatus: 'pending',
            sourceId: dataId
          };
        } else {
          // Texto
          const textEl = el.querySelector('span[data-testid="msg-text"]') || 
                        el.querySelector('div.copyable-text') ||
                        el.querySelector('.copyable-text');
          if (textEl) {
            text = textEl.innerText || textEl.textContent || '';
          } else {
            // pega texto direto, removendo metadados
            const clone = el.cloneNode(true);
            const meta = clone.querySelectorAll('[data-testid="msg-meta"], .message-meta');
            meta.forEach(m => m.remove());
            text = (clone.innerText || '').trim();
          }
          text = text.trim().slice(0, 30000);
          if (!text) return; // ignora vazias
        }

        // Timestamp
        let timestamp = now;
        const timeEl = el.querySelector('[data-pre-plain-text]');
        if (timeEl) {
          const pre = timeEl.getAttribute('data-pre-plain-text');
          // formato: "[10:30, 26/08/2025] Nome:"
          const match = pre?.match(/\[(\d+):(\d+), (\d+)\/(\d+)\/(\d+)\]/);
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
        console.warn('[Krever] Erro ao extrair mensagem', e);
      }
    });

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
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP_FROM_CONTENT' });
      // Também tenta abrir popup via mensagem
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
      if (isExtracting) return;
      const currentCount = container.querySelectorAll('div[data-id]').length;
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
          console.log('[Krever] Nova conversa detectada:', getChatName(), chatId);
        }
        // Envia para background
        chrome.runtime.sendMessage({
          type: 'CONVERSATION_UPDATE',
          payload: {
            conversationId: chatId,
            conversationName: getChatName(),
            entries: entries
          }
        }).catch(() => {}); // ignora se background não estiver pronto
      }
    }, 800);
  }

  // --- Handlers de mensagens do background/popup ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'GET_CURRENT_CHAT') {
        const entries = extractMessages();
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
          sendResponse({ success: true, data: Array.from(new Uint8Array(arrayBuffer)), mimeType: blob.type, size: blob.size });
        } else {
          sendResponse({ success: false, error: 'Áudio não encontrado' });
        }
      } else if (msg.type === 'GET_IMAGE_BLOB') {
        const { messageId, src } = msg;
        const result = await getImageBlob(messageId, src);
        sendResponse(result);
      } else if (msg.type === 'PING') {
        sendResponse({ ok: true, chat: getChatName(), messages: extractMessages().length });
      }
    })();
    return true; // async
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
    const maxAttempts = 20;

    return new Promise(resolve => {
      const interval = setInterval(() => {
        // Scroll para o topo
        scrollable.scrollTop = 0;
        // Também tenta scroll do container pai
        const parent = scrollable.parentElement;
        if (parent) parent.scrollTop = 0;

        attempts++;
        const currentCount = extractMessages().length;
        
        if (currentCount > lastCount) {
          lastCount = currentCount;
          console.log(`[Krever] Histórico carregado: ${currentCount} mensagens`);
        }

        if (currentCount >= initialCount + targetCount || attempts >= maxAttempts) {
          clearInterval(interval);
          // Volta para baixo
          setTimeout(() => {
            scrollable.scrollTop = scrollable.scrollHeight;
          }, 500);
          resolve({ 
            success: true, 
            initialCount, 
            finalCount: currentCount, 
            added: currentCount - initialCount 
          });
        }
      }, 1200);
    });
  }

  async function getAudioBlob(messageId) {
    const container = queryFirst(SELECTORS.main);
    if (!container) return null;

    const msgEl = container.querySelector(`div[data-id="${CSS.escape(messageId)}"]`) || 
                  Array.from(container.querySelectorAll('div[data-id]')).find(el => el.getAttribute('data-id') === messageId);
    
    if (!msgEl) return null;

    // Tenta pegar src do audio
    const audioEl = msgEl.querySelector('audio');
    let src = audioEl?.src;
    
    if (!src) {
      // Tenta botão de play que pode ter blob
      const btn = msgEl.querySelector('button');
      src = btn?.querySelector('audio')?.src;
    }

    // Se src é blob:, fetch funciona porque é mesma origem
    if (src && src.startsWith('blob:')) {
      try {
        const res = await fetch(src);
        return await res.blob();
      } catch (e) {
        console.warn('[Krever] Erro ao fetch blob audio', e);
      }
    }

    // Fallback: tenta via Store se disponível
    try {
      if (window.Store) {
        // Tentativa de pegar via WA Web API interna
        const msg = window.Store.Msg?.get(messageId);
        if (msg && msg.mediaData) {
          // mediaData pode ter url
          const url = msg.mediaData.mediaBlob?.url || msg.mediaData.url;
          if (url) {
            const res = await fetch(url);
            return await res.blob();
          }
        }
      }
    } catch {}

    return null;
  }

  async function getImageBlob(messageId, providedSrc) {
    try {
      let src = providedSrc;
      if (!src && messageId) {
        const container = queryFirst(SELECTORS.main);
        const msgEl = container?.querySelector(`div[data-id="${CSS.escape(messageId)}"]`);
        src = msgEl?.querySelector('img')?.src;
      }
      if (!src) return { success: false, error: 'Imagem não encontrada' };

      if (src.startsWith('data:')) {
        // já é base64
        const [header, base64] = src.split(',');
        const mime = header.split(':')[1].split(';')[0];
        return { success: true, base64, mimeType: mime, isBase64: true };
      }

      if (src.startsWith('blob:') || src.startsWith('http')) {
        const res = await fetch(src);
        const blob = await res.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        return { 
          success: true, 
          base64, 
          mimeType: blob.type || 'image/jpeg', 
          size: blob.size,
          data: Array.from(new Uint8Array(arrayBuffer))
        };
      }

      return { success: false, error: 'Src inválido: ' + src.slice(0, 100) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // --- Inicialização ---
  function init() {
    console.log('[Krever] Iniciando...');
    // Aguarda WhatsApp carregar
    const check = setInterval(() => {
      const chatList = queryFirst(SELECTORS.chatList);
      const main = queryFirst(SELECTORS.main);
      if (chatList || main) {
        clearInterval(check);
        console.log('[Krever] WhatsApp Web detectado');
        startObserver();
        setInterval(injectFloatingButton, 3000);
        debounceExtract();
        // Extrai a cada 5s também
        setInterval(debounceExtract, 5000);
      }
    }, 1000);

    // Tenta injetar Store hook para acesso a dados internos
    tryInjectStore();
  }

  function tryInjectStore() {
    // Injeta script no contexto da página para acessar webpack
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        window.addEventListener('load', () => {
          try {
            // Tenta expor Store globalmente (método conhecido)
            const webpackRequire = window.webpackChunkwhatsapp_web_client?.push?.[0]?.[1];
            // Não faz nada destrutivo, só tenta expor
            console.log('[Krever Injected] Tentando expor Store...');
          } catch(e) {}
        });
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  }

  // Inicia quando DOM pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expõe para debug
  window.KreverContent = {
    extractMessages,
    getChatName,
    getChatId,
    scrollForHistory,
    getAudioBlob,
    getImageBlob
  };
})();
