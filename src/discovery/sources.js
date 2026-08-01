/**
 * Quellen-Dienst: Registrierung, Probe-Crawl und Discovery über
 * `crawl_sources`-Konfiguration.
 */
import * as cheerio from 'cheerio';
import config from '../config.js';
import { RateLimiter, RateLimiterRegistry } from '../crawler/rate-limiter.js';
import { parseHtmlList, extractDetailText } from './html-list.js';
import { assertSafeUrl, fetchSafeHtml } from './urls.js';
import { classifyDocument } from './classify.js';
import { SOURCE_CATALOG } from './catalog.js';
import {
  addCrawlSource,
  listCrawlSources,
  getCrawlSource,
  setCrawlSourceState,
  recordSourceRun,
  addDiscoveredDocument,
  classifyDiscoveredDocument,
  ensureSourceRow,
  enqueueBrowserJob,
  hasActiveBrowserJob,
} from '../db.js';

const registry = new RateLimiterRegistry(new RateLimiter(config.fundingMaxRequestsPerMinute, 60000));

export const PARSER_VERSION = '1.0.0';

/**
 * Registriert alle Katalog-Quellen idempotent in der Datenbank.
 * Browser-Quellen erhalten zusätzlich eine `sources`-Zeile, damit sie
 * über die persistente Browser-Queue verarbeitet werden können.
 */
export function seedCrawlSources() {
  let added = 0;
  for (const entry of SOURCE_CATALOG) {
    addCrawlSource({
      sourceKey: entry.sourceKey,
      name: entry.name,
      region: entry.region || 'de',
      url: entry.url,
      declaredKind: entry.declaredKind,
      access: entry.access || 'http',
      format: entry.format || 'html_list',
      rateLimitRpm: entry.rateLimitRpm || 10,
      state: 'unprobed',
      priority: entry.priority || 5,
      notes: entry.notes || null,
    });
    if (entry.access === 'browser') {
      ensureSourceRow({ id: entry.sourceKey, name: entry.name, region: entry.region || 'de', type: 'browser', enabled: 0 });
    }
    added += 1;
  }
  return added;
}

function rateLimiterFor(source) {
  // Acquire globalen + per-Quellen-Slot (respektvolles Gesamt-Rate-Limit).
  const rpm = source.rate_limit_rpm || 10;
  return {
    acquire: () => registry.acquire(`source:${source.id}`, rpm, 60000),
  };
}

/**
 * Führt einen Probe-Crawl einer einzelnen Quelle durch.
 * Ergebnis: { state, httpStatus, itemsDiscovered, sample, errorType, error }
 */
export async function probeSource(sourceId) {
  const source = getCrawlSource(sourceId);
  if (!source) throw new Error('Quelle nicht gefunden');
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const limiter = rateLimiterFor(source);
  const result = {
    state: 'blocked',
    httpStatus: null,
    itemsDiscovered: 0,
    itemsImported: 0,
    sample: [],
    errorType: null,
    error: null,
  };

  try {
    assertSafeUrl(source.url);
    await limiter.acquire();
    const { html, status, url: finalUrl } = await fetchSafeHtml(source.url);
    result.httpStatus = status;
    result.parserVersion = PARSER_VERSION;

    if (status >= 400) {
      result.errorType = status === 403 || status === 429 ? 'auth' : 'http';
      result.error = `HTTP ${status}`;
      result.state = status === 403 || status === 429 ? 'blocked' : 'needs_config';
    } else if (isHtmlLike(html)) {
      const items = parseHtmlList(html, finalUrl || source.url, {
        listItemSelector: source.list_item_selector,
        titleSelector: source.title_selector,
        linkSelector: source.link_selector,
        dateSelector: source.date_selector,
      });
      result.itemsDiscovered = items.length;
      result.sample = items.slice(0, 3).map((i) => ({ title: i.title, url: i.url }));
      if (items.length === 0) {
        // Seite erreichbar, aber keine Liste erkennbar → Konfig prüfen
        result.state = 'needs_config';
        result.errorType = 'no_items';
        result.error = 'Keine Listeneinträge mit aktiven Selektoren erkannt';
      } else {
        result.state = 'active';
      }
    } else {
      result.state = 'needs_config';
      result.errorType = 'not_html';
      result.error = 'Antwort ist kein HTML';
    }
  } catch (error) {
    result.errorType = classifyFetchError(error);
    result.error = error.message;
    result.state = result.errorType === 'network' ? 'blocked' : 'needs_config';
  }

  result.durationMs = Date.now() - t0;
  setCrawlSourceState(source.id, result.state, {
    last_http_status: result.httpStatus,
    last_item_count: result.itemsDiscovered,
    last_error_type: result.errorType,
    last_error: result.error,
    parser_version: PARSER_VERSION,
    last_crawl_at: new Date().toISOString(),
    last_success_at: result.state === 'active' ? new Date().toISOString() : undefined,
  });
  recordSourceRun({
    sourceId: source.id,
    mode: 'probe',
    httpStatus: result.httpStatus,
    itemsDiscovered: result.itemsDiscovered,
    itemsRejected: 0,
    errorType: result.errorType,
    errorDetail: result.error,
    parserVersion: PARSER_VERSION,
    durationMs: result.durationMs,
    startedAt,
  });
  return result;
}

function isHtmlLike(html) {
  return /<html|<!doctype/i.test(String(html).slice(0, 500)) || /<(article|div|table|li|ul)/i.test(String(html).slice(0, 2000));
}

function classifyFetchError(error) {
  const msg = String(error.message || error.code || '').toLowerCase();
  if (msg.includes('403') || msg.includes('forbidden') || msg.includes('429') || msg.includes('too many')) return 'auth';
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enetunreach') || msg.includes('enotfound')) return 'network';
  if (msg.includes('redirect')) return 'redirect';
  return 'other';
}

