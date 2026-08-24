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
const { enqueueDetailBackfillJob, pruneCurrentTenderVersions } = await import('../src/cli-backfill-details.js');

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
  assert.deepEqual(pruneCurrentTenderVersions(['nrw']), { snapshots: 0, sourceDocuments: 0, chunks: 0 });
});
