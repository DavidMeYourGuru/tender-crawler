import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import {
  enqueueBrowserJob,
  hasActiveBrowserJob,
  claimNextBrowserJob,
  completeBrowserJob,
  finishBrowserJob,
  requestCancelJob,
  recoverStaleJobs,
  getRecentJobs,
  getCheckpoint,
  updateCheckpoint,
} from '../src/db.js';
import { parseRow } from '../src/browser-portals/evergabe.js';

// Die Tests dürfen die Produktions-Queue/Checkpoints nicht beschädigen:
// Nur Jobs oberhalb des Ausgangsstandes werden gelöscht, der bestehende
// Checkpoint wird nach dem Lauf wiederhergestellt.
let baselineMaxId = 0;
const savedCheckpoints = [];

before(() => {
  baselineMaxId = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM crawl_jobs').get().m;
  for (const row of db.prepare('SELECT source_id FROM crawl_checkpoints').all()) {
    savedCheckpoints.push(db.prepare('SELECT * FROM crawl_checkpoints WHERE source_id = ?').get(row.source_id));
  }
});

beforeEach(() => {
  db.prepare('DELETE FROM crawl_jobs WHERE id > ?').run(baselineMaxId);
});

after(() => {
  db.prepare('DELETE FROM crawl_jobs WHERE id > ?').run(baselineMaxId);
  db.prepare('DELETE FROM crawl_checkpoints').run();
  for (const cp of savedCheckpoints) {
    db.prepare(`
      INSERT OR REPLACE INTO crawl_checkpoints (
        source_id, backfill_complete, oldest_publication_date, last_page_key,
        last_success_at, known_page_streak, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      cp.source_id, cp.backfill_complete, cp.oldest_publication_date, cp.last_page_key,
      cp.last_success_at, cp.known_page_streak, cp.updated_at
    );
  }
  db.prepare("DELETE FROM tenders WHERE source_id = 'test'").run();
});

test('enqueueBrowserJob legt queued-Job an', () => {
  const job = enqueueBrowserJob('evergabe');
  assert.ok(job);
  assert.equal(job.source_id, 'evergabe');
  assert.equal(job.status, 'queued');
  assert.equal(job.mode, 'auto');
});

test('enqueueBrowserJob verhindert parallele aktive Jobs', () => {
  assert.ok(enqueueBrowserJob('evergabe'));
  assert.equal(enqueueBrowserJob('evergabe'), null);
  assert.equal(hasActiveBrowserJob('evergabe'), true);
});

test('claimNextBrowserJob claimt atomar den ältesten Job', () => {
  enqueueBrowserJob('evergabe');
  const job = claimNextBrowserJob('worker-1');
  assert.ok(job);
  assert.equal(job.status, 'running');
  assert.equal(job.locked_by, 'worker-1');
  assert.equal(job.attempt, 1);
  // kein zweiter Claim möglich
  assert.equal(claimNextBrowserJob('worker-2'), null);
});

test('completeBrowserJob schließt einen Job ab', () => {
  const job = enqueueBrowserJob('evergabe');
  completeBrowserJob(job.id, { pagesDone: 3, itemsDiscovered: 300, itemsNew: 12 });
  const done = db.prepare('SELECT * FROM crawl_jobs WHERE id = ?').get(job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.pages_done, 3);
  assert.equal(done.items_new, 12);
  // aktiver Job ist weg → neue Jobs möglich
  assert.equal(hasActiveBrowserJob('evergabe'), false);
});

test('fehlgeschlagener Job geht auf retry, dann failed', () => {
  const job = enqueueBrowserJob('evergabe');
  claimNextBrowserJob('worker-1');
  finishBrowserJob(job.id, 'retry', { error: 'Zeitüberschreitung' });
  assert.equal(db.prepare('SELECT status FROM crawl_jobs WHERE id=?').get(job.id).status, 'retry');
  // erneut claimen und endgültig fehlschlagen
  const retried = claimNextBrowserJob('worker-1');
  assert.equal(retried.id, job.id);
  finishBrowserJob(job.id, 'failed', { error: 'endgültig' });
  assert.equal(db.prepare('SELECT status FROM crawl_jobs WHERE id=?').get(job.id).status, 'failed');
});

test('requestCancelJob setzt cancel_requested', () => {
  const job = enqueueBrowserJob('evergabe');
  requestCancelJob(job.id);
  assert.equal(db.prepare('SELECT cancel_requested FROM crawl_jobs WHERE id=?').get(job.id).cancel_requested, 1);
});

test('recoverStaleJobs setzt verwaiste Lauf-Jobs auf retry', () => {
  const job = enqueueBrowserJob('evergabe');
  claimNextBrowserJob('worker-1');
  // Heartbeat künstlich alt setzen
  db.prepare('UPDATE crawl_jobs SET heartbeat_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', job.id);
  const changed = recoverStaleJobs(new Date().toISOString(), 60000);
  assert.equal(changed, 1);
  assert.equal(db.prepare('SELECT status FROM crawl_jobs WHERE id=?').get(job.id).status, 'retry');
});

test('getRecentJobs liefert letzte Jobs inkl. Quellenname', () => {
  enqueueBrowserJob('evergabe');
  const jobs = getRecentJobs(5);
  assert.ok(jobs.length >= 1);
  assert.equal(jobs[0].source_id, 'evergabe');
  assert.ok(jobs[0].source_name);
});

test('updateCheckpoint speichert und erhält Werte', () => {
  updateCheckpoint('evergabe', { backfillComplete: 1, oldestPublicationDate: '2024-01-01', knownPageStreak: 2 });
  let cp = getCheckpoint('evergabe');
  assert.equal(cp.backfill_complete, 1);
  assert.equal(cp.oldest_publication_date, '2024-01-01');
  assert.equal(cp.known_page_streak, 2);

  // undefined-Werte bleiben erhalten
  updateCheckpoint('evergabe', { knownPageStreak: 3 });
  cp = getCheckpoint('evergabe');
  assert.equal(cp.backfill_complete, 1);
  assert.equal(cp.known_page_streak, 3);
});

test('parseRow extrahiert eVergabe-Tabellenzeilen', () => {
  const tender = parseRow({
    cells: [
      'Erstellung eines Mietspiegels für 2027',
      '2026-ÖA-SE-06',
      'Stadtverwaltung Jena',
      'Jena',
      'National Öffentliche Ausschreibung',
      '04.09.26, 10:00',
      '31.07.26',
    ],
    href: './tenderdetails.html?id=880158',
  });
  assert.ok(tender);
  assert.equal(tender.sourceId, 'evergabe');
  assert.equal(tender.externalId, '880158');
  assert.equal(tender.title, 'Erstellung eines Mietspiegels für 2027');
  assert.equal(tender.contractingAuthority, 'Stadtverwaltung Jena');
  assert.equal(tender.placeOfPerformance, 'Jena');
  assert.equal(tender.tenderType, 'National Öffentliche Ausschreibung');
  assert.equal(tender.submissionDeadline, '2026-09-04');
  assert.equal(tender.publicationDate, '2026-07-31');
  assert.ok(tender.url.includes('id=880158'));
});

test('parseRow überspringt Zeilen ohne ID', () => {
  assert.equal(parseRow({ cells: ['Titel'], href: null }), null);
  assert.equal(parseRow(null), null);
  assert.equal(parseRow({ cells: [] }), null);
});
