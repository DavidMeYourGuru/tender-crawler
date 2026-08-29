import config from './config.js';
import {
  claimNextBrowserJob,
  updateJobProgress,
  completeBrowserJob,
  finishBrowserJob,
  requestCancelJob,
  recoverStaleJobs,
  getBrowserJobById,
  getCrawlSource,
  getCrawlSourceByKey,
} from './db.js';
import { sleep } from './utils.js';
import { runEvergabeJob } from './browser-portals/evergabe.js';
import { runNiedersachsenJob } from './browser-portals/niedersachsen.js';
import { runGenericBrowserSource } from './discovery/browser.js';

const runners = {
  evergabe: runEvergabeJob,
  niedersachsen: runNiedersachsenJob,
};

/**
 * Ermittelt den Runner für einen Job. Verwaltete Browser-Quellen
 * (crawl_sources mit access='browser') nutzen den generischen Runner.
 */
function resolveRunner(job) {
  if (runners[job.source_id]) return runners[job.source_id];
  // crawl_jobs.source_id speichert den String-Source-Key (FK auf sources.id);
  // verwaltete Browser-Quellen werden deshalb auch per Key aufgelöst.
  const source = getCrawlSource(job.source_id) || getCrawlSourceByKey(job.source_id);
  if (source && source.access === 'browser') return runGenericBrowserSource;
  return null;
}

let shuttingDown = false;
let currentJobId = null;
let workerLoopPromise = null;
let signalHandlersInstalled = false;

function refreshCancellation(job) {
  const current = getBrowserJobById(job.id);
  job.cancel_requested = current?.cancel_requested ? 1 : 0;
  return Boolean(job.cancel_requested);
}

/**
 * Führt einen übernommenen Browser-Job mit Heartbeat, Retry und
 * Fortschritts-Meldungen aus.
 */
async function runJob(job) {
  const runner = resolveRunner(job);
  if (!runner) {
    finishBrowserJob(job.id, 'failed', { error: `Kein Runner für Quelle '${job.source_id}'` });
    return;
  }

  let lastProgress = {};
  const heartbeat = setInterval(() => {
    refreshCancellation(job);
    updateJobProgress(job.id, lastProgress);
  }, config.workerHeartbeatMs);

  try {
    const result = await runner({
      job,
      onProgress: (progress) => {
        const cancellationRequested = refreshCancellation(job);
        lastProgress = {
          pagesDone: progress.pagesDone,
          itemsDiscovered: progress.itemsDiscovered,
          itemsNew: progress.itemsNew,
          itemsChanged: progress.itemsChanged,
        };
        updateJobProgress(job.id, lastProgress);
        if (cancellationRequested) {
          throw Object.assign(new Error('Job wurde abgebrochen'), { cancelled: true });
        }
        console.log(
          `[worker] ${job.source_id}: Seite ${progress.pageNumber ?? progress.pagesDone}, ` +
          `${progress.itemsDiscovered} Treffer, ${progress.itemsNew} neu, ${progress.itemsChanged} geändert ` +
          `(Modus: ${progress.mode})`
        );
      },
    });

    if (refreshCancellation(job)) {
      finishBrowserJob(job.id, 'cancelled', { ...lastProgress, error: 'Job wurde abgebrochen' });
      console.log(`[worker] Job ${job.id} abgebrochen.`);
    } else {
      completeBrowserJob(job.id, {
        pagesDone: result.pagesDone,
        itemsDiscovered: result.itemsDiscovered,
        itemsNew: result.itemsNew,
        itemsChanged: result.itemsChanged,
      });
      console.log(`[worker] Job ${job.id} abgeschlossen (${job.source_id}): ${result.itemsDiscovered} Treffer, ${result.itemsNew} neu.`);
    }
  } catch (error) {
    const cancelled = Boolean(error.cancelled) || error.name === 'CanceledError';
    if (cancelled) {
      finishBrowserJob(job.id, 'cancelled', { ...lastProgress, error: error.message });
      console.log(`[worker] Job ${job.id} abgebrochen.`);
    } else if (job.attempt >= job.max_attempts) {
      finishBrowserJob(job.id, 'failed', { ...lastProgress, error: error.message });
      console.error(`[worker] Job ${job.id} endgültig fehlgeschlagen:`, error.message);
    } else {
      finishBrowserJob(job.id, 'retry', { ...lastProgress, error: error.message });
      console.warn(`[worker] Job ${job.id} auf Retry gesetzt (Versuch ${job.attempt}/${job.max_attempts}):`, error.message);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function loop() {
  while (!shuttingDown) {
    try {
      recoverStaleJobs(new Date().toISOString(), config.workerStaleAfterMs);

      const job = claimNextBrowserJob(config.workerId);
      if (!job) {
        await sleep(config.workerPollIntervalMs);
        continue;
      }
      currentJobId = job.id;
      console.log(`[worker] Job ${job.id} übernommen: ${job.source_id} (Versuch ${job.attempt})`);
      await runJob(job);
      currentJobId = null;
    } catch (error) {
      console.error('[worker] Loop-Fehler:', error.message);
      await sleep(config.workerPollIntervalMs);
    }
  }
}

function shutdown(signal) {
  console.log(`[worker] ${signal} empfangen – fahre herunter …`);
  shuttingDown = true;
  if (currentJobId != null) {
    requestCancelJob(currentJobId);
  }
  setTimeout(() => process.exit(0), 5000).unref();
}

export function startWorker() {
  if (!config.browserWorkerEnabled) {
    console.log('[worker] Deaktiviert (BROWSER_WORKER_ENABLED=false).');
    return null;
  }
  if (workerLoopPromise) return workerLoopPromise;
  shuttingDown = false;
  if (!signalHandlersInstalled) {
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    signalHandlersInstalled = true;
  }
  console.log(`[worker] ${config.workerId} startet (Polling ${config.workerPollIntervalMs}ms, Runner: ${Object.keys(runners).join(', ')})`);
  workerLoopPromise = loop().finally(() => { workerLoopPromise = null; });
  return workerLoopPromise;
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) startWorker();
