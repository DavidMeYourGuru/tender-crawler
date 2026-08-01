import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cron from 'node-cron';
import config, { rootDir } from './config.js';
import { runCrawl, getCrawlStatus, enrichTenders, enqueueBrowserCrawlJobs } from './crawler/orchestrator.js';
import {
  getRecentJobs,
  getBrowserJobById,
  requestCancelJob,
} from './db.js';
import { getAnalysisStatus } from './llm.js';
import {
  listTenders,
  getTenderById,
  getTenderChanges,
  getSources,
  getStats,
  getCrawlHistory,
  getSavedSearches,
  createSavedSearch,
  deleteSavedSearch,
  listFundingPrograms,
  getFundingProgramById,
  getFundingStats,
  setFundingOverride,
  deleteFundingOverride,
  confirmFundingProgram,
  getFundingCrawlHistory,
  listCrawlSources,
  getCrawlSource,
  addCrawlSource,
  deleteCrawlSource,
  getSourceRuns,
  listDiscoveredDocuments,
  getDiscoveredDocument,
  backfillSearchText,
} from './db.js';
import { probeSource, probeAllSources, seedCrawlSources } from './discovery/sources.js';
import { normalizeUrl } from './discovery/urls.js';
import { processDiscovered, processDiscoveredInbox } from './discovery/pipeline.js';
import {
  runFundingCrawl,
  getFundingCrawlStatus,
} from './funding/orchestrator.js';
import { loadFundingSources } from './funding/sources/registry.js';
import { answerFundingChat, fundingChatBusy } from './funding/chat.js';

const app = Fastify({
  logger: { level: config.logLevel },
  trustProxy: config.trustProxy,
});

/**
 * Einfache Token-Authentifizierung (Bearer-Token).
 */
function isAuthorized(request) {
  if (!config.authEnabled) return true;
  if (!config.authToken) return false;
  const header = request.headers.authorization || '';
  return header === `Bearer ${config.authToken}`;
}

async function requireAuth(request, reply) {
  if (!isAuthorized(request)) {
    reply.code(401).send({ error: 'Nicht autorisiert' });
    return reply;
  }
}

/**
 * Registriert das statische Dashboard aus /public.
 */
app.register(fastifyStatic, {
  root: path.join(rootDir, 'public'),
  prefix: '/',
});

/**
 * Health-Check.
 */
app.get('/api/health', async () => ({
  status: 'ok',
  time: new Date().toISOString(),
  version: '1.0.0',
}));

/**
 * Aktueller Crawl-Status.
 */
app.get('/api/status', { preHandler: requireAuth }, async () => ({
  crawl: getCrawlStatus(),
  jobs: {
    active: getRecentJobs(10).filter((j) => ['queued', 'running', 'retry'].includes(j.status)),
    recent: getRecentJobs(10),
  },
  analysis: getAnalysisStatus(),
}));

/**
 * Abbruch eines laufenden Browser-Jobs.
 */
app.post('/api/jobs/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
  const job = getBrowserJobById(Number(request.params.id));
  if (!job) {
    reply.code(404).send({ error: 'Job nicht gefunden' });
    return reply;
  }
  requestCancelJob(job.id);
  return { cancelled: true, jobId: job.id };
});

/**
 * Startet einen Crawl (optional mit Quellen-Filter).
 * Browser-Quellen (eVergabe) werden sofort als Job eingereiht, direkte
 * Quellen laufen asynchron im Hintergrund – die Antwort kommt umgehend.
 * Body: { sources: ['ted', ...], enrich: boolean }
 */
app.post('/api/crawl', { preHandler: requireAuth }, async (request, reply) => {
  const { sources = null, enrich = true } = request.body || {};
  try {
    const enqueued = await enqueueBrowserCrawlJobs({ sources });
    const promise = runCrawl({ sources, enrich });
    promise.catch((error) => app.log.error('Crawl fehlgeschlagen:', error.message));
    app.log.info({ sources }, 'Crawl asynchron gestartet');
    return {
      started: true,
      status: getCrawlStatus(),
      enqueued,
    };
  } catch (error) {
    request.log.error(error);
    reply.code(500).send({ error: error.message });
    return reply;
  }
});

/**
 * LLM-Analyse für Ausschreibungen ist deaktiviert – Ausschreibungen werden
 * niemals per LLM analysiert. Nur Förder-Calls nutzen das LLM.
 */
