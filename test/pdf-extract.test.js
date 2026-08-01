import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { httpClient } from '../src/crawler/http-client.js';
import { extractPdfText, downloadPdf, fetchPdfText, MAX_PDF_BYTES } from '../src/funding/pdf-extract.js';

/**
 * Erzeugt ein gültiges Mini-PDF mit korrekten xref-Offsets.
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

const originalGet = httpClient.get;

beforeEach(() => {
  httpClient.get = originalGet;
});

after(() => {
  httpClient.get = originalGet;
});

test('extractPdfText extrahiert Text aus einem gültigen PDF', async () => {
  const text = await extractPdfText(makePdf('Hallo Welt Forderrichtlinie'));
  assert.ok(text);
  assert.ok(text.includes('Hallo Welt Forderrichtlinie'));
});

test('extractPdfText gibt null bei ungültigem Buffer zurück', async () => {
  assert.equal(await extractPdfText(Buffer.from('kein pdf')), null);
  assert.equal(await extractPdfText(Buffer.alloc(0)), null);
  assert.equal(await extractPdfText(null), null);
});

test('downloadPdf lädt ein PDF über den HTTP-Client', async () => {
  httpClient.get = async () => ({ data: makePdf('Download Test'), status: 200, headers: {}, request: { res: { responseUrl: 'https://example.com/richtlinie.pdf' } } });
  const { buffer, url } = await downloadPdf('https://example.com/richtlinie.pdf');
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(url, 'https://example.com/richtlinie.pdf');
  const text = await extractPdfText(buffer);
  assert.ok(text.includes('Download Test'));
});

test('downloadPdf wirft bei privaten Hosts (SSRF-Schutz)', async () => {
  await assert.rejects(downloadPdf('http://127.0.0.1:8080/x.pdf'), /Unzulässiger Host/);
  await assert.rejects(downloadPdf('http://10.0.0.5/x.pdf'), /Unzulässiger Host/);
});

test('downloadPdf wirft bei HTTP-Fehlerstatus', async () => {
  httpClient.get = async () => ({ data: Buffer.alloc(0), status: 404, headers: {} });
  await assert.rejects(downloadPdf('https://example.com/fehlt.pdf'), /HTTP 404/);
});

test('downloadPdf wirft bei zu großen PDFs', async () => {
  httpClient.get = async () => ({ data: Buffer.alloc(MAX_PDF_BYTES + 1), status: 200, headers: {} });
  await assert.rejects(downloadPdf('https://example.com/gross.pdf'), /zu groß/);
});

test('fetchPdfText liefert null bei nicht-parsebarem PDF', async () => {
  httpClient.get = async () => ({ data: Buffer.from('kein pdf'), status: 200, headers: {} });
  const text = await fetchPdfText('https://example.com/kaputt.pdf');
  assert.equal(text, null);
});
