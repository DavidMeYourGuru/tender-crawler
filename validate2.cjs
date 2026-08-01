const fs = require('fs');
const path = require('path');

const BASE = '/home/tender-crawler';

function write(step, content) {
  fs.writeFileSync(path.join(BASE, `validation-step-${String(step).padStart(2, '0')}.txt`), String(content), 'utf8');
}

async function main() {
  write(1, 'start');
  try {
    const configMod = await import(path.join(BASE, 'src/config.js'));
    write(2, `config OK: ${Object.keys(configMod.config || {}).length} keys`);
  } catch (err) {
    write(2, `config FAIL: ${err.stack || err.message}`);
    return;
  }

  try {
    const utilsMod = await import(path.join(BASE, 'src/utils.js'));
    const norm = utilsMod.normalizeDate('15.08.2026');
    const money = utilsMod.parseMoneyToCents('1.250.000 EUR');
    write(3, `utils OK: normalizeDate=${norm}, parseMoney=${money}`);
  } catch (err) {
    write(3, `utils FAIL: ${err.stack || err.message}`);
    return;
  }

  try {
    const dbMod = await import(path.join(BASE, 'src/db.js'));
    const stats = dbMod.getStats();
    const srcs = dbMod.getSources();
    write(4, `db OK: stats.total=${stats.totalTenders}, sources=${srcs.length}`);

    // Tender speichern
    try {
      const now = new Date().toISOString();
      const tender = {
        sourceId: 'ted',
        externalId: 'VAL-TEST-2',
        title: 'Validierungstest Laborausstattung',
        url: 'https://ted.europa.eu/de/notice/-/detail/VAL-TEST-2',
        description: 'Beschaffung von Laborausstattung.',
        contractingAuthority: 'Test GmbH',
        cpvCodes: ['38000000'],
        cpvLabels: ['Laborgeräte'],
        estimatedValueCents: 1000000,
        estimatedValueCurrency: 'EUR',
        placeOfPerformance: 'München',
        publicationDate: now.slice(0, 10),
        submissionDeadline: '2026-12-31',
        status: 'open',
        contentHash: 'test-hash-2',
      };
      const res = dbMod.saveTender(tender, now);
      write(5, `saveTender OK: isNew=${res.isNew}, id=${res.tenderId}`);

      const list = dbMod.listTenders({ q: 'Laborausstattung', sources: ['ted'], status: ['open'], limit: 5 });
      write(6, `listTenders OK: total=${list.total}`);
    } catch (err) {
      write(5, `saveTender FAIL: ${err.stack || err.message}`);
    }
  } catch (err) {
    write(4, `db FAIL: ${err.stack || err.message}`);
    return;
  }

  try {
    const { loadPortalModules } = await import(path.join(BASE, 'src/portals/registry.js'));
    const portals = await loadPortalModules();
    write(7, `portals OK: ${[...portals.keys()].join(', ')}`);
  } catch (err) {
    write(7, `portals FAIL: ${err.stack || err.message}`);
  }

  try {
    const llmMod = await import(path.join(BASE, 'src/llm.js'));
    const parsed = llmMod.parseLlmResponse('{"summary":"T","relevance_score":0.7,"relevance_reason":"R","requirements":["A"]}');
    write(8, `llm OK: score=${parsed.relevanceScore}`);
  } catch (err) {
    write(8, `llm FAIL: ${err.stack || err.message}`);
  }

  try {
    const orchMod = await import(path.join(BASE, 'src/crawler/orchestrator.js'));
    write(9, `orchestrator OK: ${typeof orchMod.runCrawl}`);
  } catch (err) {
    write(9, `orchestrator FAIL: ${err.stack || err.message}`);
  }

  write(10, 'ALL DONE');
}

main().catch((err) => {
  write(99, `FATAL: ${err.stack || err.message}`);
});