import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { httpClient } from '../src/crawler/http-client.js';
import * as nrw from '../src/portals/nrw.js';

const originalGet = httpClient.get;
const BASE_URL = 'https://www.evergabe.nrw.de';

function resultRow({ pid, title, publication = '23.08.2026', deadline = '30.09.2026' }) {
  return `<tr>
    <td>${publication}</td>
    <td>${deadline}</td>
    <td class="word-break">${title}</td>
    <td>UVgO<br>Ausschreibung</td>
    <td>Testvergabestelle</td>
    <td><a href="${BASE_URL}/VMPCenter/public/company/projectForwarding.do?pid=${pid}">Details</a></td>
  </tr>`;
}

const PAGE_ONE = `<html><body>
  <div>Seite: 1 von 2 - Gesamteinträge: 2</div>
  <table>
    ${resultRow({ pid: '1001', title: 'Erster echter Auftrag' })}
  </table>
  <table class="facets"><tr><td><a href="/VMPCenter/company/announcements/categoryOverview.do?method=showTable&cpvCode=71222000-0">Kategorie</a></td><td>1</td></tr></table>
  <a href="javascript:void(0);" onclick="setTargetAndSubmit('/VMPCenter/company/announcements/categoryOverview.do?method=showTable&fromSearch=1&selectedTablePagePROJECT_RESULT=2')">Weiter</a>
</body></html>`;

const PAGE_TWO = `<html><body>
  <div>Seite: 2 von 2 - Gesamteinträge: 2</div>
  <table>${resultRow({ pid: '1002', title: 'Zweiter echter Auftrag', deadline: 'nv' })}</table>
</body></html>`;

const DETAIL_HTML = `<html><body>
  <main>
    <h1>Erster echter Auftrag</h1>
    <p>Auftragsgegenstand</p>
    <p>71220000-6 Architekturentwurf</p>
    <p>80000000-4 Allgemeine und berufliche Bildung</p>
    <p>Ausführliche Beschreibung des Auftrags.</p>
    <a href="/VMPCenter/public/company/download/Bekanntmachung.pdf">Bekanntmachung</a>
  </main>
</body></html>`;

const DETAIL_DOM_HTML = `<html><body>
  <div>
    <div class="sub-headline-container"><h4 class="sub-headline"><span>Auftragsgegenstand</span></h4></div>
    <div class="control-group"><p><b>79950000-8</b> Veranstaltung von Ausstellungen, Messen und Kongressen</p></div>
    <div class="control-group"><p><b>92000000-1</b> Dienstleistungen in den Bereichen Erholung, Kultur und Sport</p></div>
  </div>
  <a href="https://www.evergabe.nrw.de/VMPCenter/">Zur Vergabeplattform</a>
  <a href="./announcements/123/Bekanntmachung.pdf">Download</a>
</body></html>`;

after(() => {
  httpClient.get = originalGet;
});

test('NRW-Parser übernimmt nur echte pid-Projektzeilen', () => {
  const results = nrw.parseResultsTable(PAGE_ONE, BASE_URL, '71220000-6');

  assert.equal(results.length, 1);
  assert.equal(results[0].externalId, '1001');
  assert.equal(results[0].title, 'Erster echter Auftrag');
  assert.equal(results[0].contractingAuthority, 'Testvergabestelle');
  assert.equal(results[0].cpvCodes, null);
  assert.deepEqual(results[0].discoveryCpvCodes, ['71220000-6']);
});

test('NRW-Pagination erkennt setTargetAndSubmit und die Gesamtseitenzahl', () => {
  const currentUrl = `${BASE_URL}/VMPCenter/company/announcements/categoryOverview.do?method=showTable&cpvCode=71220000-6`;
  const pages = nrw.parsePagination(PAGE_ONE, currentUrl, '71220000-6');

  assert.equal(pages.length, 1);
  assert.match(pages[0], /cpvCode=71220000-6/);
  assert.match(pages[0], /selectedTablePagePROJECT_RESULT=2/);
});

