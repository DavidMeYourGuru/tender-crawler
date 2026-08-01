import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Temporäre DB vor dem Import setzen – deshalb dynamische Imports,
// damit process.env.DB_PATH bereits gesetzt ist (statische Imports
// werden in ESM hoisted und liefen vor der Zuweisung).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-crawler-funding-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.AUTH_ENABLED = 'false';
process.env.CRAWL_ON_START = 'false';

const parser = await import('../src/funding/parser.js');
const { extractFundingProgram } = await import('../src/funding/extractor.js');
const {
  saveFundingProgram,
  getFundingProgramById,
  listFundingPrograms,
  getFundingStats,
  setFundingOverride,
  deleteFundingOverride,
  confirmFundingProgram,
  startFundingCrawlLog,
  finishFundingCrawlLog,
  getFundingCrawlHistory,
  getSourceDocument,
  cleanupFundingData,
  fundingProgramExists,
  listCrawlSources,
  addCrawlSource,
  saveTender,
  getTenderById,
} = await import('../src/db.js');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── Parser ── */
test('parseDeadline erkennt deutschen Monatsnamen', () => {
  const r = parser.parseDeadline('Deadline: 30. September 2026');
  assert.equal(r.deadlineAt, '2026-09-30');
  assert.equal(r.isOngoing, false);
});

test('parseDeadline erkennt Punkt-Datum mit Uhrzeit', () => {
  const r = parser.parseDeadline('20.08.2026 um 15:00 Uhr');
  assert.equal(r.deadlineAt, '2026-08-20T15:00');
});

test('parseDeadline erkennt laufende Förderung', () => {
  const r = parser.parseDeadline('keine Frist, laufende Antragstellung');
  assert.equal(r.isOngoing, true);
  assert.equal(r.deadlineAt, null);
});

test('parseDurationMonths erkennt max- und Bereichsangaben', () => {
  assert.deepEqual(parser.parseDurationMonths('bis zu 36 Monate'), { minMonths: null, maxMonths: 36, quote: 'bis zu 36 Monate' });
  assert.deepEqual(parser.parseDurationMonths('48 Monate'), { minMonths: 48, maxMonths: 48, quote: '48 Monate' });
  const range = parser.parseDurationMonths('12–24 Monate');
  assert.equal(range.minMonths, 12);
  assert.equal(range.maxMonths, 24);
});

test('parseEuroAmount erkennt Betrag und Bereich', () => {
  const single = parser.parseEuroAmount('400.000 € (Einzelprojekt)');
  assert.equal(single.minCents, 40000000);
  const range = parser.parseEuroAmount('400.000 € bis 800.000 €');
  assert.equal(range.minCents, 40000000);
  assert.equal(range.maxCents, 80000000);
});

test('parseFundingQuote erkennt Quote mit Anmerkung', () => {
  const r = parser.parseFundingQuote('100% (+20% bei Hochschulen)');
  assert.equal(r.min, 100);
  assert.equal(r.max, 100);
  assert.ok(r.note.includes('Hochschulen'));
});

test('parseMaxAmount erkennt Förderhöchstbetrag', () => {
  const r = parser.parseMaxAmount('Förderhöchstbetrag für Forschungseinrichtungen: 180.000 €');
  assert.equal(r.maxAmountCents, 18000000);
});

/* ── Extractor (deterministisch + gemocktes LLM) ── */
// LLM ist für die Extraktion erforderlich; Tests injizieren einen Mock.
function mockLlm(data) {
  return async () => data;
}

