/**
 * Vergabemarktplatz NRW (cosinex VMP, https://www.evergabe.nrw.de).
 *
 * Die Plattform liefert server-gerendertes HTML (Struts-.do-Actions) –
 * KEIN JavaScript/Browser nötig, daher klassisches HTTP-Scraping wie
 * bei portals/evergabe.js.
 *
 * Vorgehen (serverseitige Kategorie-Filterung, Datenmenge stark reduziert):
 * Die cosinex-"Erweiterte Suche" liefert bei CPV-Angabe den Kategoriebaum,
 * nicht die Trefferliste. Die echten Ausschreibungen pro CPV erhält man
 * über `categoryOverview.do?method=showTable&cpvCode=<CPV>` (GET). Wir
 * durchsuchen gezielt die CPV-Codes des Interessenbereichs:
 *   Bau (45), Landschaftsarchitektur (7122, 714), Garten (773),
 *   Bildung (80 → Schulen/Kita), Sport/Kultur (92 → Spielplätze).
 * Anschließend greift der Kategorie-Filter (CPV + Stichworte) als
 * Sicherheitsnetz – siehe category-filter.js.
 *
 * Hinweis: showTable liefert pro CPV eine (nicht paginierte) Seite mit
 * aktuellen Treffern (~24). Das ist für den fokussierten Crawl ausreichend
 * und hält die Datenmenge klein.
 */
import * as cheerio from 'cheerio';
import { httpClient } from '../crawler/http-client.js';
import { contentHash, normalizeDate, deriveStatus } from '../utils.js';
import { matchesInterestCategories } from '../category-filter.js';
import config from '../config.js';

export const meta = {
  id: 'nrw',
  name: 'Vergabemarktplatz NRW (evergabe.nrw.de)',
  region: 'nrw',
  type: 'html',
  schedule: '0 */8 * * *', // alle 8h
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://www.evergabe.nrw.de',
};

const SHOW_TABLE_URL =
  'https://www.evergabe.nrw.de/VMPCenter/company/announcements/categoryOverview.do?method=showTable';

// CPV-Codes des Interessenbereichs (siehe category-filter.js).
const INTEREST_CPV_CODES = [
  '45000000-7', // Bauarbeiten
  '71220000-6', // Architekturentwurf (u. a. Landschaftsarchitektur)
  '71400000-0', // Stadt- und Landschaftsplanung
  '77300000-3', // Landschaftspflege und Gartenbau
  '80000000-4', // Allgemeine und berufliche Bildung (Schulen/Kita)
  '92000000-1', // Erholung, Kultur und Sport (Spielplätze)
];

const BOILERPLATE = 'Informationen werden in einem neuen Tab geöffnet';

/**
 * Dekodiert HTML-Entitäten. Die NRW-Seite kodiert teils doppelt
 * (z. B. &amp;#39;), sodass ein einfacher cheerio-Text-Extrakt noch
 * Rest-Entitäten enthalten kann. Ein zweiter Parse-Pass dekodiert diese.
 */
function decodeEntities(str) {
  if (!str) return str;
  return cheerio.load(`<div>${str}</div>`).text();
}

/**
 * Parst die Treffer-Tabelle einer showTable-Seite.
 * Spalten (cosinex VMP): 0 Veröffentlichung, 1 Frist, 2 Titel,
 * 3 Verfahrenstyp, 4 Vergabestelle, 5 (Dokument-Link).
 * Der Detail-Link steht in der Zeile (projectForwarding.do?pid=…),
 * der Titel oft in einer Zelle, nicht im Link-Text.
 */
