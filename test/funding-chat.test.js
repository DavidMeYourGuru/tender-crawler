import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-crawler-chat-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.sqlite');
process.env.AUTH_ENABLED = 'false';
process.env.CRAWL_ON_START = 'false';

const {
  saveFundingProgram,
  getDocumentChunks,
  buildFundingFtsQuery,
  searchFundingChatCandidates,
  searchFundingChatChunks,
  getFundingChatSource,
} = await import('../src/db.js');
const { answerFundingChat, ChatValidationError } = await import('../src/funding/chat.js');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function makeProgram(overrides = {}) {
  return {
    sourceId: 'foerderinfo-bekanntmachungen',
    externalId: 'chat-prog',
    title: 'Wasserstoff-Forschungshub',
    fundingGeber: 'Bundesministerium (BMFTR)',
    status: 'open',
    reviewStatus: 'unreviewed',
    contentHash: 'hash-chat',
    deadlines: [{ label: 'Antragsfrist', deadlineAt: '2026-09-30', isOngoing: false, timezone: 'Europe/Berlin', quote: '30.09.2026' }],
    projectTypes: [{ name: 'Verbundprojekte', amountMaxCents: 80000000, durationMaxMonths: 36 }],
    eligibility: [{ kind: 'applicant', text: 'Hochschulen und Forschungseinrichtungen', sort: 0 }],
    links: [{ kind: 'guideline', url: 'https://example.com/richtlinie.pdf' }],
    evidence: [],
    ...overrides,
  };
}

function saveChatProgram(overrides = {}) {
  const r = saveFundingProgram(makeProgram(overrides));
  return r.programId;
}

/* ── FTS-Helper ── */
test('buildFundingFtsQuery entfernt Stoppwörter und quotet Begriffe', () => {
  const q = buildFundingFtsQuery('Welche Förderung gibt es für Wasserstoff-Elektrolyse?');
  assert.ok(q.includes('"wasserstoff"*'));
  assert.ok(q.includes('"elektrolyse"*'));
  assert.ok(!q.includes('welche'));
  assert.ok(!q.includes('für'));
  assert.equal(buildFundingFtsQuery('die der das und oder'), '');
});

/* ── Retrieval ── */
test('searchFundingChatCandidates findet Begriffe aus dem tiefen Volltext', () => {
  const id = saveChatProgram({
    externalId: 'chat-deep',
    sourceText: 'Ausführlicher Text über Katalysatormaterialien und Membranen. EinzigartigesSchluesselwortZeta2026 kommt nur hier tief im Text vor.',
    title: 'Deep Term Call',
  });
  const hits = searchFundingChatCandidates({ query: 'EinzigartigesSchluesselwortZeta2026', limit: 10 });
  assert.ok(hits.some((h) => Number(h.id) === id));
  // Closed-Calls standardmäßig ausschließen
  const closedId = saveChatProgram({ externalId: 'chat-closed', status: 'closed', title: 'Geschlossener Wasserstoff-Call' });
  const openHits = searchFundingChatCandidates({ query: 'Wasserstoff', limit: 20 });
  assert.ok(!openHits.some((h) => Number(h.id) === closedId));
  const withClosed = searchFundingChatCandidates({ query: 'Wasserstoff', limit: 20, includeClosed: true });
  assert.ok(withClosed.some((h) => Number(h.id) === closedId));
});

test('searchFundingChatCandidates toleriert Sonderzeichen ohne SQL-/FTS-Fehler', () => {
  const id = saveChatProgram({ externalId: 'chat-special', title: 'Sonderzeichen-Call', sourceText: 'Wasserstoff mit Klammern (und) Anführungszeichen "..." erhalten.' });
  const hits = searchFundingChatCandidates({ query: 'Wasserstoff "quote" ; DROP TABLE --', limit: 10 });
  assert.ok(Array.isArray(hits));
  const hits2 = searchFundingChatCandidates({ query: 'nichts-zu-finden-xyz987', limit: 10 });
  assert.deepEqual(hits2, []);
});

