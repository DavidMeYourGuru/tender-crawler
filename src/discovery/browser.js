/**
 * Generischer Playwright-Runner für browserbasierte Quellen.
 *
 * Öffnet eine frische Browser-Session (keine manuelle Vorbereitung),
 * lädt die Listen-URL, klickt gängige Cookie-/Consent-Banner und
 * extrahiert Listeneinträge über konfigurierte oder Fallback-Selektoren.
 *
 * Läuft über die Worker-Queue (Heartbeat, Retry, Cancel) – nie im Server.
 */
import path from 'node:path';
import config from '../config.js';
import { getCrawlSource, getCrawlSourceByKey, addDiscoveredDocument, classifyDiscoveredDocument, setCrawlSourceState, recordSourceRun } from '../db.js';
import { classifyDocument } from './classify.js';
import { normalizeUrl, assertSafeUrl } from './urls.js';
import { sleep } from '../utils.js';

const FALLBACK_ITEM_SELECTORS = ['article', 'li.result', '.result', '.search-result', '.teaser', 'tbody tr', 'li'];

const CONSENT_SELECTORS = [
  'button:has-text("Nur technisch notwendige")',
  'button:has-text("Alle akzeptieren")',
  'button:has-text("Accept all")',
  'button:has-text("Zustimmen")',
  'button:has-text("Einverstanden")',
  '#onetrust-accept-btn-handler',
  '.sp_choice_type_11',
];

/**
 * Ruft einen Launcher-ähnlichen Zustand ab. Playwright wird lazy importiert,
 * damit Module ohne Chromium nicht beim Laden scheitern.
 */
async function getChromium() {
  const { chromium } = await import('playwright');
  return chromium;
}

export async function runGenericBrowserSource({ job, onProgress = () => {} }) {
  // job.source_id ist der String-Source-Key (crawl_jobs FK auf sources.id);
  // ggf. zusätzlich per Key auflösen.
  const source = getCrawlSource(job.source_id) || getCrawlSourceByKey(job.source_id);
  if (!source || source.access !== 'browser') {
    throw new Error(`Keine Browser-Quelle für '${job.source_id}'`);
  }
  assertSafeUrl(source.url);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const chromium = await getChromium();

  const profileDir = path.join(process.cwd(), 'data', 'browser-profiles', `managed-${source.source_key}`);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    locale: 'de-DE',
    userAgent: config.discoveryUserAgent,
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(45000);
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(config.fundingRequestDelayMs);

    // Cookie-/Consent-Banner wegklicken (best effort)
    for (const selector of CONSENT_SELECTORS) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click({ timeout: 3000 });
          await sleep(500);
          break;
        }
      } catch {
        // Banner nicht vorhanden – weiter
      }
    }

    const itemSelector = source.list_item_selector || FALLBACK_ITEM_SELECTORS.find((s) => page.locator(s).count() > 0);
    const rows = await page.locator(itemSelector).all();
    const results = [];
    const seen = new Set();

    for (const row of rows.slice(0, 60)) {
      try {
        const title = (await row.locator(source.title_selector || 'h2, h3, a').first().innerText({ timeout: 2000 }).catch(() => ''))?.trim();
        const href = await row.locator(source.link_selector || 'a').first().getAttribute('href').catch(() => null);
        if (!title || !href) continue;
        const url = normalizeUrl(href, page.url());
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const text = (await row.innerText().catch(() => '')) || '';
        results.push({ title: title.slice(0, 300), url, publicationDate: null, rawText: text.slice(0, 1000) });
      } catch {
        // einzelne Zeile überspringen
      }
    }

    const itemsDiscovered = results.length;
    onProgress({ pagesDone: 1, itemsDiscovered, itemsNew: 0, itemsChanged: 0, pageNumber: 1, mode: 'managed' });

    let itemsClassifiedUnknown = 0;
    for (const item of results) {
      const discovered = addDiscoveredDocument({
        sourceId: source.id,
        canonicalUrl: item.url,
        title: item.title,
      });
      const { classification, confidence, reason } = classifyDocument(item.title, item.rawText, {
        declaredKind: source.declared_kind === 'mixed' ? 'mixed' : source.declared_kind,
      });
      classifyDiscoveredDocument(discovered.id, { classification, confidence, reason });
      if (classification === 'unknown') itemsClassifiedUnknown += 1;
    }

    const now = new Date().toISOString();
    setCrawlSourceState(source.id, source.state, {
      last_crawl_at: now,
      last_item_count: itemsDiscovered,
      last_success_at: now,
      last_http_status: 200,
    });
    recordSourceRun({
      sourceId: source.id,
      mode: 'crawl',
      documentKind: source.declared_kind,
      httpStatus: 200,
      itemsDiscovered,
      itemsClassifiedUnknown,
      parserVersion: 'browser-1.0.0',
      durationMs: Date.now() - t0,
      startedAt,
    });

    return { pagesDone: 1, itemsDiscovered, itemsNew: 0, itemsChanged: 0, itemsClassifiedUnknown };
  } finally {
    await context.close().catch(() => {});
  }
}

export default { runGenericBrowserSource };
