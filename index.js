'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');

const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || path.join(ROOT_DIR, 'auth'));
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CONVERSATIONS_DIR = path.join(DATA_DIR, 'conversations');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const CONVERSATIONS_INDEX_FILE = path.join(DATA_DIR, 'conversations.json');
const PROCESSED_MESSAGE_IDS_FILE = path.join(DATA_DIR, 'processed-message-ids.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.1-8b-instant';
const GROQ_TRANSCRIPTION_MODEL = process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo';
// Para transcrever sob demanda, o áudio precisa ficar salvo somente neste computador.
const STORE_AUDIO_FOR_MANUAL_TRANSCRIPTION = process.env.STORE_AUDIO_FOR_MANUAL_TRANSCRIPTION !== 'false';
const WHATSAPP_LOG_LEVEL = process.env.DEBUG_WHATSAPP === 'true' ? 'info' : 'silent';
// O histórico é importado localmente; não chama IA.
const IMPORT_HISTORY = process.env.IMPORT_HISTORY !== 'false';
const MAX_TRACKED_MESSAGE_IDS = Number(process.env.MAX_TRACKED_MESSAGE_IDS || 100000);
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 24 * 1024 * 1024);
const MAX_SUMMARY_CHARS = Number(process.env.MAX_SUMMARY_CHARS || 50000);
const ON_DEMAND_HISTORY_PAGE_SIZE = 50;
const BULK_TRANSCRIPTION_DELAY_MS = 500;

const DEFAULT_SUMMARY_INSTRUCTIONS = `Você é um assistente de vendas de consórcio. Analise a conversa em português do Brasil e preencha o relatório abaixo. Extraia somente o que foi dito ou confirmado na conversa; nunca invente, estime ou complete dados. Quando uma informação não estiver na conversa, escreva exatamente: "Não informado". Preserve CPF e data de aniversário somente se tiverem sido informados explicitamente.

QUAL OBJETIVO: ...
QUANTO QUER / VALOR DESEJADO: ...
PAGA ALUGUEL: ...
HÁ QUANTO TEMPO PAGA ALUGUEL: ...
RENDA MENSAL: ...
PARCELA IDEAL: ...
ENTRADA/ADESÃO: ...
O QUE É A ENTRADA/ADESÃO: ...
QUANTO TEMPO LEVOU PARA JUNTAR: ...
PROFISSÃO: ...
CPF: ...
DATA DE ANIVERSÁRIO: ...
ESTADO CIVIL: ...
TOMA ESSA DECISÃO SOZINHO: ...
QUANDO PRETENDE INICIAR ESSE PROJETO: ...
O QUE APRESENTEI: ...
POR QUE NÃO FECHOU: ...
PRÓXIMO PASSO: ...`;

const connection = {
  status: 'starting',
  qrImage: null,
  qrUpdatedAt: null,
  connectedAt: null,
  error: null,
  reconnectAttempt: 0,
};

let activeSocket = null;
let connectionGeneration = 0;
let reconnectTimer = null;
let conversationIndexCache = null;
let conversationIndexWriteTimer = null;
let processedMessageIds = null;
let processedMessageIdsDirty = false;
let processedMessageIdsWriteTimer = null;
let contactsCache = null;
let contactsWriteTimer = null;
const pendingTranscriptions = new Map();
const onDemandHistoryRequestAt = new Map();
const bulkTranscriptionJobs = new Map();
const activeBulkJobByConversation = new Map();

ensureDirectories();

