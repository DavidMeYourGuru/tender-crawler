import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRow, parseDetailSummaryHtml } from '../src/browser-portals/niedersachsen.js';

test('parseRow extrahiert Niedersachsen-DxGrid-Zeilen (Titel in Zelle[2])', () => {
  const tender = parseRow({
    cells: [
      '', // Icon
      'VOB', // VOrdn.
      'Sanierung und Erweiterung der Grundschule Bremervörde; Lüftungsinstallationen Öffentliches Verfahren', // Titel
      'Stadt Bremervörde', // Vergabestelle
      '03.08.2026', // Publikation
      '03.09.2026', // Frist
      '', // Icon
    ],
    href: null,
  });
  assert.ok(tender);
  assert.equal(tender.sourceId, 'niedersachsen');
  assert.equal(tender.title, 'Sanierung und Erweiterung der Grundschule Bremervörde; Lüftungsinstallationen');
  assert.equal(tender.contractingAuthority, 'Stadt Bremervörde');
  assert.equal(tender.tenderType, 'VOB');
  assert.equal(tender.publicationDate, '2026-08-03');
  assert.equal(tender.submissionDeadline, '2026-09-03');
  assert.ok(tender.url.includes('BL=03'));
});

test('parseRow überspringt unvollständige Zeilen', () => {
  assert.equal(parseRow({ cells: ['', 'VOB', 'Titel', 'Stadt', '01.08.2026'], href: null }), null); // < 6 Zellen
  assert.equal(parseRow(null), null);
  assert.equal(parseRow({ cells: [] }), null);
});

test('parseRow überspringt Zeilen ohne Titel', () => {
  assert.equal(parseRow({ cells: ['', 'VOB', '', 'Stadt', '01.08.2026', '01.09.2026', ''], href: null }), null);
});

test('Niedersachsen-Dialogparser übernimmt UUID-nahe Verfahrensdaten, CPVs und Fristen', () => {
  const detail = parseDetailSummaryHtml(`
    <div role="dialog"><h2>Sanierung Schulhof</h2>
      <p>Nr. 587136 · Offenes Verfahren · VGV</p>
      <p>Vergabestelle: Stadt Beispiel</p>
      <p>Publikation: 03.08.2026 Angebotsfrist: 03.09.2026</p>
      <p>CPV-Klassifizierung 45000000-7 Bauarbeiten 77300000-3 Gartenbau</p>
      <p>Elektronische Angebotsabgabe</p>
    </div>`);
  assert.equal(detail.referenceNumber, '587136');
  assert.equal(detail.procurementRegulation, 'VGV');
  assert.deepEqual(detail.cpvCodes, ['45000000-7', '77300000-3']);
  assert.equal(detail.electronicSubmission, true);
});

test('Niedersachsen verwendet UUID und Discovery-Fingerprint statt Frist-Hash', () => {
  const tender = parseRow({
    cells: ['', 'VGV', 'Schulhofplanung Offenes Verfahren', 'Stadt Beispiel', '03.08.2026', '03.09.2026', ''],
    href: null,
    portalProjectId: 'e1821c03-be82-4e50-85fb-f235f0b505f8',
  });
  assert.equal(tender.externalId, 'e1821c03-be82-4e50-85fb-f235f0b505f8');
  assert.equal(tender.portalProjectId, tender.externalId);
  assert.equal(tender.procedureType, 'Offenes Verfahren');
  assert.ok(tender.discoveryFingerprint);
});