test('searchFundingChatChunks liefert relevante Chunks mit aktueller Dokumentversion', () => {
  const text = `Wasserstoff ist ein zentraler Energieträger. `.repeat(50);
  const id = saveChatProgram({ externalId: 'chat-chunks', sourceText: text });
  const chunks = searchFundingChatChunks({ programIds: [id], terms: ['Wasserstoff'], chunksPerProgram: 2 });
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((c) => Number(c.entity_id) === id));
  assert.ok(chunks[0].chunk_key.includes('funding'));
});

test('searchFundingChatChunks wählt maximal zwei Chunks je Programm', () => {
  const text = `Wasserstoff-Elektrolyse für Verbundprojekte. `.repeat(300);
  const id = saveChatProgram({ externalId: 'chat-many-chunks', sourceText: text });
  const chunks = searchFundingChatChunks({ programIds: [id], terms: ['Wasserstoff'], chunksPerProgram: 2 });
  assert.ok(chunks.length <= 2);
});

test('searchFundingChatChunks nutzt nur aktuelle Dokumentversionen', () => {
  const id = saveChatProgram({
    externalId: 'chat-versioned',
    title: 'Versionierter Call',
    contentHash: 'hash-v1',
    sourceText: 'Erste Version mit Wasserstoff-Förderung. '.repeat(30),
  });
  // Zweite Version mit anderem Inhalt speichern
  saveFundingProgram(makeProgram({
    externalId: 'chat-versioned',
    title: 'Versionierter Call',
    contentHash: 'hash-v2',
    sourceText: 'Zweite Version mit Batterieforschung. '.repeat(30),
  }));
  const chunks = searchFundingChatChunks({ programIds: [id], terms: ['Batterieforschung'], chunksPerProgram: 2 });
  assert.ok(chunks.length >= 1);
  const latestVersion = Math.max(...getDocumentChunks('funding', id).map((c) => Number(c.doc_version)));
  assert.ok(chunks.every((c) => Number(c.doc_version) === latestVersion), 'Alle Chunks stammen aus der aktuellen Version');
});

test('getFundingChatSource liefert Quellenmetadaten', () => {
  const id = saveChatProgram({ externalId: 'chat-src', title: 'Quellen-Call', sourceText: 'Ein langer Quelltext für die Quelle.' });
  const src = getFundingChatSource(id);
  assert.ok(src);
  assert.equal(src.title, 'Quellen-Call');
  assert.equal(src.status, 'open');
  assert.ok(src.source_doc_version >= 1);
});

test('searchFundingChatCandidates normalisiert String-Status ohne Crash', () => {
  const id = saveChatProgram({ externalId: 'chat-status-str', status: 'open', title: 'Status-Test Call' });
  const hits = searchFundingChatCandidates({ query: 'Status-Test', includeClosed: true, status: 'open', limit: 10 });
  assert.ok(hits.some((h) => Number(h.id) === id));
  const hits2 = searchFundingChatCandidates({ query: 'Status-Test', includeClosed: true, status: ['open', 'closed'], limit: 10 });
  assert.ok(hits2.some((h) => Number(h.id) === id));
});

