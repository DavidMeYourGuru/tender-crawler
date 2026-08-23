import * as cheerio from 'cheerio';
import { httpClient } from '../crawler/http-client.js';
import { contentHash, normalizeDate, deriveStatus, parseMoneyToCents } from '../utils.js';

export const meta = {
  id: 'bayern',
  name: 'Vergabe Bayern (auftraege.bayern.de)',
  region: 'bayern',
  type: 'html',
  schedule: '0 */8 * * *', // alle 8h
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://www.auftraege.bayern.de',
};

// Das alte Bayern-Portal wurde 2024/2025 geschlossen.
// Ausschreibungen aus Bayern erscheinen heute auf der
// "Deutschen eVergabe"-Plattform (https://portal.deutsche-evergabe.de),
// die nur über einen Browser erreichbar ist (JS + Session-Storage).
const SEARCH_URLS = [
  'https://www.auftraege.bayern.de/',
  'https://portal.deutsche-evergabe.de/Dashboards/Dashboard_Off?BL=09',
];

/**
 * Parst die Ausschreibungsliste des Bayern-Portals.
 */
export function parseSearchPage(html, baseUrl = meta.baseUrl) {
  const $ = cheerio.load(html);
  const results = [];

  const selectors = [
    '.award',
    '.ausschreibung',
    '.tref',
    'tr.auffassung',
    'tr.verfahren',
    '.list tr',
    'tbody tr',
    'table tr',
    '.search-result',
  ];

  let nodes = [];
  for (const selector of selectors) {
    nodes = $(selector).toArray();
    if (nodes.length) break;
  }

  for (const node of nodes) {
    const $node = $(node);
    const link = $node.find('a').first();
    const title = link.text().trim() || $node.find('h2, h3, h4, .title').first().text().trim();
    const href = link.attr('href');

    if (!title || !href) continue;

    const url = new URL(href, baseUrl).toString();
    const text = $node.text();

    // Frist
    const deadlineMatch =
      text.match(/(?:Angebotsfrist|Ende|Frist|Abgabe\s*bis)(?:\s*[:.]?\s*|\s+)(\d{1,2}\.\d{1,2}\.\d{4})/i) ||
      text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    const deadline = deadlineMatch ? normalizeDate(deadlineMatch[1]) : null;

    // Auftraggeber
    const authorityMatch = text.match(/(?:Auftraggeber|Vergabestelle|Beschaffungsstelle)\s*[:.]?\s*([^\n|]{3,120})/i);
    const contractingAuthority = authorityMatch ? authorityMatch[1].trim() : null;

    // CPV – nur mit explizitem "CPV"-Kontext, um Falschtreffer zu vermeiden.
    const cpvMatch = text.match(/(?:CPV|Cpv|CPV-Code)\D{0,20}?([\d\s-]{7,11})/i);
    const cpvCode = cpvMatch ? cpvMatch[1].replace(/\D/g, '').slice(0, 8) : null;

    // Wert
    const moneyMatch = text.match(/(?:\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+,\d{2})\s*(?:EUR|€)/i);
    const estimatedValueCents = moneyMatch ? parseMoneyToCents(moneyMatch[0]) : null;

    // Publikationsdatum
    const pubMatch = text.match(/(?:Veröffentlicht|Veröffentlichung|Bekanntmachung)\s*[:.]?\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
    const publicationDate = pubMatch ? normalizeDate(pubMatch[1]) : null;

    // Externe ID: In Bayern oft eine Nummer in der URL
    const externalId =
      url.match(/[?&](?:id|angebot|verfahren)=([^&]+)/i)?.[1] ||
      url.match(/(\d{6,12})/)?.[1] ||
      null;

    if (!externalId) continue;

    const status = deriveStatus(deadline, 'open');

    results.push({
      sourceId: 'bayern',
      externalId: externalId,
      title: String(title).trim(),
      url,
      description: text.length > 50 ? text.slice(0, 500).trim() : null,
      contractingAuthority,
      cpvCodes: cpvCode ? [cpvCode] : null,
      cpvLabels: null,
      estimatedValueCents,
      estimatedValueCurrency: 'EUR',
      placeOfPerformance: null,
      awardCriteria: null,
      tenderType: null,
      publicationDate,
      submissionDeadline: deadline,
      openingDate: null,
      contractDuration: null,
      documentUrl: null,
      status,
      contentHash: contentHash(externalId, title, deadline, status, estimatedValueCents),
    });
  }

  return results;
}

/**
 * Discover-Phase: Durchsucht mehrere Suchseiten des Bayern-Portals.
 */
export async function discover({ maxResults = 100, rateLimiter = null } = {}) {
  const allResults = [];
  const seenIds = new Set();

  for (const url of SEARCH_URLS) {
    try {
      await rateLimiter?.acquire();
      const response = await httpClient.get(url);
      const pageResults = parseSearchPage(response.data, meta.baseUrl);
      for (const result of pageResults) {
        if (!seenIds.has(result.externalId)) {
          seenIds.add(result.externalId);
          allResults.push(result);
        }
      }
      if (allResults.length >= maxResults) break;
    } catch (error) {
      console.warn(`[bayern] Seite ${url} fehlgeschlagen: ${error.message}`);
    }
  }

  console.log(`[bayern] ${allResults.length} Ausschreibungen gefunden.`);
  return allResults.slice(0, maxResults);
}

/**
 * Detail-Phase.
 */
export async function fetchDetail(url, { rateLimiter = null } = {}) {
  try {
    await rateLimiter?.acquire();
    const response = await httpClient.get(url);
    const $ = cheerio.load(response.data);

    let description = '';
    for (const selector of ['.detail', '.inhalt', '.verfahren', 'main', 'article', '.content']) {
      const el = $(selector).first().text().trim();
      if (el.length > description.length) description = el;
    }

    return {
      description: description || null,
      documentUrl:
        $('a.pdf, a[href$=".pdf"], a[href*="download"]').first().attr('href') || null,
    };
  } catch (error) {
    console.error(`[bayern] Detail abrufen fehlgeschlagen: ${url} (${error.message})`);
    return null;
  }
}

export default { meta, discover, fetchDetail };