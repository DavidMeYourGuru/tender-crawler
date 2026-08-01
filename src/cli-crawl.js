import { runCrawl } from './crawler/orchestrator.js';
import { runAnalysis } from './llm.js';
import config, { rootDir } from './config.js';
import path from 'node:path';

function printUsage() {
  console.log(`
Verwendung:
  node src/cli-crawl.js crawl [quellen]        Führt einen Crawl aus (optional: kommagetrennte Quellen, z. B. "ted,bund")
  node src/cli-crawl.js analyze [limit]        Startet die LLM-Analyse (optional: Limit pro Batch)
  node src/cli-crawl.js help                   Zeigt diese Hilfe

Beispiele:
  node src/cli-crawl.js crawl
  node src/cli-crawl.js crawl ted,bund
  node src/cli-crawl.js analyze 10
`);
}

function parseArgs() {
  const [, , command, arg] = process.argv;
  return { command, arg };
}

async function main() {
  const { command, arg } = parseArgs();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'crawl') {
    const sources = arg
      ? arg.split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    console.log(`[cli] Crawl gestartet${sources ? ` (Quellen: ${sources.join(', ')})` : ' (alle Quellen)'}`);
    const status = await runCrawl({ sources, enrich: true });
    console.log('[cli]', status.message);
    for (const summary of status.summaries || []) {
      console.log(
        `  - ${summary.sourceName}: ${summary.itemsDiscovered} gefunden, ` +
        `${summary.itemsNew} neu, ${summary.itemsChanged} geändert, ` +
        `${summary.errors} Fehler (${summary.status})`
      );
    }
    process.exit(0);
  }

  if (command === 'analyze') {
    if (!config.llmEnabled) {
      console.error('[cli] LLM-Analyse ist deaktiviert. Setze LLM_ENABLED=true in der .env.');
      process.exit(1);
    }
    const limit = arg ? Number.parseInt(arg, 10) : null;
    console.log(`[cli] LLM-Analyse gestartet (Limit: ${limit ?? 'Standard'})`);
    try {
      const result = await runAnalysis({ limit });
      console.log(`[cli] Analyse abgeschlossen: ${result.analyzed} analysiert, ${result.skipped} fehlgeschlagen`);
      process.exit(0);
    } catch (error) {
      console.error('[cli] Analyse fehlgeschlagen:', error.message);
      process.exit(1);
    }
  }

  console.error(`[cli] Unbekannter Befehl: "${command}"`);
  printUsage();
  process.exit(1);
}

main().catch((error) => {
  console.error('[cli] Unerwarteter Fehler:', error);
  process.exit(1);
});