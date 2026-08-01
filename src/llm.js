import config from './config.js';
import {
  getTendersForLlmAnalysis,
  updateLlmAnalysis,
  logLlmAnalysis,
  countLlmAnalysesToday,
} from './db.js';
import { sleep, truncate } from './utils.js';
import https from 'node:https';
import http from 'node:http';

// HTTP/1.1 mit Keep-Alive – DeepSeek/CDN resettet HTTP/2-Verbindungen.
const AGENTS = {
  http: new http.Agent({ keepAlive: true, maxSockets: 10 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 10 }),
};

/**
 * LLM-Analyse für Ausschreibungen.
 *
 * Unterstützte Provider:
 *  - ollama  (lokal, http://localhost:11434)
 *  - openai  (OpenAI-kompatibel, z. B. auch vLLM/LM Studio über Base-URL)
 *  - custom  (wie openai, aber komplett über LLM_OPENAI_BASE_URL gesteuert)
 */

let activeAnalysis = null;

export function getAnalysisStatus() {
  return {
    running: activeAnalysis != null,
    maxPerDay: config.llmMaxAnalysesPerDay,
    usedToday: countLlmAnalysesToday(),
    enabled: config.tenderLlmEnabled,
    provider: config.llmProvider,
    model: config.llmProvider === 'ollama' ? config.llmOllamaModel : config.llmOpenAiModel,
  };
}

/**
 * Startet die Analyse neuer Tender (Batch). Lässt sich nicht doppelt starten.
 * @returns {Promise<{analyzed: number, skipped: number}>}
 */
export async function runAnalysis({ limit = null } = {}) {
  if (!config.tenderLlmEnabled) {
    throw new Error('Ausschreibungs-LLM-Analyse ist deaktiviert (TENDER_LLM_ENABLED=false). Ausschreibungen werden nie per LLM analysiert.');
  }
  if (activeAnalysis) return activeAnalysis;

  activeAnalysis = doAnalysis({ limit }).finally(() => {
    activeAnalysis = null;
  });
  return activeAnalysis;
}

async function doAnalysis({ limit }) {
  const batchSize = limit || config.llmBatchSize;
  const todayQuota = config.llmMaxAnalysesPerDay;
  let analyzed = 0;
  let skipped = 0;

  while (true) {
    const usedToday = countLlmAnalysesToday();
    if (usedToday >= todayQuota) {
      console.log(`[llm] Tageslimit erreicht (${usedToday}/${todayQuota}).`);
      break;
    }

    const remaining = todayQuota - usedToday;
    const candidates = getTendersForLlmAnalysis(Math.min(batchSize, remaining));
    if (!candidates.length) break;

    for (const tender of candidates) {
      const used = countLlmAnalysesToday();
      if (used >= todayQuota) {
        console.log(`[llm] Tageslimit erreicht (${used}/${todayQuota}).`);
        break;
      }

      try {
        const result = await analyzeTender(tender);
        const now = new Date().toISOString();
        updateLlmAnalysis({
          tenderId: tender.id,
          summary: result.summary,
          relevanceScore: result.relevanceScore,
          relevanceReason: result.relevanceReason,
          requirements: result.requirements,
          model: result.model,
          now,
        });
        logLlmAnalysis({
          tenderId: tender.id,
          provider: config.llmProvider,
          model: result.model,
          inputChars: result.inputChars,
          outputChars: result.outputChars,
          success: true,
          errorMessage: null,
          now,
        });
        analyzed += 1;
        console.log(`[llm] #${tender.id} analysiert (Score ${result.relevanceScore?.toFixed(2) ?? 'n/a'})`);
      } catch (error) {
        const now = new Date().toISOString();
        logLlmAnalysis({
          tenderId: tender.id,
          provider: config.llmProvider,
          model: config.llmProvider === 'ollama' ? config.llmOllamaModel : config.llmOpenAiModel,
          inputChars: 0,
          outputChars: 0,
          success: false,
          errorMessage: error.message,
          now,
        });
        skipped += 1;
        console.error(`[llm] Analyse von #${tender.id} fehlgeschlagen:`, error.message);
      }

      await sleep(500);
    }

    // Nächste Runde nur starten, wenn noch Tender ausstehen und Quota reicht
    const pending = getTendersForLlmAnalysis(1);
    if (!pending.length) break;
  }

  return { analyzed, skipped };
}

/**
 * Analysiert einen einzelnen Tender per LLM.
 * @returns {Promise<{summary, relevanceScore, relevanceReason, requirements, model, inputChars, outputChars}>}
 */