function ensureDirectories() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  if (STORE_AUDIO_FOR_MANUAL_TRANSCRIPTION) fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function clearLocalConversationHistory() {
  clearTimeout(conversationIndexWriteTimer);
  clearTimeout(processedMessageIdsWriteTimer);
  clearTimeout(contactsWriteTimer);
  conversationIndexWriteTimer = null;
  processedMessageIdsWriteTimer = null;
  contactsWriteTimer = null;
  conversationIndexCache = null;
  processedMessageIds = null;
  processedMessageIdsDirty = false;
  contactsCache = null;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  ensureDirectories();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Não foi possível ler ${path.basename(file)}: ${error.message}`);
    return fallback;
  }
}

function writeJson(file, value) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryFile, file);
}

function getConversationId(jid) {
  return crypto.createHash('sha256').update(jid).digest('hex').slice(0, 24);
}

function getConversationFile(id) {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  return path.join(CONVERSATIONS_DIR, `${id}.jsonl`);
}

function phoneFromJid(jid) {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function loadContacts() {
  if (contactsCache) return contactsCache;
  const saved = readJson(CONTACTS_FILE, { contacts: {} });
  contactsCache = (!saved || typeof saved !== 'object' || !saved.contacts || typeof saved.contacts !== 'object')
    ? { contacts: {} }
    : saved;
  return contactsCache;
}

function flushContacts() {
  if (!contactsCache) return;
  clearTimeout(contactsWriteTimer);
  contactsWriteTimer = null;
  writeJson(CONTACTS_FILE, contactsCache);
}

function queueContactsWrite() {
  if (contactsWriteTimer) return;
  contactsWriteTimer = setTimeout(flushContacts, 350);
  contactsWriteTimer.unref?.();
}

function knownContactFor(jid) {
  if (!jid) return null;
  return loadContacts().contacts[jid] || null;
}

function knownNameFor(jid, pushName) {
  const savedName = knownContactFor(jid)?.name;
  if (savedName) return savedName;
  if (pushName && String(pushName).trim()) return String(pushName).trim().slice(0, 100);
  return '';
}

function getDisplayName(jid, pushName) {
  const knownName = knownNameFor(jid, pushName);
  if (knownName) return knownName;
  const localPart = jid.split('@')[0] || 'Conversa';
  return jid.endsWith('@g.us') ? `Grupo ${localPart}` : localPart;
}

function updateConversationContactMetadata(jid) {
  const contact = knownContactFor(jid);
  if (!contact) return;
  const index = loadConversationIndex();
  let changed = false;
  for (const conversation of Object.values(index.conversations)) {
    if (conversation.jid !== jid) continue;
    if (contact.name && conversation.name !== contact.name) {
      conversation.name = contact.name;
      changed = true;
    }
    if (contact.phone && conversation.phone !== contact.phone) {
      conversation.phone = contact.phone;
      changed = true;
    }
  }
  if (changed) queueConversationIndexWrite();
}

function rememberContacts(records) {
  if (!Array.isArray(records)) return;
  const directory = loadContacts();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const ids = [record.id, record.lid, record.phoneNumber].filter((id) => typeof id === 'string' && id);
    if (!ids.length) continue;
    const name = [record.name, record.verifiedName, record.notify, record.subject]
      .find((value) => typeof value === 'string' && value.trim());
    const phone = phoneFromJid(record.phoneNumber) || phoneFromJid(record.id) || phoneFromJid(record.lid);
    for (const id of ids) {
      const previous = directory.contacts[id] || {};
      directory.contacts[id] = {
        name: name ? name.trim().slice(0, 100) : previous.name || '',
        phone: phone || previous.phone || '',
      };
      updateConversationContactMetadata(id);
    }
  }
  queueContactsWrite();
}

function loadConversationIndex() {
  if (conversationIndexCache) return conversationIndexCache;

  const index = readJson(CONVERSATIONS_INDEX_FILE, { conversations: {} });
  conversationIndexCache = (!index || typeof index !== 'object' || !index.conversations || typeof index.conversations !== 'object')
    ? { conversations: {} }
    : index;
  return conversationIndexCache;
}

function flushConversationIndex() {
  if (!conversationIndexCache) return;
  clearTimeout(conversationIndexWriteTimer);
  conversationIndexWriteTimer = null;
  writeJson(CONVERSATIONS_INDEX_FILE, conversationIndexCache);
}

function queueConversationIndexWrite() {
  if (conversationIndexWriteTimer) return;
  conversationIndexWriteTimer = setTimeout(flushConversationIndex, 350);
  conversationIndexWriteTimer.unref?.();
}

function loadProcessedMessageIds() {
  if (processedMessageIds) return processedMessageIds;
  const saved = readJson(PROCESSED_MESSAGE_IDS_FILE, { ids: [] });
  const ids = Array.isArray(saved?.ids) ? saved.ids.filter((id) => typeof id === 'string') : [];
  processedMessageIds = new Set(ids.slice(-MAX_TRACKED_MESSAGE_IDS));
  return processedMessageIds;
}

function flushProcessedMessageIds() {
  if (!processedMessageIdsDirty || !processedMessageIds) return;
  clearTimeout(processedMessageIdsWriteTimer);
  processedMessageIdsWriteTimer = null;
  const ids = Array.from(processedMessageIds).slice(-MAX_TRACKED_MESSAGE_IDS);
  processedMessageIds = new Set(ids);
  writeJson(PROCESSED_MESSAGE_IDS_FILE, { ids });
  processedMessageIdsDirty = false;
}

function queueProcessedMessageIdsWrite() {
  if (processedMessageIdsWriteTimer) return;
  processedMessageIdsWriteTimer = setTimeout(flushProcessedMessageIds, 500);
  processedMessageIdsWriteTimer.unref?.();
}

function hasProcessedMessage(messageId) {
  return Boolean(messageId && loadProcessedMessageIds().has(messageId));
}

function markMessageAsProcessed(messageId) {
  if (!messageId) return;
  const ids = loadProcessedMessageIds();
  ids.add(messageId);
  if (ids.size > MAX_TRACKED_MESSAGE_IDS) {
    processedMessageIds = new Set(Array.from(ids).slice(-MAX_TRACKED_MESSAGE_IDS));
  }
  processedMessageIdsDirty = true;
  queueProcessedMessageIdsWrite();
}

function toPublicConversation(conversation) {
  return {
    id: conversation.id,
    name: conversation.name,
    phone: conversation.phone || '',
    isGroup: Boolean(conversation.isGroup),
    messageCount: conversation.messageCount || 0,
    lastMessageAt: conversation.lastMessageAt || null,
    preview: conversation.preview || '',
  };
}

function appendConversationEntry({ jid, pushName, fromMe, sender, type, text, timestamp, audio, sourceMessageId }) {
  const id = getConversationId(jid);
  const index = loadConversationIndex();
  const existing = index.conversations[id];
  const entry = {
    id: sourceMessageId || crypto.randomUUID(),
    sourceMessageId: sourceMessageId || null,
    timestamp: timestamp || new Date().toISOString(),
    fromMe: Boolean(fromMe),
    sender: sender || (fromMe ? 'Você' : getDisplayName(jid, pushName)),
    type: type || 'text',
    text: String(text || '').slice(0, 30000),
  };

  if (audio) entry.audio = audio;

  const preview = entry.text.replace(/\s+/g, ' ').trim().slice(0, 140);
  const knownName = knownNameFor(jid, jid.endsWith('@g.us') ? undefined : pushName);
  const phone = knownContactFor(jid)?.phone || phoneFromJid(jid) || existing?.phone || '';
  const existingTimestamp = Date.parse(existing?.lastMessageAt || '');
  const entryTimestamp = Date.parse(entry.timestamp);
  const isNewest = !existing || !Number.isFinite(existingTimestamp) || (Number.isFinite(entryTimestamp) && entryTimestamp >= existingTimestamp);
  index.conversations[id] = {
    id,
    jid,
    name: knownName || existing?.name || getDisplayName(jid, pushName),
    phone,
    isGroup: jid.endsWith('@g.us'),
    messageCount: (existing?.messageCount || 0) + 1,
    lastMessageAt: isNewest ? entry.timestamp : existing.lastMessageAt,
    preview: isNewest ? preview : existing.preview,
  };

  queueConversationIndexWrite();
  fs.appendFileSync(getConversationFile(id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

function readAllConversationEntries(id) {
  const file = getConversationFile(id);
  if (!file || !fs.existsSync(file)) return [];

  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const timestampA = Date.parse(a.timestamp || '') || 0;
      const timestampB = Date.parse(b.timestamp || '') || 0;
      return timestampA - timestampB || String(a.id || '').localeCompare(String(b.id || ''));
    });
}

function loadConversationEntries(id, limit = 250) {
  const entries = readAllConversationEntries(id);
  return entries.slice(-Math.max(1, Math.min(Number(limit) || 250, 1000)));
}

function writeConversationEntries(id, entries) {
  const file = getConversationFile(id);
  if (!file) {
    const error = new Error('Identificador de conversa inválido.');
    error.statusCode = 400;
    throw error;
  }
  const temporaryFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(temporaryFile, file);
}

function getAudioEntry(id, messageId) {
  const entry = readAllConversationEntries(id)
    .find((item) => item.type === 'audio' && item.sourceMessageId === messageId);
  if (!entry) {
    const error = new Error('Áudio não encontrado nesta conversa.');
    error.statusCode = 404;
    throw error;
  }
  return entry;
}

function updateConversationEntry(id, messageId, update) {
  const entries = readAllConversationEntries(id);
  const position = entries.findIndex((item) => item.type === 'audio' && item.sourceMessageId === messageId);
  if (position === -1) {
    const error = new Error('Áudio não encontrado nesta conversa.');
    error.statusCode = 404;
    throw error;
  }

  const before = entries[position];
  const after = update({ ...before, audio: { ...(before.audio || {}) } });
  entries[position] = after;
  writeConversationEntries(id, entries);

  const index = loadConversationIndex();
  const conversation = index.conversations[id];
  if (conversation && conversation.lastMessageAt === before.timestamp) {
    conversation.preview = String(after.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    queueConversationIndexWrite();
  }
  return after;
}

function deleteStoredAudio(entry) {
  const filePath = getAudioFilePath(entry.audio?.fileName);
  if (filePath) fs.rmSync(filePath, { force: true });
}

function removeConversationEntries(conversationId, messageIds) {
  const ids = new Set(messageIds.filter(Boolean));
  if (!ids.size) return 0;

  const entries = readAllConversationEntries(conversationId);
  const removed = entries.filter((entry) => ids.has(entry.sourceMessageId));
  if (!removed.length) return 0;

  removed.forEach(deleteStoredAudio);
  const remaining = entries.filter((entry) => !ids.has(entry.sourceMessageId));
  const index = loadConversationIndex();

  if (!remaining.length) {
    const file = getConversationFile(conversationId);
    if (file) fs.rmSync(file, { force: true });
    delete index.conversations[conversationId];
  } else {
    writeConversationEntries(conversationId, remaining);
    const conversation = index.conversations[conversationId];
    const last = remaining[remaining.length - 1];
    if (conversation) {
      conversation.messageCount = remaining.length;
      conversation.lastMessageAt = last.timestamp;
      conversation.preview = String(last.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    }
  }
  queueConversationIndexWrite();
  return removed.length;
}

function removeEntireConversation(jid) {
  if (!jid) return 0;
  const conversationId = getConversationId(jid);
  const entries = readAllConversationEntries(conversationId);
  if (!entries.length) return 0;
  entries.forEach(deleteStoredAudio);
  const file = getConversationFile(conversationId);
  if (file) fs.rmSync(file, { force: true });
  const index = loadConversationIndex();
  delete index.conversations[conversationId];
  queueConversationIndexWrite();
  return entries.length;
}

function removeMessagesFromWhatsAppEvent(keys) {
  let removed = 0;
  const byJid = new Map();
  for (const key of keys || []) {
    const jid = key?.remoteJid || key?.remoteJidAlt;
    if (!jid || !key?.id) continue;
    if (!byJid.has(jid)) byJid.set(jid, []);
    byJid.get(jid).push(key.id);
  }
  for (const [jid, messageIds] of byJid) {
    removed += removeConversationEntries(getConversationId(jid), messageIds);
  }
  if (removed) console.log(`Sincronização: ${removed} mensagem(ns) apagada(s) também foram removidas do histórico local.`);
}

async function requestOlderConversationHistory(conversationId) {
  const index = loadConversationIndex();
  const conversation = index.conversations[conversationId];
  if (!conversation) {
    const error = new Error('Conversa não encontrada.');
    error.statusCode = 404;
    throw error;
  }
  if (!activeSocket || connection.status !== 'connected') {
    const error = new Error('Conecte o WhatsApp antes de buscar mensagens antigas.');
    error.statusCode = 409;
    throw error;
  }

  const lastRequestAt = onDemandHistoryRequestAt.get(conversationId) || 0;
  if (Date.now() - lastRequestAt < 4000) {
    const error = new Error('Aguarde alguns segundos antes de pedir outra página de histórico.');
    error.statusCode = 429;
    throw error;
  }

  const oldest = readAllConversationEntries(conversationId)
    .filter((entry) => entry.sourceMessageId && entry.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))[0];
  if (!oldest) {
    const error = new Error('Não há uma mensagem-base nesta conversa para buscar um histórico anterior.');
    error.statusCode = 400;
    throw error;
  }

  const oldestTimestamp = Math.floor(new Date(oldest.timestamp).getTime() / 1000);
  if (!Number.isFinite(oldestTimestamp)) {
    const error = new Error('A mensagem-base desta conversa não possui uma data válida.');
    error.statusCode = 400;
    throw error;
  }

  onDemandHistoryRequestAt.set(conversationId, Date.now());
  await activeSocket.fetchMessageHistory(ON_DEMAND_HISTORY_PAGE_SIZE, {
    remoteJid: conversation.jid,
    id: oldest.sourceMessageId,
    fromMe: Boolean(oldest.fromMe),
  }, oldestTimestamp);

  return { requested: ON_DEMAND_HISTORY_PAGE_SIZE, oldestTimestamp: oldest.timestamp };
}

function safeAudioFileName(conversationId, messageId, mimeType) {
  const safeMessageId = String(messageId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160);
  return `${conversationId}-${safeMessageId}.${extensionForMimeType(mimeType)}`;
}

function getAudioFilePath(fileName) {
  if (typeof fileName !== 'string' || !/^[a-f0-9]{24}-[a-zA-Z0-9_-]+\.[a-z0-9]+$/i.test(fileName)) return null;
  return path.join(AUDIO_DIR, fileName);
}

function getMessageTimestamp(message) {
  const value = message.messageTimestamp;
  const seconds = typeof value === 'object' && value?.toNumber ? value.toNumber() : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

function getMessageText(content) {
  return [
    content?.conversation,
    content?.extendedTextMessage?.text,
    content?.imageMessage?.caption,
    content?.videoMessage?.caption,
    content?.documentMessage?.caption,
  ].find((value) => typeof value === 'string' && value.trim()) || '';
}

function getAudioContent(content) {
  if (content?.audioMessage) return content.audioMessage;
  const document = content?.documentMessage;
  if (document && /^audio\//i.test(document.mimetype || '')) return document;
  return null;
}

function extensionForMimeType(mimeType) {
  const type = (mimeType || '').toLowerCase();
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('webm')) return 'webm';
  return 'bin';
}

async function callGroq(url, options) {
  if (!GROQ_API_KEY) {
    const error = new Error('GROQ_API_KEY não configurada. Crie o arquivo .env a partir de .env.example e informe a sua chave.');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      ...(options.headers || {}),
    },
  });

  const rawBody = await response.text();
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = { message: rawBody };
  }

  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `Groq respondeu com HTTP ${response.status}.`);
    error.statusCode = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  return body;
}

async function transcribeAudioBuffer(buffer, mimeType, fileName) {
  if (!GROQ_API_KEY) {
    const error = new Error('GROQ_API_KEY não configurada. Configure a chave antes de transcrever.');
    error.statusCode = 503;
    throw error;
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    const error = new Error(`O áudio excede o limite configurado de ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)} MB para transcrição.`);
    error.statusCode = 413;
    throw error;
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), fileName);
  form.append('model', GROQ_TRANSCRIPTION_MODEL);
  form.append('language', 'pt');
  form.append('response_format', 'json');

  const data = await callGroq('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    body: form,
  });

  const transcription = typeof data.text === 'string' ? data.text.trim() : '';
  return {
    text: transcription ? `[Áudio transcrito] ${transcription}` : '[Áudio recebido — a transcrição retornou vazia.]',
    transcriptionStatus: transcription ? 'completed' : 'empty',
  };
}

async function storeAudioForManualTranscription(message, audioContent, conversationId) {
  const mimeType = audioContent.mimetype || 'audio/ogg';
  if (!STORE_AUDIO_FOR_MANUAL_TRANSCRIPTION) {
    return { mimeType, transcriptionStatus: 'not_stored' };
  }

  const fileName = safeAudioFileName(conversationId, message.key?.id, mimeType);
  const filePath = getAudioFilePath(fileName);
  if (!filePath) throw new Error('Não foi possível preparar o arquivo de áudio.');

  if (fs.existsSync(filePath)) {
    return { mimeType, fileName, bytes: fs.statSync(filePath).size, transcriptionStatus: 'pending' };
  }

  const buffer = await downloadMediaMessage(message, 'buffer', {});
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });
  return { mimeType, fileName, bytes: buffer.length, transcriptionStatus: 'pending' };
}

async function hydrateStoredAudioIfNeeded(message, content, jid, sourceMessageId) {
  const audioContent = getAudioContent(content);
  if (!audioContent || !sourceMessageId) return;

  const conversationId = getConversationId(jid);
  let existing;
  try {
    existing = getAudioEntry(conversationId, sourceMessageId);
  } catch {
    return;
  }
  if (existing.audio?.fileName) return;

  try {
    const storedAudio = await storeAudioForManualTranscription(message, audioContent, conversationId);
    const wasTranscribed = existing.audio?.transcriptionStatus === 'completed';
    const pendingText = storedAudio.transcriptionStatus === 'pending'
      ? '[Áudio recebido — escolha “Transcrever este áudio” se quiser enviar para a IA.]'
      : '[Áudio recebido — o arquivo não está disponível para transcrição manual.]';
    updateConversationEntry(conversationId, sourceMessageId, (current) => ({
      ...current,
      text: wasTranscribed ? current.text : pendingText,
      audio: {
        ...current.audio,
        ...storedAudio,
        seconds: current.audio?.seconds || Number(audioContent.seconds) || null,
        transcriptionStatus: wasTranscribed ? 'completed' : storedAudio.transcriptionStatus,
      },
    }));
  } catch (error) {
    console.error(`Não foi possível recuperar um áudio histórico: ${error.message}`);
  }
}

async function processWhatsAppMessage(message) {
  const jid = message.key?.remoteJid;
  const sourceMessageId = message.key?.id;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;

  const content = extractMessageContent(message.message);
  if (!content) return;
  if (hasProcessedMessage(sourceMessageId)) {
    // Caso o histórico seja sincronizado novamente, completa áudios antigos que foram
    // registrados antes de existir o modo manual, sem duplicar os textos.
    await hydrateStoredAudioIfNeeded(message, content, jid, sourceMessageId);
    return;
  }

  // Eventos de histórico podem chegar em mais de um lote. Marca antes de processar
  // para que o mesmo áudio/texto não seja salvo mais de uma vez.
  markMessageAsProcessed(sourceMessageId);

  const fromMe = Boolean(message.key?.fromMe);
  const pushName = message.pushName;
  const senderJid = message.key?.participant || jid;
  const sender = fromMe ? 'Você' : getDisplayName(senderJid, pushName);
  const timestamp = getMessageTimestamp(message);
  const text = getMessageText(content);

  if (text) {
    appendConversationEntry({ jid, pushName, fromMe, sender, type: 'text', text, timestamp, sourceMessageId });
  }

  const audioContent = getAudioContent(content);
  if (!audioContent) return;

  const conversationId = getConversationId(jid);
  let audio;
  try {
    // Guardar o arquivo é local e não chama a Groq. A transcrição só ocorre no botão do painel.
    audio = await storeAudioForManualTranscription(message, audioContent, conversationId);
  } catch (error) {
    console.error(`Não foi possível salvar um áudio de ${getDisplayName(jid, pushName)}: ${error.message}`);
    audio = { mimeType: audioContent.mimetype || 'audio/ogg', transcriptionStatus: 'download_failed' };
  }

  const pendingCopy = audio.transcriptionStatus === 'pending'
    ? '[Áudio recebido — escolha “Transcrever este áudio” se quiser enviar para a IA.]'
    : '[Áudio recebido — o arquivo não está disponível para transcrição manual.]';
  appendConversationEntry({
    jid,
    pushName,
    fromMe,
    sender,
    type: 'audio',
    text: pendingCopy,
    timestamp,
    sourceMessageId,
    audio: {
      ...audio,
      seconds: Number(audioContent.seconds) || null,
    },
  });
}

async function transcribeStoredConversationAudio(conversationId, messageId) {
  const jobKey = `${conversationId}:${messageId}`;
  if (pendingTranscriptions.has(jobKey)) return pendingTranscriptions.get(jobKey);

  const job = (async () => {
    const entry = getAudioEntry(conversationId, messageId);
    if (entry.audio?.transcriptionStatus === 'completed') return entry;

    const filePath = getAudioFilePath(entry.audio?.fileName);
    if (!filePath || !fs.existsSync(filePath)) {
      const error = new Error('O arquivo local deste áudio não está disponível. Apenas áudios recebidos depois de ativar a transcrição manual podem ser transcritos.');
      error.statusCode = 409;
      throw error;
    }

    const buffer = fs.readFileSync(filePath);
    const transcription = await transcribeAudioBuffer(buffer, entry.audio?.mimeType || 'audio/ogg', entry.audio.fileName);
    return updateConversationEntry(conversationId, messageId, (current) => ({
      ...current,
      text: transcription.text,
      audio: {
        ...current.audio,
        transcriptionStatus: transcription.transcriptionStatus,
        transcribedAt: new Date().toISOString(),
      },
    }));
  })();

  pendingTranscriptions.set(jobKey, job);
  try {
    return await job;
  } finally {
    pendingTranscriptions.delete(jobKey);
  }
}

function getPendingAudioStats(conversationId) {
  const entries = readAllConversationEntries(conversationId)
    .filter((entry) => entry.type === 'audio' && entry.audio?.transcriptionStatus !== 'completed');
  const available = entries.filter((entry) => {
    const filePath = getAudioFilePath(entry.audio?.fileName);
    return Boolean(filePath && fs.existsSync(filePath) && entry.sourceMessageId);
  });
  return {
    totalPending: entries.length,
    available: available.length,
    unavailable: entries.length - available.length,
    entries: available,
  };
}

function publicBulkJob(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    succeeded: job.succeeded,
    failed: job.failed,
    current: job.current,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
  };
}

function retainBulkJobForInspection(job) {
  const timer = setTimeout(() => bulkTranscriptionJobs.delete(job.id), 10 * 60 * 1000);
  timer.unref?.();
}

function startBulkTranscription(conversationId) {
  const activeJobId = activeBulkJobByConversation.get(conversationId);
  const activeJob = activeJobId && bulkTranscriptionJobs.get(activeJobId);
  if (activeJob?.status === 'running') return activeJob;

  const stats = getPendingAudioStats(conversationId);
  const job = {
    id: crypto.randomUUID(),
    conversationId,
    status: 'running',
    total: stats.available,
    processed: 0,
    succeeded: 0,
    failed: 0,
    current: null,
    startedAt: new Date().toISOString(),
  };
  bulkTranscriptionJobs.set(job.id, job);
  activeBulkJobByConversation.set(conversationId, job.id);

  void (async () => {
    for (const entry of stats.entries) {
      job.current = entry.sourceMessageId;
      try {
        await transcribeStoredConversationAudio(conversationId, entry.sourceMessageId);
        job.succeeded += 1;
      } catch (error) {
        job.failed += 1;
        console.warn(`Não foi possível transcrever um áudio em lote: ${error.message}`);
      }
      job.processed += 1;
      if (job.processed < job.total) {
        await new Promise((resolve) => setTimeout(resolve, BULK_TRANSCRIPTION_DELAY_MS));
      }
    }
    job.status = job.failed ? 'completed_with_errors' : 'completed';
    job.current = null;
    job.finishedAt = new Date().toISOString();
    activeBulkJobByConversation.delete(conversationId);
    retainBulkJobForInspection(job);
  })().catch((error) => {
    job.status = 'failed';
    job.current = null;
    job.finishedAt = new Date().toISOString();
    job.failed = Math.max(1, job.failed);
    activeBulkJobByConversation.delete(conversationId);
    console.error(`Falha no lote de transcrição: ${error.message}`);
    retainBulkJobForInspection(job);
  });

  return job;
}

function setConnectionStatus(status, changes = {}) {
  Object.assign(connection, { status, ...changes });
}

function getDisconnectCode(lastDisconnect) {
  const error = lastDisconnect?.error;
  return error?.output?.statusCode || error?.data?.statusCode || error?.statusCode;
}

function getDisconnectDetail(lastDisconnect) {
  const error = lastDisconnect?.error;
  const detail = error?.output?.payload?.message || error?.message;
  return typeof detail === 'string' ? detail.replace(/\s+/g, ' ').slice(0, 180) : '';
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(30000, 2000 * Math.max(1, connection.reconnectAttempt));
  reconnectTimer = setTimeout(() => connectWhatsApp().catch((error) => {
    console.error(`Falha ao reconectar ao WhatsApp: ${error.message}`);
  }), delay);
}

async function connectWhatsApp() {
  clearTimeout(reconnectTimer);
  const generation = ++connectionGeneration;
  setConnectionStatus('connecting', { qrImage: null, qrUpdatedAt: null, error: null });

  try {
    ensureDirectories();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (error) {
      console.warn(`Não foi possível consultar a versão mais recente do WhatsApp Web; usando a versão padrão do Baileys. (${error.message})`);
    }

    if (generation !== connectionGeneration) return;

    const socket = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      // Perfil Chrome/Windows é o mais compatível para iniciar um pareamento novo por QR.
      // A solicitação de histórico continua definida pelas opções seguintes.
      browser: Browsers.windows('Chrome'),
      // Use DEBUG_WHATSAPP=true no .env apenas para diagnosticar uma falha de conexão.
      logger: pino({ level: WHATSAPP_LOG_LEVEL }),
      markOnlineOnConnect: false,
      syncFullHistory: IMPORT_HISTORY,
      shouldSyncHistoryMessage: () => IMPORT_HISTORY,
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      retryRequestDelayMs: 1000,
      generateHighQualityLinkPreview: false,
    });
    activeSocket = socket;

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('contacts.upsert', rememberContacts);
    socket.ev.on('contacts.update', rememberContacts);
    socket.ev.on('chats.upsert', rememberContacts);
    socket.ev.on('chats.update', rememberContacts);
    socket.ev.on('connection.update', async (update) => {
      if (generation !== connectionGeneration) return;

      if (update.qr) {
        try {
          const qrImage = await QRCode.toDataURL(update.qr, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 320,
            color: { dark: '#07111f', light: '#ffffff' },
          });
          setConnectionStatus('awaiting_qr', { qrImage, qrUpdatedAt: new Date().toISOString(), error: null });
        } catch (error) {
          setConnectionStatus('error', { qrImage: null, error: `Não foi possível gerar a imagem do QR: ${error.message}` });
        }
        return;
      }

      if (update.connection === 'open') {
        setConnectionStatus('connected', {
          qrImage: null,
          qrUpdatedAt: null,
          connectedAt: new Date().toISOString(),
          error: null,
          reconnectAttempt: 0,
        });
        console.log('WhatsApp conectado. Mensagens novas serão armazenadas e áudios ficarão disponíveis para transcrição manual.');
        return;
      }

      if (update.connection === 'close') {
        const code = getDisconnectCode(update.lastDisconnect);
        const isLoggedOut = code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden || code === DisconnectReason.multideviceMismatch;

        if (isLoggedOut) {
          setConnectionStatus('logged_out', {
            qrImage: null,
            error: 'A sessão do WhatsApp foi encerrada. Clique em “Refazer conexão” para criar um novo QR.',
          });
          return;
        }

        const reconnectAttempt = connection.reconnectAttempt + 1;
        const detail = getDisconnectDetail(update.lastDisconnect);
        setConnectionStatus('reconnecting', {
          qrImage: null,
          error: `Conexão interrompida${code ? ` (código ${code})` : ''}${detail ? `: ${detail}` : ''}. Tentando novamente…`,
          reconnectAttempt,
        });
        scheduleReconnect();
      }
    });

    socket.ev.on('messages.delete', (event) => {
      if ('keys' in event) {
        removeMessagesFromWhatsAppEvent(event.keys);
      } else if (event.all && event.jid) {
        const removed = removeEntireConversation(event.jid);
        if (removed) console.log('Sincronização: conversa apagada no WhatsApp removida do histórico local.');
      }
    });

    socket.ev.on('messages.update', (updates) => {
      // "Apagar para todos" chega como revogação de mensagem, não como messages.delete.
      const revokedKeys = updates
        .filter(({ key, update }) => key?.id && update?.message === null)
        .map(({ key }) => key);
      removeMessagesFromWhatsAppEvent(revokedKeys);
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      const isHistory = type === 'append';
      if (isHistory && !IMPORT_HISTORY) return;
      for (const message of messages) {
        processWhatsAppMessage(message).catch((error) => {
          console.error(`Erro ao processar mensagem do WhatsApp: ${error.message}`);
        });
      }
    });

    socket.ev.on('messaging-history.set', ({ messages, contacts, chats }) => {
      if (!IMPORT_HISTORY) return;
      rememberContacts(contacts);
      rememberContacts(chats);
      console.log(`Recebido lote de histórico: ${messages.length} mensagem(ns). Importando somente localmente…`);
      for (const message of messages) {
        processWhatsAppMessage(message).catch((error) => {
          console.error(`Erro ao importar mensagem do histórico: ${error.message}`);
        });
      }
    });
  } catch (error) {
    if (generation !== connectionGeneration) return;
    const reconnectAttempt = connection.reconnectAttempt + 1;
    setConnectionStatus('error', {
      qrImage: null,
      error: `Não foi possível iniciar o WhatsApp: ${error.message}`,
      reconnectAttempt,
    });
    scheduleReconnect();
  }
}

function publicConnectionStatus() {
  return {
    status: connection.status,
    qrImage: connection.qrImage,
    qrUpdatedAt: connection.qrUpdatedAt,
    connectedAt: connection.connectedAt,
    error: connection.error,
    groqConfigured: Boolean(GROQ_API_KEY),
    audioTranscriptionEnabled: Boolean(GROQ_API_KEY),
  };
}

function validateText(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${field} é obrigatório.`);
    error.statusCode = 400;
    throw error;
  }
  if (value.length > maximum) {
    const error = new Error(`${field} excede o limite de ${maximum.toLocaleString('pt-BR')} caracteres.`);
    error.statusCode = 413;
    throw error;
  }
  return value.trim();
}