test('extractFundingProgram übernimmt Beträge/Laufzeiten vom LLM', async () => {
  const docs = [{
    url: 'https://example.com/dikap',
    title: 'DiKAp',
    page: 'Bekanntmachung',
    text: 'Fördergeber: Bundesministerium für Bildung, Familie, Senioren, Frauen und Jugend (BMBFSFJ)\nDeadline: 30. September 2026\nEntwicklungsprojekte: bis zu 36 Monate. Entwicklungsprojekt: 400.000 € (Einzelprojekt), Entwicklungsprojekt: 800.000 €. Metavorhaben: 48 Monate. Metavorhaben: 1.500.000 €. Förderquote: 100% (+20% bei Hochschulen).',
  }];
  const llmData = {
    title: 'DiKAp',
    current_call: null,
    short_description: null,
    funding_gegenstand: null,
    funding_geber: 'BMBFSFJ',
    deadline_status: { kind: 'single', deadlines: [{ label: 'Antragsfrist', date: '2026-09-30', time: null, is_ongoing: false, quote: 'Antragsfrist: 30. September 2026' }] },
    project_types: [
      { name: 'Entwicklungsprojekte', description: null, duration_min_months: null, duration_max_months: 36, amount_min_euro: 400000, amount_max_euro: 800000, funding_quote_min: null, funding_quote_max: null, max_amount_euro: null, conditions: null },
      { name: 'Metavorhaben', description: null, duration_min_months: null, duration_max_months: 48, amount_min_euro: null, amount_max_euro: 1500000, funding_quote_min: null, funding_quote_max: null, max_amount_euro: null, conditions: null },
    ],
    eligible_applicants: [],
    requirements: [],
    exclusions: [],
  };
  const p = await extractFundingProgram(docs, { llmCaller: mockLlm(llmData), base: { title: 'DiKAp' } });
  assert.equal(p.fundingGeberShort, 'BMBFSFJ');
  assert.equal(p.status, 'open');
  assert.equal(p.deadlines[0].deadlineAt, '2026-09-30');
  const dev = p.projectTypes.find((t) => t.name === 'Entwicklungsprojekte');
  assert.equal(dev.amountMinCents, 40000000);
  assert.equal(dev.amountMaxCents, 80000000);
  assert.equal(dev.durationMaxMonths, 36);
  const meta = p.projectTypes.find((t) => t.name === 'Metavorhaben');
  assert.equal(meta.amountMaxCents, 150000000);
  assert.equal(meta.durationMaxMonths, 48);
});

test('extractFundingProgram: deterministische Werte mischen KEINE Beträge ein', async () => {
  const docs = [{
    url: 'https://example.com/igp',
    title: 'IGP',
    page: 'Bekanntmachung',
    text: 'Fördergeber: BMWK\nDeadline: 20.08.2026 um 15:00 Uhr\nMachbarkeitsprojekte: max. 12 Monate. Marktreifeprojekte: max. 24 Monate. Machbarkeitsprojekte: bis zu 80.000 €. Marktreifeprojekte: bis zu 330.000 €. Förderquote: 100% für Forschungseinrichtungen. Förderhöchstbetrag für Forschungseinrichtungen: 180.000 €.',
  }];
  // LLM liefert nur Namen, keine Beträge → es dürfen keine deterministischen
  // Beträge eingemischt werden.
  const llmData = {
    title: 'IGP',
    current_call: null,
    short_description: null,
    funding_gegenstand: null,
    funding_geber: 'BMWK',
    deadline_status: { kind: 'single', deadlines: [{ label: 'Antragsfrist', date: '2026-08-20', time: '15:00', is_ongoing: false, quote: 'Einreichung bis 20.08.2026 um 15:00 Uhr' }] },
    project_types: [
      { name: 'Machbarkeitsprojekte', description: null, duration_min_months: null, duration_max_months: null, amount_min_euro: null, amount_max_euro: null, funding_quote_min: null, funding_quote_max: null, max_amount_euro: null, conditions: null },
      { name: 'Marktreifeprojekte', description: null, duration_min_months: null, duration_max_months: null, amount_min_euro: null, amount_max_euro: null, funding_quote_min: null, funding_quote_max: null, max_amount_euro: null, conditions: null },
    ],
    eligible_applicants: [],
    requirements: [],
    exclusions: [],
  };
  const p = await extractFundingProgram(docs, { llmCaller: mockLlm(llmData), base: { title: 'IGP' } });
  assert.equal(p.deadlines[0].deadlineAt, '2026-08-20T15:00');
  const mach = p.projectTypes.find((t) => t.name === 'Machbarkeitsprojekte');
  // Determinismus müsste 80.000 € liefern, darf aber NICHT eingemischt werden
  assert.equal(mach.amountMaxCents, null);
  assert.equal(mach.durationMaxMonths, null);
});

