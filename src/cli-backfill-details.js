#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import config from './config.js';
import {
  db,
  enqueueBrowserJob,
  getBrowserJobById,
  backfillSearchText,
} from './db.js';
import { enrichTenders } from './crawler/orchestrator.js';

const DEFAULT_SOURCES = ['nrw', 'niedersachsen'];
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
let lastReport = null;

function parseSources() {
  const value = process.argv.find((arg) => arg.startsWith('--sources='))?.split('=')[1];
  return (value ? value.split(',') : DEFAULT_SOURCES).map((source) => source.trim()).filter(Boolean);
}

function printUsage() {
  console.log(`Verwendung:\n  npm run backfill:details -- [--sources=nrw,niedersachsen]\n  npm run backfill:details -- --dry-run\n\nDer Lauf erstellt eine SQLite-Sicherung und benötigt für Niedersachsen den Browser-Worker.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneCurrentTenderVersions(sourceIds) {
  const placeholders = sourceIds.map(() => '?').join(',');
  const ids = db.prepare(`SELECT id FROM tenders WHERE source_id IN (${placeholders})`).all(...sourceIds).map((row) => row.id);
  if (!ids.length) return { snapshots: 0, sourceDocuments: 0, chunks: 0 };
  const idPlaceholders = ids.map(() => '?').join(',');
  const snapshotResult = db.prepare(`
    DELETE FROM tender_snapshots
    WHERE tender_id IN (${idPlaceholders})
      AND id NOT IN (
        SELECT MAX(id) FROM tender_snapshots
        WHERE tender_id IN (${idPlaceholders}) GROUP BY tender_id, kind
      )
  `).run(...ids, ...ids);
  const sourceResult = db.prepare(`
    DELETE FROM source_documents
    WHERE doc_kind = 'tender' AND entity_id IN (${idPlaceholders})
      AND id NOT IN (
        SELECT MAX(id) FROM source_documents
        WHERE doc_kind = 'tender' AND entity_id IN (${idPlaceholders}) GROUP BY entity_id
      )
  `).run(...ids, ...ids);
  const chunkResult = db.prepare(`
    DELETE FROM document_chunks
    WHERE doc_kind = 'tender' AND entity_id IN (${idPlaceholders})
      AND NOT EXISTS (
        SELECT 1 FROM source_documents sd
        WHERE sd.doc_kind = 'tender' AND sd.entity_id = document_chunks.entity_id
          AND sd.doc_version = document_chunks.doc_version
      )
  `).run(...ids);
  return { snapshots: snapshotResult.changes, sourceDocuments: sourceResult.changes, chunks: chunkResult.changes };
}

function sourceMetrics(sourceIds) {
  const placeholders = sourceIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT source_id, COUNT(*) AS tenders,
      SUM(detail_status = 'complete') AS complete,
      SUM(detail_status = 'partial') AS partial,
      SUM(detail_status IS NULL OR detail_status NOT IN ('complete','partial')) AS incomplete
    FROM tenders WHERE source_id IN (${placeholders}) GROUP BY source_id
  `).all(...sourceIds);
  const tenderRows = db.prepare(`SELECT id, source_id, detail_completeness, portal_metadata_json FROM tenders WHERE source_id IN (${placeholders})`).all(...sourceIds);
  const bySource = Object.fromEntries(sourceIds.map((sourceId) => [sourceId, {
    facts: 0, textSections: 0, documents: 0, loginRequired: 0, unknownStructure: 0, sections: {},
  }]));
  const countBySource = (table) => db.prepare(`SELECT t.source_id, COUNT(*) AS count FROM tenders t JOIN ${table} child ON child.tender_id = t.id WHERE t.source_id IN (${placeholders}) GROUP BY t.source_id`).all(...sourceIds);
  for (const table of ['tender_facts', 'tender_text_sections', 'tender_documents']) {
    for (const item of countBySource(table)) bySource[item.source_id][table === 'tender_facts' ? 'facts' : table === 'tender_text_sections' ? 'textSections' : 'documents'] = Number(item.count);
  }
  for (const tender of tenderRows) {
    const target = bySource[tender.source_id];
    let completeness = null;
    try { completeness = tender.detail_completeness ? JSON.parse(tender.detail_completeness) : null; } catch { /* Bericht bleibt robust */ }
    const sections = completeness?.sections || {};
    for (const [section, status] of Object.entries(sections)) {
      target.sections[section] ||= {};
      target.sections[section][status] = (target.sections[section][status] || 0) + 1;
      if (status === 'login_required') target.loginRequired += 1;
      if (status === 'unknown_structure') target.unknownStructure += 1;
    }
    try {
      const metadata = tender.portal_metadata_json ? JSON.parse(tender.portal_metadata_json) : null;
      if (metadata?.loginRequired) target.loginRequired += 1;
    } catch { /* ignorieren */ }
  }
  for (const row of rows) row.detail = bySource[row.source_id] || { facts: 0, textSections: 0, documents: 0, loginRequired: 0, unknownStructure: 0, sections: {} };
  return { rows, complete: rows.every((row) => Number(row.incomplete || 0) === 0 && Number(row.partial || 0) === 0) };
}

