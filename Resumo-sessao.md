# Resumo-sessao.md — Memória permanente do projeto (Krever-Resumidor)

> **Para qualquer IA/chat novo:** leia este arquivo INTEIRO antes de mexer no código.
> Ele é a fonte de verdade do contexto. Não confie só na conversa atual.

---

## 🚨 REGRAS OBRIGATÓRIAS (NUNCA QUEBRAR)

1. **Atualizar este arquivo a cada edição/commit, na MESMA alteração.**
   Toda mudança de código, config ou comportamento só está "pronta" depois que
   este arquivo registrar: o que mudou, por quê, arquivos afetados e como foi testado.
   Sem exceção — mesmo para ajustes pequenos.
2. **NUNCA fazer PR (Pull Request) nem Merge, em hipótese nenhuma.**
   Quem faz PR/merge é o usuário, manualmente. A IA não cria PR, não aprova,
   não faz merge, não fecha PR — nem se parecer "óbvio" ou "só pra ajudar".
3. **Sempre terminar a resposta com o comando de pull + merge no VSCode.**
   Ao final de TODA entrega, mandar o bloco pronto para colar no terminal do
   VSCode para o usuário baixar a branch da IA e fazer o merge manualmente:

   ```powershell
   git checkout main
   git pull origin main
   git fetch origin arena/c4f65b51-krever-resumidor
   git merge origin/arena/c4f65b51-krever-resumidor
   ```

   É esse comando — pull/merge com a branch da IA — que fecha toda resposta.
4. **A IA só commita/pusha na PRÓPRIA branch da sessão; merge é do usuário.**
   Fluxo: IA altera → atualiza este arquivo → commit + push **somente** em
   `arena/c4f65b51-krever-resumidor` → usuário faz pull + merge no VSCode
   (regra 3). A IA nunca mergeia na `main` nem em nenhuma outra branch.
5. **Responder em português (pt-BR)** e ser direto: diagnóstico → correção → teste.

---

## 📌 O que é o projeto

Painel local (Node.js) para resumir conversas de WhatsApp de **consórcio**:

- Conecta no WhatsApp via **Baileys** (QR Code), importa histórico e salva tudo
  localmente em `data/` (fora do Git).
- **Groq** transcreve áudios e analisa imagens (só quando o usuário pede).
- O **resumo final vai para o Gemini**: botão **"Preparar para Gemini"** baixa um
  TXT da conversa, copia o prompt e abre o Gemini; o usuário anexa e envia manualmente.
- Existe também uma **extensão de Chrome** em `adaptação_extensão/` (WhatsApp Web).

## 🗂️ Estrutura essencial

| Arquivo | Papel |
|---|---|
| `index.js` | Servidor Express + WhatsApp (Baileys) + exportação TXT + resumos |
| `public/index.html` | Painel (UI), botão "Preparar para Gemini" |
| `adaptação_extensão/` | Extensão Chrome (WhatsApp Web) |
| `adaptação_extensão/lib/utils.js` | Export/TXT compartilhado da extensão |
| `adaptação_extensão/content/whatsapp.js` | Painel injetado no WhatsApp Web |
| `data/`, `auth/` | Conversas/sessão locais — **gitignored, NUNCA versionar** |

## ▶️ Como rodar

```bash
npm install
# copiar .env.example para .env e preencher GROQ_API_KEY
npm start          # painel em http://localhost:3000
```

> ⚠️ `node_modules/` está **parcialmente versionado** neste repositório
> (2557 arquivos rastreados). Não commitar mudanças dentro de `node_modules/`;
> se `npm install` alterar algo lá, reverter com `git checkout -- node_modules/`.

---

## 🕐 CORREÇÃO — Hora errada no Gemini (2026-10-14) ✅ RESOLVIDO

**Sintoma (relato do usuário):** ao clicar em gerar para o Gemini, as conversas
vinham com a **hora errada**.

**Causa raiz:** as mensagens são gravadas em ISO UTC
(ex.: `2026-10-14T17:29:00.000Z`) — isso está correto para armazenamento.
O problema era a **exportação**: o TXT jogava esse timestamp cru para o Gemini,
que lia `17:29` como horário local, quando no Brasil eram **14:29** → conversa
inteira **3 horas adiantada**. O painel não mostrava o erro porque o navegador
convertia o UTC para o fuso local na tela, mascarando o bug.

