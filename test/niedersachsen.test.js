import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRow } from '../src/browser-portals/niedersachsen.js';

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
