import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { httpClient } from '../src/crawler/http-client.js';
import * as dtvp from '../src/portals/dtvp.js';
import * as ted from '../src/portals/ted.js';
import * as evergabe from '../src/browser-portals/evergabe.js';
import { parseCosinexCommunicationPage, parseCosinexDocumentsPage, parseCosinexEformsPage } from '../src/portals/cosinex-detail.js';

const fixture = (name) => fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', name), 'utf8');

const originalGet = httpClient.get;
const originalPost = httpClient.post;
after(() => { httpClient.get = originalGet; httpClient.post = originalPost; });

const COSINEX_FORMS = fixture('dtvp-eforms.html');

test('Cosinex-Parser materialisieren eForms, Dokumente und Kommunikation gemeinsam', () => {
  const forms = parseCosinexEformsPage(COSINEX_FORMS, 'https://dtvp.test/processdata/eforms');
  assert.equal(forms.submissionDeadline, '2026-12-15');
  assert.equal(forms.estimatedValueCents, 25000000);
  assert.ok(forms.criteria.length >= 1);
  assert.ok(forms.textSections[0].text.includes('Verfahrensart'));

  const docs = parseCosinexDocumentsPage(fixture('dtvp-documents.html'), 'https://dtvp.test/documents');
  assert.equal(docs.documents.length, 3);
  assert.ok(docs.documents.every((doc) => doc.downloadStatus === 'not_requested'));
  assert.equal(docs.documents.find((doc) => doc.filename === 'Gesamtarchiv.zip').mimeType, 'application/zip');

  const communication = parseCosinexCommunicationPage(fixture('dtvp-communication.html'), 'https://dtvp.test/communication/anonym');
  assert.equal(communication.messages.length, 2);
  assert.equal(communication.messages[0].subject, 'Rückfrage zur Frist');
});

test('DTVP fetchDetailBundle folgt öffentliche Satellite-Seiten und lädt keine Binärdatei', async () => {
  const pages = new Map([
    ['https://dtvp.test/project/1', fixture('dtvp-overview.html')],
    ['https://dtvp.test/processdata/eforms?id=dtvp-1', COSINEX_FORMS],
    ['https://dtvp.test/documents?id=dtvp-1', fixture('dtvp-documents.html')],
    ['https://dtvp.test/communication/anonym?id=dtvp-1', fixture('dtvp-communication.html')],
  ]);
  const requested = [];
  httpClient.get = async (url) => { requested.push(url); return { data: pages.get(url) || '<html><body>missing</body></html>' }; };
  const detail = await dtvp.fetchDetailBundle('https://dtvp.test/project/1');
  assert.equal(detail.detailBundle.completeness.overall, 'complete');
  assert.ok(detail.detailBundle.documents.length >= 1);
  assert.ok(detail.detailBundle.messages.length >= 1);
  assert.ok(requested.every((url) => !/\.pdf|\.zip/i.test(url)));
});

test('DTVP markiert Login, unbekannte Struktur und temporäre Fehler explizit', async () => {
  httpClient.get = async (url) => {
    if (url.includes('login')) return { data: '<html><body>Anmeldung erforderlich</body></html>' };
    if (url.includes('unknown')) return { data: '<html><body><a href="/processdata/unknown-eforms">Daten</a></body></html>' };
    if (url === 'https://dtvp.test/project/eforms') return { data: '<html><body><a href="/processdata/eforms">Daten</a></body></html>' };
    if (url.includes('eforms')) throw new Error('timeout');
    return { data: '<html><body><a href="/processdata/eforms">Daten</a></body></html>' };
  };
  const login = await dtvp.fetchDetailBundle('https://dtvp.test/login');
  assert.equal(login.detailCompleteness.sections.overview, 'login_required');
  assert.equal(login.detailCompleteness.overall, 'partial');
  const unknown = await dtvp.fetchDetailBundle('https://dtvp.test/unknown');
  assert.equal(unknown.detailCompleteness.sections.eforms, 'unknown_structure');
  const temporary = await dtvp.fetchDetailBundle('https://dtvp.test/project/eforms');
  assert.match(temporary.detailCompleteness.sections.eforms, /^temporary_error:/);
  assert.equal(temporary.detailCompleteness.overall, 'partial');
  const calls = [];
  httpClient.get = async (url) => { calls.push(url); return { data: '<html><body>ignored</body></html>' }; };
  assert.equal(await dtvp.fetchDetailBundle('https://dtvp.test/download/file.pdf'), null);
  assert.deepEqual(calls, []);
});

