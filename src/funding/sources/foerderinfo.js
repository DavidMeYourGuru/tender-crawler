/**
 * Förderinfo.bund.de – Bekanntmachungen des Bundes (exklusive Förderquelle).
 *
 * - Die Suchergebnisliste wird vollständig über die direkten Pagination-URLs
 *   `gtp=407348_list%253D<seite>` geladen (1..25, Seite 25 enthält 8 Treffer).
 * - Jeder Treffer ist selbst ein `<a class="c-teaser--announcement">` und
 *   verlinkt auf die offizielle Detailseite des jeweiligen Ministeriums.
 * - fetchDocs() öffnet jede Detailseite einzeln, bereinigt den Hauptinhalt
 *   und liefert den vollständigen Call-Text für Extraktion und Suchindex.
 */

import * as cheerio from 'cheerio';
import { fetchSafeHtml, assertSafeUrl, normalizeUrl } from '../../discovery/urls.js';
import { contentHash, normalizeDate, mapLimit } from '../../utils.js';
import { extractMainContent } from './detail-text.js';
import { extractLinksFromHtml } from '../parser.js';
import { downloadPdf, extractPdfText } from '../pdf-extract.js';
import config from '../../config.js';

const BASE_URL = 'https://www.foerderinfo.bund.de/SiteGlobals/Forms/foerderinfo/bekanntmachungen/Bekanntmachungen_Formular.html';
const PAGE_SIZE = 10;

export const meta = {
  id: 'foerderinfo-bekanntmachungen',
  name: 'Förderinfo – Bundes-Bekanntmachungen',
  region: 'de',
  type: 'http',
  rateLimit: { maxRequests: 20, windowMs: 60000 },
  baseUrl: BASE_URL,
};

export function pageUrl(pageNo) {
  return `${BASE_URL}?queryResultId=null&gtp=407348_list%253D${pageNo}&cl2Categories_Foerderer=bund`;
}

/**
 * Liest die Gesamttrefferzahl aus dem Seitentext ("N Treffer").
 */
