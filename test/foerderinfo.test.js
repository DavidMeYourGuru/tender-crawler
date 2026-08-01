import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { httpClient } from '../src/crawler/http-client.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-crawler-foerderinfo-test-'));
const docsDir = path.join(tmpDir, 'docs');
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.FUNDING_DOCS_DIR = docsDir;
process.env.AUTH_ENABLED = 'false';
process.env.CRAWL_ON_START = 'false';

const { parsePage, discover, pageUrl, fetchDocs } = await import('../src/funding/sources/foerderinfo.js');
const { extractMainContent } = await import('../src/funding/sources/detail-text.js');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/**
 * Erzeugt ein gültiges Mini-PDF (für Mock-Tests).
 * Kleine Schrift + breite Seite, damit pdf.js lange Texte nicht abschneidet.
 */
function makePdf(text) {
  const fontSize = 10;
  const pageWidth = 2000;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 ${fontSize} Tf 100 700 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  const header = '%PDF-1.4\n';
  const offsets = [];
  let body = header;
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefPos = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const TEASER_HTML = `
<html><body>
  <div class="l-teaser-list">
    <a class="c-teaser c-teaser--announcement l-teaser-list__teaser" href="https://www.bmftr.bund.de/SharedDocs/Bekanntmachungen/DE/2026/07/2026-07-28-bekanntmachung-hydrogen4future.html" target="_blank">
      <div class="c-teaser__text-wrapper">
        <h2 class="c-teaser__headline">
          <span class="c-teaser__title">Forschungshub Wasserstoff – Hydrogen4Future</span>
          <small class="c-topline c-teaser__topline">
            <span class="c-topline__item">
              <span class="aural">Datum:</span>
              <time datetime="2026-07-28" class="c-topline__time">28.07.2026</time>
            </span>
            <span class="c-topline__item c-topline__item--stopdate">
              <time datetime="2026-09-30" class="c-topline__time">- 30.09.2026</time>
            </span>
            <span class="c-topline__item"><span class="c-topline__category">BMFTR</span></span>
            <span class="c-topline__item">Bekanntmachung</span>
          </small>
        </h2>
        <div class="c-teaser__text"><p>Richtlinie zur Förderung von Projekten zum Thema Forschungshubs.</p></div>
      </div>
    </a>
  </div>
</body></html>
`;

test('parsePage liest Titel, Detail-URL, Daten, Fördergeber und Typ', () => {
  const items = parsePage(TEASER_HTML, 'https://www.foerderinfo.bund.de/Formular.html');
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.title, 'Forschungshub Wasserstoff – Hydrogen4Future');
  assert.equal(item.url, 'https://www.bmftr.bund.de/SharedDocs/Bekanntmachungen/DE/2026/07/2026-07-28-bekanntmachung-hydrogen4future.html');
  assert.equal(item.publicationDate, '2026-07-28');
  assert.equal(item.submissionDeadline, '2026-09-30');
  assert.equal(item.contractingAuthority, 'BMFTR');
  assert.equal(item.tenderType, 'Bekanntmachung');
  assert.equal(item.sourceId, 'foerderinfo-bekanntmachungen');
  assert.ok(item.externalId.length > 10);
  assert.ok(item.status === 'open' || item.status === 'closed');
});

test('parsePage löst relative Detail-URLs gegen die Seiten-URL auf', () => {
  const html = TEASER_HTML.replace(
    'https://www.bmftr.bund.de/SharedDocs/Bekanntmachungen/DE/2026/07/2026-07-28-bekanntmachung-hydrogen4future.html',
    './Bekanntmachungen/DE/2026/07/relativ.html'
  );
  const items = parsePage(html, 'https://www.bmftr.bund.de/SiteGlobals/Forms/x.html');
  assert.equal(items[0].url, 'https://www.bmftr.bund.de/SiteGlobals/Forms/Bekanntmachungen/DE/2026/07/relativ.html');
});

test('parsePage dedupliziert identische URLs', () => {
  const items = parsePage(`${TEASER_HTML}${TEASER_HTML}`, 'https://www.foerderinfo.bund.de/x.html');
  assert.equal(items.length, 1);
});

