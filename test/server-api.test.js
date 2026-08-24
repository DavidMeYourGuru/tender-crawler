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
const { saveTender, db } = await import('../src/db.js');
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
