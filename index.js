const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs'), path = require('path');

const QRCode = require('qrcode-terminal');
(async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => { 
    if (u.qr) { console.log('Escaneie o QR abaixo:'); QRCode.generate(u.qr, {small:true}); }
  });
  sock.ev.on('messages.upsert', async (m) => {
    if (!m.messages[0]?.message) return;
    const msg = m.messages[0];
    const jid = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const audio = msg.message.audioMessage || msg.message.documentMessage;
    if (audio) {
      try {
        const buffer = await sock.downloadMediaMessage(msg);
        fs.mkdirSync('audio', {recursive:true});
        fs.writeFileSync(path.join('audio', jid+'.mp3'), buffer);
      } catch(e){ console.log('Erro audio:', e.message); }
    }
    if (text) { fs.mkdirSync('historico',{recursive:true}); fs.appendFileSync(path.join('historico',jid+'.txt'), new Date().toISOString()+' | '+text+'\n'); }
  });
})();

const express = require('express');
const app = express();
app.use(express.static('.'));
const GROQ_KEY = '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';
app.get('/conversas', (req,res)=>{ try { const f=fs.readdirSync('historico'); res.json({conversas:f}); } catch{ res.json({conversas:[]}); } });
app.get('/resumir', async (req,res)=>{
  let texto = req.query.texto || '';
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST', headers:{'Authorization':'Bearer '+GROQ_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({model:'llama-3.1-8b-instant', messages:[{role:'user',content:texto}]})
  });
  const data = await resp.json();
  console.log('Groq:', data);
  res.json({resumo: data.choices?.[0]?.message?.content || JSON.stringify(data)});
});
app.listen(3000,()=>console.log('Web: http://localhost:3000'));
