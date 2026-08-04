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
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.1-8b-instant';
const GROQ_TRANSCRIPTION_MODEL = process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo';
const SAVE_AUDIO_FILES = process.env.SAVE_AUDIO_FILES === 'true';
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 24 * 1024 * 1024);
const MAX_SUMMARY_CHARS = Number(process.env.MAX_SUMMARY_CHARS || 50000);

const DEFAULT_SUMMARY_INSTRUCTIONS = `Você é um assistente de vendas de consórcio. Resuma a conversa de forma objetiva em português do Brasil. Só considere que é uma oportunidade de consórcio quando houver sinais claros disso. Nunca invente dados. Use exatamente esta estrutura:

Status: ...
Cliente: ...
Interesse/objetivo: ...
Dados informados: ...
Objeções ou pendências: ...
Próxima ação recomendada: ...

Se a conversa for pessoal ou não tiver dados de venda de consórcio, responda apenas: "Conversação pessoal — sem dados de venda de consórcio."`;

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

ensureDirectories();

function ensureDirectories() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  if (SAVE_AUDIO_FILES) fs.mkdirSync(AUDIO_DIR, { recursive: true });
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

function getDisplayName(jid, pushName) {
  if (pushName && pushName.trim()) return pushName.trim().slice(0, 100);
  const localPart = jid.split('@')[0] || 'Conversa';
  return jid.endsWith('@g.us') ? `Grupo ${localPart}` : localPart;
}

function loadConversationIndex() {
  const index = readJson(CONVERSATIONS_INDEX_FILE, { conversations: {} });
  if (!index || typeof index !== 'object' || !index.conversations || typeof index.conversations !== 'object') {
    return { conversations: {} };
  }
  return index;
}

function toPublicConversation(conversation) {
  return {
    id: conversation.id,
    name: conversation.name,
    isGroup: Boolean(conversation.isGroup),
    messageCount: conversation.messageCount || 0,
    lastMessageAt: conversation.lastMessageAt || null,
    preview: conversation.preview || '',
  };
}