test('discover paginiert vollständig und dedupliziert über Seiten', async () => {
  const pages = new Map();
  // 25 Seiten à 10, Seite 25 mit 8 Treffern; insgesamt 248 Treffer
  for (let p = 1; p <= 25; p += 1) {
    const count = p === 25 ? 8 : 10;
    const teasers = [];
    for (let i = 1; i <= count; i += 1) {
      const n = (p - 1) * 10 + i;
      teasers.push(`<a class="c-teaser c-teaser--announcement" href="https://ministerium.bund/bekanntmachung/${n}.html"><h2 class="c-teaser__headline"><span class="c-teaser__title">Bekanntmachung ${n}</span></h2><div class="c-teaser__text">Text ${n}</div></a>`);
    }
    // Ein Duplikat zur Dedupe-Prüfung einschleusen
    if (p === 2) teasers.push(teasers[0]);
    pages.set(pageUrl(p), `<html><body><p>248 Treffer</p><div class="l-teaser-list">${teasers.join('')}</div></body></html>`);
  }
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(url);
    const html = pages.get(url);
    if (!html) throw new Error(`Seite nicht gefunden: ${url}`);
    return { html, url };
  };

  const items = await discover({ fetcher });
  assert.equal(items.length, 248);
  assert.equal(fetched.length, 25);
  assert.equal(items.meta.total, 248);
  assert.equal(items.meta.pageCount, 25);
  assert.equal(items.meta.uniqueUrls, 248);
  assert.equal(items.meta.pageErrors.length, 0);
  const uniqueExternalIds = new Set(items.map((i) => i.externalId));
  assert.equal(uniqueExternalIds.size, 248);
});

test('discover zählt Seitenfehler und wiederholt einmal', async () => {
  let calls = 0;
  const fetcher = async (url) => {
    if (url.includes('list%253D3')) {
      calls += 1;
      if (calls < 2) throw new Error('Timeout');
    }
    if (url.includes('list%253D4')) throw new Error('Immer kaputt');
    return { html: '<html><body><p>248 Treffer</p><div class="l-teaser-list"></div></body></html>', url };
  };
  const items = await discover({ fetcher });
  assert.equal(calls, 2); // Seite 3: 1 Fehler + 1 Retry
  const errors = items.meta.pageErrors;
  assert.ok(errors.some((e) => e.page === 3 && e.retry === undefined));
  assert.ok(errors.some((e) => e.page === 4 && e.retry === true));
});

test('extractMainContent entfernt Navigation/Footer und erhält Überschriften', () => {
  const html = `
    <html><body>
      <nav><a href="/">Start</a><a href="/impressum">Impressum</a></nav>
      <div id="cookie-hinweis">Cookies akzeptieren</div>
      <main>
        <h1>Richtlinie zur Förderung</h1>
        <p>Ausführlicher Bekanntmachungstext über Zuwendungszweck, Antragsberechtigte und Fristen der Fördermaßnahme mit genügend Länge.</p>
        <h2>Fördergegenstand</h2>
        <ul><li>Entwicklungsprojekte</li><li>Metavorhaben</li></ul>
      </main>
      <footer>© 2026 Bundesministerium – Impressum & Datenschutz</footer>
    </body></html>
  `;
  const { text, html: cleanHtml } = extractMainContent(html);
  assert.ok(text.includes('Richtlinie zur Förderung'));
  assert.ok(text.includes('Fördergegenstand'));
  assert.ok(text.includes('Entwicklungsprojekte'));
  assert.ok(!text.includes('Impressum'));
  assert.ok(!text.includes('Cookies akzeptieren'));
  assert.ok(cleanHtml.includes('<main>') || cleanHtml.includes('<h1>'));
});

test('fetchDocs lädt Detailseite, bereinigt sie und liefert Volltext', async () => {
  let acquired = 0;
  const limiter = { acquire: async () => { acquired += 1; } };
  const fetcher = async (url, limiter) => {
    if (limiter) await limiter.acquire();
    const html = `<html><body><nav>Navigation</nav><main><h1>Hydrogen4Future</h1><p>${'Ausführlicher Text '.repeat(20)}</p></main></body></html>`;
    return { html, url: 'https://ministerium.bund/bekanntmachung/1.html', status: 200 };
  };
  const docs = await fetchDocs({ title: 'Hydrogen4Future', url: 'https://ministerium.bund/bekanntmachung/1.html' }, { rateLimiter: limiter, fetcher });
  assert.equal(acquired, 1);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].url, 'https://ministerium.bund/bekanntmachung/1.html');
  assert.ok(docs[0].text.includes('Ausführlicher Text'));
  assert.ok(!docs[0].text.includes('Navigation'));
});

test('fetchDocs wirft bei zu kurzer Detailseite', async () => {
  const fetcher = async () => ({ html: '<html><body><main><h1>Kurz</h1></main></body></html>', url: 'https://ministerium.bund/kurz', status: 200 });
  await assert.rejects(
    fetchDocs({ title: 'Kurz', url: 'https://ministerium.bund/kurz' }, { fetcher }),
    /ohne ausreichenden Text/
  );
});

test('fetchDocs wirft bei HTTP-Fehlerstatus', async () => {
  const fetcher = async () => ({ html: '<html></html>', url: 'https://ministerium.bund/x', status: 404 });
  await assert.rejects(
    fetchDocs({ title: 'x', url: 'https://ministerium.bund/x' }, { fetcher }),
    /HTTP 404/
  );
});

