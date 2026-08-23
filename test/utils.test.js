import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentHash,
  normalizeDate,
  daysUntil,
  deriveStatus,
  parseMoneyToCents,
  mapLimit,
  normalizeCpv,
} from '../src/utils.js';

test('contentHash erzeugt stabilen Hash', () => {
  const a = contentHash('Titel', 'Beschreibung', 123);
  const b = contentHash('Titel', 'Beschreibung', 123);
  const c = contentHash('Titel', 'Beschreibung', 124);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64); // SHA-256 hex
});

test('contentHash normalisiert Groß-/Kleinschreibung', () => {
  assert.equal(contentHash('Hallo Welt'), contentHash('HALLO welt'));
});

test('normalizeDate erkennt ISO-Format', () => {
  assert.equal(normalizeDate('2026-08-15'), '2026-08-15');
  assert.equal(normalizeDate('2026-08-15T10:00:00Z'), '2026-08-15');
});

test('normalizeDate erkennt deutsches Format', () => {
  assert.equal(normalizeDate('15.08.2026'), '2026-08-15');
  assert.equal(normalizeDate('15.8.26'), '2026-08-15');
});

test('normalizeDate erkennt Monatsnamen', () => {
  assert.equal(normalizeDate('15. August 2026'), '2026-08-15');
  assert.equal(normalizeDate('3. März 2026, 12:00'), '2026-03-03');
});

test('normalizeCpv normalisiert Codes und Labels aus verschiedenen Formen', () => {
  // String-Array mit Suffix
  assert.deepEqual(
    normalizeCpv(['45000000-7', '45331000-6'], ['Bau', 'Heizung']),
    { cpvCodes: ['45000000', '45331000'], cpvLabels: ['Bau', 'Heizung'] }
  );
  // Objekt-Array (code/label)
  assert.deepEqual(
    normalizeCpv([{ code: '45000000-7', label: 'Bauarbeiten' }]),
    { cpvCodes: ['45000000'], cpvLabels: ['Bauarbeiten'] }
  );
  // Leere Eingabe → null
  assert.deepEqual(normalizeCpv(null, null), { cpvCodes: null, cpvLabels: null });
  assert.deepEqual(normalizeCpv([], []), { cpvCodes: null, cpvLabels: null });
  // Deduplizierung
  assert.deepEqual(
    normalizeCpv(['45000000-7', '45000000-7'], ['Bau', 'Bau']),
    { cpvCodes: ['45000000'], cpvLabels: ['Bau'] }
  );
});

test('normalizeDate gibt null bei ungültigen Werten zurück', () => {
  assert.equal(normalizeDate(null), null);
  assert.equal(normalizeDate(''), null);
  assert.equal(normalizeDate('kein datum'), null);
  assert.equal(normalizeDate('31.02.2026'), null); // ungültig
});

test('parseMoneyToCents parst verschiedene Formate', () => {
  assert.equal(parseMoneyToCents('1.250.000 EUR'), 125000000);
  assert.equal(parseMoneyToCents('€ 50.000'), 5000000);
  assert.equal(parseMoneyToCents('250000'), 25000000);
  assert.equal(parseMoneyToCents(1234.5), 123450);
  assert.equal(parseMoneyToCents('1.250.000,50'), 125000050);
  assert.equal(parseMoneyToCents(null), null);
  assert.equal(parseMoneyToCents('abc'), null);
});

test('daysUntil liefert Anzahl Tage', () => {
  const future = new Date();
  future.setDate(future.getDate() + 3);
  const iso = future.toISOString().slice(0, 10);
  const days = daysUntil(iso);
  assert.ok(days >= 2 && days <= 4);

  assert.equal(daysUntil(null), null);
});

test('deriveStatus leitet Status aus Frist ab', () => {
  const past = new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10);
  assert.equal(deriveStatus(past, 'open'), 'closed');

  const soon = new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10);
  assert.equal(deriveStatus(soon, 'open'), 'closing_soon');

  assert.equal(deriveStatus(null, 'open'), 'open');
});

test('mapLimit verarbeitet Items mit begrenzter Parallelität in Reihenfolge', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return n * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
  assert.ok(maxActive <= 2, `max parallele Worker = ${maxActive}`);
  assert.equal(maxActive, 2, 'tatsächlich 2 parallel');
});

test('mapLimit liefert leeres Ergebnis bei leerer Liste', async () => {
  assert.deepEqual(await mapLimit([], 3, async (x) => x), []);
});

test('mapLimit propagiert Fehler eines Items', async () => {
  await assert.rejects(
    mapLimit([1, 2], 2, async (n) => {
      if (n === 2) throw new Error('kaputt');
      return n;
    }),
    /kaputt/
  );
});