test('NRW-Discover crawlt alle Seiten aller aktiven CPVs ohne maxResults-Kürzung', async () => {
  const calls = [];
  let acquired = 0;
  httpClient.get = async (url) => {
    calls.push(url);
    return { data: url.includes('selectedTablePagePROJECT_RESULT=2') ? PAGE_TWO : PAGE_ONE };
  };

  const results = await nrw.discover({
    maxResults: 1,
    requestDelayMs: 0,
    rateLimiter: { acquire: async () => { acquired += 1; } },
  });

  assert.equal(results.length, 2);
  assert.equal(calls.length, nrw.NRW_CPV_CODES.length * 2);
  assert.equal(acquired, calls.length);
  assert.ok(calls.every((url) => !url.includes('45000000-7')));
  assert.ok(results.every((row) => row.cpvCodes === null));
});

test('NRW-Detailseite extrahiert Volltext, tatsächliche CPVs und Dokument', () => {
  const detail = nrw.parseDetailPage(DETAIL_HTML, BASE_URL);

  assert.match(detail.description, /Ausführliche Beschreibung/);
  assert.deepEqual(detail.cpvCodes, ['71220000-6', '80000000-4']);
  assert.deepEqual(detail.cpvLabels, ['Architekturentwurf', 'Allgemeine und berufliche Bildung']);
  assert.equal(detail.documentUrl, `${BASE_URL}/VMPCenter/public/company/download/Bekanntmachung.pdf`);
});

test('NRW-Detailparser liest die echte CPV-Struktur und ignoriert Portal-Links', () => {
  const detail = nrw.parseDetailPage(DETAIL_DOM_HTML, BASE_URL);

  assert.deepEqual(detail.cpvCodes, ['79950000-8', '92000000-1']);
  assert.deepEqual(detail.cpvLabels, [
    'Veranstaltung von Ausstellungen, Messen und Kongressen',
    'Dienstleistungen in den Bereichen Erholung, Kultur und Sport',
  ]);
  assert.equal(detail.documentUrl, `${BASE_URL}/announcements/123/Bekanntmachung.pdf`);
});

test('NRW-fetchDetail gibt bei einem Abruffehler null zurück', async () => {
  httpClient.get = async () => { throw new Error('Testfehler'); };
  const detail = await nrw.fetchDetail(`${BASE_URL}/VMPCenter/public/company/projectForwarding.do?pid=404`);
  assert.equal(detail, null);
});

test('NRW-fetchDetail nutzt den Detailparser', async () => {
  httpClient.get = async () => ({ data: DETAIL_HTML, status: 200, headers: {} });
  const detail = await nrw.fetchDetail(`${BASE_URL}/VMPCenter/public/company/projectForwarding.do?pid=1001`);
  assert.deepEqual(detail.cpvCodes, ['71220000-6', '80000000-4']);
});

test('NRW-eForms wertet Ja/Nein-Felder und unbekannte Geldwerte korrekt aus', () => {
  const parsed = nrw.parseEformsPage(`<html><body>
    <p>Verfahrensart</p><p>Offenes Verfahren</p>
    <p>Rahmenvereinbarung: Nein</p>
    <p>Elektronische Auktion: Nein</p>
    <p>Nebenangebote: Nicht zugelassen</p>
    <p>Geschätzter Auftragswert: nicht angegeben</p>
    <p>Frist für den Eingang der Angebote 31.12.2026</p>
  </body></html>`, `${BASE_URL}/processdata/eforms`);
  assert.equal(parsed.metadata.flags.frameworkAgreement, false);
  assert.equal(parsed.metadata.flags.electronicAuction, false);
  assert.equal(parsed.metadata.flags.variants, false);
  assert.equal(parsed.estimatedValueCents, null);
  assert.equal(parsed.submissionDeadline, '2026-12-31');
});