function appendConversationEntry({ jid, pushName, fromMe, sender, type, text, timestamp, audio }) {
  const id = getConversationId(jid);
  const index = loadConversationIndex();
  const existing = index.conversations[id];
  const entry = {
    id: crypto.randomUUID(),
    timestamp: timestamp || new Date().toISOString(),
    fromMe: Boolean(fromMe),
    sender: sender || (fromMe ? 'Você' : getDisplayName(jid, pushName)),
    type: type || 'text',
    text: String(text || '').slice(0, 30000),
  };

  if (audio) entry.audio = audio;

  const preview = entry.text.replace(/\s+/g, ' ').trim().slice(0, 140);
  index.conversations[id] = {
    id,
    jid,
    name: existing?.name || getDisplayName(jid, pushName),
    isGroup: jid.endsWith('@g.us'),
    messageCount: (existing?.messageCount || 0) + 1,
    lastMessageAt: entry.timestamp,
    preview,
  };

  writeJson(CONVERSATIONS_INDEX_FILE, index);
  fs.appendFileSync(getConversationFile(id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

function loadConversationEntries(id, limit = 250) {
  const file = getConversationFile(id);
  if (!file || !fs.existsSync(file)) return [];

  const entries = fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return entries.slice(-Math.max(1, Math.min(Number(limit) || 250, 1000)));
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

async function transcribeAudio(message, audioContent, conversationId) {
  if (!GROQ_API_KEY) {
    return { text: '[Áudio recebido — transcrição pendente: configure GROQ_API_KEY.]', transcriptionStatus: 'not_configured' };
  }

  const buffer = await downloadMediaMessage(message, 'buffer', {});
  if (buffer.length > MAX_AUDIO_BYTES) {
    return {
      text: `[Áudio recebido — não transcrito: excede o limite configurado de ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)} MB.]`,
      transcriptionStatus: 'too_large',
    };
  }

  const mimeType = audioContent.mimetype || 'audio/ogg';
  const extension = extensionForMimeType(mimeType);
  const fileName = `audio-${message.key.id || crypto.randomUUID()}.${extension}`;

  if (SAVE_AUDIO_FILES) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUDIO_DIR, `${conversationId}-${fileName}`), buffer, { mode: 0o600 });
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

async function processWhatsAppMessage(message) {
  const jid = message.key?.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;

  const content = extractMessageContent(message.message);
  if (!content) return;

  const fromMe = Boolean(message.key?.fromMe);
  const pushName = message.pushName;
  const sender = fromMe ? 'Você' : (pushName || getDisplayName(jid));
  const timestamp = getMessageTimestamp(message);
  const text = getMessageText(content);

  if (text) {
    appendConversationEntry({ jid, pushName, fromMe, sender, type: 'text', text, timestamp });
  }

  const audioContent = getAudioContent(content);
  if (!audioContent) return;

  const conversationId = getConversationId(jid);
  try {
    const transcription = await transcribeAudio(message, audioContent, conversationId);
    appendConversationEntry({
      jid,
      pushName,
      fromMe,
      sender,
      type: 'audio',
      text: transcription.text,
      timestamp,
      audio: {
        mimeType: audioContent.mimetype || 'audio/ogg',
        seconds: Number(audioContent.seconds) || null,
        transcriptionStatus: transcription.transcriptionStatus,
      },
    });
  } catch (error) {
    console.error(`Não foi possível transcrever um áudio de ${getDisplayName(jid, pushName)}: ${error.message}`);
    appendConversationEntry({
      jid,
      pushName,
      fromMe,
      sender,
      type: 'audio',
      text: '[Áudio recebido — não foi possível transcrever agora. Verifique GROQ_API_KEY, o modelo e o limite da conta.]',
      timestamp,
      audio: { mimeType: audioContent.mimetype || 'audio/ogg', transcriptionStatus: 'failed' },
    });
  }
}

function setConnectionStatus(status, changes = {}) {
  Object.assign(connection, { status, ...changes });
}

function getDisconnectCode(lastDisconnect) {
  const error = lastDisconnect?.error;
  return error?.output?.statusCode || error?.data?.statusCode || error?.statusCode;
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
      browser: Browsers.ubuntu('Chrome'),
      // O painel já expõe o estado da conexão; evita despejar detalhes de socket no terminal.
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    activeSocket = socket;

    socket.ev.on('creds.update', saveCreds);
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
        console.log('WhatsApp conectado. Mensagens novas serão armazenadas e áudios serão transcritos.');
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
        setConnectionStatus('reconnecting', {
          qrImage: null,
          error: `Conexão interrompida${code ? ` (código ${code})` : ''}. Tentando novamente…`,
          reconnectAttempt,
        });
        scheduleReconnect();
      }
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      // "append" costuma ser histórico sincronizado. O app grava apenas mensagens novas,
      // evitando importar todo o histórico sem uma ação explícita do usuário.
      if (type !== 'notify') return;
      for (const message of messages) {
        processWhatsAppMessage(message).catch((error) => {
          console.error(`Erro ao processar mensagem do WhatsApp: ${error.message}`);
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

    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    ensureDirectories();
    setConnectionStatus('connecting', { qrImage: null, qrUpdatedAt: null, error: null, reconnectAttempt: 0 });
    connectWhatsApp().catch((error) => console.error(`Falha ao gerar novo QR: ${error.message}`));
    res.status(202).json({ ok: true, message: 'Sessão local removida. Aguarde o novo QR aparecer.' });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Painel disponível em http://localhost:${PORT}`);
  if (!GROQ_API_KEY) console.warn('GROQ_API_KEY ausente: os resumos e as transcrições ficarão indisponíveis até configurar o .env.');
  connectWhatsApp().catch((error) => console.error(`Falha ao iniciar WhatsApp: ${error.message}`));
});
