import * as cheerio from 'cheerio';
import { config } from '../config.js';
import { httpClient, postJson } from '../crawler/http-client.js';
import { contentHash, normalizeDate, deriveStatus, parseMoneyToCents } from '../utils.js';

export const meta = {
  id: 'ted',
  name: 'TED (Tenders Electronic Daily)',
  region: 'eu',
  type: 'api',
  schedule: '0 */6 * * *', // alle 6h
  rateLimit: { maxRequests: 20, windowMs: 60000 },
};

const TED_API_URL = 'https://api.ted.europa.eu/v3/notices/search';
const TED_DETAIL_URL = 'https://ted.europa.eu/de/notice';
const TED_RSS_URL = 'https://ted.europa.eu/api/search/rss';

// Von der TED v3 API unterstützte Felder
const TED_FIELDS = [
  'publication-number',
  'notice-title',
  'publication-date',
  'deadline-date-lot',
  'deadline-receipt-tender-date-lot',
  'estimated-value-lot',
  'estimated-value-cur-lot',
  'buyer-name',
  'organisation-name-buyer',
  'classification-cpv',
  'place-of-performance',
  'description-glo',
  'description-proc',
  'announcement-url',
];

/**
 * Wählt einen Wert aus sprachabhängigen Feldern aus (z. B. { deu: [...], eng: [...] }).
 */
function pickLang(obj, langs = ['deu', 'eng', 'ger']) {
  if (obj == null) return null;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj[0] ?? null;
  if (typeof obj === 'object') {
    for (const lang of langs) {
      if (obj[lang] != null) {
        const value = obj[lang];
        return Array.isArray(value) ? (value[0] ?? null) : value;
      }
    }
    const first = Object.values(obj)[0];
    return Array.isArray(first) ? (first[0] ?? null) : first;
  }
  return String(obj);
}

function pickFirst(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Parst eine TED-v3-Notice (Kebab-Case-Felder) in das einheitliche Tender-Format.
 */
function parseV3Notice(notice, sourceId = 'ted') {
  const id = String(notice['publication-number'] || notice.publicationNumber || '');
  if (!id) return null;

  const links = notice.links || {};
  const url =
    links.html?.DEU ||
    links.html?.ENG ||
    notice['announcement-url'] ||
    `${TED_DETAIL_URL}/-/detail/${id}`;
  const documentUrl = links.pdf?.DEU || links.pdf?.ENG || null;

  const title = pickLang(notice['notice-title']) || 'Ohne Titel';
  const authority = pickLang(notice['buyer-name']) || pickLang(notice['organisation-name-buyer']) || null;
  const description =
    pickLang(notice['description-glo']) ||
    pickLang(notice['description-proc']) ||
    pickLang(notice['description-lot']) ||
    null;

  const cpvCodes = [...new Set((notice['classification-cpv'] || []).map((c) => String(c).trim()).filter(Boolean))];

  const publicationDate = normalizeDate(pickFirst(notice['publication-date']));
  const deadline = normalizeDate(
    pickFirst(notice['deadline-receipt-tender-date-lot']) ||
    pickFirst(notice['deadline-date-lot'])
  );

  const valueRaw = pickFirst(notice['estimated-value-lot']);
  const estimatedValueCents = valueRaw != null ? parseMoneyToCents(String(valueRaw)) : null;
  const estimatedValueCurrency = pickFirst(notice['estimated-value-cur-lot']) || 'EUR';

  const placeOfPerformance = pickFirst(notice['place-of-performance']) || null;

  const status = deriveStatus(deadline, 'open');

  return {
    sourceId,
    externalId: id,
    title: String(title).trim(),
    url: String(url).trim(),
    description: description ? String(description).trim() : null,
    contractingAuthority: authority ? String(authority).trim() : null,
    cpvCodes: cpvCodes.length ? cpvCodes : null,
    cpvLabels: null,
    estimatedValueCents,
    estimatedValueCurrency,
    placeOfPerformance: placeOfPerformance ? String(placeOfPerformance).trim() : null,
    awardCriteria: null,
    tenderType: null,
    publicationDate,
    submissionDeadline: deadline,
    openingDate: null,
    contractDuration: null,
    documentUrl: documentUrl ? String(documentUrl).trim() : null,
    status,
    contentHash: contentHash(id, title, deadline, status, estimatedValueCents),
  };
}

/**
 * Discover-Phase: Ruft die TED v3 Search-API ab und liefert Tender-Objekte.
 */
export async function discover({ daysBack = null, rateLimiter = null } = {}) {
  const backDays = daysBack || config.tedDaysBack;
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - backDays);
  const dateFromNum = dateFrom.toISOString().slice(0, 10).replace(/-/g, ''); // yyyymmdd

  try {
    await rateLimiter?.acquire();
    // Die anonyme eSearch-API liefert max. 250 Treffer pro Aufruf
    const limit = Math.min(250, config.maxResultsPerPortal);
    const data = await postJson(
      TED_API_URL,
      {
        query: `PD >= ${dateFromNum}`,
        limit,
        fields: TED_FIELDS,
      },
      {}
    );
    const notices = data?.notices || [];
    const tenders = notices.map((notice) => parseV3Notice(notice)).filter(Boolean);
    console.log(`[ted] ${tenders.length} Ausschreibungen seit ${dateFrom.toISOString().slice(0, 10)} gefunden.`);
    return tenders;
  } catch (error) {
    // Fallback: RSS-Feed
    console.warn(`[ted] API-Fehler (${error.message}), versuche RSS-Feed...`);
    try {
      await rateLimiter?.acquire();
      const rssResponse = await httpClient.get(TED_RSS_URL, {
        params: { lang: 'de', datefrom: dateFrom.toISOString().slice(0, 10) },
      });
      const items = parseRss(rssResponse.data);
      return items.map((item) => parseRssItem(item)).filter(Boolean);
    } catch (rssError) {
      console.error(`[ted] RSS-Feed ebenfalls fehlgeschlagen: ${rssError.message}`);
      throw new Error(`TED-Abruf fehlgeschlagen: ${error.message}`);
    }
  }
}

