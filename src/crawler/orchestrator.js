import { loadPortalModules } from '../portals/registry.js';
import config from '../config.js';
import {
  getSource,
  saveTender,
  updateSourceCrawlTime,
  startCrawlLog,
  finishCrawlLog,
  getTenderById,
  enqueueBrowserJob,
} from '../db.js';
import { RateLimiter, RateLimiterRegistry } from './rate-limiter.js';
import { contentHash, sleep } from '../utils.js';
import { seedCrawlSources, runAllHttpDiscovery } from '../discovery/sources.js';
import { processDiscoveredInbox } from '../discovery/pipeline.js';

// Globaler Limiter (MAX_REQUESTS_PER_MINUTE) + ein Limiter pro Portal
const registry = new RateLimiterRegistry(new RateLimiter(config.maxRequestsPerMinute, 60000));
let activeCrawl = null;
let crawlState = { running: false, message: 'Noch kein Crawl in diesem Prozess.', startedAt: null };

/**
 * Führt fn mit exponentiellem Backoff bis zu `retries` Mal aus.
 */
async function withRetry(fn, { retries = 2, baseDelayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.warn(`[orchestrator] Versuch ${attempt + 1}/${retries + 1} fehlgeschlagen (${error.message}), Retry in ${delay}ms …`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Gibt den aktuellen Crawl-Status zurück.
 */
export function getCrawlStatus() {
  return { ...crawlState };
}

/**
 * Führt einen Crawl für alle (oder ausgewählte) Quellen durch.
 */
export async function runCrawl({ sources: sourceIds = null, enrich = true } = {}) {
  if (activeCrawl) return activeCrawl;

  activeCrawl = doCrawl({ sourceIds, enrich }).finally(() => {
    activeCrawl = null;
  });
  return activeCrawl;
}

/**
 * Reiht Browser-Jobs (z. B. eVergabe) sofort ein – ohne auf direkte
 * Quellen zu warten. Liefert die Job-Zusammenfassungen.
 */
export async function enqueueBrowserCrawlJobs({ sources: sourceIds = null } = {}) {
  const portals = await loadPortalModules();
  const summaries = [];
  const sourceList = sourceIds && sourceIds.length ? sourceIds : null;

  for (const [portalId, portal] of portals) {
    const source = getSource(portalId);
    if (!source?.enabled) continue;
    if (sourceList && !sourceList.includes(portalId)) continue;
    if (source.type !== 'browser') continue;

    if (config.browserWorkerEnabled) {
      const job = enqueueBrowserJob(portalId, { mode: 'auto' });
      summaries.push({
        id: null,
        jobId: job?.id || null,
        sourceId: portalId,
        sourceName: source.name,
        status: job ? 'queued' : 'already_running',
        itemsDiscovered: 0,
        itemsNew: 0,
        itemsChanged: 0,
        errors: 0,
        errorMessage: job ? null : 'Browser-Job für diese Quelle läuft bereits oder ist in der Warteschlange.',
        browser: true,
      });
    } else {
      summaries.push({
        id: null,
        sourceId: portalId,
        sourceName: source.name,
        status: 'skipped',
        itemsDiscovered: 0,
        itemsNew: 0,
        itemsChanged: 0,
        errors: 0,
        errorMessage: 'Browser-Worker deaktiviert (BROWSER_WORKER_ENABLED=false) – eVergabe wird nicht vollständig gecrawlt.',
        browser: true,
      });
    }
  }
  return summaries;
}

/**
 * Ruft Detailseiten für neue/geänderte Tender ab (Enrich-Phase).
 * Ergänzt fehlende Beschreibung/Dokument-URLs und protokolliert Änderungen.
 */
export async function enrichTenders(tenderIds) {
  const portals = await loadPortalModules();
  let enriched = 0;
  for (const id of tenderIds) {
    const tender = getTenderById(id);
    if (!tender) continue;
    const portalModule = portals.get(tender.source_id);
    if (!portalModule?.fetchDetail) continue;

    // Keine Lücken → kein Netzwerkzugriff nötig
    if (tender.description && tender.document_url) continue;

    const rateLimit = portalModule.meta?.rateLimit || { maxRequests: 15, windowMs: 60000 };
    const limiter = registry.for(tender.source_id, rateLimit.maxRequests, rateLimit.windowMs);

    try {
      // Rate-Limit-Slot vor dem Detail-Abruf (der Rate-Limiter übernimmt das Pacing)
      await limiter.acquire();
      const detail = await portalModule.fetchDetail(tender.url, { rateLimiter: limiter });
      if (!detail) continue;

      // Nur Lücken füllen – so bleibt der Enrich-Schritt idempotent und
      // verhindert Pendeln zwischen Kurz- und Langbeschreibung
      const description = !tender.description && detail.description
        ? detail.description.trim()
        : tender.description;
      const documentUrl = !tender.document_url && detail.documentUrl
        ? detail.documentUrl
        : tender.document_url;
      // Nur speichern, wenn sich tatsächlich etwas ändert
      if (description === tender.description && documentUrl === tender.document_url) continue;

      const updated = {
        sourceId: tender.source_id,
        externalId: tender.external_id,
        title: tender.title,
        url: tender.url,
        description,
        contractingAuthority: tender.contracting_authority,
        cpvCodes: tender.cpv_codes ? JSON.parse(tender.cpv_codes) : null,
        cpvLabels: tender.cpv_labels ? JSON.parse(tender.cpv_labels) : null,
        estimatedValueCents: tender.estimated_value_cents,
        estimatedValueCurrency: tender.estimated_value_currency,
        placeOfPerformance: tender.place_of_performance,
        awardCriteria: null,
        tenderType: tender.tender_type,
        publicationDate: tender.publication_date,
        submissionDeadline: tender.submission_deadline,
        openingDate: null,
        contractDuration: null,
        documentUrl,
        status: tender.status,
        contentHash: contentHash(
          tender.external_id,
          tender.title,
          tender.submission_deadline,
          tender.status,
          tender.estimated_value_cents,
          description
        ),
      };
      saveTender(updated);
      enriched += 1;
    } catch (error) {
      console.error(`[enrich] Detail für Tender ${id} (${tender.title}) fehlgeschlagen:`, error.message);
    }
  }
  return enriched;
}

async function doCrawl({ sourceIds, enrich }) {
  const portals = await loadPortalModules();
  const startedAt = new Date().toISOString();
  crawlState = { running: true, startedAt, message: 'Crawl läuft' };

  const summaries = [];
  const sourceList = sourceIds && sourceIds.length ? sourceIds : null;
  let totalManagedNew = 0;

  // Browser-basierte Quellen (z. B. eVergabe) sofort als Job einreihen –
  // der separate Playwright-Worker übernimmt sie asynchron.
  const browserSummaries = await enqueueBrowserCrawlJobs({ sources: sourceList });
  summaries.push(...browserSummaries);

  for (const [portalId, portal] of portals) {
    const source = getSource(portalId);
    if (!source?.enabled) continue;
    if (sourceList && !sourceList.includes(portalId)) continue;
    if (source.type === 'browser') continue;

    const summary = await crawlOneSource(portalId, portal, source);
    summaries.push(summary);
  }

  let enriched = 0;
  if (enrich) {
    const enrichable = summaries.flatMap((s) => s.tenderIds || []);
    if (enrichable.length) {
      enriched = await enrichTenders(enrichable);
    }
  }

  // Verwaltete http-Quellen (Katalog) für Ausschreibungen einbeziehen
  if (config.crawlSourcesEnabled && (!sourceList || sourceList.includes('managed'))) {
    const managed = await runManagedTenderSources();
    summaries.push(...managed.summaries);
    totalManagedNew += managed.itemsNew;
  }

  const totalNew = summaries.reduce((sum, s) => sum + s.itemsNew, 0) + totalManagedNew;
  const totalChanged = summaries.reduce((sum, s) => sum + s.itemsChanged, 0);
  const queuedJobs = summaries.filter((s) => s.browser).map((s) => s.sourceId);
  const queuedNote = queuedJobs.length ? ` | Browser-Jobs eingereiht: ${queuedJobs.join(', ')}` : '';
  crawlState = {
    running: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    message: `Crawl beendet: ${totalNew} neu, ${totalChanged} geändert${enriched ? `, ${enriched} angereichert` : ''}${queuedNote}`,
    summaries,
  };
  return crawlState;
}

async function crawlOneSource(portalId, portal, source) {
  const log = startCrawlLog(portalId);
  const summary = {
    id: log.id,
    sourceId: portalId,
    sourceName: source.name,
    status: 'running',
    itemsDiscovered: 0,
    itemsNew: 0,
    itemsChanged: 0,
    errors: 0,
    errorMessage: null,
    tenderIds: [],
  };
  const now = new Date().toISOString();

  try {
    const rateLimit = portal.meta?.rateLimit || { maxRequests: 15, windowMs: 60000 };
    const limiter = registry.for(portalId, rateLimit.maxRequests, rateLimit.windowMs);

    await limiter.acquire();
    const tenders = await withRetry(() =>
      portal.discover({
        maxResults: config.maxResultsPerPortal,
        rateLimiter: limiter,
      })
    );
    summary.itemsDiscovered = tenders.length;

    for (const tender of tenders) {
      try {
        // Respektvolle Verzögerung zwischen den Requests
        await sleep(config.requestDelayMs);
        const result = saveTender(tender, now);
        if (result.isNew) {
          summary.itemsNew += 1;
          summary.tenderIds.push(result.tenderId);
        } else if (result.changed) {
          summary.itemsChanged += 1;
          summary.tenderIds.push(result.tenderId);
        }
      } catch (error) {
        summary.errors += 1;
        console.error(`[${portalId}] Speichern von Tender fehlgeschlagen (${tender.title}):`, error.message);
      }
    }

    updateSourceCrawlTime(portalId, now);
    summary.status = summary.errors > 0 ? 'completed_with_errors' : 'completed';
  } catch (error) {
    summary.status = 'failed';
    summary.errorMessage = error.stack || error.message;
    summary.errors += 1;
    console.error(`[${portalId}] Crawl fehlgeschlagen:`, error.message);
  } finally {
    finishCrawlLog(summary);
  }
  return summary;
}

/**
 * Entdeckt und verarbeitet Ausschreibungsquellen aus dem verwalteten Katalog.
 */
async function runManagedTenderSources() {
  seedCrawlSources();
  const discovered = await runAllHttpDiscovery({ declaredKind: 'tender' });
  const processed = await processDiscoveredInbox({ classification: 'tender', limit: 60 });
  let itemsNew = 0;
  let itemsChanged = 0;
  let errors = 0;
  for (const r of processed) {
    if (r.error) {
      errors += 1;
      continue;
    }
    if (r.kind === 'tender') {
      if (r.isNew) itemsNew += 1;
      else if (r.changed) itemsChanged += 1;
    }
  }
  const discoveredCount = discovered.reduce((sum, d) => sum + (d.itemsDiscovered || 0), 0);
  const summaries = [{
    id: null,
    sourceId: 'managed',
    sourceName: 'Verwaltete Quellen (Katalog)',
    status: errors > 0 ? 'completed_with_errors' : 'completed',
    itemsDiscovered: discoveredCount,
    itemsNew,
    itemsChanged,
    errors,
    errorMessage: null,
    tenderIds: [],
  }];
  return { summaries, itemsNew };
}

export default { runCrawl, getCrawlStatus, enrichTenders };