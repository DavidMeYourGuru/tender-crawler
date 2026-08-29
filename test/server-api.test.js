import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-crawler-api-test-'));
process.env.DB_PATH = path.join(tmpDir, 'api.sqlite');
process.env.AUTH_ENABLED = 'false';
process.env.CRAWL_ON_START = 'false';
process.env.CRAWL_CRON = 'disabled';
process.env.FUNDING_CRAWL_CRON = 'disabled';
process.env.CRAWL_SOURCES_ENABLED = 'false';
const { saveTender, enqueueBrowserJob, claimNextBrowserJob, db } = await import('../src/db.js');
const { default: app } = await import('../src/server.js');

after(async () => {
  await app.close().catch(() => {});
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('GET /api/tenders/:id liefert Detail-Kinddaten und filtert unsichere URLs', async () => {
  const result = saveTender({
    sourceId: 'nrw', externalId: 'api-detail-1', portalProjectId: 'api-detail-1',
    title: 'API Detail', url: 'javascript:alert(1)', status: 'open', contentHash: 'api-detail-1',
    detailBundle: {
      fullCrawlSucceeded: true,
      completeness: { overall: 'complete', sections: { overview: 'complete', documents: 'complete' } },
      lots: [{ lotKey: '1', title: 'Los 1' }],
      criteria: [{ criterionKey: 'price', kind: 'award', title: 'Preis', weight: 100 }],
      messages: [{ portalMessageId: 'm1', subject: 'Frage', body: 'Antwort', sourceUrl: 'https://example.test/messages' }],
      textSections: [{ sectionKey: 'overview', title: 'Übersicht', text: 'Text' }],
      facts: [{ factKey: 'overview:known', sectionKey: 'overview', label: 'Bekannt', valueText: 'Wert' }],
      documents: [{ filename: 'doc.pdf', sourceUrl: 'javascript:alert(1)', locator: { href: 'javascript:alert(1)' } }],
    },
  });
  const response = await app.inject({ method: 'GET', url: `/api/tenders/${result.tenderId}` });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.url, null);
  assert.equal(body.lots.length, 1);
  assert.equal(body.criteria.length, 1);
  assert.equal(body.messages.length, 1);
  assert.equal(body.text_sections.length, 1);
  assert.equal(body.facts.length, 1);
  assert.equal(body.completeness_status.overall, 'complete');
  assert.equal(body.documents[0].source_url, null);
  assert.equal(body.documents[0].locator_json.href, null);
});

test('Ein veralteter Browser-Job lässt sich abbrechen und gibt den Neustart frei', async () => {
  const job = enqueueBrowserJob('evergabe');
  claimNextBrowserJob('api-test-worker');
  db.prepare('UPDATE crawl_jobs SET heartbeat_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', job.id);

  const cancelResponse = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
  assert.equal(cancelResponse.statusCode, 200);
  assert.equal(cancelResponse.json().cancelled, true);
  assert.equal(cancelResponse.json().job.status, 'cancelled');

  const statusResponse = await app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(statusResponse.statusCode, 200);
  assert.equal(statusResponse.json().jobs.active.some((activeJob) => activeJob.id === job.id), false);
  assert.ok(enqueueBrowserJob('evergabe'), 'Nach dem Abbruch kann ein neuer Job gestartet werden');
});

test('Suchprofile und Tender-Status bilden die Inbox-API ab', async () => {
  const profileResponse = await app.inject({ method: 'POST', url: '/api/searches', payload: {
    name: 'Landschaft', keywords: 'Freiraumplanung', cpvCodes: ['71420000', '71410000'],
    regions: [], statusFilter: 'open', minLeadDays: 5,
  } });
  assert.equal(profileResponse.statusCode, 200);
  const profile = profileResponse.json();
  assert.equal(profile.min_lead_days, 5);
  const updateResponse = await app.inject({ method: 'PUT', url: `/api/searches/${profile.id}`, payload: { name: 'Landschaft Büro' } });
  assert.equal(updateResponse.statusCode, 200);
  assert.equal(updateResponse.json().name, 'Landschaft Büro');
  const clearLeadResponse = await app.inject({ method: 'PUT', url: `/api/searches/${profile.id}`, payload: { minLeadDays: null, minRelevance: null } });
  assert.equal(clearLeadResponse.statusCode, 200);
  assert.equal(clearLeadResponse.json().min_lead_days, null);
  const tenderResult = saveTender({ sourceId: 'nrw', externalId: 'api-state-1', title: 'Freiraumplanung', url: 'https://example.test/tender', status: 'open', contentHash: 'api-state-1', cpvCodes: ['71420000'] });
  const orTender = saveTender({ sourceId: 'nrw', externalId: 'api-state-2', title: 'Außenanlagen', url: 'https://example.test/tender-2', status: 'open', contentHash: 'api-state-2', cpvCodes: ['71410000'] });
  const stateResponse = await app.inject({ method: 'POST', url: `/api/tenders/${tenderResult.tenderId}/state`, payload: { state: 'watch' } });
  assert.equal(stateResponse.statusCode, 200);
  assert.equal(stateResponse.json().state, 'watch');
  const seenResponse = await app.inject({ method: 'POST', url: `/api/tenders/${tenderResult.tenderId}/state`, payload: { state: 'seen' } });
  assert.equal(seenResponse.json().state, 'seen');
  const watchAgainResponse = await app.inject({ method: 'POST', url: `/api/tenders/${tenderResult.tenderId}/state`, payload: { state: 'watch' } });
  assert.equal(watchAgainResponse.json().state, 'watch');
  const listResponse = await app.inject({ method: 'GET', url: `/api/tenders?profile_id=${profile.id}&user_state=watch` });
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.json().tenders[0].user_state, 'watch');
  const profileListResponse = await app.inject({ method: 'GET', url: `/api/tenders?profile_id=${profile.id}` });
  assert.equal(profileListResponse.json().tenders.some((tender) => tender.id === orTender.tenderId), false, 'Keywordfilter schließt den zweiten Tender aus');
  const orProfileResponse = await app.inject({ method: 'POST', url: '/api/searches', payload: { name: 'CPV OR', cpvCodes: ['71420000', '71410000'], statusFilter: 'open' } });
  const orListResponse = await app.inject({ method: 'GET', url: `/api/tenders?profile_id=${orProfileResponse.json().id}` });
  assert.equal(orListResponse.json().tenders.length >= 2, true, 'Mehrere CPVs werden per OR verbunden');
  await app.inject({ method: 'DELETE', url: `/api/searches/${orProfileResponse.json().id}` });
  const invalidProfileResponse = await app.inject({ method: 'GET', url: '/api/tenders?profile_id=999999' });
  assert.equal(invalidProfileResponse.statusCode, 404);
  await app.inject({ method: 'DELETE', url: `/api/searches/${profile.id}` });
});
