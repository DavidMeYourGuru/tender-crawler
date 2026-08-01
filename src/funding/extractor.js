/**
 * Förderprogramm-Extraktion mit LLM als primärer Extraktions-Engine.
 *
 * Phase 1 – Deterministische Pre-Extraction:
 *   Hard-Fakten (Fristen, Beträge, Quoten, Links, Fördergeber) werden aus dem
 *   kombinierten Quelltext (HTML-Detailseite + verlinkte PDFs) extrahiert und
 *   als strukturierte Hinweise ("hints") an das LLM übergeben.
 *
 * Phase 2 – LLM-Primärextraktion (immer erforderlich):
 *   Das LLM extrahiert alle fachlichen Felder (Titel, Call, Kurzbeschreibung,
 *   Fördergegenstand, Projektformen, Antragsberechtigte, Voraussetzungen).
 *   Jede LLM-Angabe wird serverseitig gegen den Quelltext validiert. Nicht
 *   belegbare Werte werden trotzdem gespeichert, aber als needs_review markiert.
 *
 * Merge: Fristen/Links/Fördergeber kommen aus der deterministischen Phase
 * (Präzision), freie Textfelder und Projektformen aus dem LLM. Deterministisch
 * erkannte Zahlenwerte ergänzen fehlende LLM-Projektform-Felder.
 *
 * Ohne verfügbares LLM schlägt die Extraktion fehl (kein Fallback).
 */

import * as parser from './parser.js';
import * as cheerio from 'cheerio';
import { contentHash } from '../utils.js';
import config from '../config.js';
import { callLlmJson } from './llm-client.js';

const LLM_MAX_TEXT_CHARS = 40000;
const LLM_KEEP_START = 30000;
const LLM_KEEP_END = 5000;

/**
 * Prüft, ob ein Zitat (normalisiert) im Quelltext vorkommt.
 */
export function quoteInText(text, quote) {
  if (!quote) return false;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const source = norm(text || '');
  const q = norm(quote);
  if (!q) return false;
  if (source.includes(q)) return true;
  const core = q.length > 40 ? q : null;
  return core ? source.includes(core) : false;
}

function allText(docs) {
  return docs.map((d) => d.text || '').join('\n');
}

const PROJECT_TYPE_HINTS = [
  'Entwicklungsprojekte',
  'Machbarkeitsprojekte',
  'Marktreifeprojekte',
  'Metavorhaben',
  'Innovationsprojekte',
  'Verbundprojekte',
  'Einzelvorhaben',
  'Forschungsvorhaben',
  'Pilotprojekte',
  'Demonstrationsvorhaben',
  'Transferprojekte',
  'Vernetzungsprojekte',
  'Begleitforschung',
  'Nachwuchsgruppen',
  'Graduiertenkollegs',
  'Kompetenzzentren',
  'Reallabore',
  'Modellprojekte',
  'Erprobungsvorhaben',
  'Umsetzungsprojekte',
  'Strategieprojekte',
  'Sondierungsprojekte',
];

/**
 * Deterministische Extraktion über alle Dokumente.
 * Liefert strukturierte Fakten plus Kandidaten-Scans für die LLM-Hinweise.
 */
