import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-crawler-backfill-test-'));
process.env.DB_PATH = path.join(tmpDir, 'backfill.sqlite');
process.env.AUTH_ENABLED = 'false';
process.env.CRAWL_ON_START = 'false';
const { db, saveTender, saveSourceDocument, getDocumentChunks, enqueueBrowserJob, finishBrowserJob, backfillSearchText } = await import('../src/db.js');
const { enqueueDetailBackfillJob, pruneCurrentTenderVersions, runResumableHttpBackfill } = await import('../src/cli-backfill-details.js');

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Backfill-Queue meldet aktive Jobs kontrolliert statt null zu dereferenzieren', () => {
  const job = enqueueBrowserJob('niedersachsen', { mode: 'detail_backfill' });
  assert.ok(job);
  assert.throws(() => enqueueDetailBackfillJob(), /aktive Queue/);
  finishBrowserJob(job.id, 'cancelled', { error: 'Testabbruch' });
});

test('Tender-Backfill bleibt idempotent und entfernt alte Tender-Chunks', () => {
  const result = saveTender({ sourceId: 'nrw', externalId: 'backfill-1', title: 'Backfill', url: 'https://example.test/tender', description: 'Alttext', contentHash: 'backfill-1' });
  saveSourceDocument({ docKind: 'tender', entityId: result.tenderId, canonicalUrl: 'https://example.test/tender', content: 'alte Version', replaceCurrent: false });
  assert.ok(db.prepare("SELECT COUNT(*) AS c FROM source_documents WHERE doc_kind='tender' AND entity_id=?").get(result.tenderId).c >= 2);
  backfillSearchText();
  const afterFirst = {
    docs: db.prepare("SELECT COUNT(*) AS c FROM source_documents WHERE doc_kind='tender' AND entity_id=?").get(result.tenderId).c,
    chunks: getDocumentChunks('tender', result.tenderId).length,
  };
  backfillSearchText();
  const afterSecond = {
    docs: db.prepare("SELECT COUNT(*) AS c FROM source_documents WHERE doc_kind='tender' AND entity_id=?").get(result.tenderId).c,
    chunks: getDocumentChunks('tender', result.tenderId).length,
  };
  assert.deepEqual(afterSecond, afterFirst);
  assert.equal(afterFirst.docs, 1);
  assert.ok(afterFirst.chunks >= 1);
  assert.deepEqual(pruneCurrentTenderVersions(['nrw']), { skipped: true, reason: 'historische Versionen bleiben erhalten', sources: ['nrw'] });
});

test('HTTP-Detail-Backfill verarbeitet den Snapshot trotz Mittelfehler und setzt nur Fehler fort', async () => {
  const sourceId = 'resume-test';
  const ids = [1, 2, 3];
  const states = new Map();
  const progress = {};
  const firstCalls = [];
  const first = await runResumableHttpBackfill(sourceId, {
    ids,
    progressState: progress,
    getTender: (id) => states.get(id),
    enrich: async ([id]) => { firstCalls.push(id); if (id === 2) throw new Error('simulierter Mittelfehler'); states.set(id, { detail_status: 'complete' }); return 1; },
  });
  assert.deepEqual(firstCalls, [1, 2, 3]);
  assert.equal(first.completed, false);
  assert.deepEqual(progress[sourceId].successfulIds.sort(), ['1', '3']);
  assert.deepEqual(progress[sourceId].failedIds, ['2']);

  const secondCalls = [];
  const resumed = await runResumableHttpBackfill(sourceId, {
    ids,
    progressState: progress,
    getTender: (id) => states.get(id),
    enrich: async ([id]) => { secondCalls.push(id); states.set(id, { detail_status: 'complete' }); return 1; },
  });
  assert.deepEqual(secondCalls, [2]);
  assert.equal(resumed.completed, true);
  assert.equal(progress[sourceId], undefined);

  const newRunCalls = [];
  await runResumableHttpBackfill(sourceId, {
    ids,
    progressState: progress,
    getTender: (id) => states.get(id),
    enrich: async ([id]) => { newRunCalls.push(id); states.set(id, { detail_status: 'complete' }); return 1; },
  });
  assert.deepEqual(newRunCalls, [1, 2, 3]);
});

test('HTTP-Detail-Backfill erkennt neue Fehler auch bei vorher vollständigem Bestand', async () => {
  const report = { failed: 0 };
  const progress = {};
  const result = await runResumableHttpBackfill('error-delta-test', {
    ids: [7],
    progressState: progress,
    getTender: () => ({ detail_status: 'complete' }),
    report,
    enrich: async (_ids, options) => { options.report.failed += 1; return 0; },
  });
  assert.equal(result.completed, false);
  assert.deepEqual(result.failedIds, ['7']);
  assert.deepEqual(progress['error-delta-test'].failedIds, ['7']);
});
