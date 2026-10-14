// Utils compartilhados
// Fuso de TODA data/hora exibida/exportada. As mensagens são gravadas em ISO UTC
// (correto p/ ordenar/comparar); só a APRESENTAÇÃO converte p/ este fuso.
// Sem isso, o TXT levava "2026-...T17:29Z" (UTC) e o Gemini lia como horário
// local, mostrando a conversa 3h adiantada no Brasil. Manter igual ao index.js.
const KREVER_TIME_ZONE = 'America/Sao_Paulo';
const kreverExportDateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: KREVER_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function formatTimestampForExport(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return kreverExportDateTimeFormatter.format(date);
}

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
    const ts = e.timestamp ? formatTimestampForExport(e.timestamp) : formatTimestampForExport(new Date());
    const sender = e.fromMe ? 'Você' : (e.sender || 'Cliente');
    return `[${ts}] ${sender}: ${e.text}`;
  }).join('\n');
}

function buildExportContent(conversationName, phone, entries) {
  const heading = [
    `CONVERSA: ${conversationName || 'Cliente'}`,
    phone ? `NÚMERO: +${phone}` : null,
    `EXPORTADO EM: ${formatTimestampForExport(new Date())}`,
    `FUSO HORÁRIO: ${KREVER_TIME_ZONE} (horários abaixo já convertidos para este fuso)`,
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
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: KREVER_TIME_ZONE }).format(d);
  } catch { return ''; }
}

function isTechnicalId(value) {
  return /^\d{14,}(?::\d+)?$/.test(String(value || '').trim());
}

if (typeof window !== 'undefined') {
  window.KreverUtils = { safeExportFileName, estimateTokens, buildTranscript, buildExportContent, formatDateBR, isTechnicalId, formatTimestampForExport, KREVER_TIME_ZONE };
}
if (typeof self !== 'undefined') {
  self.KreverUtils = { safeExportFileName, estimateTokens, buildTranscript, buildExportContent, formatDateBR, isTechnicalId, formatTimestampForExport, KREVER_TIME_ZONE };
}