/* ── Normalfall: genau ein LLM-Aufruf ── */
test('answerFundingChat verursacht genau einen LLM-Aufruf und liefert validierte Quellen', async () => {
  const text = 'Antragsfrist 30. September 2026. Gefördert werden Verbundprojekte zur Wasserstoff-Elektrolyse mit bis zu 800.000 Euro. Antragsberechtigt sind Hochschulen und Forschungseinrichtungen.';
  const id = saveChatProgram({
    externalId: 'chat-flow',
    sourceText: text,
    primaryUrl: 'https://example.com/call/wasserstoff',
    title: 'Wasserstoff-Elektrolyse-Call',
  });
  const chunks = getDocumentChunks('funding', id);
  const chunk = chunks[0];
  const chunkQuote = String(chunk.text).replace(/\s+/g, ' ').trim().slice(0, 60);

  let calls = 0;
  let adviceUserContent = '';
  async function mockLlm(messages) {
    calls += 1;
    adviceUserContent = String(messages[1].content);
    return {
      answer: 'Der Call **Wasserstoff-Elektrolyse-Call** passt gut.',
      recommendations: [{ program_id: id, fit: 'high', reason: 'Perfekter Fokus auf Wasserstoff-Elektrolyse.', next_steps: ['Skizze einreichen'], risks: ['Frist beachten'] }],
      citations: [{ program_id: id, chunk_key: chunk.chunk_key, quote: chunkQuote }],
    };
  }

  const result = await answerFundingChat({
    question: 'Welcher Call passt zu meinem Verbundprojekt zur Wasserstoff-Elektrolyse?',
    profile: 'Angewandte Forschungseinrichtung im Bereich Wasserstoff.',
    history: [],
    llm: mockLlm,
  });

  assert.equal(calls, 1, 'Normalfall = genau ein DeepSeek-Aufruf');
  // Das Modell erhält Kandidaten + Chunks
  assert.ok(adviceUserContent.includes('KANDIDATEN:'));
  assert.ok(adviceUserContent.includes('Wasserstoff-Elektrolyse-Call'));
  assert.ok(adviceUserContent.includes('[PROGRAM'));
  assert.ok(adviceUserContent.includes('[CHUNK'));

  assert.ok(result.answer.includes('Wasserstoff-Elektrolyse-Call'));
  assert.equal(result.sources.length, 1);
  const source = result.sources.find((s) => Number(s.program_id) === id);
  assert.ok(source, 'Quelle für Programm vorhanden');
  assert.equal(source.fit, 'high');
  assert.equal(source.url, 'https://example.com/call/wasserstoff');
  assert.ok(source.quotes.length >= 1);
  const rec = result.recommendations.find((r) => Number(r.program_id) === id);
  assert.ok(rec && rec.verified === true);
});

/* ── Zitierprüfung ── */
test('answerFundingChat verwirft erfundene Zitate, falsche Chunks und unbekannte IDs', async () => {
  const text = 'Gefördert werden Verbundprojekte zur Wasserstoff-Elektrolyse.';
  const id = saveChatProgram({ externalId: 'chat-halluc', sourceText: text });
  const chunk = getDocumentChunks('funding', id)[0];
  const realQuote = String(chunk.text).replace(/\s+/g, ' ').trim().slice(0, 40);

  let calls = 0;
  async function mockLlm(messages) {
    calls += 1;
    return {
      answer: 'Hier ist eine Antwort mit erfundenen Angaben.',
      recommendations: [
        { program_id: 999999, fit: 'high', reason: 'erfundener Call', next_steps: [], risks: [] },
        { program_id: id, fit: 'high', reason: 'nur Zitat vom richtigen Chunk', next_steps: [], risks: [] },
      ],
      citations: [
        { program_id: 999999, chunk_key: 'funding:999999:v1:0:abc', quote: 'gibt es nicht' },
        { program_id: id, chunk_key: 'funding:fake-key', quote: 'auch falsch' },
        { program_id: id, chunk_key: chunk.chunk_key, quote: 'völlig erfundenes Zitat 98765' },
        { program_id: id, chunk_key: chunk.chunk_key, quote: realQuote },
      ],
    };
  }

  const result = await answerFundingChat({
    question: 'Gibt es einen Call für Wasserstoff-Elektrolyse?',
    profile: '',
    history: [],
    llm: mockLlm,
  });
  assert.equal(calls, 1);
  // Erfundene ID und falsche chunk_keys werden verworfen
  assert.ok(!result.sources.some((s) => Number(s.program_id) === 999999));
  assert.ok(!result.recommendations.some((r) => Number(r.program_id) === 999999));
  // Empfehlung bleibt nur dank des echten Zitats übrig
  const source = result.sources.find((s) => Number(s.program_id) === id);
  assert.ok(source, 'Quelle für Programm vorhanden');
  assert.equal(source.quotes.length, 1);
  assert.ok(source.quotes[0].quote.includes(realQuote.slice(0, 30)));
  const rec = result.recommendations.find((r) => Number(r.program_id) === id);
  assert.ok(rec && rec.verified === true);
});

