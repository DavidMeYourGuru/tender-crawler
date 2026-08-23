import * as cheerio from 'cheerio';
import { getWithRedirects } from '../crawler/http-client.js';
import { contentHash, normalizeDate, deriveStatus, parseMoneyToCents, normalizeCpv } from '../utils.js';

export const meta = {
  id: 'evergabe',
  name: 'eVergabe Online (Vergabeplattform des Bundes)',
  region: 'de',
  type: 'html',
  schedule: '0 */8 * * *', // alle 8h
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://www.evergabe-online.de',
};

const START_URL = 'https://www.evergabe-online.de/';
const SEARCH_URL = 'https://www.evergabe-online.de/search.html';

/**
 * Baut die Session auf (Cookie-Setup der Plattform) und liefert die Suchseite.
 */
async function fetchSearchPage() {
  // Cookie-Check-Flow durchlaufen, damit die Session gesetzt wird
  await getWithRedirects(START_URL);
  await getWithRedirects(`${START_URL}?cookieCheck`);
  const response = await getWithRedirects(SEARCH_URL);
  return response.data;
}

/**
 * Parst die Suchergebnisse des eVergabe-Portals.
 */
export function parseSearchPage(html, baseUrl = meta.baseUrl) {
  const $ = cheerio.load(html);
  const results = [];

  $('tr.even, tr.odd').each((_, node) => {
    const $node = $(node);
    const cells = $node.find('td');

    // Spalte 0: Titel + Detail-Link (enthält die Ausschreibungs-ID)
    const link = $node.find('a[href*="tenderdetails"], a[href*="?id="]').first();
    const title = link.text().trim() || $node.find('.ev-result-col').first().text().trim();
    const href = link.attr('href');

    const idMatch = href?.match(/[?&]id=(\d+)/);
    const externalId = idMatch ? idMatch[1] : null;
    if (!externalId || !title) return;

    const url = href ? new URL(href, baseUrl).toString() : `${baseUrl}/tenderdetails.html?id=${externalId}`;

    const cellText = (index) => {
      const cell = cells.eq(index);
      return cell.length ? cell.text().replace(/\s+/g, ' ').trim() : '';
    };

    // Spalten: 0 Titel, 1 Ref.-Nr., 2 Vergabestelle, 3 Ort, 4 Verfahrensart, 5 Frist, 6 Veröffentlicht
    const reference = cellText(1) || externalId;
    const contractingAuthority = cellText(2) || null;
    const placeOfPerformance = cellText(3) || null;
    const tenderType = cellText(4) || null;
    const deadline = normalizeDate(cellText(5)) || normalizeDate(cellText(6));
    const publicationDate = normalizeDate(cellText(6));
    const text = $node.text();

    // CPV / Wert, falls auf der Seite vorhanden.
    // Nur als CPV werten, wenn explizit "CPV"/"c.pv." davorsteht – sonst
    // würden beliebige 8-stellige Zahlen (Referenznummern, Datumskonkatenate)
    // fälschlich als CPV erkannt.
    const cpvMatch = text.match(/(?:CPV|c\.pv\.|CPV-Code)\D{0,20}?([\d\s-]{7,11})/i);
    const cpvCode = cpvMatch ? cpvMatch[1].replace(/\D/g, '').slice(0, 8) : null;
    const moneyMatch = text.match(/(?:Wert|Auftragswert|geschätzt)\s*[::]?\s*([\d.\s.,]+)\s*(?:EUR|€)/i);
    const estimatedValueCents = moneyMatch ? parseMoneyToCents(moneyMatch[1]) : null;

    const status = deriveStatus(deadline, 'open');

    results.push({
      sourceId: 'evergabe',
      externalId: String(externalId),
      title: String(title).trim(),
      url,
      description: text.length > 50 ? text.slice(0, 500).trim() : null,
      contractingAuthority,
      cpvCodes: cpvCode ? [cpvCode] : null,
      cpvLabels: null,
      estimatedValueCents,
      estimatedValueCurrency: 'EUR',
      placeOfPerformance,
      awardCriteria: null,
      tenderType,
      publicationDate,
      submissionDeadline: deadline,
      openingDate: null,
      contractDuration: null,
      documentUrl: null,
      status,
      contentHash: contentHash(externalId, reference, title, deadline, status, estimatedValueCents),
    });
  });

  return results;
}

/**
 * Discover-Phase: Baut die Session auf und parst die Suchergebnisse.
 */
export async function discover({ maxResults = 100, rateLimiter = null } = {}) {
  try {
    await rateLimiter?.acquire();
    const html = await fetchSearchPage();
    let results = parseSearchPage(html, meta.baseUrl);
    results = results.slice(0, maxResults);
    console.log(`[evergabe] ${results.length} Ausschreibungen gefunden.`);
    return results;
  } catch (error) {
    console.error(`[evergabe] Abruf fehlgeschlagen: ${error.message}`);
    throw new Error(`eVergabe-Abruf fehlgeschlagen: ${error.message}`);
  }
}

/**
 * Detail-Phase: Ruft die Detailseite einer Ausschreibung ab (für Volltext).
 */
export async function fetchDetail(url, { rateLimiter = null } = {}) {
  try {
    await rateLimiter?.acquire();
    const response = await getWithRedirects(url);
    const $ = cheerio.load(response.data);

    let description = '';
    for (const selector of ['.tender-detail', '.detail', '.tenderdata', 'main', 'article', '.content', '#content']) {
      const el = $(selector).first().text().trim();
      if (el.length > description.length) description = el;
    }

    // CPV aus der Detailseite extrahieren (Code + Bezeichnung).
    // Format auf eVergabe: "CPV-Code: 45000000-7 Bauarbeiten für Rohrleitungen".
    const detailText = $('body').text();
    const rawCodes = [];
    const rawLabels = [];
    const cpvRe = /(?:CPV-?Code|CPV)\s*[:.]?\s*(\d{8}(?:-\d)?)\s*([^\n,;]{0,160})?/gi;
    let cm;
    while ((cm = cpvRe.exec(detailText)) !== null) {
      const code = cm[1];
      let label = (cm[2] || '').replace(/^[\s:.-]+/, '').trim();
      // Manche Portale wiederholen die Ziffer als Label – dann ignorieren.
      if (label && label.replace(/[^0-9]/g, '').slice(0, 8) === code.replace(/[^0-9]/g, '').slice(0, 8)) {
        label = '';
      }
      rawCodes.push(code);
      if (label) rawLabels.push(label);
    }
    const { cpvCodes, cpvLabels } = normalizeCpv(rawCodes, rawLabels);

    return {
      description: description || null,
      documentUrl:
        $('a[href$=".pdf"], a[href$=".doc"], a[href$=".docx"], a[href$=".zip"], a[href$=".xlsx"], a[href$=".xls"], a[href*="downloadTenderDocument"], a[href*="Dokument"]')
          .first().attr('href') || null,
      cpvCodes,
      cpvLabels,
    };
  } catch (error) {
    console.error(`[evergabe] Detail abrufen fehlgeschlagen: ${url} (${error.message})`);
    return null;
  }
}

export default { meta, discover, fetchDetail };
