// Utils compartilhados
function safeExportFileName(name) {
  const safe = String(name || 'cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safe || 'cliente';
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.2);
}

function buildTranscript(entries) {
  return entries.map(e => {
    const ts = e.timestamp || new Date().toISOString();
    const sender = e.fromMe ? 'Você' : (e.sender || 'Cliente');
    return `[${ts}] ${sender}: ${e.text}`;
  }).join('\n');
}

function buildExportContent(conversationName, phone, entries) {
  const heading = [
    `CONVERSA: ${conversationName || 'Cliente'}`,
    phone ? `NÚMERO: +${phone}` : null,
    `EXPORTADO EM: ${new Date().toLocaleString('pt-BR')}`,
    '',
    '=== HISTÓRICO ===',
    '',
  ].filter(Boolean).join('\n');
  const messages = buildTranscript(entries);
  return `${heading}\n${messages || 'Nenhuma mensagem registrada.'}\n`;
}

function formatDateBR(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(d);
  } catch { return ''; }
}

function isTechnicalId(value) {
  return /^\d{14,}(?::\d+)?$/.test(String(value || '').trim());
}

if (typeof window !== 'undefined') {
  window.KreverUtils = { safeExportFileName, estimateTokens, buildTranscript, buildExportContent, formatDateBR, isTechnicalId };
}
if (typeof self !== 'undefined') {
  self.KreverUtils = { safeExportFileName, estimateTokens, buildTranscript, buildExportContent, formatDateBR, isTechnicalId };
}
