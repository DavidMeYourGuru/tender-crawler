/**
 * Vergabeportal Niedersachsen (Deutsche eVergabe, Healy Hudson).
 *
 * Identisch mit der Bayern-Anbindung: Nur über den Browser erreichbar
 * (JavaScript + Session-Storage). Niedersachsen ist gegenüber Bayern
 * lediglich ein anderer Bundesland-Parameter: BL=03 (Bayern = BL=09).
 *
 * Startpunkt: https://portal.deutsche-evergabe.de/Dashboards/Dashboard_off?BL=03
 *
 * Datenmengen-Reduktion: Es werden nur Ausschreibungen aus dem
 * Interessenbereich (Bau, Landschaftsarchitektur, Garten, Schulen,
 * Kita, Spielplätze) mitgenommen – siehe category-filter.js.
 *
 * DOM (live inspiziert am 2026-08-21): DevExtreme dxDataGrid.
 *   - Datenzeilen: <tr class="dx-row dx-data-row"> mit 7 <td>; die
 *     Titel-Zelle (Index 2) enthält den Ausschreibungstitel + Verfahrenstyp.
 *   - Spalten: [0] Icon, [1] VOrdn. (VOB/VGV/SektVo), [2] Titel,
 *     [3] Vergabestelle, [4] Publikation, [5] Frist, [6] Icon.
 *   - Detail-Link: Klick auf die Titel-Zelle (kein href, JS-Navigation).
 *   - Pager: .dx-datagrid-pager mit .dx-page-Elementen (Seitenzahlen 1..N).
 */
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
import { contentHash, normalizeDate, deriveStatus } from '../utils.js';
import { matchesInterestCategories } from '../category-filter.js';

export const meta = {
  id: 'niedersachsen',
  name: 'Vergabeportal Niedersachsen (Deutsche eVergabe)',
  region: 'niedersachsen',
  type: 'browser',
  schedule: '0 */8 * * *',
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://portal.deutsche-evergabe.de',
};

const DASHBOARD_URL = 'https://portal.deutsche-evergabe.de/Dashboards/Dashboard_off?BL=03';

// Verifizierte DevExtreme-dxDataGrid-Selektoren (live inspiziert).
const ROW_SELECTOR = 'tr.dx-row.dx-data-row';
const PAGER_SELECTOR = '.dx-datagrid-pager';
const PAGE_LINK_SELECTOR = '.dx-page';

export function profileDir() {
  return path.join(config.browserProfileDir, 'niedersachsen');
}

/**
 * Pure Funktion: parst eine extrahierte Tabellenzeile in ein Tender-Objekt.
 * `raw` = { cells: string[], href: string|null }
 */
export function parseRow(raw) {
  if (!raw || !Array.isArray(raw.cells) || raw.cells.length < 6) return null;

  // Spalten (DevExtreme dxDataGrid, live inspiziert):
  // [0] Icon, [1] VOrdn., [2] Titel, [3] Vergabestelle, [4] Publikation, [5] Frist, [6] Icon
  // Die Titel-Zelle enthält oft den Verfahrenstyp angehängt
  // (z. B. "Entsorgung SperrmüllOffenes Verfahren"). Wir trennen bekannte
  // Verfahrenstyp-Suffixe sauber ab.
  const VERFAHREN_TYPEN = ['Offenes Verfahren', 'Öffentliches Verfahren', 'Öffentliche Ausschreibung', 'Vergebener Auftrag', 'Bekanntmachung', 'Interessenbekundung', 'Wettbewerb'];
  let title = (raw.cells[2] || '').toString().replace(/\s+/g, ' ').trim();
  for (const vt of VERFAHREN_TYPEN) {
    const idx = title.indexOf(vt);
    if (idx > 0) {
      title = title.slice(0, idx).trim();
      break;
    }
  }
  if (!title) return null;

  // Externe ID: DevExtreme navigiert per JS (kein href). Wir hashen über
  // Titel + Vergabestelle + Frist, um stabile IDs zu erhalten.
  const contractingAuthority = (raw.cells[3] || '').toString().replace(/\s+/g, ' ').trim() || null;
  const publicationDate = normalizeDate(raw.cells[4]);
  const deadline = normalizeDate(raw.cells[5]);
  const externalId = contentHash(title, contractingAuthority, deadline);
  const status = deriveStatus(deadline, 'open');

  return {
    sourceId: 'niedersachsen',
    externalId: String(externalId),
    title,
    url: `${meta.baseUrl}/Dashboards/Dashboard_off?BL=03`,
    description: null,
    contractingAuthority,
    cpvCodes: null,
    cpvLabels: null,
    estimatedValueCents: null,
    estimatedValueCurrency: 'EUR',
    placeOfPerformance: null,
    awardCriteria: null,
    tenderType: (raw.cells[1] || '').toString().trim() || null,
    publicationDate,
    submissionDeadline: deadline,
    openingDate: null,
    contractDuration: null,
    documentUrl: null,
    status,
    contentHash: contentHash(externalId, title, deadline, status, null),
  };
}