app.post('/api/analysis/run', { preHandler: requireAuth }, async (request, reply) => {
  reply.code(404).send({ error: 'Ausschreibungs-LLM-Analyse ist deaktiviert. Nur Förder-Calls werden per LLM analysiert.' });
  return reply;
});

/**
 * Statistiken für das Dashboard.
 */
app.get('/api/stats', { preHandler: requireAuth }, async () => getStats());

/**
 * Tender-Liste mit Filtern, Suche und Paginierung.
 * Query: q, sources (csv), regions (csv), status (csv), cpv,
 *        deadline_before, deadline_after, value_min, value_max,
 *        relevance_min, analyzed_only, sort, page, limit
 */
app.get('/api/tenders', { preHandler: requireAuth }, async (request) => {
  const query = request.query || {};
  const result = listTenders({
    q: query.q || null,
    sources: query.sources ? String(query.sources).split(',').map((s) => s.trim()).filter(Boolean) : null,
    regions: query.regions ? String(query.regions).split(',').map((s) => s.trim()).filter(Boolean) : null,
    status: query.status ? String(query.status).split(',').map((s) => s.trim()).filter(Boolean) : null,
    cpv: query.cpv || null,
    deadlineBefore: query.deadline_before || null,
    deadlineAfter: query.deadline_after || null,
    valueMinCents: query.value_min != null ? Number(query.value_min) : null,
    valueMaxCents: query.value_max != null ? Number(query.value_max) : null,
    relevanceMin: query.relevance_min != null ? Number(query.relevance_min) : null,
    analyzedOnly: query.analyzed_only === 'true' || query.analyzed_only === '1',
    sort: query.sort || 'newest',
    page: Number(query.page) || 1,
    limit: Number(query.limit) || 25,
  });
  return result;
});

/**
 * Einzelner Tender.
 */
app.get('/api/tenders/:id', { preHandler: requireAuth }, async (request, reply) => {
  const tender = getTenderById(Number(request.params.id));
  if (!tender) {
    reply.code(404).send({ error: 'Tender nicht gefunden' });
    return reply;
  }
  const changes = getTenderChanges(tender.id);
  return {
    ...tender,
    cpv_codes: tender.cpv_codes ? JSON.parse(tender.cpv_codes) : null,
    cpv_labels: tender.cpv_labels ? JSON.parse(tender.cpv_labels) : null,
    llm_requirements: tender.llm_requirements ? JSON.parse(tender.llm_requirements) : null,
    changes,
  };
});

/**
 * Quellen-Liste.
 */
app.get('/api/sources', { preHandler: requireAuth }, async () => getSources());

/**
 * Crawl-Verlauf.
 */
app.get('/api/crawls', { preHandler: requireAuth }, async (request) => {
  const limit = Math.min(Number(request.query?.limit) || 10, 100);
  return { crawls: getCrawlHistory(limit) };
});

/**
 * Gespeicherte Suchen.
 */
app.get('/api/searches', { preHandler: requireAuth }, async () => ({ searches: getSavedSearches() }));

app.post('/api/searches', { preHandler: requireAuth }, async (request, reply) => {
  try {
    const search = createSavedSearch(request.body || {});
    return search;
  } catch (error) {
    request.log.error(error);
    reply.code(400).send({ error: error.message });
    return reply;
  }
});

app.delete('/api/searches/:id', { preHandler: requireAuth }, async (request, reply) => {
  deleteSavedSearch(Number(request.params.id));
  reply.code(204).send();
  return reply;
});

/**
 * ── Förderprogramme ──────────────────────────────────────────
 */

/**
 * Verfügbare Förderquellen-Adapter.
 */
app.get('/api/funding/sources', { preHandler: requireAuth }, async () => {
  const sources = await loadFundingSources();
  return { sources: [...sources.values()].map((s) => ({ id: s.meta.id, name: s.meta.name, region: s.meta.region })) };
});

/**
 * Förderprogramm-Liste mit Filtern und Suche.
 * Query: q, geber, status, review_status, project_type,
 *        deadline_before, deadline_after, sort, page, limit
 */
app.get('/api/funding-programs', { preHandler: requireAuth }, async (request) => {
  const query = request.query || {};
  const result = listFundingPrograms({
    q: query.q || null,
    geber: query.geber || null,
    status: query.status ? String(query.status).split(',').map((s) => s.trim()).filter(Boolean) : null,
    reviewStatus: query.review_status || null,
    deadlineBefore: query.deadline_before || null,
    deadlineAfter: query.deadline_after || null,
    projectType: query.project_type || null,
    sort: query.sort || 'deadline',
    page: Number(query.page) || 1,
    limit: Number(query.limit) || 25,
  });
  return result;
});