test('TED filtert Notice-Typen, paginiert per Iteration und markiert fehlende Fristen unknown', async () => {
  const competition = { 'publication-number': '100001-2026', 'notice-title': { deu: ['Wettbewerb'] }, 'form-type': 'competition', 'notice-type': 'cn-standard' };
  const change = { 'publication-number': '100002-2026', 'notice-title': { deu: ['Korrektur'] }, 'form-type': 'change', 'notice-type': 'cn-standard' };
  const award = { 'publication-number': '100003-2026', 'notice-title': { deu: ['Zuschlag'] }, 'form-type': 'result', 'notice-type': 'can' };
  const resultChange = { 'publication-number': '100004-2026', 'notice-title': { deu: ['Korrektur Zuschlag'] }, 'form-type': 'change', 'notice-type': 'can' };
  let call = 0;
  httpClient.post = async () => (++call === 1 ? { data: { notices: [competition], iterationNextToken: 'next' } } : { data: { notices: [change, award] } });
  const notices = await ted.fetchAllNotices({ query: 'PD >= 20260801' });
  assert.equal(notices.length, 3);
  assert.equal(ted.parseV3Notice(competition).status, 'unknown');
  assert.equal(ted.parseV3Notice(award), null);
  assert.equal(ted.parseV3Notice(resultChange), null);
  assert.equal(ted.parseV3Notice({ ...competition, status: 'cancelled' }), null);
  assert.equal(ted.parseV3Notice({ ...competition, 'form-type': undefined, 'notice-type': undefined }), null);
});

test('TED paginiert ohne Iterationstoken per PAGE_NUMBER und bewahrt fehlendes total als null', async () => {
  const first = { 'publication-number': '100010-2026', 'notice-title': 'Seite 1', 'form-type': 'competition', 'notice-type': 'cn-standard' };
  const second = { 'publication-number': '100011-2026', 'notice-title': 'Seite 2', 'form-type': 'competition', 'notice-type': 'cn-standard' };
  const calls = [];
  httpClient.post = async (_url, body) => {
    calls.push(body);
    if (calls.length === 1) return { data: { notices: [first] } };
    if (calls.length === 2) return { data: { notices: [second], total: 2 } };
    return { data: { notices: [] } };
  };
  const notices = await ted.fetchAllNotices({ query: 'PD >= 20260801', limit: 1 });
  assert.deepEqual(notices.map((notice) => notice['publication-number']), ['100010-2026', '100011-2026']);
  assert.equal(calls[0].paginationMode, 'ITERATION');
  assert.equal(calls[1].paginationMode, 'PAGE_NUMBER');
  assert.equal(calls[1].page, 2);
});

test('TED-API-Ausfall importiert nichts aus einem ungefilterten RSS-Fallback', async () => {
  let rssCalls = 0;
  httpClient.post = async () => { throw new Error('API offline'); };
  httpClient.get = async () => { rssCalls += 1; return { data: '<rss><item><title>Award</title></item></rss>' }; };
  await assert.rejects(() => ted.discover({ daysBack: 1 }), /TED-Abruf fehlgeschlagen: API offline/);
  assert.equal(rssCalls, 0);
});

