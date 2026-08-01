import config from './config.js';
import {
  claimNextBrowserJob,
  updateJobProgress,
  completeBrowserJob,
  finishBrowserJob,
  requestCancelJob,
  recoverStaleJobs,
  getCrawlSource,
  getCrawlSourceByKey,
} from './db.js';
import { sleep } from './utils.js';
import { runEvergabeJob } from './browser-portals/evergabe.js';
import { runGenericBrowserSource } from './discovery/browser.js';

const runners = {
  evergabe: runEvergabeJob,
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
    updateJobProgress(job.id, lastProgress);
  }, config.workerHeartbeatMs);

  try {
    const result = await runner({
      job,
      onProgress: (progress) => {
        lastProgress = {
          pagesDone: progress.pagesDone,
          itemsDiscovered: progress.itemsDiscovered,
          itemsNew: progress.itemsNew,
          itemsChanged: progress.itemsChanged,
        };
        updateJobProgress(job.id, lastProgress);
        console.log(
          `[worker] ${job.source_id}: Seite ${progress.pageNumber ?? progress.pagesDone}, ` +
          `${progress.itemsDiscovered} Treffer, ${progress.itemsNew} neu, ${progress.itemsChanged} geändert ` +
          `(Modus: ${progress.mode})`
        );
      },
    });

    completeBrowserJob(job.id, {
      pagesDone: result.pagesDone,
      itemsDiscovered: result.itemsDiscovered,
      itemsNew: result.itemsNew,
      itemsChanged: result.itemsChanged,
    });
    console.log(`[worker] Job ${job.id} abgeschlossen (${job.source_id}): ${result.itemsDiscovered} Treffer, ${result.itemsNew} neu.`);
  } catch (error) {
    const cancelled = Boolean(error.cancelled) || error.name === 'CanceledError';
    if (cancelled) {
      finishBrowserJob(job.id, 'cancelled', { error: error.message });
      console.log(`[worker] Job ${job.id} abgebrochen.`);
    } else if (job.attempt >= job.max_attempts) {
      finishBrowserJob(job.id, 'failed', { error: error.message });
      console.error(`[worker] Job ${job.id} endgültig fehlgeschlagen:`, error.message);
    } else {
      finishBrowserJob(job.id, 'retry', { error: error.message });
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

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (!config.browserWorkerEnabled) {
  console.log('[worker] Deaktiviert (BROWSER_WORKER_ENABLED=false).');
  process.exit(0);
}

console.log(`[worker] ${config.workerId} startet (Polling ${config.workerPollIntervalMs}ms, Runner: ${Object.keys(runners).join(', ')})`);
loop();
