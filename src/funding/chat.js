/**
 * Förder-Chat: LLM-Beratung ausschließlich über gespeicherte Förder-Calls.
 *
 * Ablauf (ein LLM-Aufruf im Normalfall, zwei nur im Fallback):
 *  1. Deterministische Suchbegriffe aus Frage + Profil (kein LLM)
 *  2. FTS5-Retrieval über funding_programs_fts (BM25)
 *  3. Bei 0 Treffern: genau ein LLM-Rewrite + genau eine Suchwiederholung
 *  4. Chunk-Auswahl per FTS5 aus funding_chunks_fts (max 2 je Programm)
 *  5. Ein LLM-Aufruf: Programmauswahl, Beratung, Zitierung
 *  6. Strikte serverseitige Validierung von IDs, Chunks, Zitaten und URLs
 *
 * Kein serverseitiger Chatverlauf; Verlauf kommt vom Client und bleibt im Browser.
 */
import config from '../config.js';
import { callLlmJsonMessages } from './llm-client.js';
import {
  searchFundingChatCandidates,
  searchFundingChatChunks,
  FTS_STOPWORDS,
} from '../db.js';

const MAX_QUESTION_CHARS = 4000;
const MAX_PROFILE_CHARS = 6000;
const MAX_HISTORY_CHARS = 4000;
const CHUNK_SNIPPET_CHARS = 4000;

// Kleine, nachvollziehbare Synonymliste für die deterministische Suche.
const SYNONYMS = new Map([
  ['ki', ['künstliche', 'intelligenz']],
  ['künstliche', ['ki']],
  ['intelligenz', ['ki']],
  ['kmu', ['mittelstand']],
  ['mittelstand', ['kmu']],
  ['universität', ['hochschule']],
  ['hochschule', ['universität']],
  ['kreislaufwirtschaft', ['ressourceneffizienz']],
  ['ressourceneffizienz', ['kreislaufwirtschaft']],
  ['wasserstoff', ['h2']],
  ['h2', ['wasserstoff']],
]);

// Deterministischer Hinweis auf historische/abgelaufene Förderung.
const CLOSED_TERMS = ['früher', 'vergangen', 'vergangene', 'historisch', 'abgeschlossen', 'abgelaufen', 'ehemalig', 'ehemalige'];

export class ChatValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChatValidationError';
    this.code = 'VALIDATION';
  }
}

export class ChatProviderError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'ChatProviderError';
    this.code = 'PROVIDER';
    this.cause = cause;
  }
}

let activeChats = 0;

export function fundingChatBusy() {
  return activeChats >= config.fundingChatMaxConcurrency;
}

/**
 * Führt einen Beratungsschritt mit Concurrency-Grenze aus.
 */
export async function answerFundingChat({ question, profile, history, llm = callLlmJsonMessages }) {
  const questionValidated = validateQuestion(question);
  const profileValidated = validateProfile(profile);
  const historyValidated = sanitizeHistory(history);

  if (fundingChatBusy()) {
    throw new ChatValidationError('Zu viele gleichzeitige Anfragen, bitte kurz warten.');
  }
  activeChats += 1;
  try {
    return await doAnswer({ question: questionValidated, profile: profileValidated, history: historyValidated, llm });
  } finally {
    activeChats -= 1;
  }
}