test('TED-XML und eVergabe-XML/HTML erhalten Rohdaten und inventarisieren nur Links', () => {
  const tedXml = ted.parseTedXml(fixture('ted-notice.xml'), 'https://ted.europa.eu/de/notice/100001-2026/xml', '100001-2026');
  assert.equal(tedXml.submissionDeadline, '2026-12-15');
  assert.equal(tedXml.metadata.formType, 'competition-type');
  assert.equal(tedXml.lots.length, 2);
  assert.deepEqual(tedXml.lots[0].cpvCodes, ['38434500']);
  assert.equal(tedXml.metadata.organizations[0].name, 'Landeslabor Nord');
  assert.equal(tedXml.contractingAuthority, 'Landeslabor Nord');
  assert.deepEqual(tedXml.metadata.organizations[0].roles.sort(), ['buyer', 'contracting']);
  assert.equal(tedXml.metadata.organizations[0].technicalId, 'ORG-100');
  assert.equal(tedXml.metadata.contacts[0].email, 'anna@example.test');
  assert.equal(tedXml.metadata.contacts[0].technicalId, 'TPO-100');
  assert.equal(tedXml.metadata.contacts.find((item) => item.technicalId === 'TPO-101').email, 'lisa@example.test');
  assert.ok(tedXml.metadata.deadlines.some((item) => item.dateTime === '2026-12-15T12:30:00+01:00'));
  assert.ok(tedXml.metadata.deadlines.some((item) => item.kind === 'opening' && item.dateTime === '2026-12-16T09:00:00+01:00'));
  assert.ok(!tedXml.metadata.deadlines.some((item) => item.date === '2030-01-01' || item.date === '2031-01-01'));
  assert.equal(tedXml.criteria.find((item) => item.title === 'Gesamtqualität').kind, 'award');
  assert.ok(tedXml.facts.some((fact) => fact.dataType === 'date-time'));
  assert.ok(tedXml.documents.every((doc) => doc.downloadStatus === 'not_requested'));
  assert.equal(tedXml.snapshot.mimeType, 'application/xml');

  const ever = evergabe.parseEvergabeDetailHtml(fixture('evergabe-detail.html'), 'https://evergabe.test/tenderdetails.html?id=1');
  assert.equal(ever.submissionDeadline, '2026-12-15');
  assert.equal(ever.xmlUrl, 'https://evergabe.test/announcement.xml');
  assert.equal(ever.documentsUrl, 'https://evergabe.test/tenderdocuments?id=1');
  assert.equal(ever.documents[0].downloadStatus, 'not_requested');

  const everXml = evergabe.parseEvergabeDetailXml(fixture('evergabe-notice.xml'), 'https://evergabe.test/tenderdetails.html?id=1');
  assert.equal(everXml.submissionDeadline, '2026-12-15');
  assert.equal(everXml.lots[0].submissionDeadline, '2026-12-10');
  assert.equal(everXml.metadata.organizations[0].name, 'Bundeslabor Nord');
  assert.equal(everXml.contractingAuthority, 'Bundeslabor Nord');
  assert.deepEqual(everXml.metadata.organizations[0].roles.sort(), ['buyer', 'contracting']);
  assert.equal(everXml.metadata.organizations[0].technicalId, 'EV-ORG-1');
  assert.equal(everXml.metadata.contacts[0].email, 'max@example.test');
  assert.equal(everXml.metadata.contacts[0].technicalId, 'EV-TPO-1');
  assert.equal(everXml.metadata.contacts.find((item) => item.technicalId === 'EV-TPO-DIRECT').email, 'direkt@example.test');
  assert.equal(everXml.documents[0].locator.href, 'https://evergabe.test/files/specification.pdf');
  assert.ok(everXml.facts.some((fact) => fact.dataType === 'date-time'));
  assert.ok(!everXml.metadata.deadlines.some((item) => item.date === '2030-01-01' || item.date === '2031-01-01'));
  assert.equal(everXml.criteria.find((item) => item.title === 'Preis').kind, 'award');
});

