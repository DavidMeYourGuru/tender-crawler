import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { httpClient } from '../src/crawler/http-client.js';
import * as bund from '../src/portals/bund.js';
import * as evergabe from '../src/portals/evergabe.js';
import * as bayern from '../src/portals/bayern.js';
import * as dtvp from '../src/portals/dtvp.js';
import * as ted from '../src/portals/ted.js';

const TITLE = 'Beschaffung Laborausstattung 2026';
const HREF = '/vergabe/detail/123456789.html';

// HTML-Struktur, die die Selektoren der meisten Portal-Adapter abdeckt
const LIST_HTML = `
<html><body>
  <div class="search-results">
    <ul><li class="result" data-call-id="123456789" data-notice-id="123456789">
      <a href="${HREF}">${TITLE}</a>
      Angebotsfrist: 15.12.2026
      Auftraggeber: Bundesamt für Forschung
      CPV-Code: 38000000
      Wert: 250.000 EUR
      Veröffentlicht: 01.08.2026
    </li></ul>
  </div>
  <ul class="result-list"><li class="result" data-call-id="123456789" data-notice-id="123456789">
    <a href="${HREF}">${TITLE}</a>
    Angebotsfrist: 15.12.2026
    Auftraggeber: Bundesamt für Forschung
    CPV-Code: 38000000
    Wert: 250.000 EUR
    Veröffentlicht: 01.08.2026
  </li></ul>
  <table class="liste"><tbody><tr class="verfahren"><td>
    <a href="${HREF}">${TITLE}</a>
    Angebotsfrist: 15.12.2026
    Auftraggeber: Bundesamt für Forschung
    CPV-Code: 38000000
    Wert: 250.000 EUR
    Veröffentlicht: 01.08.2026
  </td></tr></tbody></table>
</body></html>
`;

// Echte eVergabe-Ergebnisstruktur (Wicket-Tabelle)
const EVERGABE_HTML = `
<html><body>
<table>
  <tbody>
    <tr class="even">
      <td class="ev-result-col"><div><a class="text-wrap" href="./tenderdetails.html?id=123456789">Beschaffung Laborausstattung 2026</a></div></td>
      <td class="ev-result-col"><div>2026/0999</div></td>
      <td class="ev-result-col"><div>Bundesamt für Forschung</div></td>
      <td class="ev-result-col"><div>Deutscher Bundestag, Platz der Republik 1, 11011 Berlin</div></td>
      <td class="ev-result-col"><div>National Öffentliche Ausschreibung</div></td>
      <td class="result_col_deadline result_type_date">15.12.26, 10:30</td>
      <td class="result_col_releaseDate result_type_date">31.07.26</td>
    </tr>
  </tbody>
</table>
</body></html>
`;

const DETAIL_HTML = `
<html><body>
  <article>
    <h1>${TITLE}</h1>
    <p>Ausführliche Beschreibung der Laborausstattung mit <a href="https://example.com/ausschreibung.pdf">PDF</a>.</p>
  </article>
</body></html>
`;

const originalGet = httpClient.get;

beforeEach(() => {
  // Standard-Stub: liefert Listen-HTML
  httpClient.get = async () => ({ data: LIST_HTML });
});

after(() => {
  httpClient.get = originalGet;
});

function stubGet(fn) {
  httpClient.get = async (...args) => fn(...args);
}

test('bund.parseSearchPage extrahiert Titel, Frist, Auftraggeber, CPV', () => {
  const results = bund.parseSearchPage(LIST_HTML);
  assert.ok(results.length >= 1);
  const first = results[0];
  assert.equal(first.sourceId, 'bund');
  assert.equal(first.externalId, '123456789');
  assert.equal(first.title, TITLE);
  assert.equal(first.submissionDeadline, '2026-12-15');
  assert.equal(first.contractingAuthority, 'Bundesamt für Forschung');
  assert.ok(first.cpvCodes.includes('38000000'));
  assert.equal(first.estimatedValueCents, 25000000);
  assert.equal(first.publicationDate, '2026-08-01');
});

test('evergabe.parseSearchPage extrahiert Tendereinträge', () => {
  const results = evergabe.parseSearchPage(EVERGABE_HTML);
  assert.ok(results.length >= 1);
  const first = results[0];
  assert.equal(first.sourceId, 'evergabe');
  assert.equal(first.externalId, '123456789');
  assert.equal(first.title, TITLE);
  assert.equal(first.submissionDeadline, '2026-12-15');
  assert.equal(first.contractingAuthority, 'Bundesamt für Forschung');
  assert.equal(first.placeOfPerformance, 'Deutscher Bundestag, Platz der Republik 1, 11011 Berlin');
  assert.equal(first.publicationDate, '2026-07-31');
});

test('bayern.parseSearchPage extrahiert Tendereinträge', () => {
  const results = bayern.parseSearchPage(LIST_HTML);
  assert.ok(results.length >= 1);
  assert.equal(results[0].sourceId, 'bayern');
});

