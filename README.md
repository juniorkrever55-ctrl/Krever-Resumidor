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
4. Se aparecer sessão encerrada, ou o QR nunca aparecer depois de um login antigo, clique em **Refazer conexão / novo QR**. Isso apaga somente a sessão local em `auth/` e cria um pareamento novo.

O QR não é enviado ao navegador como texto: o servidor transforma o token em imagem e disponibiliza somente a imagem temporária no painel. Esse era o principal motivo de o projeto anterior exibir QR apenas no terminal, sem uma tela para escanear.

## O que é salvo

- Apenas mensagens de evento `notify` (novas depois de conectar) são armazenadas. O aplicativo não importa todo o histórico existente por padrão.
- Conversas e transcrições são salvas localmente em `data/`, que está ignorada pelo Git.
- Áudios são transcritos pela Groq. Por padrão os arquivos de áudio não ficam em disco (`SAVE_AUDIO_FILES=false`).
- As credenciais da sessão ficam em `auth/`, também ignorada pelo Git.

## APIs locais

- `GET /api/whatsapp/status` — estado da conexão e QR temporário.
- `POST /api/whatsapp/reset` — remove a sessão local e reinicia o pareamento.
- `GET /api/conversations` — conversas capturadas.
- `POST /api/conversations/:id/summarize` — resumo de uma conversa armazenada.
- `POST /api/summarize` — resumo de texto avulso.

A chave da Groq permanece exclusivamente no servidor; o navegador usa apenas essas rotas locais.
