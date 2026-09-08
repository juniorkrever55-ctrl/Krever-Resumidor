/* Popup JS - Interface da extensão */

let currentConversationId = null;
let currentEntries = [];
let currentConversationName = 'Cliente';
let config = null;

// DOM
const els = {
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  refreshStatus: document.getElementById('refresh-status'),
  currentName: document.getElementById('current-name'),
  currentInfo: document.getElementById('current-info'),
  currentEntries: document.getElementById('current-entries'),
  savedList: document.getElementById('saved-list'),
  searchSaved: document.getElementById('search-saved'),
  tokenEstimate: document.getElementById('token-estimate'),
  summaryOutput: document.getElementById('summary-output'),
  manualText: document.getElementById('manual-text'),
  manualOutput: document.getElementById('manual-output'),
  aiProvider: document.getElementById('ai-provider'),
  messageCount: document.getElementById('message-count'),
  // buttons
  btnScroll: document.getElementById('btn-scroll-history'),
  btnRefreshCurrent: document.getElementById('btn-refresh-current'),
  btnTranscribeAll: document.getElementById('btn-transcribe-all'),
  btnAnalyzeAll: document.getElementById('btn-analyze-all'),
  btnToken: document.getElementById('btn-token'),
  btnExport: document.getElementById('btn-export'),
  btnGemini: document.getElementById('btn-gemini'),
  btnSummarize: document.getElementById('btn-summarize'),
  btnCopy: document.getElementById('btn-copy-summary'),
  btnManual: document.getElementById('btn-manual'),
  btnClearAll: document.getElementById('btn-clear-all'),
  openOptions: document.getElementById('open-options'),
  openWhatsapp: document.getElementById('open-whatsapp')
};

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'saved') loadSavedConversations();
  });
});

async function getConfig() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  config = res.config;
  if (els.aiProvider) {
    els.aiProvider.value = config.summaryProvider || 'groq';
  }
  return config;
}

async function checkWhatsAppTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (tabs.length === 0) {
      els.statusDot.className = 'dot error';
      els.statusText.textContent = 'WhatsApp Web não aberto';
      return null;
    }
    // Ping content script
    try {
      const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' });
      if (res?.ok) {
        els.statusDot.className = 'dot connected';
        const audioInfo = res.audios ? ` • ${res.audios} áudios` : '';
        const imgInfo = res.images ? ` • ${res.images} imgs` : '';
        els.statusText.textContent = `Conectado: ${res.chat} (${res.messages} msgs${audioInfo}${imgInfo})`;
        return tabs[0];
      }
    } catch (err) {
      console.warn('Ping falhou', err);
      els.statusDot.className = 'dot';
      els.statusText.textContent = 'WhatsApp aberto, mas recarregue a página (F5)';
    }
    return tabs[0];
  } catch (e) {
    els.statusDot.className = 'dot error';
    els.statusText.textContent = 'Erro: ' + e.message;
    return null;
  }
}

