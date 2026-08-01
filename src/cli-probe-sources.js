#!/usr/bin/env node
/**
 * CLI: prüft verwaltete Quellen und berichtet ihren Zustand.
 *
 * Beispiele:
 *   node src/cli-probe-sources.js            # alle ungeprüften http-Quellen
 *   node src/cli-probe-sources.js --all      # alle Quellen (auch aktive)
 *   node src/cli-probe-sources.js --kind=funding
 *   node src/cli-probe-sources.js --id=3
 */
import { probeSource, probeAllSources, seedCrawlSources } from './discovery/sources.js';
import { listCrawlSources } from './db.js';

function parseArgs(argv) {
  const args = { all: false, kind: null, id: null };
  for (const arg of argv) {
    if (arg === '--all') args.all = true;
    else if (arg.startsWith('--kind=')) args.kind = arg.slice('--kind='.length);
    else if (arg.startsWith('--id=')) args.id = Number(arg.slice('--id='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log('Verwendung: node src/cli-probe-sources.js [--all] [--kind=funding] [--id=3]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const { all, kind, id } = parseArgs(process.argv.slice(2));
  seedCrawlSources();
  let sources;
  if (id) {
    sources = listCrawlSources().filter((s) => s.id === id);
  } else {
    sources = listCrawlSources({ state: all ? null : 'unprobed', access: 'http' })
      .filter((s) => !kind || s.declared_kind === kind || s.declared_kind === 'mixed');
  }
  console.log(`Probe von ${sources.length} Quellen …`);
  const results = [];
  for (const source of sources) {
    try {
      const r = await probeSource(source.id);
      results.push({ sourceKey: source.source_key, name: source.name, state: r.state, http: r.httpStatus, items: r.itemsDiscovered, errorType: r.errorType });
      console.log(`  [${r.state.padEnd(12)}] ${source.source_key}: HTTP ${r.httpStatus ?? '-'} · ${r.itemsDiscovered} Treffer${r.errorType ? ` · ${r.errorType}` : ''}`);
    } catch (error) {
      results.push({ sourceKey: source.source_key, name: source.name, state: 'error', error: error.message });
      console.log(`  [error] ${source.source_key}: ${error.message}`);
    }
  }
  const byState = results.reduce((m, r) => ((m[r.state] = (m[r.state] || 0) + 1), m), {});
  console.log('\nZusammenfassung:', JSON.stringify(byState));
}

main().catch((error) => {
  console.error('Probe fehlgeschlagen:', error);
  process.exit(1);
});
