import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesInterestCategories, INTEREST_CPV_PREFIXES, INTEREST_KEYWORDS } from '../src/category-filter.js';

test('CPV Bau (45xxxx) trifft Interessenbereich', () => {
  assert.equal(matchesInterestCategories({ cpvCodes: ['45000000-7'] }), true);
  assert.equal(matchesInterestCategories({ cpvCodes: ['45210000-2'] }), true);
});

test('CPV Landschaftsarchitektur (7122, 714) trifft Interessenbereich', () => {
  assert.equal(matchesInterestCategories({ cpvCodes: ['71220000-6'] }), true);
  assert.equal(matchesInterestCategories({ cpvCodes: ['71400000-0'] }), true);
});

test('CPV Garten/Landschaftspflege (773) trifft Interessenbereich', () => {
  assert.equal(matchesInterestCategories({ cpvCodes: ['77300000-3'] }), true);
});

test('CPV außerhalb (Bildung 80000000-4, IT 72000000-5) trifft NICHT', () => {
  assert.equal(matchesInterestCategories({ cpvCodes: ['80000000-4'] }), false);
  assert.equal(matchesInterestCategories({ cpvCodes: ['72000000-5'] }), false);
});

test('Stichwort Schule/Kita/Spielplatz trifft Interessenbereich', () => {
  assert.equal(matchesInterestCategories({ title: 'Neubau Grundschule Mitte' }), true);
  assert.equal(matchesInterestCategories({ title: 'Kita Erweiterung Nord' }), true);
  assert.equal(matchesInterestCategories({ title: 'Sanierung Spielplatz Stadtpark' }), true);
  assert.equal(matchesInterestCategories({ description: 'Kindertagesstätte mit Außenanlagen' }), true);
});

test('Unrelated (IT, Software, Beratung) trifft NICHT', () => {
  assert.equal(matchesInterestCategories({ title: 'Software-Lizenz Rahmenvertrag' }), false);
  assert.equal(matchesInterestCategories({ title: 'IT-Beratung Cloud' }), false);
});

test('null/leer liefert false', () => {
  assert.equal(matchesInterestCategories(null), false);
  assert.equal(matchesInterestCategories({}), false);
});

test('Konstanten sind befüllt', () => {
  assert.ok(INTEREST_CPV_PREFIXES.includes('45'));
  assert.ok(INTEREST_CPV_PREFIXES.includes('714'));
  assert.ok(INTEREST_KEYWORDS.includes('schule'));
  assert.ok(INTEREST_KEYWORDS.includes('spielplatz'));
});