async function loadCurrentChat() {
  const tab = await checkWhatsAppTab();
  if (!tab) {
    els.currentName.textContent = 'WhatsApp não detectado';
    els.currentInfo.textContent = 'Abra web.whatsapp.com e selecione uma conversa';
    els.currentEntries.innerHTML = '<p class="empty">Abra o WhatsApp Web</p>';
    setButtonsDisabled(true);
    return;
  }

  try {
    const data = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_CHAT' });
    console.log('[Krever Popup] Dados recebidos:', data);
    
    if (!data) {
      els.currentName.textContent = 'Sem resposta do WhatsApp';
      els.currentInfo.textContent = 'Recarregue o WhatsApp Web (F5)';
      els.currentEntries.innerHTML = '<p class="empty">Content script não respondeu. Recarregue a página do WhatsApp.</p>';
      setButtonsDisabled(true);
      return;
    }

    if (!data.entries?.length) {
      // Tenta debug
      let debugInfo = '';
      try {
        const debug = await chrome.tabs.sendMessage(tab.id, { type: 'DEBUG_DOM' });
        console.log('[Krever] Debug DOM:', debug);
        debugInfo = `\n\nDEBUG:\n- #main: ${debug.hasMain}\n- divs em #main: ${debug.mainDivs}\n- [data-id]: ${debug.dataIds}\n- message-in/out: ${debug.messageInOut}\n- msg-container: ${debug.msgContainer}\n- true/false: ${debug.trueFalse}\n- copyable: ${debug.copyable}\n- Nome: ${debug.chatName}`;
      } catch (e) {
        debugInfo = '\n\nNão foi possível obter debug';
      }
      
      els.currentName.textContent = data.conversationName || 'Conversa detectada mas sem mensagens';
      els.currentInfo.textContent = `Nome: ${data.conversationName} • Nenhuma mensagem extraída`;
      els.currentEntries.innerHTML = `<p class="empty">Nenhuma mensagem encontrada nesta conversa.<br><br>Isso pode acontecer se:<br>• Você não selecionou uma conversa (clique em uma conversa no WhatsApp)<br>• WhatsApp Web mudou layout (abra F12 > Console e veja logs [Krever])<br><br>${debugInfo.replace(/\n/g, '<br>')}</p>`;
      setButtonsDisabled(true);
      
      // Ainda salva o que tem (mesmo vazio) para debug
      currentConversationId = data.conversationId;
      currentEntries = [];
      currentConversationName = data.conversationName;
      return;
    }

    currentConversationId = data.conversationId;
    currentEntries = data.entries;
    currentConversationName = data.conversationName;

    els.currentName.textContent = data.conversationName;
    els.currentInfo.textContent = `${data.entries.length} mensagem(ns) • ID: ${data.conversationId.slice(0,8)}`;
    els.messageCount.textContent = `${data.entries.length} msgs`;

    renderEntries(data.entries);
    setButtonsDisabled(false);

    // Também salva no background
    chrome.runtime.sendMessage({
      type: 'CONVERSATION_UPDATE',
      payload: {
        conversationId: data.conversationId,
        conversationName: data.conversationName,
        entries: data.entries
      }
    });

  } catch (e) {
    console.error('[Krever Popup] Erro loadCurrentChat', e);
    els.currentName.textContent = 'Erro ao ler conversa';
    els.currentInfo.textContent = e.message + ' - Tente recarregar WhatsApp Web (F5)';
    els.currentEntries.innerHTML = `<p class="empty">Erro: ${e.message}<br><br>Abra o console do WhatsApp (F12) e veja se aparece [Krever] logs</p>`;
  }
}

