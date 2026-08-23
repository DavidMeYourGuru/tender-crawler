import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Temporäre DB vor dem Import von db.js setzen
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-crawler-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.AUTH_ENABLED = 'false';
process.env.CRAWL_ON_START = 'false';

const {
  db,
  saveTender,
  getTenderById,
  getTenderByExternalId,
  getTenderBundleById,
  getTenderChanges,
  getSources,
  getStats,
  getCrawlHistory,
  listTenders,
  startCrawlLog,
  finishCrawlLog,
} = await import('../src/db.js');

function makeTender(overrides = {}) {
  return {
    sourceId: 'ted',
    externalId: 'EXT-001',
    title: 'Forschungsprojekt KI',
    url: 'https://example.com/tender/1',
    description: 'Entwicklung eines KI-Systems für die Forschung.',
    contractingAuthority: 'Bundesministerium für Forschung',
    cpvCodes: ['73000000', '73100000'],
    cpvLabels: ['Forschungs- und Entwicklungstätigkeiten'],
    estimatedValueCents: 25000000,
    estimatedValueCurrency: 'EUR',
    placeOfPerformance: 'Berlin',
    publicationDate: '2026-07-01',
    submissionDeadline: '2026-09-15',
    contentHash: 'hash-1',
    status: 'open',
    ...overrides,
  };
}

before(() => {
  // Testdaten bereinigen
  const { db } = globalThis;
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('sources werden geseedet', () => {
  const sources = getSources();
  assert.ok(sources.length >= 5);
  assert.ok(sources.some((s) => s.id === 'ted'));
});

test('saveTender fügt neuen Tender ein', () => {
  const result = saveTender(makeTender());
  assert.equal(result.isNew, true);
  assert.equal(result.changed, true);

  const tender = getTenderById(result.tenderId);
  assert.equal(tender.title, 'Forschungsprojekt KI');
  assert.equal(tender.source_id, 'ted');
  assert.equal(tender.estimated_value_cents, 25000000);
});

test('saveTender erkennt keine Änderung bei identischen Daten', () => {
  const result = saveTender(makeTender());
  assert.equal(result.isNew, false);
  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
});

test('saveTender erkennt Titeländerung und protokolliert sie', () => {
  const result = saveTender(makeTender({ title: 'Forschungsprojekt KI 2.0', contentHash: 'hash-2' }));
  assert.equal(result.isNew, false);
  assert.equal(result.changed, true);
  assert.ok(result.changes.some((c) => c.field === 'title'));

  const changes = getTenderChanges(result.tenderId);
  assert.ok(changes.length > 0);
  const titleChange = changes.find((c) => c.field === 'title');
  assert.equal(titleChange.old_value, 'Forschungsprojekt KI');
  assert.equal(titleChange.new_value, 'Forschungsprojekt KI 2.0');
});

test('saveTender erkennt inhaltliche Änderung über contentHash', () => {
  const result = saveTender(makeTender({ contentHash: 'hash-3' }));
  assert.equal(result.changed, true);
  assert.ok(result.changes.some((c) => c.field === 'content'));
});

test('listTenders filtert nach Status', () => {
  const result = listTenders({ status: ['open'] });
  assert.ok(result.total >= 1);
  assert.ok(result.tenders.every((t) => t.status === 'open'));
});

test('listTenders unterstützt Volltextsuche', () => {
  const result = listTenders({ q: 'KI-System' });
  assert.ok(result.total >= 1);
});

test('listTenders filtert nach Quellen', () => {
  const result = listTenders({ sources: ['ted'] });
  assert.ok(result.total >= 1);
  assert.ok(result.tenders.every((t) => t.source_id === 'ted'));
});

test('listTenders liefert paginierte Ergebnisse', () => {
  const result = listTenders({ page: 1, limit: 1 });
  assert.equal(result.limit, 1);
  assert.equal(result.tenders.length, 1);
});

test('getStats liefert Kennzahlen', () => {
  const stats = getStats();
  assert.ok(stats.totalTenders >= 1);
  assert.ok(stats.totalOpen >= 1);
  assert.ok(Array.isArray(stats.bySource));
  assert.ok(Array.isArray(stats.byStatus));
});

test('crawl-log kann gestartet und beendet werden', () => {
  const log = startCrawlLog('ted');
  assert.ok(log.id > 0);
  finishCrawlLog({
    id: log.id,
    status: 'completed',
    itemsDiscovered: 5,
    itemsNew: 2,
    itemsChanged: 0,
    errors: 0,
    errorMessage: null,
  });
  const history = getCrawlHistory(10);
  assert.ok(history.length >= 1);
  assert.equal(history[0].status, 'completed');
});

test('listTenders parst JSON-Spalten', () => {
  const result = listTenders({ limit: 1 });
  const tender = result.tenders[0];
  assert.ok(Array.isArray(tender.cpv_codes));
  assert.ok(Array.isArray(tender.cpv_labels));
});

test('Detail-Bundle wird versioniert und durch dünnen Listentreffer nicht verkürzt', () => {
  const bundleTender = makeTender({
    sourceId: 'nrw', externalId: 'bundle-001', portalProjectId: 'bundle-001',
    description: 'Vollständige Langbeschreibung', cpvCodes: ['71220000-6'],
    detailStatus: 'complete',
    detailCompleteness: { overall: 'complete', sections: { overview: 'complete', documents: 'complete' } },
    detailBundle: {
      completeness: { overall: 'complete', sections: { overview: 'complete', documents: 'complete' } },
      documents: [{ filename: 'Vergabeunterlagen.pdf', category: 'documents', locator: { href: 'https://example.test/doc.pdf' } }],
      snapshots: [{ kind: 'overview', sourceUrl: 'https://example.test/tender', content: '<main>v1</main>' }],
    },
  });
  const first = saveTender(bundleTender);
  saveTender(bundleTender);
  const thin = saveTender({
    sourceId: 'nrw', externalId: 'bundle-001', portalProjectId: 'bundle-001',
    title: bundleTender.title, url: bundleTender.url, status: 'open',
    submissionDeadline: bundleTender.submissionDeadline, contentHash: bundleTender.contentHash,
  });
  const stored = getTenderById(first.tenderId);
  const detail = getTenderBundleById(first.tenderId);
  assert.equal(thin.tenderId, first.tenderId);
  assert.equal(stored.description, 'Vollständige Langbeschreibung');
  assert.equal(detail.documents.length, 1);
  assert.equal(detail.snapshots.length, 1);
});

test('Detail-Bundle wird atomar gespeichert und fehlerhafte Bundles hinterlassen keinen Kerndatensatz', () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => saveTender(makeTender({
    sourceId: 'nrw', externalId: 'atomic-failure', portalProjectId: 'atomic-failure',
    detailBundle: { metadata: circular, completeness: { overall: 'complete' } },
  })));
  assert.equal(getTenderByExternalId('nrw', 'atomic-failure'), undefined);
});