function deterministicExtraction(docs) {
  const all = allText(docs);
  const result = {
    deadlines: [],
    projectTypes: [],
    links: [],
    fundingGeber: null,
    fundingGegenstand: null,
    eligibility: [],
    evidence: [],
    seen: new Set(),
  };

  // Fördergeber erkennen
  const geberMatch = all.match(/(?:Fördergeber|Zuwendungsgeber|Förderinstitution|Ministerium)\s*:\s*([^\n|]{5,140})/i)
    || all.match(/(Fördergeber|Zuwendungsgeber)\s*[:\-–]\s*([^\n]{5,140})/i);
  if (geberMatch) {
    const value = (geberMatch[2] || geberMatch[1]).trim();
    if (value.length <= 140) {
      result.fundingGeber = value;
      result.evidence.push({
        entity: 'program', field: 'funding_geber', sourceUrl: docs[0]?.url, quote: geberMatch[0].trim(), method: 'parser', confidence: 0.95,
      });
    }
  }

  // Fördergegenstand: Abschnitt bis zum nächsten Abschnittskopf
  const gegenstand = extractSectionUntil(all, /Fördergegenstand\s*:/, /(?:Modul\s*\d|Laufzeit|Fördersumme|Deadline|Förderquote|Antragsberechtigte|Zuwendungsvoraussetzung|Besondere Zuwendungs|Link)/i);
  if (gegenstand && gegenstand.length >= 40) {
    result.fundingGegenstand = clean(gegenstand);
    result.evidence.push({
      entity: 'program', field: 'funding_gegenstand', sourceUrl: docs[0]?.url, quote: clean(gegenstand).slice(0, 300), method: 'parser', confidence: 0.6,
    });
  }

  // Antragsberechtigte / Zuwendungsvoraussetzungen als Listeneinträge
  const eligStart = all.match(/(?:Besondere\s+)?(?:Antragsberechtigt|Zuwendungsvoraussetzung)/i);
  if (eligStart) {
    const from = eligStart.index;
    const rest = all.slice(from);
    const stop = rest.match(/(?:Förderquote|Fördergegenstand|Link|Deadline|Fördersumme|Laufzeit|Modul\s*\d)/i);
    const section = clean(stop ? rest.slice(0, stop.index) : rest);
    if (section.length >= 20) {
      const bullets = section.split(/(?<=[.!?])\s+/).map((b) => clean(b)).filter((b) => b.length >= 15);
      for (const bullet of bullets.slice(0, 20)) {
        result.eligibility.push({ kind: 'requirement', text: bullet, sort: result.eligibility.length });
        result.evidence.push({
          entity: 'eligibility', field: 'requirement', sourceUrl: docs[0]?.url, quote: bullet.slice(0, 300), method: 'parser', confidence: 0.6,
        });
      }
    }
  }

  // Fristen
  for (const line of all.split('\n')) {
    const parsed = parser.parseDeadline(line);
    if (!parsed) continue;
    const key = `${parsed.deadlineAt || 'ongoing'}`;
    if (result.seen.has(key)) continue;
    result.seen.add(key);
    result.deadlines.push({
      label: 'Antragsfrist',
      deadlineAt: parsed.deadlineAt,
      isOngoing: parsed.isOngoing,
      timezone: parsed.timezone,
      quote: parsed.quote || line.trim(),
    });
    result.evidence.push({
      entity: 'deadline', field: 'deadline_at', sourceUrl: docs[0]?.url, quote: parsed.quote || line.trim(), method: 'parser', confidence: 0.95,
    });
  }

  // Links
  for (const doc of docs) {
    if (!doc.html) continue;
    let $;
    try {
      $ = cheerio.load(doc.html);
    } catch {
      continue;
    }
    for (const link of parser.extractLinksFromHtml($, doc.url)) {
      if (!result.links.some((l) => l.url === link.url)) result.links.push(link);
    }
  }

  // Kandidaten-Scans für LLM-Hinweise
  const candidateDates = new Map();
  const candidateAmounts = [];
  const candidateQuotes = [];
  for (const line of all.split('\n')) {
    const dl = parser.parseDeadline(line);
    if (dl?.deadlineAt && !candidateDates.has(dl.deadlineAt)) {
      candidateDates.set(dl.deadlineAt, dl.quote || line.trim());
    }
    for (const amount of parser.parseAllEuroAmounts(line)) candidateAmounts.push(amount);
    const quote = parser.parseFundingQuote(line);
    if (quote) candidateQuotes.push(quote);
  }

  result.hints = {
    candidateDates: [...candidateDates.entries()].map(([date, quote]) => ({ date, quote })),
    candidateAmounts: candidateAmounts.map((a) => a.cents),
    candidateQuotes: candidateQuotes.map((q) => q.min),
    detectedProjectTypes: PROJECT_TYPE_HINTS.filter((hint) => {
      const singular = hint.endsWith('e') ? hint.slice(0, -1) : hint;
      return all.includes(hint) || all.includes(singular);
    }),
  };

  return result;
}

/**
 * Erkennt eine Projektform in einem Segment, tolerant gegenüber
 * Singular/Plural (Entwicklungsprojekt ↔ Entwicklungsprojekte).
 */
function matchProjectTypeHint(seg) {
  for (const hint of PROJECT_TYPE_HINTS) {
    const singular = hint.endsWith('e') ? hint.slice(0, -1) : hint;
    if (seg.includes(hint) || seg.includes(singular)) return hint;
  }
  return null;
}

/**
 * Haupt-Einstiegspunkt: extrahiert ein normiertes Programm aus Dokumenten.
 * @param {Array<{url,title,page,text,html}>} docs
 * @param {{llmCaller?: Function, base?: object}} [opts]
 *   base enthält bekannte Felder (title, publicationDate, primaryUrl,
 *   submissionDeadline) aus der Fundstelle. llmCaller ist für Tests injizierbar.
 */
