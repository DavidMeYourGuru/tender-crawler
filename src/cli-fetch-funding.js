#!/usr/bin/env node
/**
 * CLI: startet einen Förder-Crawl (ausschließlich Förderinfo).
 * Optional mit --llm / --no-llm und --limit=<n> für einen Testlauf.
 *
 * Beispiele:
 *   node src/cli-fetch-funding.js
 *   node src/cli-fetch-funding.js --limit=10
 *   node src/cli-fetch-funding.js --no-llm --limit=5
 */
import config from './config.js';
import { runFundingCrawl } from './funding/orchestrator.js';

function parseArgs(argv) {
  const args = { llm: config.fundingLlmEnabled, limit: null };
  for (const arg of argv) {
    if (arg === '--llm') args.llm = true;
    else if (arg === '--no-llm') args.llm = false;
    else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      args.limit = Number.isFinite(n) && n > 0 ? n : null;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Verwendung: node src/cli-fetch-funding.js [--llm|--no-llm] [--limit=<n>]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const { llm, limit } = parseArgs(process.argv.slice(2));
  console.log(`[funding] CLI startet – Quelle: foerderinfo-bekanntmachungen, LLM: ${llm}${limit ? `, Limit: ${limit}` : ''}`);
  const state = await runFundingCrawl({ llmEnabled: llm, maxResults: limit });
  console.log(`[funding] ${state.message}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('[funding] CLI fehlgeschlagen:', error);
  process.exit(1);
});