/**
 * Einzelnes Förderprogramm mit allen Detaildaten.
 */
app.get('/api/funding-programs/:id', { preHandler: requireAuth }, async (request, reply) => {
  const program = getFundingProgramById(Number(request.params.id));
  if (!program) {
    reply.code(404).send({ error: 'Förderprogramm nicht gefunden' });
    return reply;
  }
  return program;
});

/**
 * Förderprogramm-Statistiken.
 */
app.get('/api/funding/stats', { preHandler: requireAuth }, async () => getFundingStats());

/**
 * Förder-Crawl-Status.
 */
app.get('/api/funding/status', { preHandler: requireAuth }, async () => ({
  funding: getFundingCrawlStatus(),
}));

/**
 * Startet einen Förder-Crawl (asynchron).
 * Läuft ausschließlich über die registrierten Förder-Adapter (Förderinfo).
 * Body: { llm?: boolean, limit?: number }
 */
app.post('/api/funding/crawl', { preHandler: requireAuth }, async (request, reply) => {
  const { llm = null, limit = null } = request.body || {};
  const maxResults = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  try {
    const promise = runFundingCrawl({ llmEnabled: llm ?? undefined, maxResults });
    promise.catch((error) => app.log.error('Förder-Crawl fehlgeschlagen:', error.message));
    return { started: true, status: getFundingCrawlStatus(), limit: maxResults };
  } catch (error) {
    request.log.error(error);
    reply.code(500).send({ error: error.message });
    return reply;
  }
});

/**
 * Förder-Crawl-Verlauf.
 */
app.get('/api/funding/crawls', { preHandler: requireAuth }, async (request) => {
  const limit = Math.min(Number(request.query?.limit) || 10, 100);
  return { crawls: getFundingCrawlHistory(limit) };
});

/**
 * Förder-Chat: LLM-Beratung über gespeicherte Förder-Calls.
 * Body: { question, profile, history }
 * Antwort: { answer, recommendations, sources, retrieval }
 */
app.post('/api/funding-chat', { preHandler: requireAuth }, async (request, reply) => {
  if (!config.fundingChatEnabled) {
    reply.code(404).send({ error: 'Förder-Chat ist deaktiviert' });
    return reply;
  }
  const { question, profile, history } = request.body || {};

  // Klassischer Modus (JSON-Antwort)
  try {
    const result = await answerFundingChat({ question, profile, history });
    return result;
  } catch (error) {
    if (error.code === 'VALIDATION') {
      reply.code(400).send({ error: error.message });
      return reply;
    }
    request.log.error({ err: error }, 'Förder-Chat fehlgeschlagen');
    reply.code(503).send({ error: 'Beratung derzeit nicht verfügbar, bitte später erneut versuchen.' });
    return reply;
  }
});

/**
 * Chat-Status (ohne Secrets).
 */
app.get('/api/funding-chat/status', { preHandler: requireAuth }, async () => ({
  enabled: config.fundingChatEnabled,
  provider: config.llmProvider,
  model: config.llmProvider === 'ollama' ? config.llmOllamaModel : config.llmOpenAiModel,
  busy: fundingChatBusy(),
  maxConcurrency: config.fundingChatMaxConcurrency,
}));

/**
 * Feld-Override setzen oder löschen (manuell gewinnt bei Folgeläufen).
 * Body: { entity, field, value } – value=null löscht den Override.
 */
app.post('/api/funding-programs/:id/override', { preHandler: requireAuth }, async (request, reply) => {
  const program = getFundingProgramById(Number(request.params.id));
  if (!program) {
    reply.code(404).send({ error: 'Förderprogramm nicht gefunden' });
    return reply;
  }
  const { entity, field, value } = request.body || {};
  if (!entity || !field) {
    reply.code(400).send({ error: 'entity und field sind erforderlich' });
    return reply;
  }
  const validEntities = new Set(['program', 'project_type', 'deadline', 'eligibility']);
  if (!validEntities.has(String(entity))) {
    reply.code(400).send({ error: 'Ungültige entity' });
    return reply;
  }
  if (value == null) {
    deleteFundingOverride({ programId: program.id, entity: String(entity), field: String(field) });
    return { ok: true, override: null };
  }
  const override = setFundingOverride({
    programId: program.id,
    entity: String(entity),
    field: String(field),
    value,
  });
  return { ok: true, override };
});