export async function extractFundingProgram(docs, { llmCaller = callLlmJson, base = null } = {}) {
  const deterministic = deterministicExtraction(docs);
  const fullText = allText(docs).trim();
  const llmPart = await extractWithLlm(docs, deterministic.hints, fullText, { llmCaller });

  // Projektformen: LLM liefert die Liste; deterministische Zahlenwerte ergänzen
  const projectTypes = mergeProjectTypes(deterministic, llmPart, docs);

  const fundingGeber = deterministic.fundingGeber || llmPart.fundingGeber || null;
  const fundingGeberShort = fundingGeber ? fundingGeber.match(/\(([A-Z]{2,10})\)/)?.slice(1)[0] || null : null;

  // Maßgebliche Frist: der präzise Stichtag der Liste (Teaser) gewinnt;
  // andernfalls deterministische Fristen, sonst LLM-Fristen.
  // Fristen: primär vom LLM (unterscheidet eine Frist / mehrere Fristen /
  // laufend mit oder ohne Frist). Der Teaser-Stichtag der Liste ist die
  // autoritative Ergänzung, falls das LLM ihn nicht erfasst hat.
  const baseDeadline = base?.submissionDeadline || null;
  const hasBaseDeadline = Boolean(baseDeadline);

  let deadlines = (llmPart.deadlines || []).map((d) => ({
    label: d.label || 'Antragsfrist',
    deadlineAt: d.deadlineAt,
    isOngoing: d.isOngoing,
    timezone: 'Europe/Berlin',
    quote: d.quote || d.deadlineAt || 'laufend',
  }));

  // Fallback: ohne LLM-Fristen (z. B. LLM-Ausfall) deterministische nutzen
  if (!deadlines.length && deterministic.deadlines.length) {
    deadlines = deterministic.deadlines.map((d) => ({
      label: d.label || 'Antragsfrist',
      deadlineAt: d.deadlineAt,
      isOngoing: d.isOngoing,
      timezone: 'Europe/Berlin',
      quote: d.quote || d.deadlineAt || 'laufend',
    }));
  }

  // Teaser-Stichtag (autoritative Liste) ergänzen, falls fehlend.
  // Bei kind='none' (LLM: keine Frist im Dokument) wird der Teaser-Stichtag
  // NICHT erzwungen – das wäre sonst ein Veröffentlichungsdatum ohne echte Frist.
  const llmSawNoDeadline = llmPart.deadlineKind === 'none';
  if (hasBaseDeadline && !llmSawNoDeadline && !deadlines.some((d) => d.deadlineAt === baseDeadline && !d.isOngoing)) {
    deadlines.unshift({
      label: 'Antragsfrist',
      deadlineAt: baseDeadline,
      isOngoing: false,
      timezone: 'Europe/Berlin',
      quote: baseDeadline,
    });
    deterministic.evidence.push({
      entity: 'deadline', field: 'deadline_at', sourceUrl: docs[0]?.url,
      quote: baseDeadline, method: 'parser', confidence: 0.98,
    });
  }

  // Sicherheitsfilter: LLM-Fristen nur übernehmen, wenn der Belegsatz Frist-
  // Kontext enthält (sonst sind es Veröffentlichungs-/Änderungsdaten).
  // Ausnahme: der Teaser-Stichtag (baseDeadline) wird immer behalten.
  const deadlineContextRe = /frist|bis zum|bis\s|einreichung|antrag|deadline|termin|befristung|laufzeit\s+bis|spätestens|ausschlussfrist|endet|einzureichen/i;
  deadlines = deadlines.filter((d) => {
    if (d.isOngoing || !d.deadlineAt) return true;
    if (d.deadlineAt === baseDeadline) return true;
    return deadlineContextRe.test(d.quote || '');
  });

  // Historische Referenzdaten (ältere Bekanntmachungen im Text) entfernen
  if (hasBaseDeadline) {
    const baseMs = new Date(`${baseDeadline}T00:00:00`).getTime();
    const yearMs = 365 * 86400000;
    deadlines = deadlines.filter((d) => {
      if (d.isOngoing || !d.deadlineAt) return true;
      const t = new Date(`${d.deadlineAt}T00:00:00`).getTime();
      if (Number.isNaN(t)) return true;
      return t >= baseMs - 2 * yearMs && t <= baseMs + 3 * yearMs;
    });
  }

  // Friststatus ableiten (berücksichtigt laufende Förderung)
  const status = deriveFundingStatus(deadlines);

  const needsReview = llmPart.needsReview > 0;

  const program = {
    title: llmPart.title || base?.title || null,
    currentCall: llmPart.currentCall || null,
    shortDescription: llmPart.shortDescription || null,
    fundingGegenstand: llmPart.fundingGegenstand || deterministic.fundingGegenstand || null,
    fundingGeber,
    fundingGeberShort,
    status,
    reviewStatus: needsReview ? 'needs_review' : 'unreviewed',
    publicationDate: base?.publicationDate ?? null,
    primaryUrl: base?.primaryUrl ?? null,
    sourceText: fullText,
    deadlines,
    projectTypes,
    eligibility: [...deterministic.eligibility, ...llmPart.eligibility],
    links: mergeFundingLinks(deterministic.links, docs),
    evidence: [...deterministic.evidence, ...(llmPart.evidence || [])],
    needsReview,
  };

  // content_hash über die belegten Kerninhalte UND den vollständigen
  // Call-Text (HTML + PDFs) – Änderungen erzeugen neue Versionen.
  program.contentHash = contentHash(
    program.title,
    program.fundingGeber,
    program.fundingGegenstand,
    program.sourceText,
    JSON.stringify(program.projectTypes.map((p) => [p.name, p.durationMinMonths, p.durationMaxMonths, p.amountMinCents, p.amountMaxCents, p.fundingQuoteMin, p.fundingQuoteMax])),
    JSON.stringify(program.deadlines.map((d) => d.deadlineAt)),
    program.status
  );

  return program;
}

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Ergänzt deterministische Links um die URLs direkt verlinkter PDFs
 * (Bekanntmachung/Anhang) als Dokument-Links – dedupliziert nach URL.
 */
