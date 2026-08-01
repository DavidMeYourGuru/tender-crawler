import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-crawler-discovery-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.AUTH_ENABLED = 'false';
process.env.CRAWL_ON_START = 'false';

const { classifyDocument } = await import('../src/discovery/classify.js');
const { parseHtmlList, extractDetailText } = await import('../src/discovery/html-list.js');
const { normalizeUrl, isPrivateHost, isSafeHostname, assertSafeUrl } = await import('../src/discovery/urls.js');
const { seedCrawlSources, PARSER_VERSION } = await import('../src/discovery/sources.js');
const {
  listCrawlSources,
  addCrawlSource,
  addDiscoveredDocument,
  classifyDiscoveredDocument,
  linkDiscoveredDocument,
  listDiscoveredDocuments,
  recordSourceRun,
  getSourceRuns,
  chunkText,
  makeChunkKey,
  saveDocumentChunks,
  getDocumentChunks,
  saveSourceDocument,
  getSourceDocument,
  getOrCreateEmbeddingModel,
} = await import('../src/db.js');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('seedCrawlSources registriert den Katalog (Förderinfo + Tender)', () => {
  const n = seedCrawlSources();
  assert.ok(n >= 4);
  const all = listCrawlSources();
  assert.ok(all.length >= 4);
  const keys = all.map((s) => s.source_key);
  assert.ok(keys.includes('foerderinfo'));
  // Förderbereich ist auf Förderinfo beschränkt
  const funding = all.filter((s) => s.declared_kind === 'funding');
  assert.ok(funding.length >= 1);
  assert.ok(funding.every((s) => s.source_key === 'foerderinfo'));
});

test('addCrawlSource ist idempotent über source_key', () => {
  const a = addCrawlSource({ sourceKey: 'test-src', name: 'Test', url: 'https://example.com', declaredKind: 'funding' });
  const b = addCrawlSource({ sourceKey: 'test-src', name: 'Test', url: 'https://example.com', declaredKind: 'funding' });
  assert.equal(a.id, b.id);
});

test('classifyDocument unterscheidet Funding/Tender/Unknown', () => {
  const f = classifyDocument('Förderrichtlinie zur digitalen Kompetenz', 'Antragsberechtigt sind Hochschulen, Förderquote 100%');
  assert.equal(f.classification, 'funding');
  const t = classifyDocument('Vergabe von IT-Leistungen', 'Offenes Verfahren, Angebotsfrist 30.06.2026');
  assert.equal(t.classification, 'tender');
  const u = classifyDocument('Jahresbericht', 'Der Bericht fasst Ergebnisse zusammen.');
  assert.equal(u.classification, 'unknown');
});

test('parseHtmlList extrahiert Einträge mit Fallback-Selektoren', () => {
  const html = '<html><body><article><h2>Programm Alpha</h2><a href="/a">mehr</a><time>12.05.2026</time></article><article><h2>Call Beta</h2><a href="/b">mehr</a></article></body></html>';
  const items = parseHtmlList(html, 'https://example.com/');
  assert.ok(items.length >= 2);
  assert.equal(items[0].title, 'Programm Alpha');
  assert.ok(items[0].url.startsWith('https://example.com/a'));
});

test('extractDetailText findet Hauptinhalt', () => {
  const html = '<html><body><main>Dies ist ein ausführlicher Bekanntmachungstext mit genügend Länge für die Extraktion und weiteren Details zur Förderung.</main></body></html>';
  const d = extractDetailText(html);
  assert.ok(d.text.includes('Bekanntmachungstext'));
});

test('normalizeUrl und SSRF-Schutz', () => {
  assert.equal(normalizeUrl('/pfad', 'https://example.com/'), 'https://example.com/pfad');
  assert.equal(normalizeUrl('http://127.0.0.1/x'), null);
  assert.equal(normalizeUrl('http://10.0.0.1/x'), null);
  assert.equal(isPrivateHost('192.168.1.1'), true);
  assert.equal(isPrivateHost('example.com'), false);
});

