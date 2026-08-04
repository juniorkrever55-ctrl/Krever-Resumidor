# Central de conversas de consórcio

Painel local para conectar uma conta do WhatsApp, registrar **mensagens novas**, transcrever áudios em português com a Groq e gerar resumos de atendimento de consórcio.

## Antes de iniciar

- Node.js 18 ou superior (testado com Node 22).
- Uma chave da **Groq**. Veja [GROQ_INSTRUCOES.md](GROQ_INSTRUCOES.md).
- Use uma conta autorizada e trate conversas, CPF e demais dados pessoais de acordo com a LGPD.

> O projeto atual utiliza **Baileys**, uma biblioteca não oficial que emula o WhatsApp Web. Para operação comercial/produção, avalie usar a API oficial WhatsApp Business Cloud da Meta. Contas podem ter restrições quando usadas com automação não oficial.

## Como rodar

```bash
npm install
cp .env.example .env
# edite .env e informe GROQ_API_KEY
npm start
```

Abra `http://localhost:3000`. O servidor fica em `0.0.0.0:3000`, então também funciona em um ambiente de preview.

## Conectando o QR Code

1. Abra o painel e espere o QR aparecer.
2. No WhatsApp do celular, abra **Configurações > Dispositivos conectados > Conectar dispositivo**.
3. Escaneie o QR do painel. Ele expira rapidamente; o painel atualiza automaticamente.
4. Para importar conversas anteriores, faça um pareamento novo pelo botão **Refazer conexão / novo QR**. Isso apaga somente a sessão local em `auth/` e cria um novo dispositivo conectado, que solicita o histórico disponível ao WhatsApp.

O QR não é enviado ao navegador como texto: o servidor transforma o token em imagem e disponibiliza somente a imagem temporária no painel. Esse era o principal motivo de o projeto anterior exibir QR apenas no terminal, sem uma tela para escanear.

## Histórico e uso da IA

Com `IMPORT_HISTORY=true` (padrão), no primeiro pareamento o app importa e salva localmente as mensagens históricas que o WhatsApp Web disponibilizar. **Essa importação de texto não chama a Groq e não consome créditos de IA.** O WhatsApp decide quanto do histórico entrega ao dispositivo conectado; portanto não há garantia técnica de receber absolutamente toda a vida da conta.

- **Texto histórico:** é apenas gravado em `data/`; não vai para a IA automaticamente.
- **Qualquer áudio recebido:** é guardado localmente em `data/audio/` para aparecer com player no painel. Isso não chama a Groq. Na conversa, clique em **Transcrever este áudio** somente nos áudios que desejar enviar à IA.
- **Transcrição:** cada clique em **Transcrever este áudio** faz uma chamada à Groq e consome uma requisição. Áudios antigos que o WhatsApp não disponibilizar mais podem não ser baixados.
- **Resumo:** só chama a Groq quando você clica em **Gerar resumo da conversa**. Para controlar custo e contexto, cada resumo usa as últimas 1.000 mensagens registradas e no máximo 50.000 caracteres. Um novo clique faz uma nova chamada.

Para o modo manual funcionar, `STORE_AUDIO_FOR_MANUAL_TRANSCRIPTION=true` deve permanecer no `.env` (é o padrão). Se definir `false`, o sistema não guardará os áudios, nem poderá reproduzi-los ou transcrevê-los depois. Para áudios recebidos antes desta atualização, faça **Refazer conexão / novo QR**: se o WhatsApp reenviar a mídia no histórico, o app a anexa à conversa existente sem duplicar os textos.

## O que é salvo

- Conversas, histórico importado e transcrições são salvos localmente em `data/`, que está ignorada pelo Git.
- Os áudios recebidos ficam em `data/audio/` somente para reprodução e transcrição manual. Essa pasta também é ignorada pelo Git.
- As credenciais da sessão ficam em `auth/`, também ignorada pelo Git.

## APIs locais

- `GET /api/whatsapp/status` — estado da conexão e QR temporário.
- `POST /api/whatsapp/reset` — remove a sessão local e reinicia o pareamento.
- `GET /api/conversations` — conversas capturadas.
- `POST /api/conversations/:id/summarize` — resumo de uma conversa armazenada.
- `POST /api/summarize` — resumo de texto avulso.

A chave da Groq permanece exclusivamente no servidor; o navegador usa apenas essas rotas locais.
