import * as cheerio from 'cheerio';
import { httpClient } from '../crawler/http-client.js';
import { contentHash, normalizeDate, deriveStatus, parseMoneyToCents } from '../utils.js';

export const meta = {
  id: 'bund',
  name: 'Bundesvergabeportal (bund.de)',
  region: 'de',
  type: 'html',
  schedule: '0 */8 * * *', // alle 8h
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://www.bund.de',
};

const SEARCH_URL =
  'https://www.bund.de/DE/Service/Suche/Vergabe/Vergabe-node.html';

/**
 * Parst die Übersichtsseite des Bundesvergabeportals.
 * Extrahiert die Ausschreibungs-Liste.
 */
export function parseSearchPage(html, baseUrl = meta.baseUrl) {
  const $ = cheerio.load(html);
  const results = [];

  // Verschiedene mögliche Selektoren für Ergebnis-Einträge
  const selectors = [
    '.result-item',
    '.search-result',
    '.vergabe-item',
    'li.result',
    'article.result',
    '.search-results li',
    '.tabelle tbody tr',
    '.list-page li',
  ];

  let nodes = [];
  for (const selector of selectors) {
    nodes = $(selector).toArray();
    if (nodes.length) break;
  }

  for (const node of nodes) {
    const $node = $(node);

    // Titel aus Link
    const link = $node.find('a').first();
    const title = link.text().trim() || $node.find('h2, h3, h4').first().text().trim();
    const href = link.attr('href');
    if (!title || !href) continue;

    const url = new URL(href, baseUrl).toString();

    // Fristen suchen (verschiedene Formate)
    const text = $node.text();
    const deadlineMatch =
      text.match(/(?:Angebotsfrist|Bewerbungsfrist|Frist|Abgabefrist)(?:\s*:\s*|\s+)(\d{1,2}\.\d{1,2}\.\d{4})/i) ||
      text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    const deadline = deadlineMatch ? normalizeDate(deadlineMatch[1]) : null;

    // Vergebende Stelle / Auftraggeber
    const authorityMatch = text.match(/(?:Auftraggeber|Vergabestelle|Beschaffungsstelle)\s*:\s*([^\n|]{3,120})/i);
    const contractingAuthority = authorityMatch ? authorityMatch[1].trim() : null;

    // CPV-Code
    const cpvMatch = text.match(/(?:CPV|cpv)\s*-?\s*code\s*:\s*([\d\s]+)/i) || text.match(/\b(\d{8})\b/);
    const cpvCode = cpvMatch ? cpvMatch[1].replace(/\s/g, '') : null;

    // Auftragswert
    const moneyMatch = text.match(/(?:Wert|Auftragswert|geschätzter Wert)\s*:\s*([\d.\s.,]+)\s*(?:EUR|€)/i);
    const estimatedValueCents = moneyMatch ? parseMoneyToCents(moneyMatch[1]) : null;

    // Publikationsdatum
    const pubMatch = text.match(/(?:Veröffentlicht|Veröffentlichung)\s*:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
    const publicationDate = pubMatch ? normalizeDate(pubMatch[1]) : null;

    // Externe ID aus URL oder Daten-Attribut
    const externalId =
      $node.attr('data-id') ||
      $node.attr('id') ||
      url.match(/[?&](?:id|vergabe)=([^&]+)/i)?.[1] ||
      url.match(/[^/]+\/([^/]+?)\.html$/)?.[1] ||
      null;

    if (!externalId) continue;

    const status = deriveStatus(deadline, 'open');

    results.push({
      sourceId: 'bund',
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
 * Discover-Phase: Ruft die Suchergebnisse ab.
 */
export async function discover({ maxResults = 100, rateLimiter = null } = {}) {
  try {
    await rateLimiter?.acquire();
    const response = await httpClient.get(SEARCH_URL, {
      params: {
        // Limit für Ergebnisse
        query: 'Ausschreibung',
        submitted: 'true',
        von: '',
        bis: '',
      },
    });
    let results = parseSearchPage(response.data);

    // Pagination grob abschneiden
    results = results.slice(0, maxResults);
    console.log(`[bund] ${results.length} Ausschreibungen gefunden.`);
    return results;
  } catch (error) {
    console.error(`[bund] Abruf fehlgeschlagen: ${error.message}`);
    throw new Error(`bund.de-Abruf fehlgeschlagen: ${error.message}`);
  }
}

/**
 * Detail-Phase: Ruft die Detailseite einer Ausschreibung ab (optional, für Volltext).
 */
export async function fetchDetail(url, { rateLimiter = null } = {}) {
  try {
    await rateLimiter?.acquire();
    const response = await httpClient.get(url);
    const $ = cheerio.load(response.data);

    // Vollständige Beschreibung
    let description = '';
    for (const selector of ['.content', '.detail', '.vergabe-detail', 'main', 'article']) {
      const el = $(selector).first().text().trim();
      if (el.length > description.length) description = el;
    }

    return {
      description: description || null,
      documentUrl:
        $('a.pdf, a[href$=".pdf"], a[href*="download"]').first().attr('href') || null,
    };
  } catch (error) {
    console.error(`[bund] Detail abrufen fehlgeschlagen: ${url} (${error.message})`);
    return null;
  }
}

export default { meta, discover, fetchDetail };