function mergeFundingLinks(links, docs) {
  const out = (links || []).slice();
  const seen = new Set(out.map((l) => l.url));
  for (const d of docs || []) {
    if (!d?.pdfUrl) continue;
    if (seen.has(d.pdfUrl)) continue;
    seen.add(d.pdfUrl);
    out.push({ kind: 'document', url: d.pdfUrl, title: d.title || 'Bekanntmachung (PDF)' });
  }
  return out;
}

/**
 * Extrahiert den Text zwischen einem Start-Kopf (Regex) und dem nächsten
 * Abschnittskopf (Regex). Liefert null, wenn kein Start gefunden wird.
 */
function extractSectionUntil(text, startRe, stopRe) {
  const start = text.match(startRe);
  if (!start) return null;
  const from = start.index + start[0].length;
  const rest = text.slice(from);
  const stop = rest.match(stopRe);
  const section = stop ? rest.slice(0, stop.index) : rest;
  return section.trim();
}

function deriveFundingStatus(deadlines) {
  const real = deadlines.filter((d) => d.deadlineAt && !d.isOngoing);
  if (!real.length) {
    if (deadlines.some((d) => d.isOngoing)) return 'ongoing';
    return 'unknown';
  }
  // Offen, solange die späteste (maßgebliche) Frist noch in der Zukunft liegt.
  // Bei mehreren Fristen (z. B. je Modul/Phase) ist der Call offen, solange
  // mindestens eine zukünftige Frist existiert.
  const latest = real.map((d) => new Date(d.deadlineAt)).sort((a, b) => b - a)[0];
  if (latest.getTime() < Date.now()) return 'closed';
  return 'open';
}

/**
 * Merge der Projektformen.
 * Die LLM-Liste ist maßgeblich; Beträge/Quoten/Laufzeiten kommen
 * AUSSCHLIESSLICH vom LLM (deterministische Werte sind unzuverlässig und
 * werden nicht mehr eingemischt – vermeidet Halluzinationen wie "23 €").
 * Deterministisch erkannte Projektformen, die das LLM übersehen hat, werden
 * nur als Name aufgenommen (ohne Zahlenwerte).
 */