/**
 * Datensatz als geprüft bestätigen.
 */
app.post('/api/funding-programs/:id/confirm', { preHandler: requireAuth }, async (request, reply) => {
  const program = getFundingProgramById(Number(request.params.id));
  if (!program) {
    reply.code(404).send({ error: 'Förderprogramm nicht gefunden' });
    return reply;
  }
  const confirmed = confirmFundingProgram(program.id);
  return { ok: true, program: confirmed };
});

/**
 * ── Verwaltete Quellen (crawl_sources) ───────────────────────
 */

/**
 * Quellen auflisten (optional nach kind/access/state gefiltert).
 */
app.get('/api/crawl-sources', { preHandler: requireAuth }, async (request) => {
  const query = request.query || {};
  seedCrawlSources();
  return { sources: listCrawlSources({ declaredKind: query.kind || null, access: query.access || null, state: query.state || null }) };
});

/**
 * Quelle anlegen.
 */
app.post('/api/crawl-sources', { preHandler: requireAuth }, async (request, reply) => {
  const body = request.body || {};
  if (!body.url || !body.sourceKey || !body.name) {
    reply.code(400).send({ error: 'url, sourceKey und name sind erforderlich' });
    return reply;
  }
  const normalized = normalizeUrl(String(body.url));
  if (!normalized) {
    reply.code(400).send({ error: 'Ungültige oder unzulässige URL (nur http/https, keine privaten Hosts)' });
    return reply;
  }
  const source = addCrawlSource({
    sourceKey: String(body.sourceKey),
    name: String(body.name),
    region: body.region || 'de',
    url: normalized,
    declaredKind: body.declaredKind || 'funding',
    access: body.access || 'http',
    format: body.format || 'html_list',
    rateLimitRpm: Number(body.rateLimitRpm) || 10,
    notes: body.notes || null,
  });
  return { ok: true, source };
});

/**
 * Quelle löschen.
 */
app.delete('/api/crawl-sources/:id', { preHandler: requireAuth }, async (request, reply) => {
  const ok = deleteCrawlSource(Number(request.params.id));
  if (!ok) {
    reply.code(404).send({ error: 'Quelle nicht gefunden' });
    return reply;
  }
  return { ok: true };
});

/**
 * Probe-Crawl einer Quelle ausführen.
 */
app.post('/api/crawl-sources/:id/probe', { preHandler: requireAuth }, async (request, reply) => {
  try {
    const result = await probeSource(Number(request.params.id));
    return { ok: true, result };
  } catch (error) {
    reply.code(404).send({ error: error.message });
    return reply;
  }
});

/**
 * Läufe einer Quelle.
 */
app.get('/api/crawl-sources/:id/runs', { preHandler: requireAuth }, async (request) => {
  return { runs: getSourceRuns(Number(request.params.id), Math.min(Number(request.query?.limit) || 10, 50)) };
});

/**
 * Inbox der entdeckten Dokumente.
 */
app.get('/api/discovered', { preHandler: requireAuth }, async (request) => {
  const query = request.query || {};
  return { documents: listDiscoveredDocuments({ classification: query.classification || null, status: query.status || null, limit: Number(query.limit) || 50 }) };
});

/**
 * Ein entdecktes Dokument verarbeiten (routen zu Funding/Tender).
 */
app.post('/api/discovered/:id/process', { preHandler: requireAuth }, async (request, reply) => {
  // Dokument per ID laden und Client-Felder ignorieren – verhindert SSRF über
  // eine manipulierte canonical_url im Request-Body.
  const doc = getDiscoveredDocument(Number(request.params.id));
  if (!doc) {
    reply.code(404).send({ error: 'Dokument nicht gefunden' });
    return reply;
  }
  try {
    const source = getCrawlSource(doc.source_id);
    const result = await processDiscovered(doc, { source });
    return { ok: true, result };
  } catch (error) {
    reply.code(500).send({ error: error.message });
    return reply;
  }
});

/**
 * RAG-Backfill: search_text_full + Chunks für bestehende Daten neu aufbauen.
 * Asynchron mit einfacher Lock-Flag, damit der Event-Loop nicht blockiert.
 */