function parseTotal(html) {
  const $ = cheerio.load(html);
  const match = $('body').text().match(/(\d+)\s+Treffer/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Liest den Range-Indikator der aktuellen Seite ("1 - 10").
 */
function parseRange(html) {
  const $ = cheerio.load(html);
  return $('.c-nav-index__current').first().text().replace(/\s+/g, ' ').trim();
}

/**
 * Parst die Bekanntmachungs-Teaser einer Förderinfo-Seite.
 * Der Teaser selbst ist der Link auf die Detailseite.
 */
export function parsePage(html, baseUrl) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('.l-teaser-list .c-teaser--announcement').each((_, el) => {
    const $el = $(el);
    const title = $el.find('.c-teaser__title, .c-teaser__headline').first().text()
      .replace(/\s+/g, ' ').trim().replace(/\s*Datum:.*$/i, '').trim();
    if (!title || title.length < 10) return;

    const href = $el.attr('href') || $el.find('a[href]').first().attr('href');
    if (!href) return;
    const url = normalizeUrl(href, baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);

    // Datumswerte aus <time datetime> (robuster als Regex)
    let publicationDate = null;
    let submissionDeadline = null;
    const times = $el.find('time').toArray();
    if (times[0]) {
      const d0 = $(times[0]).attr('datetime');
      if (d0) publicationDate = normalizeDate(d0);
    }
    if (times[1]) {
      const d1 = $(times[1]).attr('datetime');
      if (d1) submissionDeadline = normalizeDate(d1);
    }
    if (!publicationDate || !submissionDeadline) {
      const topLine = $el.find('.c-topline').first().text().trim();
      const dateMatch = topLine.match(/(\d{1,2}\.\d{1,2}\.\d{4})\s*-\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
      if (!publicationDate && dateMatch) publicationDate = normalizeDate(dateMatch[1]);
      if (!submissionDeadline && dateMatch) submissionDeadline = normalizeDate(dateMatch[2]);
    }

    const contractingAuthority = $el.find('.c-topline__category').first().text().trim()
      || ($el.find('.c-topline').first().text().match(/(?:BMBF|BMFTR|BMWE|BMG|BMFSFJ|BMEL|BMUV|BMVg|BMDV|AA|BMAS|BMWK)/i)?.[0] ?? null);

    const typeMatch = $el.find('.c-topline').first().text().match(/(Bekanntmachung|Förderaufruf|Richtlinie)/i);
    const tenderType = typeMatch ? typeMatch[1] : null;

    const description = $el.find('.c-teaser__text').first().text().replace(/\s+/g, ' ').trim()
      || $el.text().replace(/\s+/g, ' ').trim().slice(0, 500);

    const externalId = contentHash(url);
    const status = deriveFundingStatus(submissionDeadline);

    items.push({
      sourceId: 'foerderinfo-bekanntmachungen',
      externalId,
      title,
      url,
      primaryUrl: url,
      description,
      contractingAuthority,
      cpvCodes: null,
      cpvLabels: null,
      estimatedValueCents: null,
      estimatedValueCurrency: 'EUR',
      placeOfPerformance: null,
      awardCriteria: null,
      tenderType,
      publicationDate,
      submissionDeadline,
      openingDate: null,
      contractDuration: null,
      documentUrl: null,
      status,
      contentHash: contentHash(title, description.slice(0, 300), submissionDeadline || '', publicationDate || ''),
    });
  });
  return items;
}

function deriveFundingStatus(submissionDeadline) {
  if (!submissionDeadline) return 'unknown';
  const deadline = new Date(`${submissionDeadline}T23:59:59`);
  if (Number.isNaN(deadline.getTime())) return 'unknown';
  if (deadline.getTime() < Date.now()) return 'closed';
  return 'open';
}

/**
 * Lädt eine Förderinfo-Seite (inkl. Rate-Limit).
 * Für Tests kann ein eigener `fetcher` injiziert werden.
 */
async function defaultFetchPage(url, rateLimiter) {
  if (rateLimiter) await rateLimiter.acquire();
  assertSafeUrl(url);
  const { html, url: finalUrl } = await fetchSafeHtml(url);
  return { html, url: finalUrl || url };
}

/**
 * discover() holt alle Bekanntmachungen über die paginierten Seiten.
 * Liefert ein Array; zusätzliche Metadaten hängen als `.meta` an.
 * `fetcher` ist nur für Tests gedacht.
 */
export async function discover({ rateLimiter = null, fetcher = null, maxResults = null } = {}) {
  const fetchPage = fetcher || defaultFetchPage;

  const first = await fetchPage(pageUrl(1), rateLimiter);
  const firstBase = first.url || pageUrl(1);
  const firstItems = parsePage(first.html, firstBase);
  const total = parseTotal(first.html);

  // Seitenanzahl: aus Gesamttreffern; ohne Angabe weiterblättern, bis nichts Neues kommt.
  // Bei maxResults wird nur so viel abgerufen, wie nötig ist.
  let pageCount = total > 0 ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  if (maxResults != null && maxResults > 0) {
    pageCount = Math.min(pageCount ?? Infinity, Math.ceil(maxResults / PAGE_SIZE));
  }

  const itemsByUrl = new Map();
  for (const item of firstItems) itemsByUrl.set(item.url, item);

  const pageErrors = [];
  const pagesFetched = [1];

  const fetchOne = async (p) => {
    const u = pageUrl(p);
    let result = null;
    try {
      result = await fetchPage(u, rateLimiter);
    } catch (error) {
      pageErrors.push({ page: p, error: error.message });
      // Einmaliger Wiederholungsversuch
      try {
        result = await fetchPage(u, rateLimiter);
      } catch (retryError) {
        pageErrors.push({ page: p, error: retryError.message, retry: true });
        return;
      }
    }
    pagesFetched.push(p);

    const items = parsePage(result.html || '', result.url || u);
    for (const item of items) {
      if (!itemsByUrl.has(item.url)) itemsByUrl.set(item.url, item);
    }
  };

  if (pageCount != null) {
    // Bekannte Seitenzahl: Seiten 2..pageCount parallel mit begrenzter
    // Parallelität laden (der Rate-Limiter deckelt weiterhin die Gesamtzahl).
    const pages = [];
    for (let p = 2; p <= pageCount; p += 1) pages.push(p);
    await mapLimit(pages, config.fundingPageConcurrency, fetchOne);
  } else {
    // Unbekannte Seitenzahl: sequentiell, bis keine neuen Treffer mehr kommen.
    for (let p = 2; ; p += 1) {
      const before = itemsByUrl.size;
      await fetchOne(p);
      if (itemsByUrl.size === before) break;
    }
  }

  const items = [...itemsByUrl.values()];
  const limited = maxResults != null && maxResults > 0 ? items.slice(0, maxResults) : items;
  const metaData = {
    total,
    pageCount: pageCount ?? pagesFetched.length,
    pagesFetched,
    pageErrors,
    uniqueUrls: items.length,
    maxResults: maxResults ?? null,
  };
  const result = limited.slice();
  Object.defineProperty(result, 'meta', { value: metaData, enumerable: false });
  return result;
}

/**
 * Öffnet die offizielle Detailseite eines Calls und liefert den bereinigten
 * Volltext sowie das bereinigte HTML (für Linkextraktion).
 * Wirft, wenn die Seite keinen ausreichenden Text enthält.
 */
export async function fetchDocs(candidate, { rateLimiter = null, fetcher = null } = {}) {
  const loadPage = fetcher || (async (url, limiter) => {
    if (limiter) await limiter.acquire();
    assertSafeUrl(url);
    return fetchSafeHtml(url);
  });

  const result = await loadPage(candidate.url, rateLimiter);
  const html = result.html;
  const url = result.url || candidate.url;
  if (result.status != null && result.status >= 400) {
    throw new Error(`Detailseite HTTP ${result.status}: ${candidate.url}`);
  }

  // Direkt-PDF erkennen: URL endet auf .pdf ODER der Abruf liefert eine PDF
  // (Magic Bytes "%PDF-"). Letzteres deckt PDFs ohne .pdf-Endung ab (z. B.
  // "...?__blob=publicationFile").
  if (isPdfUrl(url) || looksLikePdf(html)) {
    const { buffer, url: finalUrl } = await downloadPdf(url, { rateLimiter });
    const pdfText = await extractPdfText(buffer);
    const doc = {
      url: finalUrl,
      title: candidate.title || null,
      page: 'Bekanntmachung (PDF)',
      text: pdfText || '',
      html: null,
      pdfUrl: finalUrl,
    };
    if (!pdfText || pdfText.length < 100) {
      console.warn(`[foerderinfo] Direkt-PDF ohne verwertbaren Text: ${url}`);
    }
    return [doc];
  }

  const docs = finalizeDetail({ html, url }, candidate);

  // Verlinkte PDFs (Richtlinien, Anhänge) laden und deren Text anhängen.
  // Die Datei wird NICHT gespeichert; die Original-URL dient als Link.
  // Maximal 3 PDFs pro Call; Fehler werden übersprungen. PDFs parallel laden.
  const pdfLinks = collectPdfLinks(cleanHtmlOf(docs[0]), url).slice(0, 3);
  await mapLimit(pdfLinks, 3, async (link) => {
    try {
      const { buffer, url: pdfFinalUrl } = await downloadPdf(link.url, { rateLimiter });
      const pdfText = await extractPdfText(buffer);
      if (pdfText && pdfText.length >= 100) {
        docs.push({
          url: pdfFinalUrl,
          title: link.title || candidate.title || null,
          page: 'Richtlinie (PDF)',
          text: pdfText,
          html: null,
          pdfUrl: pdfFinalUrl,
        });
      } else {
        console.warn(`[foerderinfo] PDF ohne verwertbaren Text übersprungen: ${link.url}`);
      }
    } catch (error) {
      console.warn(`[foerderinfo] PDF fehlgeschlagen (${link.url}): ${error.message}`);
    }
  });
  return docs;
}

function isPdfUrl(url) {
  return /\.pdf($|\?)/i.test(String(url || ''));
}

function looksLikePdf(body) {
  return String(body || '').trimStart().startsWith('%PDF-');
}

function cleanHtmlOf(doc) {
  return doc.html || '';
}

/**
 * Sammelt PDF-Links aus dem bereinigten Detail-HTML.
 */
function collectPdfLinks(html, baseUrl) {
  if (!html) return [];
  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return [];
  }
  return extractLinksFromHtml($, baseUrl)
    .filter((l) => l.kind === 'document' || /\.pdf($|\?)/i.test(l.url))
    .filter((l) => {
      try {
        assertSafeUrl(l.url);
        return true;
      } catch {
        return false;
      }
    });
}

function finalizeDetail({ html, url }, candidate) {
  const { text, html: cleanHtml } = extractMainContent(html);
  if (!text || text.replace(/\s+/g, '').length < 100) {
    throw new Error(`Detailseite ohne ausreichenden Text: ${url}`);
  }
  return [{
    url,
    title: candidate.title || null,
    page: 'Bekanntmachung',
    text,
    html: cleanHtml,
  }];
}

export default { meta, discover, fetchDocs, parsePage, pageUrl };