test('eVergabe inventarisiert auch Gesamtarchive ohne sie zu öffnen', () => {
  const parsed = evergabe.parseEvergabeDocumentsHtml(fixture('evergabe-tenderdocuments.html'), 'https://evergabe.test/tenderdocuments?id=1');
  const archive = parsed.documents.find((document) => document.category === 'archive');
  assert.ok(archive);
  assert.equal(archive.mimeType, 'application/zip');
  assert.equal(archive.downloadStatus, 'not_requested');
});

test('eVergabe Due- und Target-Entscheidung ist rein und überspringt frische vollständige Details', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const fresh = { detail_status: 'complete', detail_crawled_at: '2026-08-28T00:00:00Z', last_changed_at: '2026-08-27T00:00:00Z' };
  assert.equal(evergabe.detailDue(fresh, now), false);
  assert.equal(evergabe.detailDue({ ...fresh, detail_crawled_at: '2026-08-27T00:00:00Z' }, now), true);
  assert.equal(evergabe.detailDue({ ...fresh, detail_status: 'partial' }, now), true);
  assert.equal(evergabe.shouldEnrichEvergabeTender({ result: {}, stored: fresh, now }), false);
  assert.equal(evergabe.shouldEnrichEvergabeTender({ result: { isNew: true }, stored: fresh, now }), true);
  assert.equal(evergabe.shouldEnrichEvergabeTender({ result: { changed: true }, stored: fresh, now }), true);
  assert.equal(evergabe.shouldEnrichEvergabeTender({ result: {}, stored: { ...fresh, detail_crawled_at: '2026-08-27T00:00:00Z' }, now }), true);
});

test('eVergabe XML erkennt XML/Login/Unknown und blockiert Binärantworten vor dem Snapshot', async () => {
  const xml = await evergabe.parseEvergabeXmlResponse({ headers: () => ({ 'content-type': 'application/xml' }), text: async () => fixture('evergabe-notice.xml') }, 'https://evergabe.test/announcement.xml');
  assert.equal(xml.recognized, true);
  assert.equal(xml.loginRequired, false);
  assert.equal(xml.snapshots[0].mimeType, 'application/xml');

  const login = await evergabe.parseEvergabeXmlResponse({ headers: () => ({ 'content-type': 'text/html' }), text: async () => '<html><body>Anmeldung erforderlich</body></html>' }, 'https://evergabe.test/announcement.xml');
  assert.equal(login.recognized, false);
  assert.equal(login.loginRequired, true);
  const unknown = await evergabe.parseEvergabeXmlResponse({ headers: () => ({ 'content-type': 'application/xml' }), text: async () => '<Notice><Unbekannt>Wert</Unbekannt></Notice>' }, 'https://evergabe.test/announcement.xml');
  assert.equal(unknown.recognized, false);
  assert.equal(unknown.loginRequired, false);
  let binaryTextCalled = false;
  const binary = await evergabe.parseEvergabeXmlResponse({ headers: () => ({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="notice.pdf"' }), text: async () => { binaryTextCalled = true; return '%PDF'; } }, 'https://evergabe.test/announcement.xml');
  assert.equal(binary.binary, true);
  assert.equal(binaryTextCalled, false);
  assert.equal(binary.snapshots, undefined);
});

test('eVergabe markiert Login/unbekannte Seiten und inventarisiert Binärredirects ohne Abruf', () => {
  const login = evergabe.parseEvergabeDetailHtml('<html><body>Anmeldung erforderlich</body></html>', 'https://evergabe.test/login');
  assert.equal(login.loginRequired, true);
  const unknown = evergabe.parseEvergabeDetailHtml('<html><body></body></html>', 'https://evergabe.test/unknown');
  assert.equal(unknown.description, null);
  const binary = evergabe.parseEvergabeDocumentsHtml('<a href="/download/file.pdf">Leistungsbeschreibung</a>', 'https://evergabe.test/tenderdocuments?id=1');
  assert.equal(binary.documents.length, 1);
  assert.equal(binary.documents[0].downloadStatus, 'not_requested');
  assert.equal(binary.documents[0].locator.href, 'https://evergabe.test/download/file.pdf');
});