/**
 * Extrahiert alle Ergebniszeilen der aktuellen Seite aus dem Browser-DOM.
 * DevExtreme dxDataGrid: Datenzeilen = tr.dx-row.dx-data-row mit 7 <td>.
 */
async function extractRows(page) {
  return page.evaluate((rowSelector) => {
    const rows = [...document.querySelectorAll(rowSelector)];
    return rows.map((row) => {
      const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim());
      return { cells, href: null };
    });
  }, ROW_SELECTOR);
}

/**
 * Liefert die Nummer der nächsten Seite (DevExtreme .dx-page-Links) oder null.
 * Wir klicken im Crawl-Loop auf die Seitenzahl, nicht auf einen href.
 */
async function getNextPageNumber(page, currentPage) {
  return page.evaluate(
    ({ pagerSelector, pageLinkSelector, currentPage: cp }) => {
      const pager = document.querySelector(pagerSelector);
      if (!pager) return null;
      const links = [...pager.querySelectorAll(pageLinkSelector)];
      const numbers = links
        .map((l) => Number(l.textContent.trim()))
        .filter((n) => Number.isInteger(n));
      if (!numbers.length) return null;
      const maxPage = Math.max(...numbers);
      return cp < maxPage ? cp + 1 : null;
    },
    { pagerSelector: PAGER_SELECTOR, pageLinkSelector: PAGE_LINK_SELECTOR, currentPage }
  );
}

/**
 * Führt den Niedersachsen-Browser-Crawl aus.
 */
export async function runNiedersachsenJob({ job, onProgress = () => {} } = {}) {
  const checkpoint = getCheckpoint('niedersachsen');
  const mode = checkpoint.backfill_complete ? 'incremental' : 'backfill';
  const log = startCrawlLog('niedersachsen');
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

    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
    // Auf das Rendern der Ergebnisliste warten (SPA)
    await page.waitForSelector(ROW_SELECTOR, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(config.browserPageWaitMs);

    // Seitengröße auf 100 setzen, um die Anzahl der zu durchsuchenden
    // Seiten zu minimieren (DevExtreme-Pager: .dx-page-size "100").
    const pageSizeSet = await page.evaluate(() => {
      const size = [...document.querySelectorAll('.dx-page-size')].find(
        (s) => s.textContent.trim() === '100'
      );
      if (size && !size.classList.contains('dx-selection')) {
        size.click();
        return true;
      }
      return false;
    });
    if (pageSizeSet) {
      await page.waitForTimeout(config.browserPageWaitMs);
      await page.waitForSelector(ROW_SELECTOR, { timeout: 60000 }).catch(() => {});
    }

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
        console.warn('[niedersachsen] Keine Ergebniszeilen gefunden – DOM/Selektor geändert?');
        break;
      }

      let pageAllKnown = true;
      for (const raw of rows) {
        const tender = parseRow(raw);
        if (!tender) continue;
        // Kategorie-Filter: nur Interessenbereich mitnehmen
        if (!matchesInterestCategories(tender)) continue;

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

      updateCheckpoint('niedersachsen', {
        backfillComplete: mode === 'backfill' ? (backfillDone ? 1 : 0) : undefined,
        oldestPublicationDate: stats.oldestPublicationDate,
        lastPageKey: String(pageNumber),
        knownPageStreak: stats.knownStreak,
      });
      onProgress({ ...stats, pageNumber, backfillDone, incrementalDone });

      if (backfillDone || incrementalDone) break;

      const nextPage = await getNextPageNumber(page, pageNumber);
      if (!nextPage) {
        if (mode === 'backfill') {
          backfillDone = true;
          updateCheckpoint('niedersachsen', {
            backfillComplete: 1,
            oldestPublicationDate: stats.oldestPublicationDate,
            lastPageKey: String(pageNumber),
            knownPageStreak: stats.knownStreak,
          });
          onProgress({ ...stats, pageNumber, backfillDone, incrementalDone });
        }
        break;
      }

      // DevExtreme-Pager: auf die Seitenzahl klicken (kein href-Navigation)
      const clicked = await page.evaluate(
        ({ pagerSelector, pageLinkSelector, target }) => {
          const pager = document.querySelector(pagerSelector);
          if (!pager) return false;
          const link = [...pager.querySelectorAll(pageLinkSelector)].find(
            (l) => Number(l.textContent.trim()) === target
          );
          if (!link) return false;
          link.click();
          return true;
        },
        { pagerSelector: PAGER_SELECTOR, pageLinkSelector: PAGE_LINK_SELECTOR, target: nextPage }
      );
      if (!clicked) {
        console.warn('[niedersachsen] Pager-Link für Seite ' + nextPage + ' nicht klickbar.');
        break;
      }
      await page.waitForSelector(ROW_SELECTOR, { timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(config.browserPageWaitMs);
      pageNumber = nextPage;
    }

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

export default { meta, run: runNiedersachsenJob, profileDir, parseRow };