function renderEntries(entries) {
  els.currentEntries.innerHTML = '';
  if (!entries.length) {
    els.currentEntries.innerHTML = '<p class="empty">Nenhuma mensagem</p>';
    return;
  }

  // Mostra últimas 120 para ter mais contexto
  const toShow = entries.slice(-120);
  toShow.forEach(entry => {
    const div = document.createElement('div');
    div.className = `message ${entry.fromMe ? 'own' : ''} ${entry.type}`;
    div.dataset.messageId = entry.sourceId;
    
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
    meta.textContent = `${entry.fromMe ? 'Você' : entry.sender} • ${time}`;
    
    div.appendChild(meta);

    if (entry.type === 'audio') {
      const label = document.createElement('div');
      const isDone = entry.audio?.transcriptionStatus === 'completed';
      label.className = `message-audio ${isDone ? 'completed' : 'pending'}`;
      label.textContent = isDone ? 'Áudio transcrito' : 'Áudio • clique em Transcrever';
      div.appendChild(label);

      const text = document.createElement('div');
      text.className = 'message-text';
      if (isDone && entry.text && entry.text.includes('[Áudio transcrito]')) {
        text.textContent = entry.text;
      } else {
        text.style.fontStyle = 'italic';
        text.style.opacity = '0.8';
        text.textContent = entry.audio?.seconds ? `🎧 Áudio de ${entry.audio.seconds}s - pendente` : '🎧 Áudio pendente de transcrição';
      }
      div.appendChild(text);

      // Botão manual por áudio
      if (!isDone) {
        const btn = document.createElement('button');
        btn.className = 'audio-action';
        btn.textContent = '▶️ Transcrever este áudio';
        btn.style.marginTop = '6px';
        btn.onclick = () => transcribeSingle(entry.sourceId, btn);
        div.appendChild(btn);
      }

    } else if (entry.type === 'image') {
      const label = document.createElement('div');
      const isDone = entry.image?.analysisStatus === 'completed';
      label.className = `message-image ${isDone ? 'completed' : 'pending'}`;
      label.textContent = isDone ? 'Imagem analisada' : 'Imagem • será analisada no resumo';
      div.appendChild(label);
      
      const text = document.createElement('div');
      text.className = 'message-text';
      text.textContent = entry.text || '[Imagem]';
      div.appendChild(text);

      if (!isDone) {
        const btn = document.createElement('button');
        btn.className = 'audio-action';
        btn.style.background = '#c4a8ff';
        btn.textContent = '🔍 Analisar esta imagem';
        btn.style.marginTop = '6px';
        btn.onclick = () => analyzeSingle(entry.sourceId, btn);
        div.appendChild(btn);
      }
    } else {
      const text = document.createElement('div');
      text.className = 'message-text';
      text.textContent = entry.text;
      div.appendChild(text);
    }

    els.currentEntries.appendChild(div);
  });
  els.currentEntries.scrollTop = els.currentEntries.scrollHeight;

  // Atualiza info com contagem de áudios/imagens
  const audioCount = entries.filter(e => e.type === 'audio').length;
  const imageCount = entries.filter(e => e.type === 'image').length;
  const textCount = entries.filter(e => e.type === 'text').length;
  if (els.currentInfo) {
    if (audioCount > 0 || imageCount > 0) {
      els.currentInfo.textContent = `${entries.length} msgs: ${textCount} texto, ${audioCount} áudio, ${imageCount} imagem • ${currentConversationName}`;
    }
  }
}

async function transcribeSingle(messageId, btn) {
  if (!messageId) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Buscando blob...';

  try {
    const tab = await checkWhatsAppTab();
    if (!tab) throw new Error('WhatsApp Web não encontrado');

    console.log(`[Krever Popup] Transcrição individual: ${messageId}`);
    const blobRes = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AUDIO_BLOB', messageId });
    if (!blobRes?.success) throw new Error(blobRes?.error || 'Blob não encontrado. Dê PLAY no áudio no WhatsApp (deixe tocar 1s) e tente novamente.');

    btn.textContent = '⏳ Transcrevendo...';
    const res = await chrome.runtime.sendMessage({
      type: 'TRANSCRIBE_AUDIO',
      blobData: blobRes.data,
      mimeType: blobRes.mimeType || 'audio/ogg',
      fileName: `audio_${messageId}.ogg`,
      conversationId: currentConversationId,
      messageId
    });

    if (res.success) {
      btn.textContent = '✅ Transcrito!';
      btn.style.background = '#4ade80';
      // Atualiza entry local
      const entry = currentEntries.find(e => e.sourceId === messageId);
      if (entry) {
        entry.audio.transcriptionStatus = 'completed';
        entry.text = res.result.text;
      }
      // Atualiza UI da mensagem específica
      const msgDiv = els.currentEntries.querySelector(`.message[data-message-id="${CSS.escape(messageId)}"] .message-text`);
      if (msgDiv) msgDiv.textContent = res.result.text;
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
        renderEntries(currentEntries);
      }, 1500);
    } else {
      throw new Error(res.error);
    }
  } catch (e) {
    console.error('Erro transcrição individual', e);
    btn.textContent = '❌ Erro';
    alert(`Erro: ${e.message}\n\nDica: No WhatsApp Web, dê PLAY no áudio, deixe tocar 1 segundo, pause e clique novamente em transcrever.`);
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
  }
}

