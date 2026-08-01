/**
 * Laden der Förderquellen-Adapter aus src/funding/sources.
 * Ein Adapter exportiert: meta (id, name, baseUrl, rateLimit) und discover().
 * discover() liefert Kandidaten: { sourceId, externalId, url, title, publicationDate }.
 * Optional fetchDocs(candidate) liefert Dokumente für die Extraktion.
 *
 * Die einzige aktive Förderquelle ist Förderinfo (foerderinfo.bund.de).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ONLY_SOURCE = 'foerderinfo.js';

export async function loadFundingSources() {
  const files = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith('.js') && file !== 'registry.js' && file === ONLY_SOURCE);

  const sources = new Map();
  for (const file of files) {
    try {
      const module = await import(path.join(__dirname, file));
      if (module.meta?.id && typeof module.discover === 'function') {
        sources.set(module.meta.id, module);
      }
    } catch (error) {
      console.error(`[funding-sources] Adapter ${file} konnte nicht geladen werden:`, error.message);
    }
  }
  return sources;
}

export function listFundingSourceFiles() {
  return [ONLY_SOURCE.replace(/\.js$/, '')];
}

export default { loadFundingSources, listFundingSourceFiles };