function mergeProjectTypes(deterministic, llmPart, docs) {
  const all = allText(docs);
  const out = (llmPart.projectTypes || []).map((pt) => ({ ...pt }));
  const byName = new Map(out.map((pt) => [normalizeTypeName(pt.name), pt]));

  const deterministicEntries = scanDeterministicProjectTypes(all);
  for (const entry of deterministicEntries) {
    const match = byName.get(normalizeTypeName(entry.name));
    if (match) {
      // Nur Beschreibung ergänzen, wenn das LLM keine liefert.
      if (!match.description && entry.description) match.description = entry.description;
    } else {
      out.push({
        name: entry.name,
        description: entry.description ?? null,
        durationMinMonths: null,
        durationMaxMonths: null,
        amountMinCents: null,
        amountMaxCents: null,
        currency: 'EUR',
        fundingQuoteMin: null,
        fundingQuoteMax: null,
        maxAmountCents: null,
        conditions: null,
      });
      byName.set(normalizeTypeName(entry.name), out[out.length - 1]);
    }
  }

  // Unbelegte Beschreibungen/Bedingungen entfernen (kein Zahlen-Merge mehr)
  for (const pt of out) {
    if (pt.description && !quoteInText(all, pt.description)) pt.description = null;
    if (pt.conditions && !quoteInText(all, pt.conditions)) pt.conditions = null;
  }
  return out;
}

function normalizeTypeName(name) {
  return String(name || '').toLowerCase().replace(/projekt(e|en)?$/, 'projekt').trim();
}

/**
 * Deterministische Projektform-Erkennung – nur Namen und ggf. Beschreibungen.
 * Zahlenwerte (Beträge/Quoten/Laufzeiten) werden hier bewusst NICHT erfasst,
 * da die deterministische Erkennung unzuverlässig ist (Halluzinationsgefahr).
 */
function scanDeterministicProjectTypes(all) {
  const out = [];
  const byName = new Map();
  let current = null;

  for (const rawLine of all.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const segments = line.split(/(?<=[.!?])\s+/);

    for (const segment of segments) {
      const seg = segment.trim();
      if (!seg) continue;

      const hintsInSegment = [];
      for (const h of PROJECT_TYPE_HINTS) {
        const singular = h.endsWith('e') ? h.slice(0, -1) : h;
        if (seg.includes(h) || seg.includes(singular)) hintsInSegment.push(h);
      }
      if (hintsInSegment.length) {
        current = hintsInSegment[hintsInSegment.length - 1];
        if (!byName.has(current)) {
          const entry = { name: current, description: null };
          byName.set(current, entry);
          out.push(entry);
        }
      }
      if (!current || !byName.has(current)) continue;
      const entry = byName.get(current);
      if (!entry.description && seg.length > 40 && !seg.includes(current)) {
        // Kurze, zum Segment passende Beschreibung übernehmen (ohne Zahlen)
        entry.description = seg.slice(0, 300);
      }
    }
  }
  return out;
}

function pushEvidence(list, entity, field, url, quote) {
  if (!quote) return;
  list.push({ entity, field, sourceUrl: url, quote, method: 'parser', confidence: 0.9 });
}

/**
 * Kürzt sehr lange Quelltexte heading-bewusst: Anfang + Ende bleiben erhalten.
 */
function truncateForLlm(text) {
  if (!text || text.length <= LLM_MAX_TEXT_CHARS) return text || '';
  const head = text.slice(0, LLM_KEEP_START);
  const tail = text.slice(text.length - LLM_KEEP_END);
  return `${head}\n\n[... Quelltext gekürzt, ${text.length - LLM_KEEP_START - LLM_KEEP_END} Zeichen entfernt ...]\n\n${tail}`;
}

/**
 * LLM-Primärextraktion mit Hints und Beleg-Validierung.
 */