test('extractFundingProgram nutzt den Teaser-Stichtag für den Status', async () => {
  const docs = [{
    url: 'https://example.com/call',
    title: 'Call',
    page: 'Bekanntmachung',
    text: 'Bekanntmachungstext mit historischen Datumsangaben aus 17.06.2014 und 31.12.2019 sowie einem Hinweis auf die Antragsfrist 30. September 2026.',
  }];
  const p = await extractFundingProgram(docs, {
    llmCaller: mockLlm({}),
    base: { title: 'Call', submissionDeadline: '2026-09-30' },
  });
  assert.equal(p.status, 'open');
  assert.equal(p.deadlines[0].deadlineAt, '2026-09-30');
  assert.ok(!p.deadlines.some((d) => d.deadlineAt === '2014-06-17'));
  assert.ok(!p.deadlines.some((d) => d.deadlineAt === '2019-12-31'));
});

test('extractFundingProgram markiert abgelaufene Calls als closed', async () => {
  const docs = [{
    url: 'https://example.com/call',
    title: 'Call',
    page: 'Bekanntmachung',
    text: 'Die Frist endete am 15. März 2025, keine Verlängerung vorgesehen.',
  }];
  const p = await extractFundingProgram(docs, {
    llmCaller: mockLlm({}),
    base: { title: 'Call', submissionDeadline: '2025-03-15' },
  });
  assert.equal(p.status, 'closed');
});

test('LLM-Primärextraktion: Titel/Gegenstand/Projektformen vom LLM, Werte gemerged', async () => {
  const docs = [{
    url: 'https://example.com/llm',
    title: 'Basis',
    page: 'Bekanntmachung',
    text: 'Hightech-Förderprogramm\nCall 2026: Entwicklung innovativer Technologien\nFördergeber: BMWK\nDeadline: 30. September 2026\nEntwicklungsprojekte: bis zu 36 Monate. Entwicklungsprojekte: 400.000 € bis 800.000 €.\nZuwendungsvoraussetzungen: Antragsberechtigt sind Hochschulen und Forschungseinrichtungen.',
  }];
  const llmData = {
    title: 'Hightech-Förderprogramm',
    current_call: 'Call 2026',
    short_description: 'Entwicklung innovativer Technologien',
    funding_gegenstand: 'Entwicklung innovativer Technologien',
    funding_geber: 'BMWK',
    deadlines: ['2026-09-30'],
    project_types: [
      { name: 'Entwicklungsprojekte', description: 'Entwicklungsprojekte: bis zu 36 Monate.', duration_min_months: null, duration_max_months: 36, amount_min_euro: 400000, amount_max_euro: 800000, funding_quote_min: null, funding_quote_max: null, max_amount_euro: null, conditions: null },
    ],
    eligible_applicants: ['Antragsberechtigt sind Hochschulen und Forschungseinrichtungen.'],
    requirements: [],
    exclusions: [],
  };
  const p = await extractFundingProgram(docs, { llmCaller: mockLlm(llmData), base: { title: 'Basis' } });
  assert.equal(p.title, 'Hightech-Förderprogramm');
  assert.equal(p.currentCall, 'Call 2026');
  assert.equal(p.fundingGeber, 'BMWK');
  const dev = p.projectTypes.find((t) => t.name === 'Entwicklungsprojekte');
  assert.ok(dev);
  assert.equal(dev.durationMaxMonths, 36);
  assert.equal(dev.amountMinCents, 40000000);
  assert.equal(dev.amountMaxCents, 80000000);
  assert.equal(p.needsReview, false);
});