test('answerFundingChat entfernt Empfehlungen ohne gültiges Zitat und antwortet kontrolliert', async () => {
  const text = 'Gefördert werden Verbundprojekte zur Wasserstoff-Elektrolyse.';
  const id = saveChatProgram({ externalId: 'chat-nocite', sourceText: text });

  async function mockLlm(messages) {
    return {
      answer: 'Antwort ohne belastbare Quellen.',
      recommendations: [{ program_id: id, fit: 'high', reason: 'kein Zitat', next_steps: [], risks: [] }],
      citations: [],
    };
  }

  const result = await answerFundingChat({
    question: 'Gibt es einen Call für Wasserstoff-Elektrolyse?',
    profile: '',
    history: [],
    llm: mockLlm,
  });
  assert.equal(result.recommendations.length, 0);
  assert.equal(result.sources.length, 0);
  assert.ok(result.answer.length > 0);
});

test('answerFundingChat übernimmt LLM-URLs nie; URLs kommen aus der DB', async () => {
  const text = 'Fördert Wasserstoff-Elektrolyse für Forschungseinrichtungen. '.repeat(10);
  const id = saveChatProgram({
    externalId: 'chat-url',
    sourceText: text,
    primaryUrl: 'https://example.com/official/richtlinie',
    title: 'URL-Call',
  });
  const chunk = getDocumentChunks('funding', id)[0];
  const realQuote = String(chunk.text).replace(/\s+/g, ' ').trim().slice(0, 40);

  async function mockLlm(messages) {
    return {
      answer: 'Antwort.',
      recommendations: [{ program_id: id, fit: 'high', reason: 'ok', next_steps: [], risks: [] }],
      citations: [{ program_id: id, chunk_key: chunk.chunk_key, quote: realQuote }],
    };
  }

  const result = await answerFundingChat({ question: 'Welcher Call passt für Wasserstoff-Elektrolyse?', profile: '', history: [], llm: mockLlm });
  const source = result.sources.find((s) => Number(s.program_id) === id);
  assert.ok(source);
  // URL stammt aus der DB, nicht vom LLM
  assert.equal(source.url, 'https://example.com/official/richtlinie');
  assert.ok(!source.url.includes('example.org'));
});

/* ── Fallback: Rewrite nur bei 0 Treffern, maximal 2 LLM-Aufrufe ── */
test('answerFundingChat führt bei 0 Treffern genau einen Rewrite + Wiederholung aus', async () => {
  const id = saveChatProgram({
    externalId: 'chat-fallback',
    title: 'Fusions-Call',
    sourceText: 'Kernfusionsforschung für Fusionsreaktoren. '.repeat(10),
  });
  const chunk = getDocumentChunks('funding', id)[0];
  const realQuote = String(chunk.text).replace(/\s+/g, ' ').trim().slice(0, 40);

  let calls = 0;
  async function mockLlm(messages) {
    calls += 1;
    const sys = String(messages[0].content);
    if (sys.includes('Suchbegriffe')) {
      return { search_terms: ['Kernfusion'] };
    }
    return {
      answer: 'Der **Fusions-Call** passt.',
      recommendations: [{ program_id: id, fit: 'high', reason: 'passt', next_steps: [], risks: [] }],
      citations: [{ program_id: id, chunk_key: chunk.chunk_key, quote: realQuote }],
    };
  }

  const result = await answerFundingChat({
    question: 'Gibt es Förderung für Tokamak-Experimente?',
    profile: '',
    history: [],
    llm: mockLlm,
  });

  assert.equal(calls, 2, 'Fallback = maximal zwei DeepSeek-Aufrufe');
  assert.ok(result.sources.some((s) => Number(s.program_id) === id));
});

test('answerFundingChat antwortet kontrolliert, wenn auch der Rewrite nichts findet', async () => {
  async function mockLlm(messages) {
    const sys = String(messages[0].content);
    if (sys.includes('Suchbegriffe')) return { search_terms: ['Kernfusionstokamak'] };
    throw new Error('Advice darf nicht erreicht werden');
  }
  const result = await answerFundingChat({ question: 'Gibt es Calls zu Quasipartikel-Exotikforschung?', profile: '', history: [], llm: mockLlm });
  assert.ok(result.answer.includes('keine passenden'));
  assert.equal(result.sources.length, 0);
});