test('Dokumente durchlaufen bei erfolgreichen Vollcrawls not_seen und removed', () => {
  const tender = makeTender({
    sourceId: 'nrw', externalId: 'visibility-001', portalProjectId: 'visibility-001',
    detailStatus: 'complete', detailCrawlKind: 'full', fullCrawlSucceeded: true,
    detailCompleteness: { overall: 'complete', sections: { documents: 'complete' } },
    detailBundle: {
      fullCrawlSucceeded: true,
      completeness: { overall: 'complete', sections: { documents: 'complete' } },
      documents: [{ filename: 'initial.pdf', category: 'documents', locator: { href: 'https://example.test/initial.pdf' } }],
    },
  });
  const first = saveTender(tender);
  const emptyBundle = {
    sourceId: tender.sourceId, externalId: tender.externalId, portalProjectId: tender.portalProjectId,
    title: tender.title, url: tender.url, status: 'open', contentHash: tender.contentHash,
    detailStatus: 'complete', detailCrawlKind: 'full', fullCrawlSucceeded: true,
    detailCompleteness: { overall: 'complete', sections: { documents: 'complete' } },
    detailBundle: { fullCrawlSucceeded: true, completeness: { overall: 'complete', sections: { documents: 'complete' } }, documents: [] },
  };
  saveTender(emptyBundle);
  assert.equal(getTenderBundleById(first.tenderId).documents[0].visibility_status, 'not_seen');
  saveTender(emptyBundle);
  assert.equal(getTenderBundleById(first.tenderId).documents[0].visibility_status, 'removed');
});
