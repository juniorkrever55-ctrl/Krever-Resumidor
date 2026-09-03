/* Krever Resumidor - Background Service Worker
   Gerencia Groq, Ollama, storage, downloads e comunicação
*/

importScripts('lib/prompts.js', 'lib/utils.js', 'lib/storage.js', 'lib/groq.js');

console.log('[Krever BG] Service Worker iniciado');

// Mantém config em memória
let currentConfig = null;
let aiClient = null;

async function loadConfig() {
  currentConfig = await KreverStorage.getConfig();
  aiClient = new AIClient(currentConfig);
  return currentConfig;
}

// Carrega config ao iniciar
loadConfig();

// Atualiza quando storage muda
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local') {
    console.log('[Krever BG] Config alterada, recarregando');
    await loadConfig();
  }
});

// --- Comunicação ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const config = currentConfig || await loadConfig();

      switch (msg.type) {
        case 'CONVERSATION_UPDATE': {
          const { conversationId, conversationName, entries } = msg.payload;
          // Salva no storage
          await KreverStorage.saveConversationEntries(conversationId, entries);
          // Atualiza meta
          const meta = {
            id: conversationId,
            name: conversationName,
            phone: entries[0]?.phone || '',
            jid: conversationId,
            lastMessageAt: entries[entries.length - 1]?.timestamp || new Date().toISOString(),
            messageCount: entries.length,
            preview: String(entries[entries.length - 1]?.text || '').slice(0, 140)
          };
          await KreverStorage.saveConversationMeta(meta);
          sendResponse({ ok: true });
          break;
        }

        case 'GET_CONVERSATIONS': {
          const index = await KreverStorage.getConversationsIndex();
          const conversations = Object.values(index).sort((a, b) => 
            String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''))
          );
          sendResponse({ conversations });
          break;
        }

        case 'GET_CONVERSATION': {
          const { conversationId } = msg;
          const entries = await KreverStorage.getConversationEntries(conversationId);
          const index = await KreverStorage.getConversationsIndex();
          sendResponse({ 
            conversation: index[conversationId] || null, 
            entries 
          });
          break;
        }

        case 'GET_CONFIG': {
          sendResponse({ config });
          break;
        }

        case 'SAVE_CONFIG': {
          await KreverStorage.saveConfig(msg.config);
          await loadConfig();
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_ALL': {
          await KreverStorage.clearAllConversations();
          sendResponse({ ok: true });
          break;
        }

        case 'TRANSCRIBE_AUDIO': {
          // msg.blobData é array de bytes
          const { blobData, mimeType, fileName, conversationId, messageId } = msg;
          const blob = new Blob([new Uint8Array(blobData)], { type: mimeType });
          const result = await aiClient.transcribeAudio(blob, fileName, mimeType);
          
          // Atualiza entry
          if (conversationId && messageId) {
            const entries = await KreverStorage.getConversationEntries(conversationId);
            const idx = entries.findIndex(e => e.sourceId === messageId || e.id === messageId);
            if (idx !== -1) {
              entries[idx].text = result.text;
              entries[idx].audio = { ...entries[idx].audio, transcriptionStatus: result.status, transcribedAt: new Date().toISOString() };
              await KreverStorage.saveConversationEntries(conversationId, entries);
            }
          }
          
          sendResponse({ success: true, result });
          break;
        }

        case 'ANALYZE_IMAGE': {
          const { base64, mimeType, conversationId, messageId } = msg;
          const analysis = await aiClient.analyzeImage(base64, mimeType);
          
          if (conversationId && messageId) {
            const entries = await KreverStorage.getConversationEntries(conversationId);
            const idx = entries.findIndex(e => e.sourceId === messageId || e.id === messageId);
            if (idx !== -1) {
              entries[idx].text = `[Imagem analisada] ${analysis}`;
              entries[idx].image = { ...entries[idx].image, analysisStatus: 'completed', analyzedAt: new Date().toISOString() };
              await KreverStorage.saveConversationEntries(conversationId, entries);
            }
          }
          
          sendResponse({ success: true, analysis });
          break;
        }

        case 'SUMMARIZE_CONVERSATION': {
          const { conversationId, instructions, provider } = msg;
          const entries = await KreverStorage.getConversationEntries(conversationId);
          if (!entries.length) throw new Error('Conversa vazia');
          
          const transcript = KreverUtils.buildTranscript(entries);
          const summary = await aiClient.summarize(transcript, instructions, provider);
          sendResponse({ success: true, summary, transcriptLength: transcript.length });
          break;
        }

        case 'SUMMARIZE_TEXT': {
          const { text, instructions, provider } = msg;
          if (!text?.trim()) throw new Error('Texto vazio');
          const summary = await aiClient.summarize(text, instructions, provider);
          sendResponse({ success: true, summary });
          break;
        }

        case 'TOKEN_ESTIMATE': {
          const { conversationId, instructions, provider } = msg;
          const entries = await KreverStorage.getConversationEntries(conversationId);
          const transcript = KreverUtils.buildTranscript(entries);
          const prompt = instructions?.trim() ? instructions.trim().slice(0, 5000) : DEFAULT_SUMMARY_INSTRUCTIONS;
          const inputTokens = KreverUtils.estimateTokens(`${prompt}\n${transcript}`);
          const outputTokens = provider === 'ollama' ? 1200 : 900;
          sendResponse({
            estimatedInputTokens: inputTokens,
            outputTokenBudget: outputTokens,
            estimatedTotalTokens: inputTokens + outputTokens,
            originalCharacters: transcript.length,
            sentCharacters: transcript.length,
            provider
          });
          break;
        }

        case 'EXPORT_TXT': {
          const { conversationId } = msg;
          const entries = await KreverStorage.getConversationEntries(conversationId);
          const index = await KreverStorage.getConversationsIndex();
          const conv = index[conversationId];
          const content = KreverUtils.buildExportContent(conv?.name || 'Cliente', conv?.phone || '', entries);
          const fileName = `${KleverUtilsSafeFileName(conv?.name)}-${new Date().toISOString().slice(0,10)}.txt`;
          // Na extensão, o download é feito pelo popup via chrome.downloads, mas podemos retornar conteúdo
          sendResponse({ success: true, content, fileName: fileName || `cliente-${new Date().toISOString().slice(0,10)}.txt` });
          break;
        }

        case 'PREPARE_GEMINI': {
          const { conversationId, instructions } = msg;
          const entries = await KreverStorage.getConversationEntries(conversationId);
          const index = await KreverStorage.getConversationsIndex();
          const conv = index[conversationId];
          const content = KreverUtils.buildExportContent(conv?.name || 'Cliente', conv?.phone || '', entries);
          const fileName = `${KleverUtilsSafeFileName(conv?.name)}-${new Date().toISOString().slice(0,10)}.txt`;
          
          // Cria blob URL para download via offscreen ou retorna conteúdo
          // O popup vai lidar com download + clipboard + abrir Gemini
          sendResponse({ 
            success: true, 
            content, 
            fileName,
            geminiUrl: config.geminiChatUrl,
            prompt: GEMINI_PROMPT_PREFIX + (instructions || config.instructions)
          });
          break;
        }

        case 'OPEN_GEMINI': {
          const { url } = msg;
          chrome.tabs.create({ url: url || config.geminiChatUrl });
          sendResponse({ ok: true });
          break;
        }

        case 'CHECK_WHATSAPP_TAB': {
          const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
          sendResponse({ hasTab: tabs.length > 0, tabs: tabs.map(t => ({ id: t.id, url: t.url })) });
          break;
        }

        default:
          sendResponse({ error: 'Tipo desconhecido: ' + msg.type });
      }
    } catch (e) {
      console.error('[Krever BG] Erro', e);
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true; // async
});

function KleverUtilsSafeFileName(name) {
  try {
    return KreverUtils.safeExportFileName(name);
  } catch {
    return 'cliente';
  }
}

// Alarme para manter service worker vivo durante transcrição longa (opcional)
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log('[Krever BG] keepAlive');
  }
});

// --- Offscreen helper para manter SW vivo em jobs longos ---
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  if (creatingOffscreen) await creatingOffscreen;
  else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS', 'AUDIO_PLAYBACK'],
      justification: 'Manter transcrição de áudio longa e análise de imagens ativa'
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
}

// Tenta criar offscreen quando começa transcrição
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TRANSCRIBE_AUDIO' || msg.type === 'ANALYZE_IMAGE') {
    ensureOffscreen().catch(()=>{});
  }
});

// Quando extensão instalada, abre options
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