async function analyzeSingle(messageId, btn) {
  if (!messageId) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Analisando...';
  try {
    const tab = await checkWhatsAppTab();
    const entry = currentEntries.find(e => e.sourceId === messageId);
    const blobRes = await chrome.tabs.sendMessage(tab.id, { type: 'GET_IMAGE_BLOB', messageId, src: entry?.image?.src });
    if (!blobRes?.success) throw new Error(blobRes?.error);

    const res = await chrome.runtime.sendMessage({
      type: 'ANALYZE_IMAGE',
      base64: blobRes.base64,
      mimeType: blobRes.mimeType,
      conversationId: currentConversationId,
      messageId
    });

    if (res.success) {
      btn.textContent = '✅ Analisada!';
      btn.style.background = '#4ade80';
      const entryLocal = currentEntries.find(e => e.sourceId === messageId);
      if (entryLocal) {
        entryLocal.image.analysisStatus = 'completed';
        entryLocal.text = `[Imagem analisada] ${res.analysis}`;
      }
      renderEntries(currentEntries);
    } else throw new Error(res.error);
  } catch (e) {
    btn.textContent = '❌ Erro';
    alert(`Erro: ${e.message}`);
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
    return;
  }
  btn.disabled = false;
}

function setButtonsDisabled(disabled) {
  [els.btnTranscribeAll, els.btnAnalyzeAll, els.btnToken, els.btnExport, els.btnGemini, els.btnSummarize].forEach(btn => {
    if (btn) btn.disabled = disabled;
  });
}

async function scrollForHistory() {
  const tab = await checkWhatsAppTab();
  if (!tab) return alert('Abra o WhatsApp Web primeiro');

  els.btnScroll.disabled = true;
  els.btnScroll.textContent = '⏳ Buscando...';
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'SCROLL_FOR_HISTORY', count: 50 });
    els.currentInfo.textContent = `Histórico: +${result.added} msgs (total ${result.finalCount})`;
    setTimeout(loadCurrentChat, 1000);
  } catch (e) {
    alert('Erro ao buscar histórico: ' + e.message);
  } finally {
    els.btnScroll.disabled = false;
    els.btnScroll.textContent = '⬆️ Buscar 50 anteriores';
  }
}

async function transcribeAll() {
  if (!currentEntries.length) return;
  // Considera pendentes e também os que ainda estão com status pending (mesmo que não completed)
  const audios = currentEntries.filter(e => e.type === 'audio');
  const pending = audios.filter(e => e.audio?.transcriptionStatus !== 'completed');
  
  console.log('[Krever Popup] Total entries:', currentEntries.length, 'audios:', audios.length, 'pending:', pending.length);
  
  if (!audios.length) {
    return alert(`Nenhum áudio detectado nesta conversa!\n\nTotal de mensagens: ${currentEntries.length}\nTipos: ${[...new Set(currentEntries.map(e=>e.type))].join(', ')}\n\nDica: Recarregue o WhatsApp Web (F5) e tente novamente. Se o bug persistir, abra o console (F12) e veja logs [Krever].`);
  }
  if (!pending.length) {
    return alert(`Todos os ${audios.length} áudio(s) já foram transcritos!`);
  }

  if (!confirm(`Transcrever ${pending.length} áudio(s) pendente(s) de ${audios.length} total?\n\nIsso consome créditos da Groq.\n\nDICA: No WhatsApp Web, dê play em um áudio antes para garantir que o blob carregou.`)) return;

  els.btnTranscribeAll.disabled = true;
  els.btnTranscribeAll.textContent = `⏳ 0/${pending.length}`;

  const tab = await checkWhatsAppTab();
  if (!tab) {
    els.btnTranscribeAll.disabled = false;
    els.btnTranscribeAll.textContent = '🎙️ Transcrever áudios';
    return alert('WhatsApp Web não encontrado');
  }

  let success = 0, fail = 0;
  let failReasons = [];

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    els.btnTranscribeAll.textContent = `⏳ ${i+1}/${pending.length}`;
    try {
      console.log(`[Krever] Tentando pegar blob do áudio ${entry.sourceId}`);
      const blobRes = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AUDIO_BLOB', messageId: entry.sourceId });
      if (!blobRes?.success) throw new Error(blobRes?.error || 'Blob não encontrado');

      const res = await chrome.runtime.sendMessage({
        type: 'TRANSCRIBE_AUDIO',
        blobData: blobRes.data,
        mimeType: blobRes.mimeType || 'audio/ogg',
        fileName: `audio_${entry.sourceId}.ogg`,
        conversationId: currentConversationId,
        messageId: entry.sourceId
      });

      if (res.success) {
        success++;
        // Atualiza entry local
        entry.audio.transcriptionStatus = 'completed';
        entry.text = res.result.text;
      } else {
        fail++;
        failReasons.push(res.error);
      }

    } catch (e) {
      console.warn('Erro transcrição', e);
      fail++;
      failReasons.push(e.message);
    }
    await new Promise(r => setTimeout(r, 1300));
  }

  els.btnTranscribeAll.disabled = false;
  els.btnTranscribeAll.textContent = '🎙️ Transcrever áudios';
  
  let msg = `Transcrição: ${success} sucesso, ${fail} falha`;
  if (fail > 0) {
    msg += `\n\nFalhas: ${failReasons.slice(0,3).join('; ')}`;
    msg += `\n\nDica: No WhatsApp Web, clique no play de um áudio para carregar o blob, depois tente novamente.`;
  }
  alert(msg);
  await loadCurrentChat();
  renderEntries(currentEntries);
}