async function extractWithLlm(docs, hints, fullText, { llmCaller }) {
  const promptText = truncateForLlm(fullText);
  let data = null;
  let prompt = buildLlmPrompt(promptText, hints);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      data = await llmCaller(prompt);
      break;
    } catch (error) {
      console.warn(`[funding] LLM-Extraktion Versuch ${attempt} fehlgeschlagen: ${error.message}`);
      if (attempt === 2) {
        return { fundingGegenstand: null, currentCall: null, title: null, shortDescription: null, fundingGeber: null, projectTypes: [], eligibility: [], deadlines: [], evidence: [], needsReview: 1 };
      }
      // Vereinfachter Prompt (ohne Hinweise) beim zweiten Versuch
      prompt = buildLlmPrompt(promptText, null);
    }
  }
  if (data == null) {
    return { fundingGegenstand: null, currentCall: null, title: null, shortDescription: null, fundingGeber: null, projectTypes: [], eligibility: [], deadlines: [], evidence: [], needsReview: 1 };
  }

  const evidence = [];
  const needsReview = [];

  // Wert validieren:
  //  - mode 'lenient' (Zusammenfassungen/Titel): wird übernommen, schwache
  //    Evidenz, KEIN Review-Flag – Paraphrasen lösen keine Prüfung aus.
  //  - mode 'grounded' (Standard: Antragsberechtigte, Voraussetzungen,
  //    Ausschlüsse): muss wörtlich belegt sein, sonst needs_review.
  const validateText = (value, entity, field, { mode = 'grounded' } = {}) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const v = value.trim();
    if (mode === 'lenient') {
      const snippet = findSnippet(fullText, v);
      evidence.push({
        entity, field, sourceUrl: docs[0]?.url,
        quote: snippet || v.slice(0, 200), method: 'llm', confidence: snippet ? 0.6 : 0.4,
      });
      return v;
    }
    if (quoteInText(fullText, v)) {
      evidence.push({ entity, field, sourceUrl: docs[0]?.url, quote: v.slice(0, 300), method: 'llm', confidence: 0.7 });
      return v;
    }
    needsReview.push({ entity, field, reason: 'Wert nicht im Quelltext belegt' });
    return v;
  };

  const projectTypes = [];
  // 0 wird als "nicht angegeben" behandelt (LLM-Platzhalter)
  const numOrNull = (n) => (n == null || Number(n) === 0 ? null : Number(n));
  for (const pt of Array.isArray(data.project_types) ? data.project_types : []) {
    const name = validateText(pt.name, 'project_type', 'name', { mode: 'lenient' });
    if (!name) continue;
    const entry = {
      name,
      description: typeof pt.description === 'string' ? (quoteInText(fullText, pt.description) ? pt.description : null) : null,
      durationMinMonths: numOrNull(pt.duration_min_months),
      durationMaxMonths: numOrNull(pt.duration_max_months),
      amountMinCents: pt.amount_min_euro != null && Number(pt.amount_min_euro) !== 0 ? Math.round(Number(pt.amount_min_euro) * 100) : null,
      amountMaxCents: pt.amount_max_euro != null && Number(pt.amount_max_euro) !== 0 ? Math.round(Number(pt.amount_max_euro) * 100) : null,
      currency: 'EUR',
      fundingQuoteMin: numOrNull(pt.funding_quote_min),
      fundingQuoteMax: numOrNull(pt.funding_quote_max),
      maxAmountCents: pt.max_amount_euro != null && Number(pt.max_amount_euro) !== 0 ? Math.round(Number(pt.max_amount_euro) * 100) : null,
      conditions: typeof pt.conditions === 'string' ? (quoteInText(fullText, pt.conditions) ? pt.conditions : null) : null,
    };

    // Unplausible Werte kennzeichnen (typische Klarschrift-Halluzinationen).
    // Plausible Beträge/Quoten werden ohne Review übernommen (deterministische
    // Kandidaten sind nur Ergänzung, kein harter Validierungs-Gate).
    for (const cents of [entry.amountMinCents, entry.amountMaxCents, entry.maxAmountCents]) {
      if (cents != null && cents < 50000) { // < 500 €
        needsReview.push({ entity: 'project_type', field: `${name} amount`, reason: `Unplausibler Betrag (${cents} Cent)` });
        break;
      }
    }
    for (const quoteVal of [entry.fundingQuoteMin, entry.fundingQuoteMax]) {
      if (quoteVal != null && (quoteVal < 0 || quoteVal > 100)) {
        needsReview.push({ entity: 'project_type', field: `${name} quote`, reason: `Unplausible Quote (${quoteVal})` });
        break;
      }
    }
    if (entry.description) {
      evidence.push({ entity: 'project_type', field: `${name} description`, sourceUrl: docs[0]?.url, quote: entry.description.slice(0, 300), method: 'llm', confidence: 0.6 });
    }
    projectTypes.push(entry);
  }

  const eligibility = [];
  const eligibilityGroups = [['applicant', data.eligible_applicants ?? data.applicants], ['target_group', data.target_groups], ['requirement', data.requirements], ['exclusion', data.exclusions]];
  for (const [kind, list] of eligibilityGroups) {
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item === 'string' && quoteInText(fullText, item)) {
        eligibility.push({ kind, text: item, sort: eligibility.length });
        evidence.push({ entity: 'eligibility', field: kind, sourceUrl: docs[0]?.url, quote: item.slice(0, 300), method: 'llm', confidence: 0.7 });
      } else if (typeof item === 'object' && item && typeof item.text === 'string' && quoteInText(fullText, item.text)) {
        eligibility.push({ kind, text: item.text, sort: eligibility.length });
        evidence.push({ entity: 'eligibility', field: kind, sourceUrl: docs[0]?.url, quote: item.text.slice(0, 300), method: 'llm', confidence: 0.7 });
      } else if (typeof item === 'string' || (typeof item === 'object' && item && typeof item.text === 'string')) {
        const text = typeof item === 'string' ? item : item.text;
        eligibility.push({ kind, text, sort: eligibility.length });
        needsReview.push({ entity: 'eligibility', field: kind, reason: 'Voraussetzung nicht belegt' });
      }
    }
  }

  // Fristen: LLM unterscheidet eine Frist / mehrere Fristen / laufend mit
  // oder ohne Frist. Jeder Eintrag trägt label, date, is_ongoing und Beleg.
  const deadlineStatus = (data.deadline_status && typeof data.deadline_status === 'object') ? data.deadline_status : {};
  const deadlineEntries = Array.isArray(deadlineStatus.deadlines) ? deadlineStatus.deadlines : [];
  const deadlines = [];
  for (const entry of deadlineEntries) {
    if (!entry || typeof entry !== 'object') continue;
    let deadlineAt = null;
    if (typeof entry.date === 'string') {
      const m = entry.date.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        deadlineAt = `${m[1]}-${m[2]}-${m[3]}`;
        if (typeof entry.time === 'string' && /^\d{2}:\d{2}/.test(entry.time)) deadlineAt += `T${entry.time}`;
      }
    }
    deadlines.push({
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : 'Antragsfrist',
      deadlineAt,
      isOngoing: entry.is_ongoing === true,
      quote: typeof entry.quote === 'string' && entry.quote.trim() ? entry.quote.trim() : null,
    });
  }
  // Laufende Förderung explizit als Dauerfrist eintragen (auch ohne Datum)
  const ongoingKind = ['ongoing', 'ongoing_without_deadline', 'ongoing_with_deadline'];
  if (ongoingKind.includes(deadlineStatus.kind) && !deadlines.some((d) => d.isOngoing)) {
    deadlines.push({ label: 'Laufende Antragstellung', deadlineAt: null, isOngoing: true, quote: deadlineStatus.kind === 'ongoing_with_deadline' ? 'laufend' : null });
  }

  if (needsReview.length) {
    console.warn(`[funding] needs_review (${docs[0]?.url}): ${needsReview.map((r) => `${r.entity}.${r.field}`).join(', ')}`);
  }

  return {
    title: validateText(data.title, 'program', 'title', { mode: 'lenient' }),
    currentCall: validateText(data.current_call, 'program', 'current_call', { mode: 'lenient' }),
    shortDescription: validateText(data.short_description, 'program', 'short_description', { mode: 'lenient' }),
    fundingGegenstand: validateText(data.funding_gegenstand, 'program', 'funding_gegenstand', { mode: 'lenient' }),
    fundingGeber: data.funding_geber ? validateText(String(data.funding_geber), 'program', 'funding_geber', { mode: 'lenient' }) : null,
    projectTypes,
    eligibility,
    deadlines,
    deadlineKind: typeof deadlineStatus.kind === 'string' ? deadlineStatus.kind : null,
    evidence,
    needsReview: needsReview.length,
  };
}