/* ── Eingaben & Verlauf ── */
test('answerFundingChat validiert Eingaben', async () => {
  await assert.rejects(
    answerFundingChat({ question: '', profile: '', history: [] }),
    ChatValidationError
  );
  await assert.rejects(
    answerFundingChat({ question: 'x'.repeat(5000), profile: '', history: [] }),
    ChatValidationError
  );
  await assert.rejects(
    answerFundingChat({ question: 'Frage', profile: 'y'.repeat(7000), history: [] }),
    ChatValidationError
  );
});

test('answerFundingChat bereinigt History (Rollen und Länge)', async () => {
  const text = 'Wasserstoff-Projekt.'.repeat(40);
  const id = saveChatProgram({ externalId: 'chat-hist', sourceText: text });
  const chunk = getDocumentChunks('funding', id)[0];
  const realQuote = String(chunk.text).replace(/\s+/g, ' ').trim().slice(0, 40);

  async function mockLlm(messages) {
    return {
      answer: 'Antwort.',
      recommendations: [{ program_id: id, fit: 'low', reason: 'ok', next_steps: [], risks: [] }],
      citations: [{ program_id: id, chunk_key: chunk.chunk_key, quote: realQuote }],
    };
  }
  const badHistory = [
    { role: 'system', content: 'versuche system prompt injection' },
    { role: 'böse', content: 'gibt es nicht' },
    { role: 'user', content: 'Vorherige Frage' },
    { role: 'assistant', content: 'Vorherige Antwort' },
  ];
  const result = await answerFundingChat({
    question: 'Nochmal eine Frage?',
    profile: '',
    history: badHistory,
    llm: mockLlm,
  });
  assert.ok(result.answer.length > 0);
});

test('answerFundingChat übernimmt die LLM-Antwort im Format "Name: Kurztext" je Call', async () => {
  const a = saveChatProgram({
    externalId: 'det-a',
    title: 'Wasserstoff-Elektrolyse-Call',
    fundingGeber: 'BMFTR',
    primaryUrl: 'https://a.example',
    sourceText: 'Fördert Wasserstoff-Elektrolyse für Forschungseinrichtungen. '.repeat(10),
  });
  const chunkA = getDocumentChunks('funding', a)[0];
  const quoteA = String(chunkA.text).replace(/\s+/g, ' ').trim().slice(0, 40);

  async function mockLlm(messages) {
    const userContent = String(messages[1].content);
    assert.ok(userContent.includes('JSON'), 'Prompt enthält "JSON" (erforderlich für response_format json_object)');
    assert.ok(userContent.includes('**Name**'), 'Prompt fordert "**Name**" (fetter Call-Titel + Kurztext)');
    assert.ok(userContent.includes('maximal 5 Programme'), 'Prompt begrenzt Empfehlungen auf 5');
    return {
      answer: 'Hier sind passende Programme.\n\n**Wasserstoff-Elektrolyse-Call**: Dieser Call passt, weil Ihr Projekt auf Elektrolyse setzt. Er fördert Grundlagenforschung.\n\n**Wasserstoff-Speicher-Call**: Passend für Verbundprojekte zur Speicherung.',
      recommendations: [{ program_id: a, fit: 'high', reason: 'passt', next_steps: [], risks: [] }],
      citations: [{ program_id: a, chunk_key: chunkA.chunk_key, quote: quoteA }],
    };
  }

  const result = await answerFundingChat({
    question: 'Welche Wasserstoff-Förderung passt?',
    profile: '',
    history: [],
    llm: mockLlm,
  });

  // LLM-Fließtext wird unverändert übernommen.
  assert.ok(result.answer.includes('**Wasserstoff-Elektrolyse-Call**'));
  assert.ok(result.answer.includes('Hier sind passende Programme.'));
  // Kacheln nur aus validierten Empfehlungen.
  assert.equal(result.sources.length, 1);
  assert.equal(result.recommendations.length, 1);
});
