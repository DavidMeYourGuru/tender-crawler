/**
 * LLM-Client für die Förderprogramm-Extraktion und den Förder-Chat.
 *
 * Nutzt den OpenAI-kompatiblen Chat-Completions-Endpunkt (funktioniert mit
 * DeepSeek API, vLLM, LM Studio u. a.) sowie Ollama nativ.
 *
 * LLM ist für Extraktion und Chat erforderlich: Ohne konfiguriertes Backend
 * (LLM_ENABLED=true bzw. FUNDING_LLM_ENABLED=true und API-Zugang) wirft
 * `callLlmJson` einen Fehler; es gibt keinen stillen deterministischen Fallback.
 */
import config from '../config.js';
import { sleep } from '../utils.js';
import https from 'node:https';
import http from 'node:http';

// HTTP/1.1 mit Keep-Alive erzwingen – DeepSeek/CDN resettet HTTP/2-Verbindungen.
const AGENTS = {
  http: new http.Agent({ keepAlive: true, maxSockets: 10 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 10 }),
};

const TIMEOUT_MS = 180000;
const MAX_ATTEMPTS = 2;

/**
 * JSON-Antwort mit einer einzelnen User-Prompt.
 * @param {string} prompt
 * @param {{ temperature?: number, timeoutMs?: number }} [opts]
 */
export async function callLlmJson(prompt, { temperature = 0.1, timeoutMs = TIMEOUT_MS } = {}) {
  const parsed = await callLlmJsonMessages(
    [{ role: 'user', content: String(prompt) }],
    { temperature, timeoutMs }
  );
  return parsed;
}

/**
 * JSON-Antwort mit vollen Nachrichten (system/user/assistant).
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ temperature?: number, timeoutMs?: number }} [opts]
 */
export async function callLlmJsonMessages(messages, { temperature = 0.1, timeoutMs = TIMEOUT_MS } = {}) {
  if (!config.llmEnabled && !config.fundingLlmEnabled) {
    throw new Error('LLM ist deaktiviert (LLM_ENABLED und FUNDING_LLM_ENABLED sind beide false).');
  }
  const responseText = await callLlm(messages, { temperature, timeoutMs });
  const parsed = parseJsonResponse(responseText);
  if (parsed == null) {
    throw new Error('LLM-Antwort enthält kein gültiges JSON');
  }
  return parsed;
}

/**
 * Ruft das LLM auf, mit Retry bei Netzwerkfehlern und HTTP 429
 * (Exponential Backoff 2s/4s/8s).
 */
async function callLlm(messages, { temperature, timeoutMs }) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const text = config.llmProvider === 'ollama'
        ? await callOllama(messages, temperature, timeoutMs)
        : await callOpenAiCompatible(messages, temperature, timeoutMs);
      return text;
    } catch (error) {
      const status = error?.response?.status;
      const isRateLimited = status === 429;
      const isServerError = status != null && status >= 500;
      const isConnectReset = !error?.response;
      // Nur Wiederholung bei Rate-Limit oder Serverfehler; Verbindungsabbruch scheitert sofort.
      if (attempt >= MAX_ATTEMPTS || isConnectReset || (!isRateLimited && !isServerError)) {
        throw error;
      }
      const backoffMs = 1000 * (2 ** (attempt - 1)); // 1s, 2s
      console.warn(`[llm] Versuch ${attempt} fehlgeschlagen (HTTP ${status || '000'}), erneuter Versuch in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
}

async function callOllama(messages, temperature, timeoutMs) {
  const { default: axios } = await import('axios');
  const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  const response = await axios.post(
    `${config.llmOllamaUrl}/api/generate`,
    {
      model: config.llmOllamaModel,
      prompt,
      stream: false,
      options: { temperature },
    },
    { timeout: timeoutMs, httpAgent: AGENTS.http, httpsAgent: AGENTS.https }
  );
  return response.data?.response ?? '';
}

async function callOpenAiCompatible(messages, temperature, timeoutMs) {
  const { default: axios } = await import('axios');
  const response = await axios.post(
    `${config.llmOpenAiBaseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      model: config.llmOpenAiModel,
      messages,
      temperature,
      ...(config.llmDisableThinking ? { thinking: { type: 'disabled' } } : {}),
      response_format: { type: 'json_object' },
    },
    {
      timeout: timeoutMs,
      httpAgent: AGENTS.http,
      httpsAgent: AGENTS.https,
      headers: {
        ...(config.llmOpenAiApiKey ? { Authorization: `Bearer ${config.llmOpenAiApiKey}` } : {}),
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data?.choices?.[0]?.message?.content ?? '';
}

function parseJsonResponse(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export default { callLlmJson, callLlmJsonMessages };
