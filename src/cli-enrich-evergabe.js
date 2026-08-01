#!/usr/bin/env node
/**
 * Einmaliger Beschreibungs-Backfill für eVergabe-Tender ohne Beschreibung.
 *
 * Läuft über den HTTP-Adapter (Detailseiten) mit Rate-Limiting und füllt
 * fehlende `description`-Felder auf, damit die Volltextsuche funktioniert.
 *
 * Aufruf:
 *   node src/cli-enrich-evergabe.js            # alle fehlenden Beschreibungen
 *   node src/cli-enrich-evergabe.js --limit 50 # nur 50 Stück (Test)
 *   node src/cli-enrich-evergabe.js --source dtvp
 */
import config from './config.js';
import { db, getTenderById, saveTender } from './db.js';
import { RateLimiter } from './crawler/rate-limiter.js';

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
const sourceArg = args.find((a) => a.startsWith('--source='))?.split('=')[1];
const limit = limitArg ? parseInt(limitArg, 10) : Infinity;

async function main() {
  const sourceId = sourceArg || 'evergabe';
  const portal = (await import(`./portals/${sourceId}.js`)).default;

  if (typeof portal.fetchDetail !== 'function') {
    console.error(`[enrich] Quelle '${sourceId}' hat kein fetchDetail.`);
    process.exit(1);
  }

  const rows = db
    .prepare('SELECT id, url FROM tenders WHERE source_id = ? AND description IS NULL ORDER BY id LIMIT ?')
    .all(sourceId, limit === Infinity ? 100000 : limit);

  console.log(`[enrich] ${rows.length} Tender ohne Beschreibung gefunden (Quelle: ${sourceId}).`);
  if (!rows.length) {
    console.log('[enrich] Nichts zu tun.');
    return;
  }

  const limitCfg = portal.meta?.rateLimit || { maxRequests: 15, windowMs: 60000 };
  const limiter = new RateLimiter(limitCfg.maxRequests, limitCfg.windowMs);

  let enriched = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await limiter.acquire();
      const detail = await portal.fetchDetail(row.url, { rateLimiter: limiter });
      const stored = detail?.description || detail?.documentUrl ? getTenderById(row.id) : null;
      if (stored && detail.description && !stored.description) {
        saveTender({
          sourceId: stored.source_id,
          externalId: stored.external_id,
          title: stored.title,
          url: stored.url,
          description: detail.description.trim(),
          contractingAuthority: stored.contracting_authority,
          cpvCodes: stored.cpv_codes ? JSON.parse(stored.cpv_codes) : null,
          cpvLabels: stored.cpv_labels ? JSON.parse(stored.cpv_labels) : null,
          estimatedValueCents: stored.estimated_value_cents,
          estimatedValueCurrency: stored.estimated_value_currency,
          placeOfPerformance: stored.place_of_performance,
          awardCriteria: null,
          tenderType: stored.tender_type,
          publicationDate: stored.publication_date,
          submissionDeadline: stored.submission_deadline,
          openingDate: null,
          contractDuration: null,
          documentUrl: stored.document_url,
          status: stored.status,
          contentHash: stored.content_hash,
        });
        enriched += 1;
      }
    } catch (error) {
      failed += 1;
      if (failed <= 5) console.warn(`[enrich] ${row.id} fehlgeschlagen: ${error.message}`);
    }
    if (enriched % 25 === 0 && enriched > 0) {
      console.log(`[enrich] Fortschritt: ${enriched} angereichert / ${rows.length}`);
    }
  }

  const remaining = db
    .prepare('SELECT COUNT(*) c FROM tenders WHERE source_id = ? AND description IS NULL')
    .get(sourceId).c;
  console.log(`[enrich] Fertig: ${enriched} angereichert, ${failed} Fehler. Noch ohne Beschreibung: ${remaining}.`);
}

main().catch((error) => {
  console.error('[enrich] Abbruch:', error);
  process.exit(1);
});