test('Unplausible LLM-Beträge und nicht belegte Voraussetzungen führen zu needs_review', async () => {
  const docs = [{
    url: 'https://example.com/llm2',
    title: 'Basis',
    page: 'Bekanntmachung',
    text: 'Fördergeber: BMWK\nDeadline: 30. September 2026\nEntwicklungsprojekte: bis zu 36 Monate.',
  }];
  const llmData = {
    title: 'Völlig erfundener Titel ohne Beleg',
    current_call: null,
    project_types: [
      { name: 'Entwicklungsprojekte', description: null, duration_min_months: 12, duration_max_months: null, amount_min_euro: 2, amount_max_euro: null, funding_quote_min: null, funding_quote_max: 150, max_amount_euro: null, conditions: null },
    ],
    eligible_applicants: ['Diese Voraussetzung steht nirgendwo im Quelltext.'],
    requirements: [],
    exclusions: [],
  };
  const p = await extractFundingProgram(docs, { llmCaller: mockLlm(llmData), base: { title: 'Basis' } });
  assert.equal(p.needsReview, true);
  assert.equal(p.reviewStatus, 'needs_review');
  // Freitext-Titel bleibt erhalten (lenient), unplausible Zahlen + unbelegte
  // Voraussetzung lösen den Review-Flag aus.
  assert.equal(p.title, 'Völlig erfundener Titel ohne Beleg');
  assert.ok(p.projectTypes.length >= 1);
});

test('LLM-Betrag 0 wird als "nicht angegeben" behandelt (kein Review-Flag)', async () => {
  const docs = [{
    url: 'https://example.com/zero',
    title: 'Basis',
    page: 'Bekanntmachung',
    text: 'Fördergeber: BMWK\nDeadline: 30. September 2026\nAntragsberechtigt sind Hochschulen.\nFörderquote: bis zu 100%.',
  }];
  const llmData = {
    title: 'Basis',
    current_call: null,
    short_description: null,
    funding_gegenstand: null,
    funding_geber: 'BMWK',
    deadlines: [],
    project_types: [
      { name: 'Verbundprojekte', description: null, duration_min_months: 0, duration_max_months: 36, amount_min_euro: 0, amount_max_euro: 0, funding_quote_min: 0, funding_quote_max: 100, max_amount_euro: 0, conditions: null },
    ],
    eligible_applicants: ['Antragsberechtigt sind Hochschulen.'],
    requirements: [],
    exclusions: [],
  };
  const p = await extractFundingProgram(docs, { llmCaller: mockLlm(llmData), base: { title: 'Basis' } });
  const pt = p.projectTypes.find((t) => t.name === 'Verbundprojekte');
  assert.ok(pt);
  assert.equal(pt.amountMinCents, null);
  assert.equal(pt.amountMaxCents, null);
  assert.equal(pt.fundingQuoteMin, null);
  assert.equal(pt.durationMinMonths, null);
  assert.equal(p.needsReview, false);
});

