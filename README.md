# Central de conversas de consórcio

Painel local para conectar uma conta do WhatsApp, registrar **mensagens novas**, transcrever áudios em português com a Groq e gerar resumos de atendimento de consórcio.

## Antes de iniciar

- Node.js 20 ou superior (testado com Node 22).
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
4. Para importar conversas anteriores da **mesma conta**, faça um pareamento novo pelo botão **Refazer conexão / novo QR**. Isso apaga somente a sessão local em `auth/`, preserva o histórico já salvo em `data/` e cria um novo dispositivo conectado.
5. Para conectar **outra conta de WhatsApp**, use **Trocar conta e apagar histórico**. Essa opção remove a sessão e todos os textos, contatos, áudios e resumos locais antes de exibir o QR da nova conta, impedindo que dados de contas diferentes fiquem misturados.

O QR não é enviado ao navegador como texto: o servidor transforma o token em imagem e disponibiliza somente a imagem temporária no painel. Esse era o principal motivo de o projeto anterior exibir QR apenas no terminal, sem uma tela para escanear.

## Nomes, números e pesquisa

O painel usa os contatos e chats que o WhatsApp disponibiliza na sincronização para exibir nome e número, e a busca lateral aceita ambos. Não é feita busca externa pelo número: se um contato não tiver nome salvo/disponível no WhatsApp, o painel exibe **Cliente**, sem usar seu próprio nome ou identificadores técnicos como nome do contato. Para atualizar nomes de conversas antigas, faça um novo pareamento pelo botão **Refazer conexão / novo QR** e aguarde a sincronização terminar.

## Exportar conversa em TXT

Depois de selecionar uma conversa, use **Exportar TXT**. O download contém todo o histórico local, incluindo transcrições de áudio e análises de imagem já realizadas. O arquivo é nomeado com o nome do contato quando disponível; caso contrário, usa `cliente-AAAA-MM-DD.txt`. Nenhuma chamada de IA é feita para exportar.

## Histórico e uso da IA

Com `IMPORT_HISTORY=true` (padrão), no primeiro pareamento o app importa e salva localmente as mensagens históricas que o WhatsApp Web disponibilizar. **Essa importação de texto não chama a Groq e não consome créditos de IA.** O WhatsApp decide quanto do histórico entrega ao dispositivo conectado; portanto não há garantia técnica de receber absolutamente toda a vida da conta.

Em uma conversa selecionada, o botão **Buscar 50 anteriores** pede ao WhatsApp mais uma página de até 50 mensagens antes da mensagem mais antiga já guardada. Pode ser usado novamente após alguns segundos. Essa busca não usa IA, mas o WhatsApp pode não retornar mensagens antigas se elas não estiverem disponíveis na conta/dispositivo.

- **Texto histórico:** é apenas gravado em `data/`; não vai para a IA automaticamente.
- **Qualquer áudio recebido:** é guardado localmente em `data/audio/` para aparecer com player no painel. Isso não chama a Groq. Na conversa, clique em **Transcrever este áudio** somente nos áudios que desejar enviar à IA.
- **Imagens de simulação:** são guardadas em `data/images/`, aparecem como prévia na conversa e não são enviadas automaticamente à IA.
- **Transcrição/análise em lote:** ao clicar em **Gerar resumo da conversa**, o painel pergunta se deve transcrever todos os áudios e analisar todas as imagens locais pendentes. Confirmar envia os arquivos um a um para a Groq e consome uma requisição por áudio/imagem; cancelar gera o resumo somente com textos, transcrições e análises já existentes.
- **Resumo:** só chama a IA quando você clica em **Gerar resumo da conversa** e envia o contexto completo, sem cortes automáticos. O painel mostra uma estimativa de tokens de entrada, saída e total antes do resumo; é uma aproximação, pois o tokenizador real pode variar. Provedores em nuvem podem recusar conversas que excedam seus próprios limites de contexto ou taxa. Um novo clique faz uma nova chamada.

