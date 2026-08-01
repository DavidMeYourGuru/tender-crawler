/**
 * Förderprogramm-Crawl-Orchestrator.
 * Eigenständig und unabhängig vom Vergabe-Crawl.
 *
 * Der Förder-Crawl läuft ausschließlich über die registrierten
 * Förder-Adapter (derzeit nur Förderinfo). Fremde Quellen werden weder
 * über den Katalog noch über Request-Parameter gestartet.
 */
import config from '../config.js';
import { loadFundingSources } from './sources/registry.js';
import { extractFundingProgram } from './extractor.js';
import { mapLimit } from '../utils.js';
import { RateLimiter, RateLimiterRegistry } from '../crawler/rate-limiter.js';
import {
  saveFundingProgram,
  startFundingCrawlLog,
  finishFundingCrawlLog,
  getFundingProgramById,
  fundingProgramExists,
} from '../db.js';

const registry = new RateLimiterRegistry(new RateLimiter(config.fundingMaxRequestsPerMinute, 60000));
let activeFundingCrawl = null;
let fundingCrawlState = { running: false, message: 'Noch kein Förder-Crawl in diesem Prozess.', startedAt: null };

export function getFundingCrawlStatus() {
  return { ...fundingCrawlState };
}

export function runFundingCrawl({ llmEnabled = config.fundingLlmEnabled, maxResults = null } = {}) {
  if (activeFundingCrawl) return activeFundingCrawl;
  activeFundingCrawl = doFundingCrawl({ llmEnabled, maxResults }).finally(() => {
    activeFundingCrawl = null;
  });
  return activeFundingCrawl;
}

async function doFundingCrawl({ llmEnabled, maxResults }) {
  const startedAt = new Date().toISOString();
  fundingCrawlState = { running: true, startedAt, message: 'Förder-Crawl läuft' };
  const summary = {
    itemsDiscovered: 0,
    itemsNew: 0,
    itemsChanged: 0,
    documentsLoaded: 0,
    extractionErrors: 0,
    needsReview: 0,
    errors: 0,
    errorMessage: null,
    status: 'running',
  };
  const log = startFundingCrawlLog(null);
  summary.id = log.id;

  try {
    const sources = await loadFundingSources();
    for (const [sourceId, source] of sources) {
      await runOneFundingSource(source, summary, llmEnabled, maxResults);
    }
    summary.status = summary.errors > 0 ? 'completed_with_errors' : 'completed';
  } catch (error) {
    summary.status = 'failed';
    summary.errorMessage = error.stack || error.message;
    summary.errors += 1;
    console.error('[funding] Förder-Crawl fehlgeschlagen:', error.message);
  } finally {
    finishFundingCrawlLog(summary);
    fundingCrawlState = {
      running: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      message: `Förder-Crawl beendet: ${summary.itemsNew} neu, ${summary.itemsChanged} geändert, ${summary.documentsLoaded} Dokumente, ${summary.needsReview} prüfbedürftig`,
      summary,
    };
  }
  return fundingCrawlState;
}

async function runOneFundingSource(source, summary, llmEnabled, maxResults) {
  const rateLimit = source.meta?.rateLimit || { maxRequests: 10, windowMs: 60000 };
  const limiter = registry.for(source.meta.id, rateLimit.maxRequests, rateLimit.windowMs);
  console.log(`[funding] Start Quelle ${source.meta.id} (${source.meta.name})${maxResults ? ` – max ${maxResults} Calls` : ''}`);

  let candidates;
  try {
    await limiter.acquire();
    candidates = await source.discover({ rateLimiter: limiter, maxResults });
  } catch (error) {
    summary.errors += 1;
    console.error(`[funding] Discover ${source.meta.id} fehlgeschlagen:`, error.message);
    return;
  }
  summary.itemsDiscovered += candidates.length;
  if (candidates.meta) {
    const { total, pageCount, pageErrors } = candidates.meta;
    console.log(`[funding] ${source.meta.id}: ${candidates.length} eindeutige Calls (${total} Treffer, ${pageCount} Seiten)`);
    if (pageErrors?.length) {
      summary.errors += pageErrors.length;
      for (const pe of pageErrors) {
        console.warn(`[funding] ${source.meta.id} Seite ${pe.page} fehlgeschlagen: ${pe.error}`);
      }
    }
  }

  // Kandidaten mit begrenzter Parallelität verarbeiten. Der Rate-Limiter
  // deckelt weiterhin die Gesamtzahl an HTTP-Requests je Quelle; die extra
  // künstliche Verzögerung (fundingRequestDelayMs) entfällt, da jeder Request
  // bereits über den Limiter läuft.
  await mapLimit(candidates, config.fundingCrawlConcurrency, async (candidate) => {
    try {
      // Deterministische Existenzprüfung: Nur NEUE Förder-Calls werden mit dem
      // LLM analysiert. Bereits vorhandene Calls werden übersprungen (kein LLM,
      // kein erneutes Laden des Volltexts).
      if (fundingProgramExists(candidate.sourceId, candidate.externalId)) {
        console.log(`[funding] ${candidate.externalId}: bereits vorhanden, kein LLM`);
        return;
      }

      await limiter.acquire();

      let docs = [];
      if (typeof source.fetchDocs === 'function') {
        docs = await source.fetchDocs(candidate, { rateLimiter: limiter });
      }
      summary.documentsLoaded += docs.length;

      if (!docs.length) {
        console.warn(`[funding] Keine Dokumente für ${candidate.externalId} (${candidate.title})`);
        return;
      }

      const program = await extractFundingProgram(docs, {
        base: {
          title: candidate.title,
          publicationDate: candidate.publicationDate,
          submissionDeadline: candidate.submissionDeadline,
          primaryUrl: candidate.primaryUrl || candidate.url,
        },
      });
      program.sourceId = candidate.sourceId;
      program.externalId = candidate.externalId;
      program.extractedAt = new Date().toISOString();
      program.extractionModel = llmEnabled ? 'hybrid' : 'deterministic';

      const result = saveFundingProgram(program);
      if (result.isNew) summary.itemsNew += 1;
      else if (result.changed) summary.itemsChanged += 1;
      if (result.needsReview) summary.needsReview += 1;
      if (program.needsReview) summary.needsReview += 1;

      console.log(`[funding] ${candidate.externalId}: ${result.isNew ? 'neu' : result.changed ? 'geändert' : 'unverändert'}`);
    } catch (error) {
      summary.errors += 1;
      summary.extractionErrors += 1;
      console.error(`[funding] Verarbeitung von ${candidate.externalId} fehlgeschlagen:`, error.message);
    }
  });
}

export function getFundingProgramForId(id) {
  return getFundingProgramById(id);
}

export default { runFundingCrawl, getFundingCrawlStatus };
