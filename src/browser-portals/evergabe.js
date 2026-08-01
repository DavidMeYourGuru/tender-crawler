import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import config from '../config.js';
import {
  saveTender,
  getTenderById,
  startCrawlLog,
  finishCrawlLog,
  getCheckpoint,
  updateCheckpoint,
} from '../db.js';
import { RateLimiter } from '../crawler/rate-limiter.js';
import { fetchDetail as fetchHttpDetail } from '../portals/evergabe.js';
import { contentHash, normalizeDate, deriveStatus } from '../utils.js';

export const meta = {
  id: 'evergabe',
  name: 'eVergabe Online (Vergabeplattform des Bundes)',
  region: 'de',
  type: 'browser',
  schedule: '0 */8 * * *',
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://www.evergabe-online.de',
};

const SEARCH_URL = 'https://www.evergabe-online.de/search.html';
const NAVIGATOR_LINK = 'a[href*="topToolbars"][href*="pageLink"]';
const ROW_SELECTOR = 'tr.even, tr.odd';

export function profileDir() {
  return path.join(config.browserProfileDir, 'evergabe');
}

/**
 * Pure Funktion: parst eine extrahierte Tabellenzeile in ein Tender-Objekt.
 * `raw` = { cells: string[], href: string|null }
 */
export function parseRow(raw) {
  if (!raw || !Array.isArray(raw.cells) || !raw.cells.length) return null;
  const href = raw.href || '';
  const idMatch = href.match(/[?&]id=(\d+)/);
  const externalId = idMatch ? idMatch[1] : null;
  if (!externalId) return null;

  const title = raw.cells[0] || 'Ohne Titel';
  const reference = raw.cells[1] || externalId;
  const deadline = normalizeDate(raw.cells[5]);
  const publicationDate = normalizeDate(raw.cells[6]);
  const status = deriveStatus(deadline, 'open');

  return {
    sourceId: 'evergabe',
    externalId: String(externalId),
    title: String(title).trim(),
    url: `${meta.baseUrl}/tenderdetails.html?id=${externalId}`,
    description: null,
    contractingAuthority: raw.cells[2] ? String(raw.cells[2]).trim() : null,
    cpvCodes: null,
    cpvLabels: null,
    estimatedValueCents: null,
    estimatedValueCurrency: 'EUR',
    placeOfPerformance: raw.cells[3] ? String(raw.cells[3]).trim() : null,
    awardCriteria: null,
    tenderType: raw.cells[4] ? String(raw.cells[4]).trim() : null,
    publicationDate,
    submissionDeadline: deadline,
    openingDate: null,
    contractDuration: null,
    documentUrl: null,
    status,
    contentHash: contentHash(externalId, reference, title, deadline, status, null),
  };
}

/**
 * Extrahiert alle Ergebniszeilen der aktuellen Seite aus dem Browser-DOM.
 */
async function extractRows(page) {
  return page.evaluate((rowSelector) => {
    const rows = [...document.querySelectorAll(rowSelector)];
    return rows.map((row) => {
      const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim());
      const link = row.querySelector('a[href*="tenderdetails"], a[href*="?id="]');
      return { cells, href: link ? link.getAttribute('href') : null };
    });
  }, ROW_SELECTOR);
}

/**
 * Sucht den Link zur nächsten Seite im Wicket-Navigator.
 * Liefert die absolute URL oder null (letzte Seite erreicht).
 */
async function getNextPageUrl(page, currentPage) {
  return page.evaluate(({ rowSelector, navLink, currentPage: cp }) => {
    const anchors = [...document.querySelectorAll(navLink)];
    const byNumber = (text) => new RegExp(`^\\s*${text}\\s*$`).test(String(text).trim());
    const next = anchors.find((a) => byNumber(a.textContent.trim()) && Number(a.textContent.trim()) === cp + 1);
    if (next) return next.getAttribute('href');
    // Fallback: "Weiter"-Pfeil im Navigator
    const arrow = anchors.find((a) => /^(\s*>\s*|\s*>>\s*|\u203A|\u00BB)$/.test(a.textContent));
    return arrow ? arrow.getAttribute('href') : null;
  }, { rowSelector: ROW_SELECTOR, navLink: NAVIGATOR_LINK, currentPage });
}

/**
 * Führt den eVergabe-Browser-Crawl aus.
 * - mode 'backfill': läuft bis zum 24-Monats-Stichtag, Checkpoint wird gesetzt
 * - mode 'incremental': stoppt nach mehreren vollständig bekannten Seiten
 */