Para o modo manual funcionar, `STORE_AUDIO_FOR_MANUAL_TRANSCRIPTION=true` deve permanecer no `.env` (é o padrão). Se definir `false`, o sistema não guardará os áudios, nem poderá reproduzi-los ou transcrevê-los depois. Para áudios recebidos antes desta atualização, faça **Refazer conexão / novo QR**: se o WhatsApp reenviar a mídia no histórico, o app a anexa à conversa existente sem duplicar os textos.

## Exclusões no WhatsApp

O modo atual é **remover também do sistema**. Enquanto o app estiver conectado, quando o WhatsApp enviar um evento de exclusão — inclusive “apagar para todos” ou uma exclusão sincronizada do telefone — a mensagem sai do histórico local e o arquivo de áudio associado também é apagado. Se uma conversa inteira vier marcada como apagada, ela também é removida.

Não existe uma API confiável para comparar toda a conta e descobrir retroativamente cada mensagem que foi apagada apenas no celular (“apagar para mim”/limpar conversa) enquanto o app estava desligado. Para isso, conecte o painel antes de realizar a exclusão; ele então recebe o evento do WhatsApp e aplica a remoção local.

## O que é salvo

- Conversas, histórico importado e transcrições são salvos localmente em `data/`, que está ignorada pelo Git.
- Os áudios recebidos ficam em `data/audio/` somente para reprodução e transcrição manual. As imagens ficam em `data/images/` para análise opcional. Essas pastas também são ignoradas pelo Git.
- As credenciais da sessão ficam em `auth/`, também ignorada pelo Git.

## APIs locais

- `GET /api/whatsapp/status` — estado da conexão e QR temporário.
- `POST /api/whatsapp/reset` — remove a sessão local e reinicia o pareamento.
- `GET /api/conversations` — conversas capturadas.
- `GET /api/conversations/:id/export.txt` — baixa o histórico local completo em TXT.
- `POST /api/conversations/:id/history` — pede uma página de até 50 mensagens mais antigas ao WhatsApp.
- `GET /api/conversations/:id/audio/pending` — quantidade de áudios disponíveis para transcrição em lote.
- `POST /api/conversations/:id/audio/transcribe-all` — inicia a transcrição manual em lote.
- `POST /api/conversations/:id/image/analyze-all` — inicia a análise de imagens da conversa em lote.
- `POST /api/conversations/:id/token-estimate` — estimativa local do consumo de tokens para o resumo.
- `POST /api/conversations/:id/summarize` — resumo de uma conversa armazenada.
- `POST /api/summarize` — resumo de texto avulso.

## Resumo local com Ollama

No painel, selecione **Local (Ollama)** em “Motor do resumo” para resumir conversas no seu próprio computador, sem consumir tokens ou créditos da Groq. Instale o [Ollama](https://ollama.com/), baixe o modelo configurado e mantenha o serviço aberto:

```powershell
ollama pull llama3.2:3b
ollama serve
```

O modelo padrão local é `llama3.2:3b`, mais adequado para computadores com 8 GB de RAM e sem GPU dedicada potente. O app usa `http://127.0.0.1:11434` por padrão e envia o contexto completo da conversa, sem cortes automáticos. A seleção vale para o **resumo de texto**. Transcrição de áudio e análise de imagens continuam na Groq até uma integração local específica para essas mídias.

Por padrão, `OLLAMA_KEEP_ALIVE=0` descarrega o modelo local ao terminar cada resumo, liberando RAM e encerrando o processo de execução do modelo após alguns instantes. Isso faz o próximo resumo demorar mais para carregar o modelo. Use `5m`, por exemplo, se preferir velocidade nas chamadas seguintes e tiver RAM disponível.

## Arquivos enviados para a IA

Com `SAVE_AI_REQUESTS=true`, cada resumo cria um arquivo `.txt` em `data/ai-requests/` contendo o provedor, modelo, instruções e o trecho exato da conversa enviado para a IA. A chave da API nunca é incluída. Esses arquivos têm dados sensíveis e ficam fora do Git; defina `SAVE_AI_REQUESTS=false` se não quiser guardá-los.

A chave da Groq permanece exclusivamente no servidor; o navegador usa apenas essas rotas locais.
