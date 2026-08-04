# Configuração da Groq

> **Groq não é Grok.** Este projeto usa a API da **Groq** em `api.groq.com`, que executa modelos como Llama e Whisper. Grok é o produto/API da xAI e usa outra chave e outra URL.

## 1. Criar a chave

1. Acesse o console da Groq e crie uma API key.
2. Na raiz do projeto, copie `.env.example` para `.env`.
3. Preencha somente esta linha no `.env`:

```env
GROQ_API_KEY=sua_chave_aqui
```

4. Inicie o app com `npm start` e abra `http://localhost:3000`.

A chave não deve ficar em `index.js`, no HTML, em commits ou ser enviada pelo navegador. O `.env` já está no `.gitignore`.

## Modelos usados

- **Resumo:** `llama-3.1-8b-instant` (configurável com `GROQ_CHAT_MODEL`)
- **Áudio:** `whisper-large-v3-turbo` (configurável com `GROQ_TRANSCRIPTION_MODEL`)

O áudio é baixado do WhatsApp no servidor, enviado à rota de transcrição da Groq e a transcrição passa a fazer parte da conversa que será resumida. Por padrão o arquivo de áudio original **não é guardado**; só a transcrição é salva em `data/`. Para guardar os originais, use `SAVE_AUDIO_FILES=true` conscientemente.

## Segurança importante

Uma chave da Groq estava escrita diretamente no código anterior. Considere essa chave exposta: **revogue-a no console da Groq e crie outra**, antes de usar o projeto. Sessões do WhatsApp também são secretas e ficam em `auth/`; nunca publique essa pasta.