test('fetchDocs lädt verlinkte PDFs und hängt deren Text an', async () => {
  const originalGet = httpClient.get;
  try {
    const detailHtml = `<html><body><nav>Navigation</nav><main><h1>Call mit PDF</h1><p>${'Ausführlicher Text '.repeat(20)}</p><a href="https://ministerium.bund/richtlinie.pdf">Richtlinie (PDF)</a></main></body></html>`;
    httpClient.get = async (url) => {
      if (String(url).endsWith('.pdf')) {
        return { data: makePdf('Forderrichtlinie mit Laufzeit von 36 Monaten und Foerdersumme bis 800000 Euro fuer die Forschung im Bereich Wasserstoff'), status: 200, headers: {}, request: { res: { responseUrl: String(url) } } };
      }
      return { data: detailHtml, status: 200, headers: {}, request: { res: { responseUrl: String(url) } } };
    };
    const fetcher = async (url, limiter) => {
      if (limiter) await limiter.acquire();
      return { html: detailHtml, url, status: 200 };
    };
    const docs = await fetchDocs({ title: 'Call mit PDF', url: 'https://ministerium.bund/call' }, { fetcher });
    assert.ok(docs.length >= 2);
    const pdfDoc = docs.find((d) => d.page === 'Richtlinie (PDF)');
    assert.ok(pdfDoc, 'PDF-Dokument erwartet');
    assert.equal(pdfDoc.url, 'https://ministerium.bund/richtlinie.pdf');
    assert.ok(pdfDoc.text.includes('Forderrichtlinie'));
    assert.ok(pdfDoc.text.includes('36 Monaten'));
  } finally {
    httpClient.get = originalGet;
  }
});

test('fetchDocs erkennt ein PDF ohne .pdf-Endung über Magic Bytes', async () => {
  const originalGet = httpClient.get;
  try {
    httpClient.get = async (url) => ({
      data: makePdf('Bekanntmachung Frankreich Kooperation Wasserstoff mit Foerderquote und Frist'),
      status: 200,
      headers: {},
      request: { res: { responseUrl: String(url) } },
    });
    // URL endet NICHT auf .pdf – der Abruf liefert aber eine PDF (__blob-Parameter)
    const fetcher = async (url) => ({
      html: makePdf('Bekanntmachung Frankreich Kooperation Wasserstoff mit Foerderquote und Frist').toString('latin1'),
      url,
      status: 200,
    });
    const docs = await fetchDocs({ title: 'ZIM Deutsch-Franzoesische Ausschreibung', url: 'https://www.zim.de/download.pdf?__blob=publicationFile&v=2' }, { fetcher });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].page, 'Bekanntmachung (PDF)');
    assert.ok(docs[0].text.includes('Wasserstoff'));
    assert.equal(docs[0].pdfUrl, 'https://www.zim.de/download.pdf?__blob=publicationFile&v=2', 'PDF-URL als Link erwartet');
  } finally {
    httpClient.get = originalGet;
  }
});

test('fetchDocs parst und speichert ein Direkt-PDF (URL endet auf .pdf)', async () => {
  const originalGet = httpClient.get;
  try {
    httpClient.get = async (url) => ({
      data: makePdf('Bekanntmachung Wasserstoff Elektrolyse mit Foerderquote bis 100 Prozent fuer Verbundprojekte und einer Frist'),
      status: 200,
      headers: {},
      request: { res: { responseUrl: String(url) } },
    });
    const docs = await fetchDocs({ title: 'ZIM Deutsch-Franzoesische Ausschreibung', url: 'https://example.com/bekanntmachung.pdf' });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].page, 'Bekanntmachung (PDF)');
    assert.ok(docs[0].text.includes('Wasserstoff Elektrolyse'));
    assert.equal(docs[0].pdfUrl, 'https://example.com/bekanntmachung.pdf', 'PDF-URL als Link erwartet');
  } finally {
    httpClient.get = originalGet;
  }
});

test('fetchDocs überspringt fehlerhafte PDFs, ohne den Call zu verlieren', async () => {
  const originalGet = httpClient.get;
  try {
    const detailHtml = `<html><body><main><h1>Call mit kaputtem PDF</h1><p>${'Ausführlicher Text '.repeat(20)}</p><a href="https://ministerium.bund/kaputt.pdf">Kaputt</a></main></body></html>`;
    httpClient.get = async () => ({ data: Buffer.from('kein pdf'), status: 200, headers: {}, request: { res: { responseUrl: 'https://ministerium.bund/kaputt.pdf' } } });
    const fetcher = async (url) => ({ html: detailHtml, url, status: 200 });
    const docs = await fetchDocs({ title: 'Call mit kaputtem PDF', url: 'https://ministerium.bund/call2' }, { fetcher });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].page, 'Bekanntmachung');
    assert.ok(docs[0].text.includes('Ausführlicher Text'));
  } finally {
    httpClient.get = originalGet;
  }
});