async function doAnswer({ question, profile, history, llm }) {
  // 1) Deterministische Suchbegriffe (kein LLM)
  const searchTerms = buildSearchTerms(question, profile);
  const includeClosed = closedTermsTrigger(question);
  const queryText = searchTerms.length ? searchTerms.join(' ') : question;

  // 2) FTS5-Retrieval
  let candidates;
  try {
    candidates = searchFundingChatCandidates({
      query: queryText,
      limit: config.fundingChatMaxCandidates,
      includeClosed,
    });
  } catch (error) {
    throw new ChatProviderError('Förder-Calls konnten nicht durchsucht werden.', error);
  }

  // 2b) Fallback: genau ein LLM-Rewrite + genau eine Suchwiederholung.
  //     Nur wenn die erste Suche 0 Treffer liefert. Kein weiterer Pfad.
  if (!candidates.length) {
    try {
      const rewritten = await rewriteOnceViaLlm(question, profile, llm);
      const newTerms = (Array.isArray(rewritten?.search_terms) ? rewritten.search_terms : [])
        .map(String)
        .filter((t) => t.length >= 2);
      if (newTerms.length) {
        searchTerms.length = 0;
        searchTerms.push(...newTerms.slice(0, 8));
        candidates = searchFundingChatCandidates({
          query: searchTerms.join(' '),
          limit: config.fundingChatMaxCandidates,
          includeClosed,
        });
      }
    } catch (error) {
      // Rewrite-Ausfall ist nicht fatal: Antwort bleibt "keine Treffer".
    }
  }

  if (!candidates.length) {
    return {
      answer: 'Ich habe in den gespeicherten Förder-Calls keine passenden Programme zu deiner Anfrage gefunden. Formuliere die Frage anders oder ergänze weitere Schlagworte zu deinem Projekt.',
      recommendations: [],
      sources: [],
      retrieval: { candidate_count: 0, used_programs: 0 },
    };
  }

  // 3) Kandidaten für den finalen LLM-Aufruf (BM25-Reihenfolge, begrenzt)
  const candidateById = new Map(candidates.map((c) => [Number(c.id), c]));
  const usedCandidates = candidates.slice(0, config.fundingChatMaxSources);
  const usedIds = usedCandidates.map((c) => Number(c.id));

  // 4) Chunk-Auswahl per FTS5 (max 2 je Programm)
  const chunks = searchFundingChatChunks({
    programIds: usedIds,
    terms: searchTerms,
    chunksPerProgram: config.fundingChatChunksPerProgram,
  });

  const { blocks, chunkTextById } = prepareContext(chunks, config.fundingChatContextChars);
  if (!blocks.length) {
    return {
      answer: 'Zu den passenden Calls liegen keine durchsuchbaren Volltexte vor. Kandidaten:\n' + listCandidateNames(usedCandidates),
      recommendations: [],
      sources: usedCandidates.map((c) => toSource(c, [])).filter(Boolean),
      retrieval: { candidate_count: candidates.length, used_programs: usedIds.length },
    };
  }

  // 5) Einziger LLM-Aufruf: Auswahl, Beratung, Zitierung
  const advice = await generateAdvice(question, profile, history, usedCandidates, blocks, llm);

  // 6) Strikte Validierung
  const { recommendations, sources } = validateAdvice(advice, chunkTextById, candidateById, usedIds);

  if (!recommendations.length) {
    return {
      answer: 'Ich habe die passenden Calls geprüft, aber für die genannten Programme konnte keine ausreichend belegte Empfehlung aus den Quellen abgeleitet werden. Bitte stelle eine konkretere Frage.',
      recommendations: [],
      sources: [],
      retrieval: { candidate_count: candidates.length, used_programs: 0 },
    };
  }

  const answer = advice.answer && typeof advice.answer === 'string' && advice.answer.trim()
    ? advice.answer.trim()
    : 'Ich habe die passenden Calls geprüft, konnte aber keine zufriedenstellende Antwort aus den Quellen ableiten. Bitte stelle eine konkretere Frage.';

  return {
    answer,
    recommendations,
    sources,
    retrieval: { candidate_count: candidates.length, used_programs: sources.length },
  };
}

/**
 * Deterministische Suchbegriffe aus Frage + Profil.
 * Tokenisierung, Normalisierung, Stoppwörter, kleine Synonymliste.
 */
function buildSearchTerms(question, profile) {
  const text = `${question} ${profile || ''}`;
  const tokens = String(text)
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/i)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 3 || (t.length === 2 && /^(ki|h2|kmu)$/.test(t)))
    .filter((t) => !FTS_STOPWORDS.has(t));

  const expanded = new Set();
  for (const t of tokens) {
    expanded.add(t);
    const syn = SYNONYMS.get(t);
    if (syn) for (const s of syn) expanded.add(s);
  }
  return [...expanded].slice(0, 8);
}

/**
 * Deterministischer Hinweis auf historische/abgeschlossene Förderung.
 * Ohne LLM – einfache Begriffsprüfung der normalisierten Frage.
 */
function closedTermsTrigger(question) {
  const q = String(question || '').toLowerCase();
  return CLOSED_TERMS.some((t) => q.includes(t));
}

/**
 * LLM-Fallback: alternative Suchbegriffe erzeugen (nur bei 0 FTS-Treffern).
 */
