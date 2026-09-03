# Krever Resumidor - Extensão Chrome

Versão em extensão Chrome do sistema de resumo de consórcio. **Não mexe no código original** - pasta isolada `adaptação_extensão`.

## O que faz (mesmas funcionalidades do sistema original)

- ✅ Lê conversas direto do WhatsApp Web (sem Baileys/QR separado)
- ✅ Histórico: botão "Buscar 50 anteriores" faz scroll automático pra cima
- ✅ Áudios: transcreve via Groq Whisper (`whisper-large-v3-turbo`)
- ✅ Imagens: analisa simulações via Groq Vision (`qwen/qwen3.6-27b`)
- ✅ Resumo: Groq `llama-3.1-8b-instant` ou Ollama local `llama3.2:3b`
- ✅ Exporta TXT completo
- ✅ Preparar para Gemini: baixa TXT + copia prompt + abre gemini.google.com (você só cola)
- ✅ Estimativa de tokens, busca de conversas salvas, modo manual

## Instalação (modo desenvolvedor)

1. Abra `chrome://extensions/`
2. Ative "Modo do desenvolvedor" (canto superior direito)
3. Clique "Carregar sem compactação"
4. Selecione a pasta `adaptação_extensão`
5. Clique no ícone da extensão > ⚙️ Configurações
6. Cole sua `GROQ_API_KEY` (de https://console.groq.com/keys)
7. Salvar

## Como usar

1. Abra https://web.whatsapp.com e faça login
2. Selecione uma conversa de cliente
3. Clique no ícone da extensão Krever na barra do Chrome
4. Aba "Conversa Atual" já mostra as mensagens detectadas
5. Use:
   - ⬆️ Buscar 50 anteriores = scroll automático pra carregar histórico
   - 🎙️ Transcrever áudios = pega blob do áudio e manda pra Groq
   - 🖼️ Analisar imagens = manda simulações pra Groq Vision
   - 📊 Estimar tokens = mesma lógica original (chars / 3.2)
   - ✨ Gerar Resumo = chama Groq/Ollama com o prompt original
   - 📄 Exportar TXT = baixa `cliente-2026-08-26.txt`
   - 🔮 Preparar Gemini = baixa TXT + copia prompt + abre Gemini

## Diferenças vs sistema Node original

| Original (Node) | Extensão |
|---|---|
| Baileys + QR próprio + `auth/` | Usa login já existente do WhatsApp Web |
| `data/conversations/*.jsonl` no disco | `chrome.storage.local` + `conv_*` |
| `data/audio/`, `data/images/` | Blob URLs capturados direto do DOM |
| `IMPORT_HISTORY=true` automático | Scroll automático (simula "Buscar 50") |
| `api.groq.com` via backend | `fetch` direto do background (chave no storage) |
| Ollama `127.0.0.1:11434` | Mesma URL, precisa `host_permissions` |
| Botão Preparar Gemini baixa TXT e copia prompt | Idêntico, via `chrome.downloads` + clipboard |

## Arquitetura

```
manifest.json
background.js (service worker) -> Groq/Ollama, storage, downloads
content/whatsapp.js -> lê DOM do WhatsApp Web, extrai mensagens, blobs
popup/ -> UI principal (3 abas: atual, salvas, manual)
options/ -> config de chaves e modelos
lib/ -> prompts.js (mesmo prompt original), utils.js, storage.js, groq.js
```

## Permissões explicadas

- `storage`: salva config e conversas localmente
- `activeTab`: lê conversa ativa do WhatsApp Web
- `downloads`: baixa TXT exportado
- `clipboardWrite`: copia prompt para Gemini
- `host_permissions web.whatsapp.com`: content script
- `host_permissions api.groq.com`: chamadas IA
- `host_permissions 127.0.0.1:11434`: Ollama local

## Segurança

- Chave Groq fica só em `chrome.storage.local`, nunca no código
- Nenhum dado enviado para servidor próprio - só para api.groq.com e Ollama local
- Código aberto, auditável

## Próximos passos (opcional)

- [ ] Adicionar `offscreen` para jobs longos (Chrome desliga SW após 30s)
- [ ] Melhorar extração de JID/telefone via Store injection
- [ ] Adicionar atalho de teclado Ctrl+Shift+K para resumir
- [ ] Publicar na Chrome Web Store (precisa zipar pasta)

## Zip para publicar

```bash
cd adaptação_extensão
zip -r krever-resumidor-extension.zip * -x "*.git*"
```

Depois upload em https://chrome.google.com/webstore/devconsole