async function analyzeAll() {
  if (!currentEntries.length) return;
  const images = currentEntries.filter(e => e.type === 'image' && e.image?.analysisStatus !== 'completed');
  if (!images.length) return alert('Nenhuma imagem pendente');

  if (!confirm(`Analisar ${images.length} imagem(ns)? Consome créditos da Groq.`)) return;

  els.btnAnalyzeAll.disabled = true;
  els.btnAnalyzeAll.textContent = `⏳ 0/${images.length}`;

  const tab = await checkWhatsAppTab();
  let success = 0, fail = 0;

  for (let i = 0; i < images.length; i++) {
    const entry = images[i];
    els.btnAnalyzeAll.textContent = `⏳ ${i+1}/${images.length}`;
    try {
      const blobRes = await chrome.tabs.sendMessage(tab.id, { 
        type: 'GET_IMAGE_BLOB', 
        messageId: entry.sourceId, 
        src: entry.image?.src 
      });
      if (!blobRes?.success) throw new Error(blobRes?.error);

      const res = await chrome.runtime.sendMessage({
        type: 'ANALYZE_IMAGE',
        base64: blobRes.base64,
        mimeType: blobRes.mimeType,
        conversationId: currentConversationId,
        messageId: entry.sourceId
      });

      if (res.success) success++;
      else fail++;
    } catch (e) {
      console.warn('Erro análise', e);
      fail++;
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  els.btnAnalyzeAll.disabled = false;
  els.btnAnalyzeAll.textContent = '🖼️ Analisar imagens';
  alert(`Análise concluída: ${success} sucesso, ${fail} falha`);
  loadCurrentChat();
}

async function estimateTokens() {
  if (!currentConversationId) return;
  els.tokenEstimate.textContent = 'Calculando...';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'TOKEN_ESTIMATE',
      conversationId: currentConversationId,
      instructions: config?.instructions || DEFAULT_SUMMARY_INSTRUCTIONS,
      provider: els.aiProvider.value
    });
    if (res.estimatedInputTokens) {
      els.tokenEstimate.textContent = `≈ ${res.estimatedInputTokens.toLocaleString()} entrada + ${res.outputTokenBudget} saída = ${res.estimatedTotalTokens.toLocaleString()} tokens • ${res.originalCharacters} chars`;
    } else {
      els.tokenEstimate.textContent = 'Erro: ' + res.error;
    }
  } catch (e) {
    els.tokenEstimate.textContent = 'Erro: ' + e.message;
  }
}

