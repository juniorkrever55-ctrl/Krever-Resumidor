// Options page logic

const els = {
  groqApiKey: document.getElementById('groqApiKey'),
  toggleKey: document.getElementById('toggleKey'),
  groqChatModel: document.getElementById('groqChatModel'),
  groqTranscriptionModel: document.getElementById('groqTranscriptionModel'),
  groqVisionModel: document.getElementById('groqVisionModel'),
  ollamaBaseUrl: document.getElementById('ollamaBaseUrl'),
  ollamaChatModel: document.getElementById('ollamaChatModel'),
  ollamaKeepAlive: document.getElementById('ollamaKeepAlive'),
  geminiChatUrl: document.getElementById('geminiChatUrl'),
  summaryProvider: document.getElementById('summaryProvider'),
  instructions: document.getElementById('instructions'),
  save: document.getElementById('save'),
  reset: document.getElementById('reset'),
  saveStatus: document.getElementById('saveStatus'),
  testGroq: document.getElementById('testGroq'),
  testOllama: document.getElementById('testOllama'),
  testResult: document.getElementById('testResult'),
  clearData: document.getElementById('clearData')
};

let isKeyVisible = false;

els.toggleKey.addEventListener('click', () => {
  isKeyVisible = !isKeyVisible;
  els.groqApiKey.type = isKeyVisible ? 'text' : 'password';
  els.toggleKey.textContent = isKeyVisible ? '🙈 Ocultar' : '👁️ Mostrar';
});

async function load() {
  const { config } = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  
  els.groqApiKey.value = config.groqApiKey || '';
  els.groqChatModel.value = config.groqChatModel || 'llama-3.1-8b-instant';
  els.groqTranscriptionModel.value = config.groqTranscriptionModel || 'whisper-large-v3-turbo';
  els.groqVisionModel.value = config.groqVisionModel || 'qwen/qwen3.6-27b';
  els.ollamaBaseUrl.value = config.ollamaBaseUrl || 'http://127.0.0.1:11434';
  els.ollamaChatModel.value = config.ollamaChatModel || 'llama3.2:3b';
  els.ollamaKeepAlive.value = config.ollamaKeepAlive || '0';
  els.geminiChatUrl.value = config.geminiChatUrl || 'https://gemini.google.com/app';
  els.summaryProvider.value = config.summaryProvider || 'groq';
  els.instructions.value = config.instructions || DEFAULT_SUMMARY_INSTRUCTIONS;
}

async function save() {
  const cfg = {
    groqApiKey: els.groqApiKey.value.trim(),
    groqChatModel: els.groqChatModel.value.trim() || 'llama-3.1-8b-instant',
    groqTranscriptionModel: els.groqTranscriptionModel.value.trim() || 'whisper-large-v3-turbo',
    groqVisionModel: els.groqVisionModel.value.trim() || 'qwen/qwen3.6-27b',
    ollamaBaseUrl: els.ollamaBaseUrl.value.trim() || 'http://127.0.0.1:11434',
    ollamaChatModel: els.ollamaChatModel.value.trim() || 'llama3.2:3b',
    ollamaKeepAlive: els.ollamaKeepAlive.value,
    geminiChatUrl: els.geminiChatUrl.value.trim() || 'https://gemini.google.com/app',
    summaryProvider: els.summaryProvider.value,
    instructions: els.instructions.value.trim() || DEFAULT_SUMMARY_INSTRUCTIONS
  };

  await chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: cfg });
  
  els.saveStatus.textContent = '✅ Salvo com sucesso!';
  setTimeout(() => els.saveStatus.textContent = '', 3000);
}

async function reset() {
  if (!confirm('Restaurar configurações padrão? Sua chave Groq será apagada.')) return;
  
  els.groqApiKey.value = '';
  els.groqChatModel.value = 'llama-3.1-8b-instant';
  els.groqTranscriptionModel.value = 'whisper-large-v3-turbo';
  els.groqVisionModel.value = 'qwen/qwen3.6-27b';
  els.ollamaBaseUrl.value = 'http://127.0.0.1:11434';
  els.ollamaChatModel.value = 'llama3.2:3b';
  els.ollamaKeepAlive.value = '0';
  els.geminiChatUrl.value = 'https://gemini.google.com/app';
  els.summaryProvider.value = 'groq';
  els.instructions.value = DEFAULT_SUMMARY_INSTRUCTIONS;
  
  await save();
}

async function testGroq() {
  const key = els.groqApiKey.value.trim();
  if (!key) return alert('Informe a chave Groq primeiro');

  els.testResult.textContent = 'Testando Groq...';
  els.testResult.className = 'test-result';

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (res.ok) {
      els.testResult.textContent = '✅ Groq OK - chave válida';
      els.testResult.className = 'test-result ok';
    } else {
      const txt = await res.text();
      els.testResult.textContent = `❌ Groq erro ${res.status}: ${txt.slice(0,100)}`;
      els.testResult.className = 'test-result error';
    }
  } catch (e) {
    els.testResult.textContent = '❌ Erro: ' + e.message;
    els.testResult.className = 'test-result error';
  }
}

async function testOllama() {
  const base = (els.ollamaBaseUrl.value.trim() || 'http://127.0.0.1:11434').replace(/\/$/, '');
  els.testResult.textContent = `Testando ${base}...`;
  
  try {
    const res = await fetch(`${base}/api/tags`);
    if (res.ok) {
      const data = await res.json();
      const models = data.models?.map(m => m.name).join(', ') || 'nenhum modelo';
      els.testResult.textContent = `✅ Ollama OK - modelos: ${models.slice(0,120)}`;
      els.testResult.className = 'test-result ok';
    } else {
      els.testResult.textContent = `❌ Ollama HTTP ${res.status}`;
      els.testResult.className = 'test-result error';
    }
  } catch (e) {
    els.testResult.textContent = `❌ Não conectou em ${base}. Rode: ollama serve`;
    els.testResult.className = 'test-result error';
  }
}

els.save.addEventListener('click', save);
els.reset.addEventListener('click', reset);
els.testGroq.addEventListener('click', testGroq);
els.testOllama.addEventListener('click', testOllama);
els.clearData.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!confirm('Apagar TODAS as conversas salvas na extensão?')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
  alert('Conversas apagadas');
});

load();