test('SSRF-Schutz deckt IPv6 und private Ranges ab', () => {
  assert.equal(isPrivateHost('[::1]'), true);
  assert.equal(isPrivateHost('[::ffff:127.0.0.1]'), true);
  assert.equal(isPrivateHost('[::ffff:10.0.0.1]'), true);
  assert.equal(isPrivateHost('[fc00::1]'), true);
  assert.equal(isPrivateHost('[fe80::1]'), true);
  assert.equal(isSafeHostname('[2001:db8::1]'), true);
  assert.throws(() => assertSafeUrl('http://127.0.0.1:11434/'), /Unzulässiger Host/);
  assert.throws(() => assertSafeUrl('ftp://example.com/x'), /Unzulässiges Protokoll/);
  assert.doesNotThrow(() => assertSafeUrl('https://example.com/x'));
});

test('chunkText und stabile chunk_keys', () => {
  const text = 'Wort '.repeat(1200);
  const chunks = chunkText(text, { chunkWords: 200, overlapWords: 20 });
  assert.ok(chunks.length >= 5);
  const n = saveDocumentChunks('tender', 42, text, { docVersion: 1 });
  assert.ok(n >= 1);
  const read = getDocumentChunks('tender', 42);
  assert.equal(read.length, n);
  assert.equal(new Set(read.map((c) => c.chunk_key)).size, read.length);
});

test('saveSourceDocument speichert versionierte Rohdokumente', () => {
  const r1 = saveSourceDocument({ docKind: 'funding', entityId: 99, canonicalUrl: 'https://example.com/p', content: 'Version eins Inhalt' });
  assert.equal(r1.docVersion, 1);
  assert.equal(r1.changed, true);
  const r2 = saveSourceDocument({ docKind: 'funding', entityId: 99, canonicalUrl: 'https://example.com/p', content: 'Version eins Inhalt' });
  assert.equal(r2.changed, false);
  const r3 = saveSourceDocument({ docKind: 'funding', entityId: 99, canonicalUrl: 'https://example.com/p', content: 'Version zwei Inhalt geändert' });
  assert.equal(r3.docVersion, 2);
  const doc = getSourceDocument('funding', 99);
  assert.equal(doc.doc_version, 2);
});

test('getOrCreateEmbeddingModel ist idempotent', () => {
  const a = getOrCreateEmbeddingModel({ provider: 'test', model: 'm', dimensions: 384, version: '1' });
  const b = getOrCreateEmbeddingModel({ provider: 'test', model: 'm', dimensions: 384, version: '1' });
  assert.equal(a.id, b.id);
});

test('discovered-documents Inbox + Klassifikation + Link', () => {
  const src = addCrawlSource({ sourceKey: 'inbox-src', name: 'Inbox', url: 'https://example.com', declaredKind: 'mixed' });
  const d = addDiscoveredDocument({ sourceId: src.id, canonicalUrl: 'https://example.com/call', title: 'Förderaufruf', fingerprint: 'x' });
  assert.equal(d.status, 'new');
  const classified = classifyDiscoveredDocument(d.id, { classification: 'funding', confidence: 0.9 });
  assert.equal(classified.classification, 'funding');
  // Nur Status prüfen (kein Fake-FK auf funding_programs/tenders)
  linkDiscoveredDocument(d.id, { status: 'processed' });
  const list = listDiscoveredDocuments({ classification: 'funding', status: 'processed' });
  assert.ok(list.some((x) => x.id === d.id && x.status === 'processed'));
});

test('recordSourceRun und getSourceRuns', () => {
  const src = addCrawlSource({ sourceKey: 'run-src', name: 'Run', url: 'https://example.com', declaredKind: 'tender' });
  const runId = recordSourceRun({ sourceId: src.id, mode: 'probe', httpStatus: 200, itemsDiscovered: 3, parserVersion: PARSER_VERSION });
  assert.ok(runId > 0);
  const runs = getSourceRuns(src.id);
  assert.ok(runs.some((r) => r.id === runId && r.http_status === 200));
});
