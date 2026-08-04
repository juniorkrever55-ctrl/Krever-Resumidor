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

Os áudios recebidos são baixados e guardados localmente em `data/audio/` para você ouvir no painel. Eles **não são enviados à Groq automaticamente**. A Groq só é chamada quando você clica em **Transcrever este áudio** ou no botão de resumo; a transcrição escolhida passa a fazer parte da conversa que será resumida.

A importação de textos de conversas anteriores também é local e **não** chama a Groq. Mantenha `STORE_AUDIO_FOR_MANUAL_TRANSCRIPTION=true` no `.env` para que áudios novos e históricos disponíveis possam ser reproduzidos e transcritos sob demanda. Como os arquivos podem conter dados pessoais, `data/` permanece fora do Git.

## Segurança importante

Uma chave da Groq estava escrita diretamente no código anterior. Considere essa chave exposta: **revogue-a no console da Groq e crie outra**, antes de usar o projeto. Sessões do WhatsApp também são secretas e ficam em `auth/`; nunca publique essa pasta.