test('LLM unterscheidet mehrere Fristen und laufende Förderung mit/ohne Frist', async () => {
  const docs = [{
    url: 'https://example.com/fristen',
    title: 'Fristen',
    page: 'Bekanntmachung',
    text: 'Fördergeber: BMWK\nAntragsfrist Modul 1: 31. März 2026\nAntragsfrist Modul 2: 30. September 2026\nFür Metavorhaben ist die Antragstellung laufend möglich, Anträge bis 31.12.2026.',
  }];
  const llmData = {
    title: 'Fristen',
    current_call: null,
    short_description: null,
    funding_gegenstand: null,
    funding_geber: 'BMWK',
    deadline_status: {
      kind: 'multiple',
      deadlines: [
        { label: 'Antragsfrist Modul 1', date: '2026-03-31', time: null, is_ongoing: false, quote: 'Antragsfrist Modul 1: 31. März 2026' },
        { label: 'Antragsfrist Modul 2', date: '2026-09-30', time: null, is_ongoing: false, quote: 'Antragsfrist Modul 2: 30. September 2026' },
        { label: 'Laufende Antragstellung', date: '2026-12-31', time: null, is_ongoing: true, quote: 'laufend möglich, Anträge bis 31.12.2026' },
      ],
    },
    project_types: [],
    eligible_applicants: [],
    requirements: [],
    exclusions: [],
  };
  const p = await extractFundingProgram(docs, { llmCaller: mockLlm(llmData), base: { title: 'Fristen' } });
  assert.equal(p.status, 'open');
  assert.equal(p.deadlines.length, 3);
  const laufend = p.deadlines.find((d) => d.isOngoing);
  assert.ok(laufend, 'laufende Frist erwartet');
  assert.equal(laufend.deadlineAt, '2026-12-31');
  const mod1 = p.deadlines.find((d) => d.label === 'Antragsfrist Modul 1');
  assert.equal(mod1.deadlineAt, '2026-03-31');
});

test('LLM erkennt laufende Antragstellung ohne Frist', async () => {
  const docs = [{
    url: 'https://example.com/laufend',
    title: 'Laufend',
    page: 'Bekanntmachung',
    text: 'Fördergeber: BMWK\nDie Antragstellung ist dauerhaft möglich, es gibt keine Frist.',
  }];
  const llmData = {
    title: 'Laufend',
    current_call: null,
    short_description: null,
    funding_gegenstand: null,
    funding_geber: 'BMWK',
    deadline_status: { kind: 'ongoing_without_deadline', deadlines: [] },
    project_types: [],
    eligible_applicants: [],
    requirements: [],
    exclusions: [],
  };
  const p = await extractFundingProgram(docs, { llmCaller: mockLlm(llmData), base: { title: 'Laufend' } });
  assert.equal(p.status, 'ongoing');
  assert.ok(p.deadlines.some((d) => d.isOngoing && d.deadlineAt === null));
});

test('LLM-Ausfall führt zu prüfbedürftigem Datensatz statt Abbruch', async () => {
  const docs = [{
    url: 'https://example.com/fail',
    title: 'Basis',
    page: 'Bekanntmachung',
    text: 'Fördergeber: BMWK\nDeadline: 30. September 2026\nEntwicklungsprojekte: bis zu 36 Monate.',
  }];
  const failingLlm = async () => { throw new Error('LLM nicht erreichbar'); };
  const p = await extractFundingProgram(docs, { llmCaller: failingLlm, base: { title: 'Basis' } });
  assert.equal(p.needsReview, true);
  // Deterministisch extrahierte Daten bleiben erhalten
  assert.equal(p.fundingGeber, 'BMWK');
  assert.equal(p.status, 'open');
});

/* ── DB: Speichern, Listen, Overrides ── */
function makeProgram(overrides = {}) {
  return {
    sourceId: 'seed',
    externalId: 'prog-1',
    title: 'Testprogramm',
    fundingGeber: 'Ministerium (MIN)',
    status: 'open',
    reviewStatus: 'unreviewed',
    contentHash: 'hash-1',
    deadlines: [{ label: 'Antragsfrist', deadlineAt: '2026-12-31', isOngoing: false, timezone: 'Europe/Berlin', quote: '31.12.2026' }],
    projectTypes: [{ name: 'Machbarkeitsprojekte', amountMaxCents: 8000000, durationMaxMonths: 12 }],
    eligibility: [{ kind: 'applicant', text: 'KMU', sort: 0 }],
    links: [{ kind: 'guideline', url: 'https://example.com/richtlinie.pdf' }],
    evidence: [{ entity: 'program', field: 'title', quote: 'Testprogramm', method: 'parser', confidence: 0.9 }],
    ...overrides,
  };
}