async function exportTxt() {
  if (!currentConversationId) return;
  try {
    // Pega conteúdo via background ou local
    const entries = currentEntries;
    const content = KreverUtils.buildExportContent(currentConversationName, '', entries);
    const fileName = `${KleverSafeName(currentConversationName)}-${new Date().toISOString().slice(0,10)}.txt`;
    
    // Download via chrome.downloads
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    
    await chrome.downloads.download({
      url: url,
      filename: fileName,
      saveAs: true
    });
    
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    alert('Erro ao exportar: ' + e.message);
  }
}

function KleverSafeName(name) {
  try { return KreverUtils.safeExportFileName(name); } catch { return 'cliente'; }
}

async function prepareGemini() {
  if (!currentConversationId) return;
  try {
    const entries = currentEntries;
    const content = KreverUtils.buildExportContent(currentConversationName, '', entries);
    const fileName = `${KleverSafeName(currentConversationName)}-${new Date().toISOString().slice(0,10)}.txt`;
    const prompt = GEMINI_PROMPT_PREFIX + (config?.instructions || DEFAULT_SUMMARY_INSTRUCTIONS);

    // 1. Download TXT
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: fileName, saveAs: false });
    
    // 2. Copia prompt
    await navigator.clipboard.writeText(prompt);
    
    // 3. Abre Gemini
    const geminiUrl = config?.geminiChatUrl || 'https://gemini.google.com/app';
    chrome.tabs.create({ url: geminiUrl });

    alert(`TXT baixado (${fileName}) e prompt copiado!\n\nNo Gemini, anexe o TXT e cole o prompt (Ctrl+V).`);
    
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    alert('Erro Gemini: ' + e.message);
  }
}

async function summarize() {
  if (!currentConversationId) return;
  
  els.btnSummarize.disabled = true;
  els.btnSummarize.textContent = '⏳ Gerando...';
  els.summaryOutput.textContent = 'Enviando para IA...';

  try {
    // Verifica áudios pendentes
    const audiosPendentes = currentEntries.filter(e => e.type === 'audio' && e.audio?.transcriptionStatus !== 'completed').length;
    if (audiosPendentes > 0) {
      if (confirm(`${audiosPendentes} áudio(s) não transcrito(s). Transcrever antes?`)) {
        await transcribeAll();
        await loadCurrentChat();
      }
    }

    const imagesPendentes = currentEntries.filter(e => e.type === 'image' && e.image?.analysisStatus !== 'completed').length;
    if (imagesPendentes > 0) {
      if (confirm(`${imagesPendentes} imagem(ns) não analisada(s). Analisar antes?`)) {
        await analyzeAll();
        await loadCurrentChat();
      }
    }

    const res = await chrome.runtime.sendMessage({
      type: 'SUMMARIZE_CONVERSATION',
      conversationId: currentConversationId,
      instructions: config?.instructions || DEFAULT_SUMMARY_INSTRUCTIONS,
      provider: els.aiProvider.value
    });

    if (res.success) {
      els.summaryOutput.textContent = res.summary;
      els.btnCopy.disabled = false;
    } else {
      els.summaryOutput.textContent = 'Erro: ' + res.error;
    }
  } catch (e) {
    els.summaryOutput.textContent = 'Erro: ' + e.message;
  } finally {
    els.btnSummarize.disabled = false;
    els.btnSummarize.textContent = '✨ Gerar Resumo';
  }
}