test('dtvp.parseProject extrahiert Ausschreibungsdaten', () => {
  const tender = dtvp.parseProject({
    projectId: 1486847,
    title: 'Teilaustausch defekte Ventilationsleitungen',
    publishingDate: '31.07.2026',
    relevantDate: '19.08.2027',
    organisationName: 'Ärztekammer Berlin',
    contractingRule: 'VOB/A',
    publicationType: 'Ausschreibung',
    cpvCodes: ['45000000-7', '45331000-6'],
    cpvLabels: ['Bauarbeiten', 'Installation von Heizungsanlagen'],
    links: { enterprojectroom: 'https://www.dtvp.de/Center/public/company/projectForwarding.do?pid=1486847' },
  });
  assert.equal(tender.sourceId, 'dtvp');
  assert.equal(tender.externalId, '1486847');
  assert.equal(tender.title, 'Teilaustausch defekte Ventilationsleitungen');
  assert.equal(tender.submissionDeadline, '2027-08-19');
  assert.equal(tender.publicationDate, '2026-07-31');
  assert.equal(tender.contractingAuthority, 'Ärztekammer Berlin');
  assert.equal(tender.tenderType, 'VOB/A');
  assert.equal(tender.status, 'open');
  assert.deepEqual(tender.cpvCodes, ['45000000', '45331000']);
  assert.deepEqual(tender.cpvLabels, ['Bauarbeiten', 'Installation von Heizungsanlagen']);
});

test('dtvp.parseProject liefert null-Codes ohne CPV', () => {
  const tender = dtvp.parseProject({
    projectId: 99,
    title: 'ohne CPV',
    links: { enterprojectroom: 'https://www.dtvp.de/x' },
  });
  assert.equal(tender.cpvCodes, null);
  assert.equal(tender.cpvLabels, null);
});

test('dtvp.parseProject überspringt Einträge ohne projectId', () => {
  assert.equal(dtvp.parseProject({ title: 'ohne ID' }), null);
  assert.equal(dtvp.parseProject(null), null);
});

test('dtvp.fetchDetail liefert null (Anmeldung erforderlich)', async () => {
  const detail = await dtvp.fetchDetail('https://www.dtvp.de/notice/123456789');
  assert.equal(detail, null);
});

test('bund.fetchDetail liefert Beschreibung und Dokument-URL', async () => {
  stubGet(async (url) => {
    assert.equal(url, `https://www.bund.de${HREF}`);
    return { data: DETAIL_HTML };
  });
  const detail = await bund.fetchDetail(`https://www.bund.de${HREF}`);
  assert.ok(detail.description.length > 0);
  assert.equal(detail.documentUrl, 'https://example.com/ausschreibung.pdf');
});

test('evergabe.fetchDetail liefert Beschreibung', async () => {
  stubGet(async () => ({ data: DETAIL_HTML }));
  const detail = await evergabe.fetchDetail('https://www.evergabe-online.de/calls/123456789');
  assert.ok(detail.description.length > 0);
});

test('bayern.fetchDetail liefert Beschreibung', async () => {
  stubGet(async () => ({ data: DETAIL_HTML }));
  const detail = await bayern.fetchDetail('https://www.auftraege.bayern.de/vergabe/123456789');
  assert.ok(detail.description.length > 0);
});

test('ted.fetchDetail parst die HTML-Detailseite', async () => {
  stubGet(async (url) => {
    assert.match(url, /ted\.europa\.eu\/de\/notice\/424456-2026\/html/);
    return {
      data: `<html><body><main>
        <h1>Laborausstattung EU-weit</h1>
        <p>1. Beschaffer</p>
        <p>Beschreibung: Ausführliche Beschreibung der Laborausstattung.</p>
        <p>2. Verfahren</p>
      </main></body></html>`,
    };
  });
  const detail = await ted.fetchDetail('https://ted.europa.eu/de/notice/-/detail/424456-2026');
  assert.ok(detail);
  assert.ok(detail.description.includes('Beschreibung'));
});

test('ted.fetchDetail gibt null ohne Notice-ID zurück', async () => {
  const detail = await ted.fetchDetail('https://ted.europa.eu/de/notice/ohne-id');
  assert.equal(detail, null);
});

test('portals respektieren den optionalen rateLimiter', async () => {
  let acquired = 0;
  const limiter = { acquire: async () => { acquired += 1; } };
  stubGet(async () => ({ data: DETAIL_HTML }));
  await bund.fetchDetail(`https://www.bund.de${HREF}`, { rateLimiter: limiter });
  assert.equal(acquired, 1);
});

test('discover nutzt optionalen rateLimiter', async () => {
  let acquired = 0;
  const limiter = { acquire: async () => { acquired += 1; } };
  stubGet(async () => ({ data: EVERGABE_HTML }));
  const results = await evergabe.discover({ maxResults: 10, rateLimiter: limiter });
  assert.ok(acquired >= 1);
  assert.ok(results.length >= 1);
});

test('stellt die gemockte httpClient.get wieder her', () => {
  httpClient.get = originalGet;
  assert.equal(typeof httpClient.get, 'function');
});