test('saveFundingProgram legt Programm samt Kinddaten an', () => {
  const r = saveFundingProgram(makeProgram());
  assert.equal(r.isNew, true);
  const full = getFundingProgramById(r.programId);
  assert.equal(full.title, 'Testprogramm');
  assert.equal(full.deadlines.length, 1);
  assert.equal(full.project_types.length, 1);
  assert.equal(full.eligibility.length, 1);
  assert.equal(full.evidence.length, 1);
  assert.equal(full.links.length, 1);
});

test('fundingProgramExists prüft deterministisch, ob ein Call bereits vorhanden ist', () => {
  const p = makeProgram({ externalId: 'dedup-call', sourceId: 'foerderinfo-bekanntmachungen' });
  assert.equal(fundingProgramExists(p.sourceId, p.externalId), false);
  saveFundingProgram(p);
  assert.equal(fundingProgramExists(p.sourceId, p.externalId), true);
  assert.equal(fundingProgramExists(p.sourceId, 'andere-external-id'), false);
  assert.equal(fundingProgramExists('andere-quelle', p.externalId), false);
});

test('saveFundingProgram erkennt keine Änderung', () => {
  const r = saveFundingProgram(makeProgram());
  assert.equal(r.isNew, false);
  assert.equal(r.changed, false);
});

test('listFundingPrograms filtert nach Status und Suchtext', () => {
  const open = listFundingPrograms({ status: ['open'] });
  assert.ok(open.total >= 1);
  const found = listFundingPrograms({ q: 'Testprogramm' });
  assert.ok(found.total >= 1);
});

test('getFundingStats liefert Kennzahlen', () => {
  const stats = getFundingStats();
  assert.ok(stats.total >= 1);
  assert.ok(stats.open >= 1);
});

test('setFundingOverride und deleteFundingOverride', () => {
  const full = getFundingProgramById(1) || saveFundingProgram(makeProgram());
  const pid = full.id;
  setFundingOverride({ programId: pid, entity: 'program', field: 'title', value: 'Manuell korrigiert' });
  const updated = getFundingProgramById(pid);
  const ov = updated.overrides.find((o) => o.entity === 'program' && o.field === 'title');
  assert.ok(ov);
  assert.equal(ov.value, 'Manuell korrigiert');
  assert.ok(updated.changes.some((c) => c.source === 'manual'));
  deleteFundingOverride({ programId: pid, entity: 'program', field: 'title' });
  const after = getFundingProgramById(pid);
  assert.equal(after.overrides.find((o) => o.entity === 'program' && o.field === 'title'), undefined);
});

test('confirmFundingProgram setzt review_status und bestätigt Overrides', () => {
  const full = getFundingProgramById(1);
  setFundingOverride({ programId: full.id, entity: 'program', field: 'title', value: 'Bestätigt' });
  confirmFundingProgram(full.id);
  const updated = getFundingProgramById(full.id);
  assert.equal(updated.review_status, 'verified');
  const ov = updated.overrides.find((o) => o.entity === 'program' && o.field === 'title');
  assert.equal(ov.is_confirmed, 1);
});

test('funding-crawl-log kann gestartet und beendet werden', () => {
  const log = startFundingCrawlLog('seed');
  finishFundingCrawlLog({ id: log.id, status: 'completed', itemsDiscovered: 2, itemsNew: 1, itemsChanged: 0, documentsLoaded: 1, extractionErrors: 0, needsReview: 0, errorMessage: null });
  const history = getFundingCrawlHistory(5);
  assert.ok(history.length >= 1);
  assert.equal(history[0].status, 'completed');
});

