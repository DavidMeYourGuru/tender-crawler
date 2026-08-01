const fs = require('fs');
const path = require('path');

const results = [];
function ok(name) { results.push(`OK   ${name}`); }
function fail(name, err) { results.push(`FAIL ${name}: ${err.message}`); }

const outFile = '/home/tender-crawler/validation-output.txt';

function writeOutput(exitCode) {
  const output = results.join('\n') + `\n\n=== FAIL count: ${results.filter((r) => r.startsWith('FAIL')).length} ===\nEXIT_CODE=${exitCode}`;
  try {
    fs.writeFileSync(outFile, output, 'utf8');
    fmt = `=== ${results.length - results.filter((r) => r.startsWith('FAIL')).length}/${results.length} OK, ${results.filter((r) => r.startsWith('FAIL')).length} FAIL ===`;
    fs.writeFileSync('/home/tender-crawler/validation-summary.txt', output, 'utf8');
  } catch (err) {
    console.error('Output write failed:', err.message);
  }
  process.exit(exitCode);
}

async function main() {
  // 1. Modul-Imports prüfen (ESM dynamisch laden)
  const modules = [
    'src/config.js',
    'src/db.js',
    'src/utils.js',
    'src/llm.js',
    'src/crawler/rate-limiter.js',
    'src/crawler/http-client.js',
    'src/crawler/orchestrator.js',
    'src/portals/registry.js',
    'src/portals/ted.js',
    'src/portals/bund.js',
    'src/portals/evergabe.js',
    'src/portals/bayern.js',
    'src/portals/dtvp.js',
  ];
  for (const mod of modules) {
    try {
      await import(path.resolve('/home/tender-crawler', mod));
      ok(`import ${mod}`);
    } catch (err) {
      fail(`import ${mod}`, err);
    }
  }

  // 2. Kernfunktionen aus db.js testen
  try {
    const { saveTender, listTenders, getStats, getSources, getSavedSearches, createSavedSearch } = await import(path.resolve('/home/tender-crawler', 'src/db.js'));
    ok('db exports geladen');

    // Tender speichern + Wiederholung
    const now = new Date().toISOString();
    const tender = {
      sourceId: 'ted',
      externalId: 'VAL-TEST-1',
      title: 'Validierungs-Testausschreibung Laborausstattung',
      url: 'https://ted.europa.eu/de/notice/-/detail/VAL-TEST-1',
      description: 'Beschaffung von Laborausstattung für Forschungszwecke.',
      contractingAuthority: 'Test-Auftraggeber GmbH',
      cpvCodes: ['38000000'],
      cpvLabels: ['Laborgeräte'],
      estimatedValueCents: 25000000,
      estimatedValueCurrency: 'EUR',
      placeOfPerformance: 'München',
      publicationDate: now.slice(0, 10),
      submissionDeadline: '2026-12-31',
      status: 'open',
      contentHash: 'test-hash-1',
    };
    const saved = saveTender(tender, now);
    ok(`saveTender (isNew=${saved.isNew}, id=${saved.tenderId})`);

    const saved2 = saveTender(tender, now);
    ok(`saveTender idempotent (changed=${saved2.changed})`);

    // listTenders-Filter
    const list = listTenders({ q: 'Laborausstattung', sources: ['ted'], status: ['open'], limit: 5 });
    ok(`listTenders q/sources/status (total=${list.total})`);

    const listAll = listTenders({ limit: 5 });
    ok(`listTenders ohne Filter (total=${listAll.total})`);

    const stats = getStats();
    ok(`getStats (totalOpen=${stats.totalOpen}, total=${stats.totalTenders})`);

    const srcs = getSources();
    ok(`getSources (${srcs.length} Quellen)`);

    const search = createSavedSearch({ name: 'Test-Suche', keywords: 'Labor', cpvCodes: ['38000000'], sources: ['ted'], regions: ['eu'] });
    ok(`createSavedSearch (id=${search.id})`);

    const searches = getSavedSearches();
    ok(`getSavedSearches (${searches.length})`);
  } catch (err) {
    fail('db-Kernfunktionen', err);
  }

  // 3. utils testen
  try {
    const utils = await import(path.resolve('/home/tender-crawler', 'src/utils.js'));
    if (utils.normalizeDate('15.08.2026') !== '2026-08-15') throw new Error('normalizeDate dd.mm.yyyy');
    ok('normalizeDate dd.mm.yyyy');
    if (utils.parseMoneyToCents('1.250.000 EUR') !== 125000000) throw new Error('parseMoneyToCents');
    ok('parseMoneyToCents');
    if (!utils.contentHash('a', 'b', 'c')) throw new Error('contentHash');
    ok('contentHash');
    if (utils.daysUntil('2099-01-01') === null) throw new Error('daysUntil');
    ok('daysUntil');
  } catch (err) {
    fail('utils', err);
  }

  // 4. Portal-Registry testen
  try {
    const { loadPortalModules } = await import(path.resolve('/home/tender-crawler', 'src/portals/registry.js'));
    const portals = await loadPortalModules();
    ok(`loadPortalModules (${portals.size} Portale: ${[...portals.keys()].join(', ')})`);
  } catch (err) {
    fail('loadPortalModules', err);
  }

  // 5. LLM parseLlmResponse testen
  try {
    const { parseLlmResponse } = await import(path.resolve('/home/tender-crawler', 'src/llm.js'));
    const parsed = parseLlmResponse('{"summary":"Test","relevance_score":0.8,"relevance_reason":"Passt","requirements":["A","B"]}');
    if (parsed.relevanceScore !== 0.8) throw new Error('relevanceScore');
    ok(`parseLlmResponse (score=${parsed.relevanceScore})`);
  } catch (err) {
    fail('parseLlmResponse', err);
  }

  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  writeOutput(failed ? 1 : 0);
}

main().catch((err) => {
  results.push(`FATAL ${err.message}`);
  writeOutput(2);
});

// Fallback: Falls main() vor writeOutput scheitert, schreibe nach 30s Zwischenstand
setTimeout(() => {
  if (!fs.existsSync(outFile)) {
    fs.writeFileSync(outFile, results.join('\n') + '\n\n(TIMEOUT – Skript noch nicht durchgelaufen)\n', 'utf8');
  }
}, 45000);