**Correção (só na apresentação/exportação — NENHUM dado gravado foi alterado):**

- Novo fuso central `APP_TIME_ZONE` (padrão `America/Sao_Paulo`, configurável no
  `.env`) + função `formatTimestampForExport()` em `index.js`.
- `buildConversationExport()` (TXT do botão "Preparar para Gemini") e
  `buildConversationTranscript()` (texto enviado à Groq) agora exportam
  `[14/10/2026, 14:29:00]` em vez de `[2026-10-14T17:29:00.000Z]`, e o cabeçalho
  do TXT ganhou a linha `FUSO HORÁRIO: America/Sao_Paulo (...)`.
- `public/index.html`: `formatDate()` com `timeZone: 'America/Sao_Paulo'` fixo,
  para o painel mostrar exatamente a mesma hora do TXT.
- Extensão: mesma correção em `lib/utils.js` (`buildTranscript`,
  `buildExportContent`, `formatDateBR`) e nas 3 exportações inline de
  `content/whatsapp.js`.
- `.env.example`: documentado `APP_TIME_ZONE=America/Sao_Paulo`.

**Arquivos alterados:** `index.js`, `public/index.html`, `.env.example`,
`adaptação_extensão/lib/utils.js`, `adaptação_extensão/content/whatsapp.js`
(+ este `Resumo-sessao.md`).

**Teste realizado (2026-10-14):** servidor iniciado com conversa fictícia e
`GET /api/conversations/:id/export.txt` conferido:

| Gravado (UTC) | Antes (TXT) | Depois (TXT) |
|---|---|---|
| `2026-10-14T17:29:00.000Z` | `17:29` ❌ | `14/10/2026, 14:29:00` ✅ |
| `2026-10-14T03:15:00.000Z` | `03:15` ❌ | `14/10/2026, 00:15:00` ✅ |
| `2026-01-15T02:30:00.000Z` | `02:30` ❌ | `14/01/2026, 23:30:00` ✅ (dia anterior!) |

**Impacto:** conversas antigas **já saem corrigidas automaticamente** — a
conversão acontece na hora de exportar, não precisa reimportar nada.

**Para valer na máquina do usuário:** reiniciar o servidor (`Ctrl+C` +
`npm start`). Se usar a extensão, recarregá-la em `chrome://extensions`.

---

## 📋 Estado atual / próximos passos

- [x] Fuso horário do Gemini/TXT/resumo/extensão corrigido e testado (2026-10-14).
- [ ] Usuário validar na máquina dele com uma conversa real (reiniciar `npm start`).
- [ ] (Opcional) Se um dia atender clientes fora de SP, trocar `APP_TIME_ZONE` no `.env`.

## 📝 Histórico de alterações

| Data | Alteração | Arquivos |
|---|---|---|
| 2026-10-14 | Criado este arquivo + regras permanentes (sem PR/merge; comandos VSCode no final) | `Resumo-sessao.md` |
| 2026-10-14 | Fix: hora UTC→`America/Sao_Paulo` no TXT do Gemini, transcript Groq, painel e extensão | `index.js`, `public/index.html`, `.env.example`, `adaptação_extensão/lib/utils.js`, `adaptação_extensão/content/whatsapp.js` |
| 2026-10-14 | Regra do VSCode corrigida pelo usuário: comando final é sempre **pull + merge com a branch da IA** (`arena/c4f65b51-krever-resumidor`), não add/commit | `Resumo-sessao.md` |

---

## ⌨️ Comando para o VSCode (entregar SEMPRE no final da resposta)

No terminal do VSCode, na pasta do projeto — baixa a branch da IA e faz o
merge na `main` local (o merge é sempre manual, feito pelo usuário):

```powershell
git checkout main
git pull origin main
git fetch origin arena/c4f65b51-krever-resumidor
git merge origin/arena/c4f65b51-krever-resumidor
npm start
```

> Se der conflito ou o merge não for necessário, parar e avisar no chat —
> nunca forçar (`--force`), nunca criar PR.

*Última atualização: 2026-10-14 — regra do pull+merge no VSCode definida pelo usuário.*
