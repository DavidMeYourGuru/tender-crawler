import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, '..');

function asBoolean(value, fallback) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asStringList(value, fallback = []) {
  if (Array.isArray(value)) return value;
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  // Server
  port: asPositiveInt(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // Datenbank
  dbPath: path.resolve(rootDir, process.env.DB_PATH || './data/tender-crawler.sqlite'),

  // Crawling
  userAgent:
    process.env.USER_AGENT ||
    'TenderCrawler/1.0 (+Forschungseinrichtung; durchsucht öffentliche Vergabebekanntmachungen)',

  // Scheduler (mehrfach täglich)
  crawlCron: process.env.CRAWL_CRON ?? '0 */8 * * *',
  crawlOnStart: asBoolean(process.env.CRAWL_ON_START, true),

  // Request-Verhalten
  requestTimeoutMs: asPositiveInt(process.env.REQUEST_TIMEOUT_MS, 30000),
  requestDelayMs: asPositiveInt(process.env.REQUEST_DELAY_MS, 1200),
  maxRequestsPerMinute: asPositiveInt(process.env.MAX_REQUESTS_PER_MINUTE, 20),
  maxResultsPerPortal: asPositiveInt(process.env.MAX_RESULTS_PER_PORTAL, 250),

  // TED API: Suche über zurückliegende Tage
  tedDaysBack: asPositiveInt(process.env.TED_DAYS_BACK, 3),

  // LLM-Anreicherung
  llmEnabled: asBoolean(process.env.LLM_ENABLED, false),
  llmProvider: process.env.LLM_PROVIDER || 'ollama', // 'ollama' | 'openai' | 'custom'
  llmOllamaUrl: process.env.LLM_OLLAMA_URL || 'http://localhost:11434',
  llmOllamaModel: process.env.LLM_OLLAMA_MODEL || 'llama3.1:8b',
  llmOpenAiApiKey: process.env.LLM_OPENAI_API_KEY || null,
  llmOpenAiModel: process.env.LLM_OPENAI_MODEL || 'gpt-4o-mini',
  llmOpenAiBaseUrl:
    process.env.LLM_OPENAI_BASE_URL || 'https://api.openai.com/v1',
  llmDisableThinking: asBoolean(process.env.LLM_DISABLE_THINKING, true),
  // Ausschreibungen (Tender) werden NIEMALS per LLM analysiert
  tenderLlmEnabled: asBoolean(process.env.TENDER_LLM_ENABLED, false),
  llmMaxAnalysesPerDay: asPositiveInt(process.env.LLM_MAX_ANALYSES_PER_DAY, 50),
  llmResearchProfile:
    process.env.LLM_RESEARCH_PROFILE ||
    'Forschungseinrichtung mit Kernkompetenzen in angewandter Forschung. Interessiert an Ausschreibungen für Forschungsprojekte, Technologieentwicklung, Beratungsleistungen, IT- und Laborausstattung sowie wissenschaftliche Dienstleistungen.',
  llmMinRelevanceThreshold: asNumber(process.env.LLM_MIN_RELEVANCE_THRESHOLD, 0.4),
  llmBatchSize: asPositiveInt(process.env.LLM_BATCH_SIZE, 5),

  // Auth (einfach, token-basiert)
  authEnabled: asBoolean(process.env.AUTH_ENABLED, true),
  authToken: process.env.AUTH_TOKEN || null,

  // CORS / Deployment
  trustProxy: asBoolean(process.env.TRUST_PROXY, false),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // ── Browser-Worker (Playwright) ─────────────────────────────
  browserWorkerEnabled: asBoolean(process.env.BROWSER_WORKER_ENABLED, true),
  browserProfileDir:
    process.env.BROWSER_PROFILE_DIR || path.resolve(rootDir, './data/browser-profiles'),
  browserHeadless: asBoolean(process.env.BROWSER_HEADLESS, true),
  browserJobTimeoutMs: asPositiveInt(process.env.BROWSER_JOB_TIMEOUT_MS, 30 * 60 * 1000),
  browserMaxTabs: asPositiveInt(process.env.BROWSER_MAX_TABS, 2),
  browserPageWaitMs: asPositiveInt(process.env.BROWSER_PAGE_WAIT_MS, 2500),

  // eVergabe-Backfill
  evergabeBackfillMonths: asPositiveInt(process.env.EVERGABE_BACKFILL_MONTHS, 24),
  evergabeKnownPageStop: asPositiveInt(process.env.EVERGABE_KNOWN_PAGE_STOP, 3),
  evergabePageSize: 100,

  // Worker-Laufverhalten
  workerId: process.env.WORKER_ID || `worker-${process.pid}`,
  workerPollIntervalMs: asPositiveInt(process.env.WORKER_POLL_INTERVAL_MS, 2000),
  workerHeartbeatMs: asPositiveInt(process.env.WORKER_HEARTBEAT_MS, 10000),
  workerMaxAttempts: asPositiveInt(process.env.WORKER_MAX_ATTEMPTS, 3),
  workerStaleAfterMs: asPositiveInt(process.env.WORKER_STALE_AFTER_MS, 60000),

  // ── Förderprogramme ────────────────────────────────────────
  fundingEnabled: asBoolean(process.env.FUNDING_ENABLED, true),
  fundingCrawlCron: process.env.FUNDING_CRAWL_CRON ?? '30 6 * * *',
  fundingCrawlOnStart: asBoolean(process.env.FUNDING_CRAWL_ON_START, false),
  fundingRequestDelayMs: asPositiveInt(process.env.FUNDING_REQUEST_DELAY_MS, 300),
  fundingMaxRequestsPerMinute: asPositiveInt(process.env.FUNDING_MAX_REQUESTS_PER_MINUTE, 30),
  fundingMaxSources: asPositiveInt(process.env.FUNDING_MAX_SOURCES, 5),
  fundingLlmEnabled: asBoolean(process.env.FUNDING_LLM_ENABLED, asBoolean(process.env.LLM_ENABLED, false)),
  fundingRetryMax: asPositiveInt(process.env.FUNDING_RETRY_MAX, 2),
  fundingCrawlConcurrency: asPositiveInt(process.env.FUNDING_CRAWL_CONCURRENCY, 5),
  fundingPageConcurrency: asPositiveInt(process.env.FUNDING_PAGE_CONCURRENCY, 6),

  // ── Förder-Chat (RAG-Beratung über Förder-Calls) ───────────
  fundingChatEnabled: asBoolean(process.env.FUNDING_CHAT_ENABLED, true),
  fundingChatMaxCandidates: asPositiveInt(process.env.FUNDING_CHAT_MAX_CANDIDATES, 20),
  fundingChatMaxSources: asPositiveInt(process.env.FUNDING_CHAT_MAX_SOURCES, 8),
  fundingChatMaxHistory: asPositiveInt(process.env.FUNDING_CHAT_MAX_HISTORY, 12),
  fundingChatMaxConcurrency: asPositiveInt(process.env.FUNDING_CHAT_MAX_CONCURRENCY, 2),
  fundingChatContextChars: asPositiveInt(process.env.FUNDING_CHAT_CONTEXT_CHARS, 40000),
  fundingChatChunksPerProgram: asPositiveInt(process.env.FUNDING_CHAT_CHUNKS_PER_PROGRAM, 2),

  // ── Verwaltete Quellen (crawl_sources) ─────────────────────
  crawlSourcesEnabled: asBoolean(process.env.CRAWL_SOURCES_ENABLED, true),
  crawlSourcesProbeOnStart: asBoolean(process.env.CRAWL_SOURCES_PROBE_ON_START, false),
  crawlSourcesProbeCron: process.env.CRAWL_SOURCES_PROBE_CRON ?? '0 5 * * *',
  discoveryUserAgent: process.env.DISCOVERY_USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  discoveryMaxHttpSourcesPerCrawl: asPositiveInt(process.env.DISCOVERY_MAX_HTTP_SOURCES_PER_CRAWL, 8),
};

export default config;