export async function runEvergabeJob({ job, onProgress = () => {} } = {}) {
  const checkpoint = getCheckpoint('evergabe');
  const mode = checkpoint.backfill_complete ? 'incremental' : 'backfill';
  const log = startCrawlLog('evergabe');
  const stats = {
    pagesDone: 0,
    itemsDiscovered: 0,
    itemsNew: 0,
    itemsChanged: 0,
    knownStreak: checkpoint.known_page_streak || 0,
    oldestPublicationDate: checkpoint.oldest_publication_date || null,
    mode,
  };

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - config.evergabeBackfillMonths);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  fs.mkdirSync(config.browserProfileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir(), {
    headless: config.browserHeadless,
    viewport: { width: 1440, height: 900 },
    locale: 'de-DE',
    userAgent: config.userAgent,
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    // Startseite + Suche laden, Wicket initialisieren lassen
    await page.goto(meta.baseUrl + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.browserPageWaitMs);
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('select[name=rowsPerPageChoice]', { timeout: 60000 });
    await page.waitForTimeout(config.browserPageWaitMs);

    // Seitengröße auf 100 Ergebnisse setzen und abwarten
    await page.selectOption('select[name=rowsPerPageChoice]', '3');
    await page.waitForFunction(
      (rowSelector) => document.querySelectorAll(rowSelector).length >= 100,
      ROW_SELECTOR,
      { timeout: 30000 }
    );

    let pageNumber = 1;
    let backfillDone = false;
    let incrementalDone = false;
    const newTenderIds = [];

    while (true) {
      if (job?.cancel_requested) {
        throw Object.assign(new Error('Job wurde abgebrochen'), { cancelled: true });
      }

      const rows = await extractRows(page);
      if (!rows.length) {
        throw new Error('eVergabe: keine Ergebniszeilen gefunden – DOM/Selektor geändert?');
      }

      let pageAllKnown = true;
      for (const raw of rows) {
        const tender = parseRow(raw);
        if (!tender) continue;
        stats.itemsDiscovered += 1;
        const result = saveTender(tender);
        if (result.isNew) {
          stats.itemsNew += 1;
          newTenderIds.push({ id: result.tenderId, url: tender.url });
        } else if (result.changed) {
          stats.itemsChanged += 1;
        }
        if (result.isNew || result.changed) pageAllKnown = false;
        if (tender.publicationDate && (!stats.oldestPublicationDate || tender.publicationDate < stats.oldestPublicationDate)) {
          stats.oldestPublicationDate = tender.publicationDate;
        }
      }
      stats.pagesDone += 1;
      stats.knownStreak = pageAllKnown ? stats.knownStreak + 1 : 0;

      backfillDone = mode === 'backfill' && Boolean(stats.oldestPublicationDate) && stats.oldestPublicationDate < cutoffIso;
      incrementalDone = mode === 'incremental' && stats.knownStreak >= config.evergabeKnownPageStop;

      // Im inkrementellen Modus darf der Backfill-Status nicht zurückgesetzt werden
      updateCheckpoint('evergabe', {
        backfillComplete: mode === 'backfill' ? (backfillDone ? 1 : 0) : undefined,
        oldestPublicationDate: stats.oldestPublicationDate,
        lastPageKey: String(pageNumber),
        knownPageStreak: stats.knownStreak,
      });
      onProgress({ ...stats, pageNumber, backfillDone, incrementalDone });

      if (backfillDone || incrementalDone) break;

      const nextUrl = await getNextPageUrl(page, pageNumber);
      if (!nextUrl) {
        // Ende der Ergebnisliste erreicht → Backfill ist vollständig abgearbeitet
        if (mode === 'backfill') {
          backfillDone = true;
          updateCheckpoint('evergabe', {
            backfillComplete: 1,
            oldestPublicationDate: stats.oldestPublicationDate,
            lastPageKey: String(pageNumber),
            knownPageStreak: stats.knownStreak,
          });
          onProgress({ ...stats, pageNumber, backfillDone, incrementalDone });
        }
        break;
      }

      await page.goto(new URL(nextUrl, SEARCH_URL).toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(ROW_SELECTOR, { timeout: 45000 });
      await page.waitForTimeout(config.browserPageWaitMs);
      pageNumber += 1;
    }

    // Detail-Anreicherung nur für neue Tender (über den HTTP-Adapter, rate-limited)
    let enriched = 0;
    if (newTenderIds.length) {
      console.log(`[evergabe] Enrich: ${newTenderIds.length} neue Tender werden angereichert …`);
      const limit = meta.rateLimit;
      const limiter = new RateLimiter(limit.maxRequests, limit.windowMs);
      for (const item of newTenderIds) {
        if (job?.cancel_requested) break;
        try {
          // Rate-Limiting übernimmt fetchDetail intern (rateLimiter-Option)
          const detail = await fetchHttpDetail(item.url, { rateLimiter: limiter });
          const stored = detail?.description || detail?.documentUrl ? getTenderById(item.id) : null;
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
              // Listen-Hash beibehalten, damit kein Pendeln zwischen Sweep- und Enrich-Hash entsteht;
              // die Beschreibung wird über die Feld-Änderungserkennung protokolliert.
              contentHash: stored.content_hash,
            });
            enriched += 1;
          }
        } catch (error) {
          console.warn(`[evergabe] Detail-Anreicherung für ${item.id} fehlgeschlagen: ${error.message}`);
        }
      }
    }
    stats.enriched = enriched;

    finishCrawlLog({
      id: log.id,
      status: 'completed',
      itemsDiscovered: stats.itemsDiscovered,
      itemsNew: stats.itemsNew,
      itemsChanged: stats.itemsChanged,
      errors: 0,
      errorMessage: null,
    });
    return { ...stats, finished: true, backfillDone, incrementalDone };
  } catch (error) {
    finishCrawlLog({
      id: log.id,
      status: 'failed',
      itemsDiscovered: stats.itemsDiscovered,
      itemsNew: stats.itemsNew,
      itemsChanged: stats.itemsChanged,
      errors: 1,
      errorMessage: error.message,
    });
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

export default { meta, run: runEvergabeJob, profileDir, parseRow };