/**
 * Parst ein RSS-XML-Dokument von TED.
 */
function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  const matchAll = xml.matchAll(itemRegex);
  for (const match of matchAll) {
    const content = match[1];
    const item = {
      title: extractTag(content, 'title'),
      link: extractTag(content, 'link'),
      guid: extractTag(content, 'guid'),
      pubDate: extractTag(content, 'pubDate'),
      description: extractTag(content, 'description'),
    };
    if (item.title || item.link) items.push(item);
  }
  return items;
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  if (!match) return null;
  return match[1]
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .trim();
}

function parseRssItem(item) {
  const match = item.link?.match(/detail\/(\d+)/) || item.guid?.match(/(\d+)/);
  const id = match ? match[1] : `rss-${item.guid || Math.random().toString(36).slice(2, 10)}`;
  const title = item.title || 'Ohne Titel';
  const deadline = normalizeDate(item.title?.match(/(\d{1,2}\.\d{1,2}\.\d{4})/)?.[1]);
  const publicationDate = normalizeDate(item.pubDate);

  return {
    sourceId: 'ted',
    externalId: id,
    title: String(title).trim(),
    url: item.link || `${TED_DETAIL_URL}/-/detail/${id}`,
    description: item.description || null,
    contractingAuthority: null,
    cpvCodes: null,
    cpvLabels: null,
    estimatedValueCents: null,
    estimatedValueCurrency: 'EUR',
    placeOfPerformance: null,
    awardCriteria: null,
    tenderType: null,
    publicationDate,
    submissionDeadline: deadline,
    openingDate: null,
    contractDuration: null,
    documentUrl: null,
    status: deriveStatus(deadline, 'open'),
    contentHash: contentHash(id, title, deadline, 'open', null),
  };
}

/**
 * Detail-Phase: Ruft die serverseitig gerenderte HTML-Detailseite ab.
 */
export async function fetchDetail(url, { rateLimiter = null } = {}) {
  const idMatch = url.match(/(\d{3,8}-\d{4})/);
  const noticeId = idMatch ? idMatch[1] : null;
  if (!noticeId) return null;

  try {
    await rateLimiter?.acquire();
    const response = await httpClient.get(`${TED_DETAIL_URL}/${noticeId}/html`);
    const $ = cheerio.load(response.data);

    let description = '';
    for (const selector of ['main', '.ted-content', '.notice-content', '#content', 'article', 'body']) {
      const el = $(selector).first().text().trim();
      if (el.length > description.length) description = el;
    }

    // Auf die eigentliche Beschreibung kürzen: "Beschreibung" bis "2. Verfahren"
    const descMatch = description.match(/Beschreibung[\s\S]*?(?=\n\s*2\.|\n\s*Verfahren|\n\s*1\.\s+Beschaffer|$)/);
    const cleanDescription = descMatch ? descMatch[0].trim() : (description.length > 100 ? description.slice(0, 3000) : description);

    return {
      description: cleanDescription || null,
      documentUrl:
        $('a.pdf, a[href$=".pdf"], a[href*="/xml"], a[href*="document"]').first().attr('href') || null,
    };
  } catch (error) {
    console.error(`[ted] Detail abrufen fehlgeschlagen: ${url} (${error.message})`);
    return null;
  }
}

export default { meta, discover, fetchDetail };
