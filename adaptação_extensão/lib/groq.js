// Groq + Ollama client - roda no background service worker
class AIClient {
  constructor(config) {
    this.config = config;
  }

  async callGroq(url, options) {
    if (!this.config.groqApiKey) {
      throw new Error('GROQ_API_KEY não configurada. Vá em Opções da extensão e informe sua chave.');
    }
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.config.groqApiKey}`,
        ...(options.headers || {})
      }
    });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw }; }
    if (!response.ok) {
      const msg = body?.error?.message || body?.message || `Groq HTTP ${response.status}`;
      const err = new Error(msg);
      err.statusCode = response.status;
      throw err;
    }
    return body;
  }

  async transcribeAudio(blob, fileName, mimeType) {
    const maxBytes = 24 * 1024 * 1024;
    if (blob.size > maxBytes) throw new Error(`Áudio excede ${Math.floor(maxBytes/1024/1024)}MB`);
    
    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('model', this.config.groqTranscriptionModel);
    form.append('language', 'pt');
    form.append('response_format', 'json');

    const data = await this.callGroq('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      body: form
    });
    const transcription = typeof data.text === 'string' ? data.text.trim() : '';
    return {
      text: transcription ? `[Áudio transcrito] ${transcription}` : '[Áudio recebido — transcrição vazia]',
      raw: transcription,
      status: transcription ? 'completed' : 'empty'
    };
  }

  async analyzeImage(base64, mimeType) {
    const data = await this.callGroq('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.groqVisionModel,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: 'Você analisa imagens de simulação de consórcio para nota interna de CRM. Extraia somente informações visualmente legíveis e relevantes: administradora, crédito/carta, parcela, prazo, taxa/condições, lance de recurso próprio quando explicitamente descrito. Não invente valores. Não confunda lance embutido, fidelidade, parcela ou taxa com lance de recurso próprio. Responda em português, factual e conciso.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analise esta imagem enviada na conversa e descreva apenas dados de simulação de consórcio legíveis.' },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
            ]
          }
        ]
      })
    });
    const analysis = data?.choices?.[0]?.message?.content?.trim();
    if (!analysis) throw new Error('Groq não retornou análise válida');
    return analysis;
  }

  async summarizeWithGroq(transcript, instructions) {
    const prompt = instructions?.trim() ? instructions.trim().slice(0, 5000) : DEFAULT_SUMMARY_INSTRUCTIONS;
    const data = await this.callGroq('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.groqChatModel,
        temperature: 0.2,
        max_completion_tokens: 900,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Conversa para análise:\n\n${transcript}` }
        ]
      })
    });
    const result = data?.choices?.[0]?.message?.content;
    if (!result) throw new Error('Groq não retornou resumo válido');
    return result;
  }

  async summarizeWithOllama(transcript, instructions) {
    const baseUrl = (this.config.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const prompt = instructions?.trim() ? instructions.trim().slice(0, 5000) : DEFAULT_SUMMARY_INSTRUCTIONS;
    let response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.ollamaChatModel,
          stream: false,
          think: false,
          keep_alive: this.config.ollamaKeepAlive || '0',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: `Conversa para análise:\n\n${transcript}` }
          ],
          options: { temperature: 0.2, num_ctx: 4096, num_predict: 1200 }
        })
      });
    } catch {
      throw new Error(`Não foi possível conectar ao Ollama em ${baseUrl}. Verifique se o Ollama está rodando: ollama serve`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Ollama HTTP ${response.status}`);
    const result = data?.message?.content?.trim();
    if (!result) throw new Error('Ollama não retornou resumo válido');
    return result;
  }

  async summarize(transcript, instructions, provider) {
    const p = provider === 'ollama' ? 'ollama' : 'groq';
    if (p === 'ollama') return this.summarizeWithOllama(transcript, instructions);
    return this.summarizeWithGroq(transcript, instructions);
  }
}

if (typeof self !== 'undefined') self.AIClient = AIClient;
if (typeof window !== 'undefined') window.AIClient = AIClient;