export function parseResultsTable(html, baseUrl = meta.baseUrl) {
  const $ = cheerio.load(html);
  const results = [];

  $('table tr').each((_, node) => {
    const $node = $(node);
    const cells = $node.find('td');
    if (cells.length < 2) return; // Header/Leerzeile

    const link = $node.find('a[href]').first();
    const href = link.attr('href');
    if (!href) return;

    const cellTexts = cells.map((_, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();

    // Titel: Link-Text (Boilerplate entfernt) oder längste nicht-Datum-Zelle
    let title = decodeEntities(link.text().replace(BOILERPLATE, '').replace(/\s+/g, ' ').trim());
    if (!title) {
      title = cellTexts
        .filter((t) => t && !normalizeDate(t))
        .sort((a, b) => b.length - a.length)[0] || 'Ohne Titel';
    }
    title = decodeEntities(String(title).trim());

    const url = new URL(href, baseUrl).toString();
    const externalId = url.match(/[?&]pid=([^&]+)/)?.[1] || url.match(/[?&]id=([^&]+)/)?.[1] || contentHash(url);

    const publicationDate = normalizeDate(cellTexts[0]);
    const deadline = normalizeDate(cellTexts[1]) || normalizeDate(cellTexts[2]);
    const tenderType = decodeEntities(cellTexts[3] || '');
    const contractingAuthority = decodeEntities(cellTexts[4] || '');
    const status = deriveStatus(deadline, 'open');

    results.push({
      sourceId: 'nrw',
      externalId: String(externalId),
      title,
      url,
      description: null,
      contractingAuthority,
      cpvCodes: null,
      cpvLabels: null,
      estimatedValueCents: null,
      estimatedValueCurrency: 'EUR',
      placeOfPerformance: null,
      awardCriteria: null,
      tenderType,
      publicationDate,
      submissionDeadline: deadline,
      openingDate: null,
      contractDuration: null,
      documentUrl: null,
      status,
      contentHash: contentHash(externalId, title, deadline, status),
    });
  });

  return results;
}

/**
 * Discover-Phase: pro Interessen-CPV die Trefferliste holen, deduplizieren
 * und durch den Kategorie-Filter (CPV + Stichworte) schicken.
 */
export async function discover({ maxResults = 100, rateLimiter = null } = {}) {
  await rateLimiter?.acquire();

  const byId = new Map();
  let totalRaw = 0;

  for (const cpv of INTEREST_CPV_CODES) {
    try {
      const response = await httpClient.get(`${SHOW_TABLE_URL}&cpvCode=${cpv}`, { maxRedirects: 5 });
      const rows = parseResultsTable(String(response.data));
      totalRaw += rows.length;
      for (const row of rows) {
        if (!byId.has(row.externalId)) byId.set(row.externalId, row);
      }
      // Respektvolle Verzögerung zwischen den CPV-Abfragen
      await new Promise((r) => setTimeout(r, config.requestDelayMs));
    } catch (error) {
      console.warn(`[nrw] CPV ${cpv} nicht abrufbar: ${error.message}`);
    }
  }

  const filtered = [...byId.values()]
    .filter(matchesInterestCategories)
    .slice(0, maxResults);

  console.log(`[nrw] ${totalRaw} Rohtreffer (${INTEREST_CPV_CODES.length} CPVs), ${filtered.length} im Interessenbereich.`);
  return filtered;
}

/**
 * Detail-Phase: Ruft die Detailseite ab (Volltext + Dokument-Links).
 */
export async function fetchDetail(url, { rateLimiter = null } = {}) {
  try {
    await rateLimiter?.acquire();
    const response = await httpClient.get(url, { maxRedirects: 5 });
    const $ = cheerio.load(String(response.data));

    let description = '';
    for (const selector of ['.announcement-detail', '.detail', 'main', 'article', '.content', '#content']) {
      const el = $(selector).first().text().trim();
      if (el.length > description.length) description = el;
    }

    return {
      description: description || null,
      documentUrl:
        $('a[href$=".pdf"], a[href$=".doc"], a[href$=".docx"], a[href$=".zip"], a[href$=".xlsx"], a[href$=".xls"]')
          .first().attr('href') || null,
    };
  } catch (error) {
    console.error(`[nrw] Detail abrufen fehlgeschlagen: ${url} (${error.message})`);
    return null;
  }
}

export default { meta, discover, fetchDetail, parseResultsTable };