test('NRW-eForms liefert Klartextabschnitt und generische Fakten', () => {
  const parsed = nrw.parseEformsPage(`<html><body>
    <dl><dt>Verfahrensart</dt><dd>Offenes Verfahren</dd><dt>Sprache</dt><dd>Deutsch</dd></dl>
    <p>Rahmenvereinbarung: Nein</p><p>Frist für den Eingang der Angebote 31.12.2026</p>
  </body></html>`, `${BASE_URL}/processdata/eforms`);
  assert.ok(parsed.textSections.some((section) => section.sectionKey === 'eforms' && /Verfahrensart/.test(section.text)));
  assert.ok(parsed.facts.some((fact) => fact.label === 'procedureType'));
  assert.ok(parsed.facts.some((fact) => fact.label === 'flags.frameworkAgreement'));
});

test('NRW-Dokumente und Kommunikation behalten Locator, Anhänge und Rohsnapshot', () => {
  const documents = nrw.parseDocumentsPage(`<html><body>
    <h2>Vergabeunterlagen</h2>
    <table><tr><td>Leistungsbeschreibung.pdf</td><td>1 MB</td><td>23.08.2026</td>
      <td><a href="/download/leistungsbeschreibung.pdf">Download</a></td></tr></table>
    <a href="/download/gesamt.zip">Alle Unterlagen als ZIP</a>
  </body></html>`, BASE_URL);
  const communication = nrw.parseCommunicationPage(`<html><body>
    <section><p>Betreff: Rückfrage zur Frist</p><p>Datum: 23.08.2026</p>
      <p>Die Frist bleibt unverändert.</p><a href="/download/antwort.pdf">Antwort.pdf</a></section>
  </body></html>`, `${BASE_URL}/communication/anonym`);
  assert.equal(documents.documents.length, 1);
  assert.equal(documents.documents[0].downloadStatus, 'not_requested');
  assert.match(documents.documents[0].locator.href, /leistungsbeschreibung\.pdf/);
  assert.match(documents.archiveUrl, /gesamt\.zip/);
  assert.equal(communication.messages.length, 1);
  assert.equal(communication.messages[0].attachments.length, 1);
  assert.equal(communication.messages[0].attachments[0].accessStatus, 'public');
  assert.equal(communication.snapshot.kind, 'nrw:communication');
});

test('NRW erlaubt Unterlagen-HTML, blockiert Download- und Binärantworten vor Parserverarbeitung', async () => {
  assert.equal(nrw.isDeferredDocumentUrl(`${BASE_URL}/documents/project-1`), false);
  assert.equal(nrw.isDeferredDocumentUrl(`${BASE_URL}/download/file?id=1`), true);
  assert.equal(nrw.isDeferredDocumentUrl(`${BASE_URL}/file.pdf`), true);
  httpClient.get = async () => ({
    data: Buffer.from('%PDF-1.7'), status: 200,
    headers: { 'content-type': 'application/pdf' }, config: { url: `${BASE_URL}/documents/project-1` },
  });
  assert.equal(await nrw.fetchDetail(`${BASE_URL}/documents/project-1`), null);
});

test('NRW lädt bekannte Download- und Binär-Redirect-Ziele nicht per GET', async () => {
  const calls = [];
  httpClient.get = async (url) => {
    calls.push(url);
    return { status: 302, headers: { location: `${BASE_URL}/files/bekanntmachung.pdf` }, data: '' };
  };
  assert.equal(await nrw.fetchDetail(`${BASE_URL}/download?id=1`), null);
  assert.deepEqual(calls, []);
  assert.equal(await nrw.fetchDetail(`${BASE_URL}/public/project`), null);
  assert.deepEqual(calls, [`${BASE_URL}/public/project`]);
});

test('NRW materialisiert unbekannte Fließtextfelder nicht als Fakten', () => {
  const parsed = nrw.parseEformsPage('<html><body><p>Unbekanntes Feld: geraten</p><dl><dt>Verfahrensart</dt><dd>Offenes Verfahren</dd></dl></body></html>', BASE_URL);
  assert.equal(parsed.facts.some((fact) => fact.label === 'Unbekanntes Feld'), false);
  assert.equal(parsed.facts.some((fact) => fact.label === 'procedureType'), true);
});