test('Volltextsuche findet Begriffe nur im Call-Volltext', () => {
  const r = saveFundingProgram(makeProgram({
    sourceId: 'foerderinfo-bekanntmachungen',
    externalId: 'prog-full',
    title: 'Test-Call',
    contentHash: 'hash-full',
    sourceText: 'EinzigartigerVolltextBegriff XYZ-2026 ausschließlich tief im Bekanntmachungstext',
  }));
  const found = listFundingPrograms({ q: 'XYZ-2026' });
  assert.ok(found.total >= 1);
  assert.ok(found.programs.some((p) => p.id === r.programId));

  const full = getFundingProgramById(r.programId);
  assert.ok(full.source_text.includes('XYZ-2026'));

  // Rohdokument enthält den echten Detailtext
  const doc = getSourceDocument('funding', r.programId);
  assert.ok(doc.content.includes('XYZ-2026'));

  // Listen-API blendet den schweren Volltext aus
  const listRow = found.programs.find((p) => p.id === r.programId);
  assert.equal(listRow.search_text_full, undefined);
});

test('identischer Recrawl erzeugt keine neue Dokumentversion', () => {
  const r = saveFundingProgram(makeProgram({
    sourceId: 'foerderinfo-bekanntmachungen',
    externalId: 'prog-ver',
    title: 'Versionierung',
    contentHash: 'hash-v1',
    sourceText: 'Konstanter Volltext für Versionstest',
  }));
  const d1 = getSourceDocument('funding', r.programId);
  const again = saveFundingProgram(makeProgram({
    sourceId: 'foerderinfo-bekanntmachungen',
    externalId: 'prog-ver',
    title: 'Versionierung',
    contentHash: 'hash-v1',
    sourceText: 'Konstanter Volltext für Versionstest',
  }));
  assert.equal(again.changed, false);
  const d2 = getSourceDocument('funding', r.programId);
  assert.equal(d2.doc_version, d1.doc_version);
});

test('cleanupFundingData löscht Förderdaten, erhält Tender und Tender-Quellen', async () => {
  // Fremde Förderquelle + Inbox-Datensatz anlegen
  const foreign = addCrawlSource({ sourceKey: 'custom-fremd', name: 'Fremd', url: 'https://example.com', declaredKind: 'funding', access: 'http' });
  // Förderprogramm aus fremder Quelle speichern
  saveFundingProgram(makeProgram({
    sourceId: 'url:custom-fremd',
    externalId: 'prog-foreign',
    title: 'Fremdes Programm',
    contentHash: 'hash-foreign',
    sourceText: 'Fremder Volltext, wird gelöscht',
  }));
  // Tender anlegen (bleibt erhalten)
  const tender = saveTender({
    sourceId: 'ted',
    externalId: 'EXT-CLEAN',
    title: 'Bleibender Tender',
    url: 'https://example.com/t',
    description: 'Beschreibung',
    contractingAuthority: 'Bund',
    cpvCodes: ['73000000'],
    cpvLabels: ['Forschung'],
    estimatedValueCents: 1000,
    estimatedValueCurrency: 'EUR',
    publicationDate: '2026-07-01',
    submissionDeadline: '2026-12-01',
    contentHash: 'hash-tender',
    status: 'open',
  });

  const result = await cleanupFundingData({ backup: false });
  assert.ok(result.deletedPrograms >= 1);

  // Förderbestand leer, fremde Quelle entfernt
  assert.equal(listFundingPrograms().total, 0);
  const sources = listCrawlSources();
  const fundingSources = sources.filter((s) => s.declared_kind === 'funding');
  assert.ok(fundingSources.length >= 1);
  assert.ok(fundingSources.every((s) => s.source_key === 'foerderinfo'));
  assert.ok(!sources.some((s) => s.source_key === 'custom-fremd'));

  // Tender unverändert
  assert.ok(getTenderById(tender.tenderId));
  assert.equal(getFundingCrawlHistory(10).length, 0);
});
