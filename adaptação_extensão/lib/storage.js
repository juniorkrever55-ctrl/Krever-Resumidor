// Storage wrapper para extensão
// Usa chrome.storage.local para config e IndexedDB para conversas grandes

const Storage = {
  async getConfig() {
    const defaults = {
      groqApiKey: '',
      groqChatModel: 'llama-3.1-8b-instant',
      groqTranscriptionModel: 'whisper-large-v3-turbo',
      groqVisionModel: 'qwen/qwen3.6-27b',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaChatModel: 'llama3.2:3b',
      ollamaKeepAlive: '0',
      geminiChatUrl: 'https://gemini.google.com/app',
      summaryProvider: 'groq',
      instructions: (typeof DEFAULT_SUMMARY_INSTRUCTIONS !== 'undefined' ? DEFAULT_SUMMARY_INSTRUCTIONS : '')
    };
    const stored = await chrome.storage.local.get(Object.keys(defaults));
    return { ...defaults, ...stored };
  },

  async saveConfig(partial) {
    await chrome.storage.local.set(partial);
  },

  // Conversas: armazenadas em chrome.storage.local por simplicidade
  // Chave: conversations -> { id: { id, name, phone, jid, lastMessageAt, messageCount, preview } }
  async getConversationsIndex() {
    const { conversationsIndex } = await chrome.storage.local.get('conversationsIndex');
    return conversationsIndex || {};
  },

  async saveConversationMeta(meta) {
    const index = await this.getConversationsIndex();
    index[meta.id] = meta;
    await chrome.storage.local.set({ conversationsIndex: index });
  },

  async getConversationEntries(conversationId) {
    const key = `conv_${conversationId}`;
    const data = await chrome.storage.local.get(key);
    return data[key] || [];
  },

  async saveConversationEntries(conversationId, entries) {
    const key = `conv_${conversationId}`;
    // Limita a 1000 últimas para não estourar storage (10MB)
    const limited = entries.slice(-1000);
    await chrome.storage.local.set({ [key]: limited });
    
    // Atualiza meta
    if (limited.length) {
      const last = limited[limited.length - 1];
      const meta = {
        id: conversationId,
        name: last.conversationName || 'Cliente',
        phone: last.phone || '',
        jid: last.jid || '',
        lastMessageAt: last.timestamp,
        messageCount: limited.length,
        preview: String(last.text || '').replace(/\s+/g, ' ').slice(0, 140)
      };
      // tenta preservar nome existente
      const index = await this.getConversationsIndex();
      const existing = index[conversationId];
      if (existing && existing.name && existing.name !== 'Cliente') meta.name = existing.name;
      if (existing && existing.phone) meta.phone = existing.phone;
      await this.saveConversationMeta(meta);
    }
  },

  async appendConversationEntry(conversationId, entry) {
    const entries = await this.getConversationEntries(conversationId);
    // evita duplicado por sourceId
    if (entry.sourceId && entries.some(e => e.sourceId === entry.sourceId)) return;
    entries.push(entry);
    await this.saveConversationEntries(conversationId, entries);
  },

  async clearAllConversations() {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(all).filter(k => k.startsWith('conv_') || k === 'conversationsIndex');
    await chrome.storage.local.remove(keysToRemove);
  }
};

if (typeof window !== 'undefined') window.KreverStorage = Storage;
if (typeof self !== 'undefined') self.KreverStorage = Storage;