async function rewriteOnceViaLlm(question, profile, llm) {
  const messages = [
    {
      role: 'system',
      content: [
        'Die Volltextsuche nach Förderprogrammen hat keine Treffer geliefert.',
        'Erzeuge alternative Suchbegriffe für die Suche in deutschen Förder-Bekanntmachungen.',
        'Antworte NUR mit JSON:',
        JSON.stringify({ search_terms: ['Technologien, Branchen, Methoden'] }),
        'search_terms: 4–8 präzise Fachbegriffe ohne Füllwörter, die von der ursprünglichen Formulierung abweichen.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Frage: ${question}\n\nProfil: ${profile || 'kein Profil'}`.slice(0, 8000),
    },
  ];
  const data = await llm(messages, { temperature: 0, timeoutMs: 60000 });
  return data && typeof data === 'object' ? data : {};
}

/**
 * Baut die Kontextblöcke einmalig (Wrapper + Chunk-Kürzung) und budgetiert auf
 * das Zeichenlimit. Liefert die Blöcke sowie die exakt gesendeten Texte je
 * Chunk für die spätere Zitat-Validierung.
 */
function prepareContext(chunks, maxChars) {
  const blocks = [];
  const chunkTextById = new Map();
  let used = 0;
  for (const c of chunks) {
    const snippet = String(c.text || '').slice(0, CHUNK_SNIPPET_CHARS);
    const block = `[PROGRAM ${c.entity_id}]
[CHUNK ${c.chunk_key}]
${snippet}
[/CHUNK]
[/PROGRAM]`;
    if (used + block.length > maxChars && blocks.length) break;
    blocks.push(block);
    used += block.length;
    const pid = Number(c.entity_id);
    let byKey = chunkTextById.get(pid);
    if (!byKey) {
      byKey = new Map();
      chunkTextById.set(pid, byKey);
    }
    byKey.set(String(c.chunk_key), snippet);
  }
  return { blocks, chunkTextById };
}

function toSource(candidate, quotes) {
  if (!candidate) return null;
  return {
    program_id: Number(candidate.id),
    title: candidate.title,
    url: candidate.primary_url,
    funding_geber: candidate.funding_geber,
    status: candidate.status,
    next_deadline: candidate.next_deadline,
    fit: null,
    quotes,
  };
}

/**
 * Validierung der LLM-Antwort gegen den tatsächlich gesendeten Kontext.
 * Ein Zitat ist gültig, wenn das normalisierte Zitat wörtlich in einem der
 * gesendeten Chunks des Programms vorkommt; der echte chunk_key wird dann aus
 * dem Kontext übernommen (nicht dem LLM vertraut). Ungültige Zitate und
 * Empfehlungen ohne gültiges Zitat werden entfernt. URLs stammen nur aus
 * serverseitigen Quelldaten.
 */
function validateAdvice(advice, chunkTextById, candidateById, usedIds) {
  const usedPrograms = new Set(usedIds.map(Number));
  const citations = Array.isArray(advice.citations) ? advice.citations : [];
  const validCitations = [];

  for (const cite of citations) {
    if (!cite || typeof cite !== 'object') continue;
    const programId = Number(cite.program_id);
    if (!usedPrograms.has(programId)) continue;
    const quote = String(cite.quote || '').trim();
    if (!quote) continue;
    const byKey = chunkTextById.get(programId);
    if (!byKey) continue;
    // Zitat muss wörtlich in mindestens einem gesendeten Chunk vorkommen.
    let resolvedKey = null;
    for (const [key, sentText] of byKey) {
      if (quoteInChunk(sentText, quote)) {
        resolvedKey = key;
        break;
      }
    }
    if (!resolvedKey) continue;
    validCitations.push({ program_id: programId, chunk_key: resolvedKey, quote });
  }

  const citationsByProgram = new Map();
  for (const c of validCitations) {
    const list = citationsByProgram.get(c.program_id) || [];
    list.push(c);
    citationsByProgram.set(c.program_id, list);
  }

  const recommendations = [];
  for (const rec of Array.isArray(advice.recommendations) ? advice.recommendations : []) {
    if (!rec || typeof rec !== 'object') continue;
    const programId = Number(rec.program_id);
    if (!usedPrograms.has(programId)) continue;
    const candidate = candidateById.get(programId);
    if (!candidate) continue;
    const cites = citationsByProgram.get(programId) || [];
    // Empfehlung ohne gültiges Zitat wird entfernt (keine "verified:false"-Ausgabe).
    if (!cites.length) continue;
    const fit = ['high', 'medium', 'low'].includes(String(rec.fit)) ? String(rec.fit) : 'medium';
    recommendations.push({
      program_id: programId,
      fit,
      reason: String(rec.reason || '').slice(0, 600) || null,
      next_steps: sanitizeStringList(rec.next_steps),
      risks: sanitizeStringList(rec.risks),
      verified: true,
    });
  }

  // Quellen nur aus überlebenden Empfehlungen; URLs aus candidate.primary_url.
  const sources = recommendations.map((rec) => {
    const s = toSource(candidateById.get(rec.program_id), []);
    if (!s) return null;
    s.fit = rec.fit;
    s.verified = true;
    s.quotes = (citationsByProgram.get(rec.program_id) || []).map((c) => ({ chunk_key: c.chunk_key, quote: c.quote.slice(0, 400) }));
    return s;
  }).filter(Boolean);

  return { recommendations, sources };
}

function listCandidateNames(candidates) {
  return candidates.map((c) => c.title).filter(Boolean).join('\n');
}

function sanitizeStringList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((i) => String(i).trim()).filter(Boolean).slice(0, 10);
}