/**
 * Probed alle ungeprüften Quellen. Optional auf http beschränkt.
 */
export async function probeAllSources({ access = null } = {}) {
  const sources = listCrawlSources({ state: 'unprobed', access });
  const results = [];
  for (const source of sources) {
    const r = await probeSource(source.id);
    results.push({ id: source.id, sourceKey: source.source_key, ...r });
  }
  return results;
}

/**
 * Führt Discovery auf einer aktiven http-Quelle aus: lädt die Liste,
 * klassifiziert jeden Treffer und legt ihn in der Inbox ab.
 */
export async function runHttpDiscovery(sourceId) {
  const source = getCrawlSource(sourceId);
  if (!source) throw new Error('Quelle nicht gefunden');
  if (source.state !== 'active') throw new Error('Quelle ist nicht aktiv (erst Probe-Crawl ausführen)');
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const limiter = rateLimiterFor(source);
  assertSafeUrl(source.url);
  await limiter.acquire();
  const { html, status, url: finalUrl } = await fetchSafeHtml(source.url);
  if (status >= 400) throw new Error(`HTTP ${status}`);

  const items = parseHtmlList(html, finalUrl || source.url, {
    listItemSelector: source.list_item_selector,
    titleSelector: source.title_selector,
    linkSelector: source.link_selector,
    dateSelector: source.date_selector,
  });

  const summary = { itemsDiscovered: items.length, itemsImported: 0, itemsClassifiedUnknown: 0, itemsRejected: 0 };
  for (const item of items) {
    const discovered = addDiscoveredDocument({
      sourceId: source.id,
      canonicalUrl: item.url,
      title: item.title,
      publicationDate: item.publicationDate,
    });
    const cls = await classifyAndStore(discovered, source, item);
    if (cls === 'unknown') summary.itemsClassifiedUnknown += 1;
    else summary.itemsImported += 1;
  }

  const durationMs = Date.now() - t0;
  recordSourceRun({
    sourceId: source.id,
    mode: 'crawl',
    httpStatus: status,
    ...summary,
    parserVersion: PARSER_VERSION,
    durationMs,
    startedAt,
  });
  setCrawlSourceState(source.id, source.state, { last_crawl_at: new Date().toISOString(), last_item_count: items.length });
  return { sourceId: source.id, ...summary };
}

/**
 * Klassifiziert ein entdecktes Dokument deterministisch.
 * Bei unklarem Signal bleibt es 'unknown' (ohne LLM-Verbrauch).
 */
async function classifyAndStore(discovered, source, item) {
  const { classification, confidence, reason } = classifyDocument(item.title, item.rawText, {
    declaredKind: source.declared_kind === 'mixed' ? 'mixed' : source.declared_kind,
  });
  classifyDiscoveredDocument(discovered.id, { classification, confidence, reason });
  return classification;
}

/**
 * Führt Discovery auf allen aktiven http-Quellen eines Typs aus.
 * Berücksichtigt discoveryMaxHttpSourcesPerCrawl und überspringt Quellen,
 * die innerhalb von crawl_interval_min (8h) bereits gecrawlt wurden.
 */
export async function runAllHttpDiscovery({ declaredKind = null, limit = config.discoveryMaxHttpSourcesPerCrawl } = {}) {
  const sources = listCrawlSources({ state: 'active', access: 'http' })
    .filter((s) => !declaredKind || s.declared_kind === declaredKind || s.declared_kind === 'mixed')
    .slice(0, limit);
  const results = [];
  for (const source of sources) {
    try {
      results.push(await runHttpDiscovery(source.id));
    } catch (error) {
      results.push({ sourceId: source.id, error: error.message, itemsDiscovered: 0 });
    }
  }
  return results;
}

/**
 * Lädt eine Detailseite und extrahiert Text/HTML für die Extraktions-Pipeline.
 */
export async function fetchSourceDetail(url, { rateLimiter = null, source = null } = {}) {
  const limiter = rateLimiter || (source ? rateLimiterFor(source) : null);
  if (limiter) await limiter.acquire();
  assertSafeUrl(url);
  const { html, url: finalUrl } = await fetchSafeHtml(url);
  const detail = extractDetailText(html, source ? { detailTextSelector: source.detail_text_selector } : {});
  return {
    url: finalUrl || url,
    title: cheerio.load(html)('title').first().text().trim() || null,
    page: 'Detailseite',
    text: detail.text,
    html: detail.html,
  };
}

export default { seedCrawlSources, probeSource, probeAllSources, runHttpDiscovery, runAllHttpDiscovery, fetchSourceDetail, enqueueManagedBrowserJobs, PARSER_VERSION };

/**
 * Reiht Browser-Jobs für aktive verwaltete Browser-Quellen ein.
 * Wird über die Worker-Queue (Heartbeat/Retry/Cancel) verarbeitet.
 */
export async function enqueueManagedBrowserJobs({ declaredKind = null, limit = 5 } = {}) {
  seedCrawlSources();
  const sources = listCrawlSources({ state: 'active', access: 'browser' })
    .filter((s) => !declaredKind || s.declared_kind === declaredKind || s.declared_kind === 'mixed')
    .slice(0, limit);
  const summaries = [];
  for (const source of sources) {
    if (hasActiveBrowserJob(source.source_key)) {
      summaries.push({ sourceKey: source.source_key, status: 'already_running' });
      continue;
    }
    const job = enqueueBrowserJob(source.source_key, { mode: 'auto' });
    summaries.push({ sourceKey: source.source_key, status: job ? 'queued' : 'already_running' });
  }
  return summaries;
}