async function summarize(text, instructions) {
  const conversation = validateText(text, 'A conversa', MAX_SUMMARY_CHARS);
  const prompt = typeof instructions === 'string' && instructions.trim()
    ? instructions.trim().slice(0, 5000)
    : DEFAULT_SUMMARY_INSTRUCTIONS;

  const data = await callGroq('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_CHAT_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Conversa para análise:\n\n${conversation}` },
      ],
    }),
  });

  const result = data?.choices?.[0]?.message?.content;
  if (!result) {
    const error = new Error('A Groq não retornou um resumo válido.');
    error.statusCode = 502;
    throw error;
  }
  return result;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'deny' }));

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, whatsapp: publicConnectionStatus() });
});

app.get('/api/whatsapp/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(publicConnectionStatus());
});

app.post('/api/whatsapp/reset', async (req, res, next) => {
  try {
    clearTimeout(reconnectTimer);
    connectionGeneration += 1;
    const oldSocket = activeSocket;
    activeSocket = null;
    try {
      oldSocket?.ws?.close();
    } catch {
      // A conexão pode já estar fechada.
    }

    const clearData = req.body?.clearData === true;
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    if (clearData) clearLocalConversationHistory();
    else ensureDirectories();
    setConnectionStatus('connecting', { qrImage: null, qrUpdatedAt: null, error: null, reconnectAttempt: 0 });
    connectWhatsApp().catch((error) => console.error(`Falha ao gerar novo QR: ${error.message}`));
    res.status(202).json({
      ok: true,
      message: clearData
        ? 'Sessão e histórico local removidos. Aguarde o novo QR aparecer.'
        : 'Sessão local removida. O histórico atual foi preservado. Aguarde o novo QR aparecer.',
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations', (req, res) => {
  const index = loadConversationIndex();
  const conversations = Object.values(index.conversations)
    .sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')))
    .map(toPublicConversation);
  res.json({ conversations });
});

app.get('/api/conversations/:id', (req, res) => {
  const id = req.params.id;
  const index = loadConversationIndex();
  const conversation = index.conversations[id];
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });
  return res.json({ conversation: toPublicConversation(conversation), entries: loadConversationEntries(id, req.query.limit) });
});

app.post('/api/conversations/:id/history', async (req, res, next) => {
  try {
    const result = await requestOlderConversationHistory(req.params.id);
    return res.status(202).json({
      ok: true,
      message: `Solicitação enviada. O WhatsApp pode retornar até ${result.requested} mensagens mais antigas se elas ainda estiverem disponíveis.`,
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/conversations/:id/audio/pending', (req, res, next) => {
  try {
    const index = loadConversationIndex();
    if (!index.conversations[req.params.id]) return res.status(404).json({ error: 'Conversa não encontrada.' });
    const stats = getPendingAudioStats(req.params.id);
    return res.json({ totalPending: stats.totalPending, available: stats.available, unavailable: stats.unavailable });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/conversations/:id/audio/transcribe-all', (req, res, next) => {
  try {
    const index = loadConversationIndex();
    if (!index.conversations[req.params.id]) return res.status(404).json({ error: 'Conversa não encontrada.' });
    const job = startBulkTranscription(req.params.id);
    return res.status(202).json({ job: publicBulkJob(job) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/transcription-jobs/:jobId', (req, res) => {
  const job = bulkTranscriptionJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Lote de transcrição não encontrado ou expirado.' });
  return res.json({ job: publicBulkJob(job) });
});

app.get('/api/conversations/:id/audio/:messageId', (req, res, next) => {
  try {
    const entry = getAudioEntry(req.params.id, req.params.messageId);
    const filePath = getAudioFilePath(entry.audio?.fileName);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'O arquivo local deste áudio não está disponível.' });
    }

    const stat = fs.statSync(filePath);
    res.set({
      'Content-Type': entry.audio?.mimeType || 'audio/ogg',
      'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=3600',
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', next);
    return stream.pipe(res);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/conversations/:id/audio/:messageId/transcribe', async (req, res, next) => {
  try {
    const entry = await transcribeStoredConversationAudio(req.params.id, req.params.messageId);
    return res.json({ entry });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/summarize', async (req, res, next) => {
  try {
    const summary = await summarize(req.body?.text, req.body?.instructions);
    res.json({ summary });
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:id/summarize', async (req, res, next) => {
  try {
    const id = req.params.id;
    const index = loadConversationIndex();
    const conversation = index.conversations[id];
    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });

    const transcript = loadConversationEntries(id, 1000)
      .map((entry) => `[${entry.timestamp}] ${entry.fromMe ? 'Você' : entry.sender}: ${entry.text}`)
      .join('\n');
    const safeTranscript = transcript.slice(-MAX_SUMMARY_CHARS);
    const summary = await summarize(safeTranscript, req.body?.instructions);
    return res.json({ summary, conversation: toPublicConversation(conversation) });
  } catch (error) {
    return next(error);
  }
});

app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = Number(error.statusCode) || 500;
  if (status >= 500) console.error(`Erro em ${req.method} ${req.path}: ${error.message}`);
  res.status(status).json({ error: error.message || 'Ocorreu um erro inesperado.' });
});

process.on('SIGINT', () => {
  flushConversationIndex();
  flushProcessedMessageIds();
  flushContacts();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flushConversationIndex();
  flushProcessedMessageIds();
  flushContacts();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Painel disponível em http://localhost:${PORT}`);
  if (!GROQ_API_KEY) console.warn('GROQ_API_KEY ausente: os resumos e as transcrições ficarão indisponíveis até configurar o .env.');
  connectWhatsApp().catch((error) => console.error(`Falha ao iniciar WhatsApp: ${error.message}`));
});
