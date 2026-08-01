import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLlmResponse } from '../src/llm.js';

test('parseLlmResponse parst JSON-Antwort', () => {
  const result = parseLlmResponse(
    JSON.stringify({
      summary: 'Test-Zusammenfassung',
      relevance_score: 0.75,
      relevance_reason: 'Passt zum Profil',
      requirements: ['Anforderung A', 'Anforderung B'],
    })
  );
  assert.equal(result.summary, 'Test-Zusammenfassung');
  assert.equal(result.relevanceScore, 0.75);
  assert.equal(result.relevanceReason, 'Passt zum Profil');
  assert.deepEqual(result.requirements, ['Anforderung A', 'Anforderung B']);
});

test('parseLlmResponse entfernt Markdown-Code-Block', () => {
  const text = '```json\n{"summary": "Test", "relevance_score": 0.5}\n```';
  const result = parseLlmResponse(text);
  assert.equal(result.summary, 'Test');
  assert.equal(result.relevanceScore, 0.5);
});

test('parseLlmResponse extrahiert JSON aus Fließtext', () => {
  const text = 'Hier ist die Antwort: {"summary": "Extrahiert", "relevance_score": 0.9} Viel Erfolg!';
  const result = parseLlmResponse(text);
  assert.equal(result.summary, 'Extrahiert');
  assert.equal(result.relevanceScore, 0.9);
});

test('parseLlmResponse klemmt Scores auf 0 bis 1', () => {
  assert.equal(parseLlmResponse('{"summary":"a","relevance_score":1.5}').relevanceScore, 1);
  assert.equal(parseLlmResponse('{"summary":"a","relevance_score":-0.2}').relevanceScore, 0);
});

test('parseLlmResponse ignoriert leere Anforderungen', () => {
  const result = parseLlmResponse('{"summary":"a","relevance_score":0.3,"requirements":[]}');
  assert.deepEqual(result.requirements, []);
});

test('parseLlmResponse akzeptiert camelCase-Schluessel', () => {
  const result = parseLlmResponse(
    '{"summary":"a","relevanceScore":0.4,"relevanceReason":"weil","requirements":["x"]}'
  );
  assert.equal(result.relevanceScore, 0.4);
  assert.equal(result.relevanceReason, 'weil');
});

test('parseLlmResponse wirft bei leerer Antwort', () => {
  assert.throws(() => parseLlmResponse(''), /Leere LLM-Antwort/);
  assert.throws(() => parseLlmResponse(null), /Leere LLM-Antwort/);
});