export function enqueueDetailBackfillJob(sourceId = 'niedersachsen') {
  const job = enqueueBrowserJob(sourceId, { mode: 'detail_backfill' });
  if (!job) throw new Error(`${sourceId}-Backfill konnte nicht eingereiht werden (aktive Queue vorhanden).`);
  return job;
}

async function waitForBrowserJob(jobId) {
  const deadline = Date.now() + config.browserJobTimeoutMs + 120000;
  while (Date.now() < deadline) {
    const job = getBrowserJobById(jobId);
    if (job && TERMINAL_JOB_STATES.has(job.status)) return job;
    await sleep(1000);
  }
  throw new Error(`Browser-Backfill ${jobId} hat das Zeitlimit überschritten.`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }
  const sourceIds = parseSources();
  const unknown = sourceIds.filter((sourceId) => !['nrw', 'niedersachsen'].includes(sourceId));
  if (unknown.length) throw new Error(`Nicht unterstützte Detailquelle(n): ${unknown.join(', ')}`);

  if (process.argv.includes('--dry-run')) {
    const counts = db.prepare(`SELECT source_id, COUNT(*) AS tenders FROM tenders WHERE source_id IN (${sourceIds.map(() => '?').join(',')}) GROUP BY source_id`).all(...sourceIds);
    console.log(JSON.stringify({ dryRun: true, sources: sourceIds, counts }, null, 2));
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(path.dirname(config.dbPath), `tender-detail-backfill-${timestamp}.sqlite`);
  await db.backup(backupPath);
  console.log(`[detail-backfill] Sicherung: ${backupPath}`);

  const report = lastReport = { sources: sourceIds, status: 'running', nrwEnriched: 0, niedersachsenJob: null, pruned: null, metrics: null, error: null };
  if (sourceIds.includes('nrw')) {
    const rows = db.prepare(`SELECT id FROM tenders WHERE source_id = 'nrw' ORDER BY id`).all();
    report.nrw = { failed: 0, metrics: null };
    report.nrwEnriched = await enrichTenders(rows.map((row) => row.id), { force: true, report: report.nrw });
    if (report.nrw.failed > 0) {
      throw new Error(`NRW-Detail-Backfill: ${report.nrw.failed} Detailabrufe fehlgeschlagen.`);
    }
  }
  if (sourceIds.includes('niedersachsen')) {
    const job = enqueueDetailBackfillJob('niedersachsen');
    report.niedersachsenJob = await waitForBrowserJob(job.id);
    if (report.niedersachsenJob.status !== 'completed') {
      throw new Error(`Niedersachsen-Backfill ${job.id} endete mit Status ${report.niedersachsenJob.status}: ${report.niedersachsenJob.error_detail || 'unbekannter Fehler'}`);
    }
  }
  report.metrics = sourceMetrics(sourceIds);
  report.search = { updated: backfillSearchText() };
  if (!report.metrics.complete) {
    report.status = 'partial';
    report.pruned = { skipped: true, reason: 'unvollständige oder fehlerhafte Detailergebnisse' };
  } else {
    report.pruned = pruneCurrentTenderVersions(sourceIds);
    report.status = 'complete';
  }
  console.log(JSON.stringify(report, null, 2));
}

export { parseSources, pruneCurrentTenderVersions, sourceMetrics, waitForBrowserJob, main };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[detail-backfill] Fehlgeschlagen:', error.message);
    if (lastReport) {
      lastReport.status = error.message.includes('aktive Queue') ? 'partial' : 'failed';
      lastReport.error = error.message;
      try { lastReport.metrics = sourceMetrics(lastReport.sources); } catch { /* DB bereits geschlossen/defekt */ }
      console.error(JSON.stringify(lastReport, null, 2));
    }
    process.exitCode = 1;
  });
}