async function summarizeManual() {
  const text = els.manualText.value.trim();
  if (!text) return alert('Cole uma conversa primeiro');

  els.btnManual.disabled = true;
  els.btnManual.textContent = '⏳ Gerando...';
  els.manualOutput.textContent = 'Enviando...';

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SUMMARIZE_TEXT',
      text,
      instructions: config?.instructions || DEFAULT_SUMMARY_INSTRUCTIONS,
      provider: els.aiProvider.value
    });
    els.manualOutput.textContent = res.success ? res.summary : 'Erro: ' + res.error;
  } catch (e) {
    els.manualOutput.textContent = 'Erro: ' + e.message;
  } finally {
    els.btnManual.disabled = false;
    els.btnManual.textContent = 'Gerar resumo manual';
  }
}

async function loadSavedConversations() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_CONVERSATIONS' });
    const convs = res.conversations || [];
    
    const query = (els.searchSaved.value || '').toLowerCase();
    const filtered = query ? convs.filter(c => 
      (c.name + ' ' + c.preview + ' ' + c.phone).toLowerCase().includes(query)
    ) : convs;

    if (!filtered.length) {
      els.savedList.innerHTML = '<p class="empty">Nenhuma conversa encontrada</p>';
      return;
    }

    els.savedList.innerHTML = '';
    filtered.forEach(conv => {
      const btn = document.createElement('button');
      btn.className = 'conversation-item';
      if (conv.id === currentConversationId) btn.classList.add('active');
      
      btn.innerHTML = `
        <span class="name">${conv.name}</span>
        <span class="preview">${conv.preview || 'Sem prévia'}</span>
        <span class="date">${conv.messageCount} msgs • ${new Date(conv.lastMessageAt).toLocaleDateString('pt-BR')}</span>
      `;
      
      btn.addEventListener('click', async () => {
        const data = await chrome.runtime.sendMessage({ type: 'GET_CONVERSATION', conversationId: conv.id });
        if (data.entries) {
          currentConversationId = conv.id;
          currentEntries = data.entries;
          currentConversationName = conv.name;
          // Troca para aba atual
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
          document.querySelector('[data-tab="current"]').classList.add('active');
          document.getElementById('tab-current').classList.add('active');
          
          els.currentName.textContent = conv.name;
          els.currentInfo.textContent = `${data.entries.length} msgs (salva)`;
          renderEntries(data.entries);
          setButtonsDisabled(false);
        }
      });
      
      els.savedList.appendChild(btn);
    });
  } catch (e) {
    els.savedList.innerHTML = `<p class="empty">Erro: ${e.message}</p>`;
  }
}

// Event listeners
els.btnScroll?.addEventListener('click', scrollForHistory);
els.btnRefreshCurrent?.addEventListener('click', loadCurrentChat);
els.refreshStatus?.addEventListener('click', () => { checkWhatsAppTab(); loadCurrentChat(); });
els.btnTranscribeAll?.addEventListener('click', transcribeAll);
els.btnAnalyzeAll?.addEventListener('click', analyzeAll);
els.btnToken?.addEventListener('click', estimateTokens);
els.btnExport?.addEventListener('click', exportTxt);
els.btnGemini?.addEventListener('click', prepareGemini);
els.btnSummarize?.addEventListener('click', summarize);
els.btnManual?.addEventListener('click', summarizeManual);
els.btnCopy?.addEventListener('click', async () => {
  const text = els.summaryOutput.textContent;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const orig = els.btnCopy.textContent;
  els.btnCopy.textContent = '✅ Copiado!';
  setTimeout(() => els.btnCopy.textContent = orig, 1500);
});
els.searchSaved?.addEventListener('input', loadSavedConversations);
els.btnClearAll?.addEventListener('click', async () => {
  if (!confirm('Apagar TODAS as conversas salvas?')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
  loadSavedConversations();
});
els.openOptions?.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.openWhatsapp?.addEventListener('click', () => chrome.tabs.create({ url: 'https://web.whatsapp.com' }));
els.aiProvider?.addEventListener('change', async () => {
  const cfg = await getConfig();
  cfg.summaryProvider = els.aiProvider.value;
  await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: { summaryProvider: els.aiProvider.value } });
});

// Init
(async () => {
  await getConfig();
  await checkWhatsAppTab();
  await loadCurrentChat();
})();