function findSnippet(text, value) {
  const core = value.length > 60 ? value.slice(0, 60) : value;
  const idx = text.indexOf(core);
  if (idx >= 0) return text.slice(idx, idx + 200);
  return null;
}

function buildLlmPrompt(text, hints) {
  const hintBlock = hints
    ? [
      '',
      '--- Bereits erkannte Fakten (nur bestätigen oder korrigieren, wenn im Text belegt; NICHT erfinden) ---',
      JSON.stringify({
        daten: hints.candidateDates,
        betraege_euro: hints.candidateAmounts,
        quotes_prozent: hints.candidateQuotes,
        projektformen_hinweise: hints.detectedProjectTypes,
      }, null, 2),
    ].join('\n')
    : '';

  return [
    'Du bist ein Förderprogramm-Rechercheur. Extrahiere aus dem folgenden offiziellen Bekanntmachungstext strukturierte Daten.',
    'WICHTIG: Gib KEINE Angabe an, die nicht wörtlich oder sinngemäß im Quelltext steht. Fehlende Werte als null oder leeres Array ausgeben.',
    'Behalte deutsche Formulierungen bei. Alle Geldbeträge in Euro (Zahl), alle Zeiträume in Monaten (Zahl), Quoten in Prozent (Zahl).',
    'FRISTEN: Unterscheide exakt, ob eine Frist, mehrere Fristen oder eine laufende/dauerhafte Antragstellung vorliegt.',
    '  - single: genau eine maßgebliche Frist (deadlines mit einem Eintrag).',
    '  - multiple: mehrere unterschiedliche Fristen (z. B. je Modul, Phase, Einreichungsfrist, Vorantrag, Befristung/Geltungsdauer der Richtlinie) - je Frist ein eigener Eintrag.',
    '  - ongoing_without_deadline: laufende/dauerhafte Antragstellung ohne Enddatum (is_ongoing=true, date=null).',
    '  - ongoing_with_deadline: laufende Antragstellung mit konkreter Frist (is_ongoing=true UND date gesetzt; zusaetzlich den Fristeintrag mit Datum aufnehmen).',
    '  - none: keine Frist und keine laufende Antragstellung im Text.',
    'Jede einzelne Frist als eigenes Objekt unter deadlines aufnehmen. date als ISO-Datum (YYYY-MM-DD), Uhrzeit separat. quote = woertlicher Belegsatz. Keine historischen/alten Daten als Frist uebernehmen.',
    'Erfasse ALLE Fristarten: Antragsfrist, Einreichungsfrist, Vorantrag, Modul-/Phasenfristen, und explizit die Befristung/Geltungsdauer der Richtlinie (z. B. „Diese Richtlinie tritt am ... in Kraft und ist bis zum ... befristet“).',
    'Jede Befristung als eigenen Eintrag mit label=„Befristung der Richtlinie“ oder „Geltungsdauer“ aufnehmen.',
    'Veröffentlichungs-, Bekanntmachungs- und Änderungsdaten sind KEINE Fristen und dürfen NICHT als Frist aufgenommen werden.',
    'Wenn der Text KEINE echte Antragsfrist/Einreichungsfrist nennt, setze kind="none" und deadlines=[] - erfinde NIEMALS Fristen.',
    'Eine Frist ist nur gültig, wenn sie im Text klar als Einreichungs-/Antragstermin erkennbar ist (z. B. "Antragsfrist", "bis zum", "Einreichung bis", "Deadline").',
    '',
    '--- Quelltext ---',
    text,
    hintBlock,
    '',
    '--- Antwortformat (nur JSON) ---',
    JSON.stringify({
      title: 'Programmtitel',
      current_call: 'Aktueller Call (z. B. Untertitel), oder null',
      short_description: 'Kurzbeschreibung in 1-2 Sätzen (wörtlich aus dem Text), oder null',
      funding_gegenstand: 'Ausführlicher Fördergegenstand (wörtliche Zusammenfassung), oder null',
      funding_geber: 'Fördergeber-Bezeichnung, oder null',
      deadline_status: {
        kind: 'single | multiple | ongoing_without_deadline | ongoing_with_deadline | none',
        deadlines: [
          {
            label: 'z. B. Antragsfrist, Einreichungsfrist, Modul 1, Vorantrag, Befristung der Richtlinie',
            date: 'ISO-Datum YYYY-MM-DD, oder null',
            time: 'HH:MM, oder null',
            is_ongoing: false,
            quote: 'wörtlicher Belegsatz aus dem Text',
          },
        ],
      },
      project_types: [
        {
          name: 'Projektform (z. B. Entwicklungsprojekte, Machbarkeitsprojekte, Innovationsprojekte)',
          description: 'Beschreibung (wörtlich), oder null',
          duration_min_months: 0,
          duration_max_months: 0,
          amount_min_euro: 0,
          amount_max_euro: 0,
          funding_quote_min: 0,
          funding_quote_max: 0,
          max_amount_euro: 0,
          conditions: 'Besondere Bedingungen, oder null',
        },
      ],
      eligible_applicants: ['Antragsberechtigte, jeweils ein wörtlicher Belegsatz'],
      requirements: ['Zuwendungsvoraussetzungen, jeweils ein wörtlicher Belegsatz'],
      exclusions: ['Ausschlüsse, jeweils ein wörtlicher Belegsatz'],
    }, null, 2),
  ].join('\n');
}

export default { extractFundingProgram, quoteInText };