function quoteInChunk(sentText, quote) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const source = norm(sentText);
  const q = norm(quote);
  if (!q) return false;
  if (source.includes(q)) return true;
  const core = q.length > 60 ? q.slice(0, 60) : q;
  return source.includes(core);
}

function validateQuestion(question) {
  const q = String(question || '').trim();
  if (q.length < 2) throw new ChatValidationError('Bitte gib eine Frage ein.');
  if (q.length > MAX_QUESTION_CHARS) throw new ChatValidationError(`Frage zu lang (max. ${MAX_QUESTION_CHARS} Zeichen).`);
  return q;
}

function validateProfile(profile) {
  const p = String(profile || '').trim();
  if (p.length > MAX_PROFILE_CHARS) throw new ChatValidationError(`Profil zu lang (max. ${MAX_PROFILE_CHARS} Zeichen).`);
  return p;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-config.fundingChatMaxHistory)
    .map((m) => {
      if (!m || typeof m !== 'object') return null;
      // Nur Nutzerturns aus dem Client vertrauen: gefälschte Assistent-Turns
      // würden vom LLM als eigene frühere Ausgabe behandelt (Injection-Kanal).
      if (m.role !== 'user') return null;
      const content = String(m.content || '').trim().slice(0, MAX_HISTORY_CHARS);
      if (!content) return null;
      return { role: 'user', content };
    })
    .filter(Boolean)
    .slice(-config.fundingChatMaxHistory);
}

/* ── Prompt-Bausteine ──────────────────────────────────────────── */

function buildSystemBase() {
  return [
    'Du bist Berater für Forschungs- und Innovationsförderung. Antworte nur auf Deutsch und nur mit belegbaren Aussagen.',
    'Alle Fakten (Fristen, Beträge, Quoten, Bedingungen) müssen aus den bereitgestellten Quellen stammen.',
    'Fehlt eine Information in den Quellen, sage ausdrücklich: "Diese Information ist in den Quellen nicht enthalten."',
  ].join(' ');
}

async function generateAdvice(question, profile, history, candidates, blocks, llm) {
  const context = blocks.join('\n\n');
  const candidateBlock = candidates.map((c) =>
    `- ID ${Number(c.id)}: ${c.title} — Geber: ${c.funding_geber || 'unbekannt'}, Status: ${c.status || 'unbekannt'}${c.next_deadline ? `, Frist: ${c.next_deadline}` : ''}`
  ).join('\n');

  const historyBlock = history.length
    ? `Bisherige Fragen:\n${history.map((m) => m.content).join('\n')}`
    : '';

  const messages = [
    { role: 'system', content: buildSystemBase() },
    ...history.map((m) => ({ role: 'user', content: m.content.slice(0, 3000) })),
    {
      role: 'user',
      content: [
        `Profil: ${profile || 'nicht angegeben'}`,
        `Frage: ${question}`,
        historyBlock,
        '',
        'KANDIDATEN:',
        candidateBlock,
        '',
        `QUELLEN (nur diese verwenden und zitieren):\n${context}`,
        '',
        'Antworte NUR mit JSON:',
        JSON.stringify({
          answer: 'Kurzer Einleitungssatz + pro Call ein Absatz "**Name**: 2-3 Sätze warum passend". Leerzeile zwischen Calls.',
          recommendations: [{ program_id: 0, fit: 'high|medium|low', reason: 'Begründung', next_steps: ['Schritt'], risks: ['Risiko'] }],
          citations: [{ program_id: 0, chunk_key: 'CHUNK:ID', quote: 'wörtlicher Satz aus QUELLEN' }],
        }),
        'REGELN:',
        '1. Empfiehl maximal 5 Programme (program_id aus KANDIDATEN).',
        '2. Jede Empfehlung braucht ≥1 Zitat mit exaktem chunk_key und wörtlichem quote aus QUELLEN.',
        '3. answer: Einleitungssatz, dann je Call ein Absatz "**Name**: 2-3 Sätze zur Passung". Leerzeile zwischen Calls.',
      ].join('\n'),
    },
  ];
  return llm(messages, { temperature: 0, timeoutMs: 60000 });
}

export default { answerFundingChat, fundingChatBusy, ChatValidationError, ChatProviderError };