export async function analyzeTender(tender, overrideProfile = null) {
  if (!config.tenderLlmEnabled) {
    throw new Error('Ausschreibungs-LLM-Analyse ist deaktiviert (TENDER_LLM_ENABLED=false).');
  }

  const researchProfile = overrideProfile || config.llmResearchProfile;
  const prompt = buildPrompt(tender, researchProfile);

  let responseText;
  if (config.llmProvider === 'ollama') {
    responseText = await callOllama(prompt);
  } else {
    responseText = await callOpenAiCompatible(prompt);
  }

  const parsed = parseLlmResponse(responseText);
  const inputChars = prompt.length;
  const outputChars = responseText.length;

  return {
    ...parsed,
    model: config.llmProvider === 'ollama' ? config.llmOllamaModel : config.llmOpenAiModel,
    inputChars,
    outputChars,
  };
}

function buildPrompt(tender, researchProfile) {
  const cpv = tender.cpv_labels || tender.cpv_codes || '';
  return [
    'Du bist ein wissenschaftlicher Recherche-Scout. Bewerte die folgende öffentliche Ausschreibung',
    `anhand des Forschungsprofils. Antworte AUSSCHLIESSLICH mit validem JSON – keine Einleitung, kein Markdown.`,
    '',
    `Forschungsprofil: ${researchProfile}`,
    '',
    '--- Ausschreibung ---',
    `Titel: ${tender.title || 'n/a'}`,
    `Beschreibung: ${truncate(tender.description || 'n/a', 4000)}`,
    `Auftraggeber: ${tender.contracting_authority || 'n/a'}`,
    `CPV: ${cpv || 'n/a'}`,
    `Frist: ${tender.submission_deadline || 'n/a'}`,
    `Wert: ${tender.estimated_value_cents != null ? `${(tender.estimated_value_cents / 100).toLocaleString('de-DE')} ${tender.estimated_value_currency || 'EUR'}` : 'n/a'}`,
    `Leistungsort: ${tender.place_of_performance || 'n/a'}`,
    '',
    '--- Antwortformat ---',
    JSON.stringify({
      summary: 'Kurzusammenfassung der Ausschreibung in 2-3 Sätzen (deutsch).',
      relevance_score: 'Zahl von 0.0 (völlig irrelevant) bis 1.0 (perfekte Übereinstimmung mit dem Forschungsprofil)',
      relevance_reason: 'Kurze Begründung der Bewertung (deutsch).',
      requirements: ['Liste der wichtigsten formalen/inhaltlichen Anforderungen (deutsch)', '...'],
    }, null, 2),
  ].join('\n');
}

async function callOllama(prompt) {
  const url = `${config.llmOllamaUrl}/api/generate`;
  const { default: axios } = await import('axios');
  const response = await axios.post(
    url,
    {
      model: config.llmOllamaModel,
      prompt,
      stream: false,
      options: { temperature: 0.2 },
    },
    { timeout: 120000, httpAgent: AGENTS.http, httpsAgent: AGENTS.https }
  );
  return response.data?.response ?? '';
}

async function callOpenAiCompatible(prompt) {
  const { default: axios } = await import('axios');
  const url = `${config.llmOpenAiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await axios.post(
    url,
    {
      model: config.llmOpenAiModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      ...(config.llmDisableThinking ? { thinking: { type: 'disabled' } } : {}),
      response_format: { type: 'json_object' },
    },
    {
      timeout: 120000,
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

/**
 * Parst die LLM-Antwort robust zu einem strukturierten Ergebnis.
 */
export function parseLlmResponse(text) {
  if (!text) {
    throw new Error('Leere LLM-Antwort');
  }

  let cleaned = String(text).trim();
  // Markdown-Code-Block entfernen
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Falls das JSON in geschweiften Klammern eingebettet ist, extrahieren
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    // Fallback: key/value-Zeilen parsen
    data = parseLooseLines(cleaned);
  }

  const relevanceScore = clampScore(Number.parseFloat(data.relevance_score ?? data.relevanceScore));
  const requirements = Array.isArray(data.requirements)
    ? data.requirements.map(String).filter(Boolean).slice(0, 20)
    : typeof data.requirements === 'string'
      ? data.requirements.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20)
      : [];

  return {
    summary: String(data.summary ?? '').trim() || null,
    relevanceScore,
    relevanceReason: String(data.relevance_reason ?? data.relevanceReason ?? '').trim() || null,
    requirements,
  };
}

function clampScore(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

/**
 * Sehr toleranter Fallback-Parser für nicht-JSON-Antworten.
 */
function parseLooseLines(text) {
  const result = { summary: '', relevance_score: null, relevance_reason: '', requirements: [] };
  for (const line of text.split('\n')) {
    const match = line.match(/^([^:]{1,30}):\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key.includes('zusammenfassung') || key.includes('summary')) result.summary = value;
    else if (key.includes('relevanz') || key.includes('score')) result.relevance_score = value;
    else if (key.includes('begründung') || key.includes('reason')) result.relevance_reason = value;
    else if (key.includes('anforderung') || key.includes('requirement')) result.requirements = value.split(';').map((s) => s.trim());
  }
  return result;
}

export default { runAnalysis, analyzeTender, getAnalysisStatus };

// Hinweis: getTendersForLlmAnalysis wird über db importiert und oben genutzt.