let backfillRunning = false;
let backfillStatus = { running: false, updated: 0, startedAt: null, finishedAt: null };
app.post('/api/rag/backfill', { preHandler: requireAuth }, async (request, reply) => {
  if (backfillRunning) {
    return { ok: false, started: false, message: 'Backfill läuft bereits', status: backfillStatus };
  }
  backfillRunning = true;
  backfillStatus = { running: true, updated: 0, startedAt: new Date().toISOString(), finishedAt: null };
  setImmediate(() => {
    try {
      const updated = backfillSearchText();
      backfillStatus = { running: false, updated, startedAt: backfillStatus.startedAt, finishedAt: new Date().toISOString() };
      app.log.info(`RAG-Backfill beendet: ${updated} Datensätze`);
    } catch (error) {
      backfillStatus = { running: false, updated: 0, startedAt: backfillStatus.startedAt, finishedAt: new Date().toISOString(), error: error.message };
      app.log.error('RAG-Backfill fehlgeschlagen:', error.message);
    } finally {
      backfillRunning = false;
    }
  });
  return { ok: true, started: true, status: backfillStatus };
});

app.get('/api/rag/backfill', { preHandler: requireAuth }, async () => ({ status: backfillStatus }));

/**
 * Scheduler (node-cron).
 */
if (config.crawlCron) {
  const isCronExpression = cron.validate(config.crawlCron);
  if (isCronExpression) {
    cron.schedule(config.crawlCron, async () => {
      app.log.info('Scheduled crawl gestartet');
      try {
        const status = await runCrawl({ enrich: true });
        app.log.info(`Scheduled crawl beendet: ${status.message}`);
      } catch (error) {
        app.log.error('Scheduled crawl fehlgeschlagen:', error.message);
      }
    });
    app.log.info(`Crawl-Scheduler aktiv: "${config.crawlCron}"`);
  } else {
    app.log.warn(`Ungültiger CRAWL_CRON-Wert, Scheduler deaktiviert: "${config.crawlCron}"`);
  }
}

if (config.fundingEnabled && config.fundingCrawlCron) {
  if (cron.validate(config.fundingCrawlCron)) {
    cron.schedule(config.fundingCrawlCron, async () => {
      app.log.info('Scheduled Förder-Crawl gestartet');
      try {
        const status = await runFundingCrawl({});
        app.log.info(`Scheduled Förder-Crawl beendet: ${status.message}`);
      } catch (error) {
        app.log.error('Scheduled Förder-Crawl fehlgeschlagen:', error.message);
      }
    });
    app.log.info(`Förder-Crawl-Scheduler aktiv: "${config.fundingCrawlCron}"`);
  } else {
    app.log.warn(`Ungültiger FUNDING_CRAWL_CRON-Wert, Scheduler deaktiviert: "${config.fundingCrawlCron}"`);
  }
}

// Scheduler für Quellen-Probe-Crawls
if (config.crawlSourcesEnabled && config.crawlSourcesProbeCron) {
  if (cron.validate(config.crawlSourcesProbeCron)) {
    cron.schedule(config.crawlSourcesProbeCron, async () => {
      app.log.info('Scheduled Quellen-Probe gestartet');
      try {
        const results = await probeAllSources({ access: 'http' });
        app.log.info(`Quellen-Probe beendet: ${results.length} geprüft`);
      } catch (error) {
        app.log.error('Quellen-Probe fehlgeschlagen:', error.message);
      }
    });
    app.log.info(`Quellen-Probe-Scheduler aktiv: "${config.crawlSourcesProbeCron}"`);
  }
}

/**
 * Startet den Server.
 */
export async function startServer() {
  await app.listen({ port: config.port, host: config.host });

  // Quellen-Katalog registrieren
  if (config.crawlSourcesEnabled) {
    seedCrawlSources();
    app.log.info('Quellen-Katalog registriert.');
  }

  if (config.crawlOnStart) {
    app.log.info('Start-Crawl wird ausgeführt …');
    runCrawl({ enrich: true })
      .then((status) => app.log.info(`Start-Crawl beendet: ${status.message}`))
      .catch((error) => app.log.error('Start-Crawl fehlgeschlagen:', error.message));
  }

  return app;
}

// Nur direkt starten, wenn diese Datei ausgeführt wird (nicht bei Import)
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startServer().catch((error) => {
    console.error('Server-Start fehlgeschlagen:', error);
    process.exit(1);
  });
}

export default app;