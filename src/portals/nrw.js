/**
 * Vergabemarktplatz NRW (cosinex VMP, https://www.evergabe.nrw.de).
 *
 * Die Plattform liefert server-gerendertes HTML (Struts-.do-Actions).
 * Der Adapter nutzt deshalb klassische HTTP-Anfragen und Cheerio; ein
 * Browser-Worker ist für Land NRW nicht erforderlich.
 */
import * as cheerio from 'cheerio';
import { getWithRedirects, httpClient } from '../crawler/http-client.js';
import { contentHash, normalizeDate, deriveStatus, sleep } from '../utils.js';
import config from '../config.js';
import { cleanDetailText, extractFactsFromDom, makeFact, makeTextSection, uniqueFacts } from '../detail-data.js';

export const meta = {
  id: 'nrw',
  name: 'Vergabemarktplatz NRW (evergabe.nrw.de)',
  region: 'nrw',
  type: 'html',
  schedule: '0 */8 * * *',
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://www.evergabe.nrw.de',
  // Diese Portale sind sichtbar dokumentiert, werden aber bewusst noch nicht
  // gecrawlt. Dafür werden später eigene Adapter benötigt.
  connectedPortals: [
    {
      id: 'metropole-ruhr',
      name: 'Metropole Ruhr',
      url: 'https://www.vergabe.metropoleruhr.de/VMPSatellite/?lang=de&',
      enabled: false,
    },
    {
      id: 'rheinland',
      name: 'Rheinland',
      url: 'https://www.vmp-rheinland.de/VMPSatellite/?lang=de&',
      enabled: false,
    },
    {
      id: 'blb-nrw',
      name: 'BLB NRW',
      url: 'https://evergabe.blb.nrw.de/Vergabe/?lang=de&',
      enabled: false,
    },
    {
      id: 'westfalen',
      name: 'Westfalen',
      url: 'https://www.vergabe-westfalen.de/VMPSatellite/?lang=de&',
      enabled: false,
    },
    {
      id: 'stadt-koeln',
      name: 'Stadt Köln',
      url: 'https://vergabe.stadt-koeln.de/VMPSatellite/?lang=de&',
      enabled: false,
    },
    {
      id: 'wirtschaftsregion-aachen',
      name: 'Wirtschaftsregion Aachen',
      url: 'https://www.vergaben-wirtschaftsregion-aachen.de/VMPSatellite/?lang=de&',
      enabled: false,
    },
  ],
};

const SHOW_TABLE_URL =
  'https://www.evergabe.nrw.de/VMPCenter/company/announcements/categoryOverview.do?method=showTable';
const PAGE_PARAMETER = 'selectedTablePagePROJECT_RESULT';
const PAGE_SUMMARY_RE = /Seite:\s*(\d+)\s+von\s+(\d+)\s*-\s*Gesamteinträge:\s*(\d+)/i;
const PROJECT_PATH_RE = /\/public\/company\/projectForwarding\.do$/i;
const CPV_RE = /\b(\d{8}-\d)\b/g;

/**
 * Vergabeunterlagen-/Dokumente-Seiten sind HTML und dürfen gelesen werden.
 * Gesperrt werden nur echte Dateiendungen bzw. bekannte Download-Endpunkte.
 * Das ist absichtlich enger als ein bloßes `vergabeunterlage`-Substring:
 * `/documents` und `/vergabeunterlagen` liefern auf NRW häufig erst das
 * öffentliche HTML-Inventar.
 */
export function isDeferredDocumentUrl(url) {
  const value = String(url || '');
  if (!value) return false;
  if (/\.(?:pdf|docx?|xlsx?|zip|7z|rar|odt|ods|txt|rtf)(?:$|[?#])/i.test(value)) return true;
  return /(?:^|[/?_.?&-])(?:directdocload|download(?:document|file)?|filedownload)(?:[/?_.?&=-]|$)/i.test(value)
    || /(?:[?&](?:download|downloadFile|fileDownload|inlineFile)(?:=true)?(?:&|$))/i.test(value);
}

function responseUrl(response, fallback) {
  return response?.request?.res?.responseUrl || response?.config?.url || fallback;
}

function assertHtmlResponse(response, requestedUrl) {
  const finalUrl = responseUrl(response, requestedUrl);
  const contentType = String(response?.headers?.['content-type'] || '').toLowerCase();
  const disposition = String(response?.headers?.['content-disposition'] || '').toLowerCase();
  if (isDeferredDocumentUrl(finalUrl) || isDeferredDocumentUrl(requestedUrl)
    || /(?:application\/(?:pdf|zip|msword|vnd\.|octet-stream)|image\/|audio\/|video\/)/i.test(contentType)
    || /attachment\s*;/i.test(disposition)) {
    throw new Error('document_deferred');
  }
  // A mocked/old adapter may omit content-type. Do not reject it solely for
  // that reason; HTML is validated by the parser and all known binary types
  // above are rejected before any body conversion.
  return finalUrl;
}

// 45000000-7 (Bauarbeiten) bleibt als spätere Option erhalten, ist aber
// wegen der großen Trefferzahl zunächst nicht aktiv.
export const OPTIONAL_CPV_CODES = Object.freeze({
  construction: '45000000-7',
});

// 71400000-2 ist die vom NRW-Portal angebotene CPV-Kategorie
// „Stadtplanung und Landschaftsgestaltung“. 71400000-0 war ungültig.
export const NRW_CPV_CODES = Object.freeze([
  '71220000-6',
  '71400000-2',
  '77300000-3',
  '80000000-4',
  '92000000-1',
]);

function decodeEntities(str) {
  if (!str) return str;
  return cheerio.load(`<div>${str}</div>`).text();
}

function cleanText(value) {
  return decodeEntities(String(value ?? '').replace(/\s+/g, ' ').trim());
}

function projectIdFromHref(href, baseUrl = meta.baseUrl) {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    if (!PROJECT_PATH_RE.test(url.pathname)) return null;
    const pid = url.searchParams.get('pid');
    return pid ? String(pid) : null;
  } catch {
    return null;
  }
}

function projectLinkFromRow($, row, baseUrl) {
  for (const link of $(row).find('a[href]').toArray()) {
    const href = $(link).attr('href');
    if (projectIdFromHref(href, baseUrl)) return href;
  }
  return null;
}

function fallbackTitle(cellTexts) {
  return cellTexts
    .filter((text, index) => text && index !== 0 && index !== 1 && !normalizeDate(text))
    .sort((a, b) => b.length - a.length)[0] || 'Ohne Titel';
}

/**
 * Parst ausschließlich Zeilen mit einem echten NRW-Projektraum-Link.
 * Facet-/Kategorie-Links enthalten keine pid und werden bewusst ignoriert.
 *
 * Der optionale discoveryCpvCode dient nur Diagnose und Deduplizierung. Er
 * wird niemals als tatsächlicher Tender-CPV in cpvCodes gespeichert.
 */
export function parseResultsTable(html, baseUrl = meta.baseUrl, discoveryCpvCode = null) {
  const $ = cheerio.load(html);
  const results = [];

  $('table tr').each((_, node) => {
    const $node = $(node);
    const cells = $node.find('td');
    if (cells.length < 2) return;

    const href = projectLinkFromRow($, node, baseUrl);
    const externalId = projectIdFromHref(href, baseUrl);
    if (!href || !externalId) return;

    const cellTexts = cells.map((__, td) => cleanText($(td).text())).get();
    const title = cleanText(cellTexts[2] || fallbackTitle(cellTexts));
    const url = new URL(href, baseUrl).toString();
    const publicationDate = normalizeDate(cellTexts[0]);
    const deadline = normalizeDate(cellTexts[1]) || normalizeDate(cellTexts[2]);
    const tenderType = cleanText(cellTexts[3] || '');
    const contractingAuthority = cleanText(cellTexts[4] || '');
    const status = deriveStatus(deadline, 'open');

    results.push({
      sourceId: meta.id,
      externalId,
      portalProjectId: externalId,
      title: title || 'Ohne Titel',
      url,
      description: null,
      contractingAuthority: contractingAuthority || null,
      // Der CPV der Ergebnisabfrage ist nur ein Discovery-Metadatum.
      cpvCodes: null,
      cpvLabels: null,
      discoveryCpvCodes: discoveryCpvCode ? [discoveryCpvCode] : [],
      estimatedValueCents: null,
      estimatedValueCurrency: 'EUR',
      placeOfPerformance: null,
      awardCriteria: null,
      tenderType: tenderType || null,
      publicationDate,
      submissionDeadline: deadline,
      openingDate: null,
      contractDuration: null,
      documentUrl: null,
      status,
      contentHash: contentHash('nrw-parser-v2', externalId, title, deadline, status),
    });
  });

  return results;
}

function pageUrlFromTarget(target, currentUrl, cpvCode, page) {
  const url = new URL(target || currentUrl, currentUrl);
  if (!url.searchParams.has('method')) url.searchParams.set('method', 'showTable');
  if (!url.searchParams.has('cpvCode') && cpvCode) url.searchParams.set('cpvCode', cpvCode);
  url.searchParams.set('fromSearch', '1');
  url.searchParams.set(PAGE_PARAMETER, String(page));
  return url.toString();
}

/**
 * Extrahiert die vom Portal per JavaScript ausgelösten Seitenwechsel.
 * Zusätzlich wird aus „Seite: x von y“ die nächste Seite erzeugt, falls das
 * Portal keinen direkt sichtbaren Link ausliefert.
 */
export function parsePagination(html, currentUrl, cpvCode) {
  const $ = cheerio.load(html);
  const pageUrls = new Map();
  const bodyText = cleanText($.root().text());
  const summary = bodyText.match(PAGE_SUMMARY_RE);
  const currentPage = summary ? Number(summary[1]) : null;
  const totalPages = summary ? Number(summary[2]) : null;

  const addPage = (target, page) => {
    if (!Number.isInteger(page) || page < 1) return;
    const url = pageUrlFromTarget(target, currentUrl, cpvCode, page);
    pageUrls.set(`${cpvCode}:${page}`, url);
  };

  $('a[onclick], a[href]').each((_, node) => {
    const onclick = $(node).attr('onclick') || '';
    const href = $(node).attr('href') || '';
    const source = `${onclick} ${href}`;
    const pageMatch = source.match(new RegExp(`${PAGE_PARAMETER}=(\\d+)`));
    if (!pageMatch) return;

    const page = Number(pageMatch[1]);
    const targetMatch = onclick.match(/setTargetAndSubmit\(['\"]([^'\"]+)['\"]\)/i);
    addPage(targetMatch ? targetMatch[1] : href, page);
  });

  if (currentPage != null && totalPages != null && currentPage < totalPages) {
    addPage(currentUrl, currentPage + 1);
  }

  return [...pageUrls.values()];
}

async function fetchPage(url, rateLimiter, requestDelayMs) {
  if (isDeferredDocumentUrl(url)) throw new Error('document_deferred');
  await rateLimiter?.acquire();
  // Manuelle Redirects erlauben, jeden Hop und das finale Content-Type zu
  // prüfen, bevor er als HTML in den Parser gelangt.
  const response = await getWithRedirects(url, { rejectBinary: true }, 5);
  const finalUrl = assertHtmlResponse(response, url);
  if (requestDelayMs > 0) await sleep(requestDelayMs);
  return {
    html: String(response.data),
    url: finalUrl,
  };
}

/** Holt alle Seiten einer einzelnen CPV-Kategorie. */
export async function crawlCategory(
  cpvCode,
  { rateLimiter = null, requestDelayMs = config.requestDelayMs } = {}
) {
  const initialUrl = `${SHOW_TABLE_URL}&cpvCode=${encodeURIComponent(cpvCode)}`;
  const queue = [initialUrl];
  const visited = new Set();
  const rows = [];

  while (queue.length) {
    const requestedUrl = queue.shift();
    const pageKey = new URL(requestedUrl).toString();
    if (visited.has(pageKey)) continue;
    visited.add(pageKey);

    const page = await fetchPage(requestedUrl, rateLimiter, requestDelayMs);
    const pageUrl = page.url || requestedUrl;
    rows.push(...parseResultsTable(page.html, meta.baseUrl, cpvCode));

    for (const nextUrl of parsePagination(page.html, pageUrl, cpvCode)) {
      if (!visited.has(nextUrl)) queue.push(nextUrl);
    }
  }

  return rows;
}

/**
 * Discover-Phase: alle Seiten der aktiven CPV-Kategorien holen und über pid
 * deduplizieren. maxResults wird absichtlich ignoriert: NRW wird vollständig
 * innerhalb des gewählten CPV-Scopes gecrawlt.
 */
export async function discover({ rateLimiter = null, requestDelayMs = config.requestDelayMs } = {}) {
  const byId = new Map();
  const errors = [];
  let totalRaw = 0;

  for (const cpv of NRW_CPV_CODES) {
    try {
      const rows = await crawlCategory(cpv, { rateLimiter, requestDelayMs });
      totalRaw += rows.length;
      for (const row of rows) {
        const existing = byId.get(row.externalId);
        if (!existing) {
          byId.set(row.externalId, row);
          continue;
        }

        existing.discoveryCpvCodes = [
          ...new Set([...(existing.discoveryCpvCodes || []), ...(row.discoveryCpvCodes || [])]),
        ];
      }
    } catch (error) {
      errors.push({ cpv, message: error.message });
      console.warn(`[nrw] CPV ${cpv} nicht abrufbar: ${error.message}`);
    }
  }

  if (!byId.size && errors.length === NRW_CPV_CODES.length) {
    throw new Error(`Keine NRW-CPV-Kategorie konnte abgerufen werden: ${errors.map((e) => e.cpv).join(', ')}`);
  }

  console.log(
    `[nrw] ${totalRaw} Rohtreffer (${NRW_CPV_CODES.length} aktive CPVs), ` +
    `${byId.size} eindeutige Ausschreibungen gefunden.`
  );
  return [...byId.values()];
}

function extractCpvDetails(detailText) {
  const cpvCodes = [];
  const cpvLabels = [];
  const lines = String(detailText || '')
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    CPV_RE.lastIndex = 0;
    const matches = [...line.matchAll(CPV_RE)];
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const match = matches[matchIndex];
      const code = match[1];
      if (cpvCodes.includes(code)) continue;

      const labelEnd = matches[matchIndex + 1]?.index ?? line.length;
      let label = cleanText(line.slice((match.index ?? 0) + match[0].length, labelEnd));
      if (!label && lines[index + 1] && !/\b\d{8}-\d\b/.test(lines[index + 1])) {
        label = cleanText(lines[index + 1]);
      }
      label = label.slice(0, 200);
      cpvCodes.push(code);
      cpvLabels.push(label || null);
    }
  }

  return {
    cpvCodes: cpvCodes.length ? cpvCodes : null,
    cpvLabels: cpvLabels.some(Boolean) ? cpvLabels : null,
  };
}

function extractCpvDetailsFromDom($) {
  const cpvCodes = [];
  const cpvLabels = [];

  $('h4.sub-headline').each((_, heading) => {
    const headingText = cleanText($(heading).text()).toLowerCase();
    if (!headingText.includes('auftragsgegenstand')) return;

    const section = $(heading).closest('.sub-headline-container').parent();
    section.find('.control-group').each((__, element) => {
      const text = cleanText($(element).text());
      const matches = [...text.matchAll(CPV_RE)];
      for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const code = match[1];
        if (cpvCodes.includes(code)) continue;
        const labelEnd = matches[index + 1]?.index ?? text.length;
        const label = cleanText(text.slice((match.index ?? 0) + match[0].length, labelEnd)).slice(0, 200);
        cpvCodes.push(code);
        cpvLabels.push(label || null);
      }
    });
  });

  return {
    cpvCodes: cpvCodes.length ? cpvCodes : null,
    cpvLabels: cpvLabels.some(Boolean) ? cpvLabels : null,
  };
}

function extractDetailText($) {
  const candidates = [
    '.announcement-detail',
    '.project-detail',
    '.projectDetail',
    '.detail',
    'main',
    'article',
    '.content',
    '#content',
  ];
  let description = '';
  for (const selector of candidates) {
    $(selector).each((_, element) => {
      const text = cleanText($(element).text());
      if (text.length > description.length) description = text;
    });
  }
  return description || cleanText($('body').text()) || null;
}

function extractDocumentUrl($, baseUrl) {
  for (const link of $('a[href]').toArray()) {
    const href = $(link).attr('href');
    if (!href) continue;
    let url;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    const text = cleanText($(link).text());
    const documentHint = `${new URL(url).pathname} ${text}`;
    if (
      /\.(pdf|doc|docx|zip|xlsx?|odt)(?:$|[?#])/i.test(url) ||
      /download|documents?|bekanntmachung|vergabeunterlage|dokument/i.test(documentHint)
    ) {
      return url;
    }
  }
  return null;
}

/** Parst Volltext, tatsächliche CPVs und Dokumente einer NRW-Detailseite. */
export function parseDetailPage(html, baseUrl = meta.baseUrl) {
  const $ = cheerio.load(html);
  const detailText = $('body').text();
  const domCpvs = extractCpvDetailsFromDom($);
  const { cpvCodes, cpvLabels } = domCpvs.cpvCodes
    ? domCpvs
    : extractCpvDetails(detailText);

  return {
    description: extractDetailText($),
    cpvCodes,
    cpvLabels,
    documentUrl: extractDocumentUrl($, baseUrl),
    textSections: [makeTextSection({
      sectionKey: 'overview',
      title: 'Übersicht',
      sourceUrl: baseUrl,
      text: cleanDetailText(bodyLines($).join('\n')),
    })],
  };
}

function parseGermanNumber(value) {
  if (value == null) return null;
  const normalized = String(value).replace(/\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const numeric = normalized.replace(/[^\d.-]/g, '');
  if (!numeric || !/\d/.test(numeric)) return null;
  const number = Number(numeric);
  return Number.isFinite(number) ? number : null;
}

function parseSizeBytes(value) {
  if (!value) return null;
  const match = String(value).replace(',', '.').match(/([\d.]+)\s*(bytes?|kb|mb|gb)/i);
  if (!match) return null;
  const number = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit.startsWith('gb') ? 1024 ** 3 : unit.startsWith('mb') ? 1024 ** 2 : unit.startsWith('kb') ? 1024 : 1;
  return Number.isFinite(number) ? Math.round(number * factor) : null;
}

function bodyLines($) {
  const blockSelector = 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,label,legend,button,article,section';
  const blockTexts = $(blockSelector).filter((_, element) => !$(element).find(blockSelector).length)
    .map((_, element) => cleanText($(element).text())).get().filter(Boolean);
  if (blockTexts.length) return blockTexts;
  const leafTexts = $('body *').filter((_, element) => $(element).children().length === 0)
    .map((_, element) => cleanText($(element).text())).get().filter(Boolean);
  if (leafTexts.length) return leafTexts;
  return String($('body').text() || '').split(/[\r\n]+/).map((line) => cleanText(line)).filter(Boolean);
}

function firstLabelValue(text, labels) {
  const source = cleanText(text);
  for (const label of labels) {
    const expression = new RegExp(`${label}\\s*:?\\s*(.{1,240}?)(?=\\s+(?:Auftraggeber|Vergabestelle|Verfahrensart|Status|Frist|Termin|Laufzeit|Auftragswert|CPV|Kriterien|Eignung|Ausschluss|Einreichung|Sprache|Leistungsort|Los)|$)`, 'i');
    const match = source.match(expression);
    if (match?.[1]) return cleanText(match[1]);
  }
  return null;
}

function extractBooleanField(text, labels) {
  const source = cleanText(text);
  for (const label of labels) {
    const match = source.match(new RegExp(`${label}\\s*:?\\s*(ja|nein|yes|no|zugelassen|nicht zugelassen|vorgesehen|nicht vorgesehen)\\b`, 'i'));
    if (!match) continue;
    return !/^(?:nein|no|nicht zugelassen|nicht vorgesehen)$/i.test(match[1]);
  }
  return null;
}

function explicitBooleanFacts($, sectionKey, sourceUrl, metadata) {
  const labels = {
    frameworkAgreement: ['Rahmenvereinbarung'],
    dynamicPurchasingSystem: ['dynamisches Beschaffungssystem', 'DPS'],
    electronicAuction: ['elektronische Auktion'],
    variants: ['Nebenangebote', 'Varianten'],
    electronicSubmission: ['elektronische Angebotsabgabe', 'elektronisch eingereicht'],
    euFunded: ['EU-Finanzierung', 'Finanzierung durch die Europäische Union'],
    smeRelevant: ['KMU', 'kleine und mittlere Unternehmen'],
    sustainable: ['Nachhaltigkeitskriterium', 'nachhaltige Beschaffung'],
  };
  const facts = [];
  $('p,li,td,dd,label,.control-label,.field-label').each((_, node) => {
    const text = cleanText($(node).text());
    for (const [key, names] of Object.entries(labels)) {
      if (!names.some((name) => new RegExp(`^${name}\\s*:?\\s*(?:ja|nein|yes|no|zugelassen|nicht zugelassen|vorgesehen|nicht vorgesehen)$`, 'i').test(text))) continue;
      const value = metadata.flags?.[key];
      if (value == null) continue;
      facts.push(makeFact({
        sectionKey, key: `${sectionKey}:flags.${key}`, label: `flags.${key}`,
        value: value ? 'Ja' : 'Nein', normalizedValue: value, dataType: 'boolean', sourceUrl,
      }));
    }
  });
  return facts.filter(Boolean);
}

function canonicalStructuredFacts($, sectionKey, sourceUrl, metadata) {
  const aliases = {
    status: ['status'], procedureType: ['verfahrensart'], procurementRegulation: ['vergabeordnung', 'rechtsgrundlage'],
    contractingAuthority: ['auftraggeber', 'vergabestelle'], buyerId: ['identifikationsnummer', 'ted-nummer', 'nuts'],
    questionDeadline: ['frist für fragen', 'fragenfrist'], submissionDeadline: ['frist für den eingang der angebote', 'angebotsfrist', 'teilnahmefrist'],
    openingDate: ['öffnungstermin', 'öffnung der angebote'], bindingPeriod: ['bindefrist'], publicationDate: ['veröffentlichungsdatum', 'datum der veröffentlichung'],
    estimatedValue: ['geschätzter auftragswert', 'geschätzter wert', 'auftragswert'], contractDuration: ['laufzeit', 'vertragslaufzeit'],
    placeOfPerformance: ['leistungsort', 'ort der leistung', 'erfüllungsort'],
  };
  const structured = extractFactsFromDom($, sectionKey, sourceUrl);
  const facts = [];
  for (const [key, names] of Object.entries(aliases)) {
    const match = structured.find((fact) => names.some((name) => cleanText(fact.label).toLowerCase() === name));
    if (!match) continue;
    facts.push(makeFact({
      sectionKey, key: `${sectionKey}:${key}`, label: key, value: match.valueText,
      normalizedValue: match.valueText, dataType: 'structured', sourceUrl,
    }));
  }
  return facts.filter(Boolean);
}

function parseCriteriaFromText(text) {
  const criteria = [];
  const source = String(text || '');
  const patterns = [
    ['award', /Zuschlagskriter(?:ium|ien)\s*:?\s*([^]{0,500}?)(?=\s+(?:Eignung|Ausschluss|Ausführung|Einreichung|$))/gi],
    ['suitability', /Eignungskriter(?:ium|ien)\s*:?\s*([^]{0,500}?)(?=\s+(?:Zuschlag|Ausschluss|Ausführung|Einreichung|$))/gi],
    ['exclusion', /Ausschlussgr(?:ünde|und)\s*:?\s*([^]{0,500}?)(?=\s+(?:Eignung|Zuschlag|Ausführung|Einreichung|$))/gi],
    ['execution', /Ausführungsbeding(?:ungen|ung)\s*:?\s*([^]{0,500}?)(?=\s+(?:Einreichung|Sprache|$))/gi],
    ['submission', /Einreichungsanforderungen?\s*:?\s*([^]{0,500}?)(?=\s+(?:Sprache|Varianten|$))/gi],
  ];
  for (const [kind, regex] of patterns) {
    for (const match of source.matchAll(regex)) {
      const description = cleanText(match[1]);
      if (!description) continue;
      criteria.push({
        criterionKey: `${kind}-${contentHash(description).slice(0, 24)}`,
        kind,
        title: kind,
        description,
        sourceSection: kind,
        required: kind !== 'award' ? true : null,
      });
    }
  }
  // Gewichtete Zuschlagskriterien werden zusätzlich aus typischen „70 %“-Zeilen
  // extrahiert. Der Rohabschnitt bleibt im Snapshot erhalten, falls das Portal
  // eine neue Darstellung verwendet.
  for (const line of String(text).split(/[\r\n]+/).map(cleanText).filter(Boolean)) {
    const weight = line.match(/(\d+(?:[,.]\d+)?)\s*%/);
    if (!weight || !/(Zuschlag|Kriterium|Preis|Qualität)/i.test(line)) continue;
    criteria.push({
      criterionKey: `weighted-${contentHash(line).slice(0, 24)}`,
      kind: 'award',
      title: line.replace(weight[0], '').trim(),
      description: line,
      weight: parseGermanNumber(weight[1]),
      sourceSection: 'Zuschlagskriterien',
    });
  }
  return criteria;
}

/** Parser für die moderne eForms-Seite. Nicht erkannte Felder bleiben im
 * rawText erhalten, damit spätere Parserergänzungen keine Datenlücke erzeugen. */
export function parseEformsPage(html, baseUrl = meta.baseUrl) {
  const $ = cheerio.load(html);
  const lines = bodyLines($);
  const rawText = cleanText(lines.join(' '));
  const cpv = extractCpvDetails(lines.join('\n'));
  const estimatedValueText = firstLabelValue(rawText, ['Geschätzter Auftragswert', 'Geschätzter Wert', 'Auftragswert']);
  const durationText = firstLabelValue(rawText, ['Laufzeit', 'Vertragslaufzeit']);
  const metadata = {
    pageKind: 'eforms',
    rawText,
    status: firstLabelValue(rawText, ['Status']),
    procedureType: firstLabelValue(rawText, ['Verfahrensart']),
    procurementRegulation: firstLabelValue(rawText, ['Vergabeordnung', 'Rechtsgrundlage']),
    contractingAuthority: firstLabelValue(rawText, ['Auftraggeber', 'Vergabestelle']),
    buyerId: firstLabelValue(rawText, ['Identifikationsnummer', 'TED-Nummer', 'NUTS']),
    questionDeadline: firstLabelValue(rawText, ['Frist für Fragen', 'Fragenfrist']),
    submissionDeadline: firstLabelValue(rawText, ['Frist für den Eingang der Angebote', 'Angebotsfrist', 'Teilnahmefrist']),
    openingDate: firstLabelValue(rawText, ['Öffnungstermin', 'Öffnung der Angebote']),
    bindingPeriod: firstLabelValue(rawText, ['Bindefrist']),
    publicationDate: firstLabelValue(rawText, ['Veröffentlichungsdatum', 'Datum der Veröffentlichung']),
    estimatedValue: estimatedValueText,
    contractDuration: durationText,
    placeOfPerformance: firstLabelValue(rawText, ['Leistungsort', 'Ort der Leistung', 'Erfüllungsort']),
    nuts: [...rawText.matchAll(/NUTS(?:-Code)?\s*[:]?\s*([A-Z]{2,3}\w*)/gi)].map((match) => match[1]),
    flags: {
      frameworkAgreement: extractBooleanField(rawText, ['Rahmenvereinbarung']),
      dynamicPurchasingSystem: extractBooleanField(rawText, ['dynamisches Beschaffungssystem', 'DPS']),
      electronicAuction: extractBooleanField(rawText, ['elektronische Auktion']),
      variants: extractBooleanField(rawText, ['Nebenangebote', 'Varianten']),
      electronicSubmission: extractBooleanField(rawText, ['elektronische Angebotsabgabe', 'elektronisch eingereicht']),
      euFunded: extractBooleanField(rawText, ['EU-Finanzierung', 'Finanzierung durch die Europäische Union']),
      smeRelevant: extractBooleanField(rawText, ['KMU', 'kleine und mittlere Unternehmen']),
      sustainable: extractBooleanField(rawText, ['Nachhaltigkeitskriterium', 'nachhaltige Beschaffung']),
    },
  };
  const lots = [];
  $('h1,h2,h3,h4,h5,legend').each((_, heading) => {
    const headingText = cleanText($(heading).text());
    const lotMatch = headingText.match(/(?:Los|Lot)\s*([\w.-]+)/i);
    if (!lotMatch) return;
    const parentText = cleanText($(heading).parent().text());
    lots.push({
      lotKey: lotMatch[1], lotNumber: lotMatch[1], title: headingText,
      description: parentText.slice(0, 2000), cpvCodes: cpv.cpvCodes, cpvLabels: cpv.cpvLabels,
      metadata: { sourceSection: headingText },
    });
  });
  const criteria = parseCriteriaFromText(lines.join('\n'));
  const core = {
    description: firstLabelValue(rawText, ['Beschreibung', 'Kurzbeschreibung', 'Auftragsgegenstand']) || extractDetailText($),
    cpvCodes: cpv.cpvCodes,
    cpvLabels: cpv.cpvLabels,
    submissionDeadline: metadata.submissionDeadline ? normalizeDate(metadata.submissionDeadline) || metadata.submissionDeadline : null,
    bindingPeriod: metadata.bindingPeriod ? normalizeDate(metadata.bindingPeriod) || metadata.bindingPeriod : null,
    openingDate: metadata.openingDate ? normalizeDate(metadata.openingDate) || metadata.openingDate : null,
    questionDeadline: metadata.questionDeadline ? normalizeDate(metadata.questionDeadline) || metadata.questionDeadline : null,
    contractDuration: durationText,
    estimatedValueCents: estimatedValueText && parseGermanNumber(estimatedValueText) != null
      ? Math.round(parseGermanNumber(estimatedValueText) * 100)
      : null,
    estimatedValueCurrency: /GBP|USD|CHF|EUR/i.exec(estimatedValueText || '')?.[0]?.toUpperCase() || 'EUR',
    contractingAuthority: metadata.contractingAuthority,
    placeOfPerformance: metadata.placeOfPerformance,
    procedureType: metadata.procedureType,
    portalStatus: metadata.status,
    tenderType: metadata.procurementRegulation,
    awardCriteria: criteria.filter((criterion) => criterion.kind === 'award').map((criterion) => criterion.description).join(' | ') || null,
  };
  return {
    ...core,
    metadata,
    lots,
    criteria,
    facts: uniqueFacts([
      ...extractFactsFromDom($, 'eforms', baseUrl),
      ...canonicalStructuredFacts($, 'eforms', baseUrl, metadata),
      ...explicitBooleanFacts($, 'eforms', baseUrl, metadata),
      ...criteria.map((criterion) => makeFact({
        sectionKey: 'eforms',
        key: `eforms:criterion:${criterion.criterionKey}`,
        label: criterion.title || criterion.kind,
        value: criterion.description,
        normalizedValue: criterion,
        dataType: 'criterion',
        sourceUrl: baseUrl,
      })),
    ].filter(Boolean)),
    textSections: [makeTextSection({
      sectionKey: 'eforms',
      title: 'Verfahrensdaten / eForms',
      sourceUrl: baseUrl,
      text: lines.join('\n'),
    })],
    snapshot: { kind: 'nrw:eforms', sourceUrl: baseUrl, content: String(html), mimeType: 'text/html' },
  };
}

export function parseDocumentsPage(html, baseUrl = meta.baseUrl) {
  const $ = cheerio.load(html);
  const pageText = cleanText($('body').text());
  const hasFileLink = $('a[href]').toArray().some((link) => /\.(?:pdf|docx?|xlsx?|zip|odt|txt|xml|html?)(?:$|[?#])/i.test($(link).attr('href') || ''));
  const loginRequired = /(?:login|anmelden|anmeldung erforderlich|nur für registrierte)/i.test(pageText) && !hasFileLink;
  const documents = [];
  let category = null;
  $('h1,h2,h3,h4,h5,legend,table,tr,a').each((_, node) => {
    const $node = $(node);
    const text = cleanText($node.text());
    if (!text) return;
    if (/unterlagen|dokument|bekanntmach|anhang|formulare|sonstig/i.test(text) && $node.is('h1,h2,h3,h4,h5,legend')) {
      category = text;
    }
    if (!$node.is('tr')) return;
    const cells = $node.find('td,th').map((__, cell) => cleanText($(cell).text())).get().filter(Boolean);
    const links = $node.find('a[href]').map((__, link) => {
      try { return new URL($(link).attr('href'), baseUrl).toString(); } catch { return null; }
    }).get().filter(Boolean);
    const filename = cells.find((value) => /\.(?:pdf|docx?|xlsx?|zip|odt|txt|xml|html?)$/i.test(value)) || cells[0];
    if (!filename || /^datei|name$/i.test(filename)) return;
    const href = links.find((link) => /download|document|file|zip|\.pdf(?:$|\?)/i.test(link)) || links[0] || null;
    const sizeText = cells.find((value) => /\d+(?:[.,]\d+)?\s*(?:KB|MB|Bytes?)/i.test(value));
    const dateText = cells.find((value) => /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(value));
    const type = cells.find((value) => /^(?:PDF|DOCX?|XLSX?|ZIP|HTML?)$/i.test(value)) || null;
    const document = {
      portalFileId: href || `${category || 'documents'}:${filename}`,
      category: category || 'unknown', filename, mimeType: type, sizeBytes: parseSizeBytes(sizeText),
      publishedAt: dateText ? normalizeDate(dateText) || dateText : null,
      sourceUrl: baseUrl,
      locator: { pageUrl: baseUrl, href, filename, category: category || 'unknown' },
      accessStatus: href ? 'public' : 'unknown', downloadStatus: 'not_requested',
    };
    if (!documents.some((item) => item.portalFileId === document.portalFileId && item.filename === filename)) documents.push(document);
  });
  // Karten-/Formularansichten enthalten Dateien oft nur als Link. Ergänzend
  // zu Tabellen werden deshalb alle eindeutigen Datei- und Download-Links
  // inventarisiert; Gesamt-ZIPs bleiben separat als archiveUrl.
  $('a[href]').each((_, link) => {
    const href = $(link).attr('href');
    const linkText = cleanText($(link).text());
    if (!href || /zip|gesamt|alle unterlagen/i.test(`${href} ${linkText}`)) return;
    if (!/(?:download|directdocload|file|dokument|unterlage)|\.(?:pdf|docx?|xlsx?|odt|txt|xml|html?)(?:$|[?#])/i.test(`${href} ${linkText}`)) return;
    let absolute;
    try { absolute = new URL(href, baseUrl).toString(); } catch { return; }
    const filename = linkText.match(/[^|]+\.(?:pdf|docx?|xlsx?|odt|txt|xml|html?)/i)?.[0]?.trim()
      || absolute.split('/').pop()?.split('?')[0] || 'Dokument';
    if (documents.some((item) => item.portalFileId === absolute && item.filename === filename
      || item.locator?.href === absolute)) return;
    documents.push({
      portalFileId: absolute, category: category || 'unknown', filename,
      mimeType: /\.pdf(?:$|\?)/i.test(absolute) ? 'application/pdf' : null,
      sourceUrl: baseUrl, locator: { pageUrl: baseUrl, href: absolute, filename },
      accessStatus: 'public', downloadStatus: 'not_requested',
    });
  });
  const archiveLinks = $('a[href]').map((_, link) => {
    const href = $(link).attr('href');
    if (!href || !/zip|gesamt|alle unterlagen/i.test(`${href} ${$(link).text()}`)) return null;
    try { return new URL(href, baseUrl).toString(); } catch { return null; }
  }).get().filter(Boolean);
  return {
    documents,
    archiveUrl: archiveLinks[0] || null,
    loginRequired,
    textSection: makeTextSection({
      sectionKey: 'documents',
      title: 'Vergabeunterlagen',
      sourceUrl: baseUrl,
      text: cleanDetailText(bodyLines($).join('\n')),
      status: loginRequired ? 'login_required' : 'complete',
    }),
    snapshot: { kind: 'nrw:documents', sourceUrl: baseUrl, content: String(html), mimeType: 'text/html' },
  };
}

export function parseCommunicationPage(html, baseUrl = meta.baseUrl) {
  const $ = cheerio.load(html);
  const pageText = cleanText(bodyLines($).join(' '));
  const loginRequired = /(?:login|anmelden|anmeldung erforderlich|nur für registrierte)/i.test(pageText)
    && !/(?:Betreff\s*:|Bieterfrage\s*:|Nachricht\s*:)/i.test(pageText);
  const messages = [];
  const candidateNodes = $('body *').filter((_, element) => {
    const text = cleanText($(element).text());
    return /Betreff\s*:/i.test(text) && $(element).children().length < 8;
  }).toArray();
  // Ein semantischer Nachrichten-Container enthält häufig zusätzlich
  // einzelne <p>-Elemente mit "Betreff:". Nur den äußersten Kandidaten
  // verarbeiten, damit eine Nachricht nicht doppelt inventarisiert wird.
  const outerCandidates = candidateNodes.filter((element) => !$(element).parents().toArray()
    .some((parent) => candidateNodes.includes(parent)));
  outerCandidates.forEach((element) => {
    const $element = $(element);
    const structuredParts = $element.find('p,li,td,th,div,br').map((__, child) => cleanText($(child).text())).get().filter(Boolean);
    const text = cleanText((structuredParts.length ? structuredParts : [$element.text()]).join(' '));
    const subject = text.match(/Betreff\s*:\s*(.*?)(?=\s+(?:Datum|Veröffentlicht|Nachricht|Text)\s*:|$)/i)?.[1] || null;
    const publishedAt = text.match(/(?:Datum|Veröffentlicht(?: am)?)\s*:\s*([\d.\-/ :]+)/i)?.[1] || null;
    const body = text.replace(/Betreff\s*:\s*.*?(?=\s+(?:Datum|Veröffentlicht|Nachricht|Text)\s*:|$)/i, '')
      .replace(/(?:Datum|Veröffentlicht(?: am)?)\s*:\s*[\d.\-/ :]+/i, '').trim();
    const attachments = $element.find('a[href]').map((__, link) => {
      try {
        const href = new URL($(link).attr('href'), baseUrl).toString();
        return { filename: cleanText($(link).text()) || href.split('/').pop(), href, accessStatus: 'public' };
      } catch { return null; }
    }).get().filter(Boolean);
    if (subject || body) {
      const portalMessageId = `message-${contentHash('nrw-message', subject, publishedAt, body)}`;
      if (!messages.some((message) => message.portalMessageId === portalMessageId)) {
        messages.push({
          portalMessageId,
          subject, publishedAt: normalizeDate(publishedAt) || publishedAt, body,
          sourceUrl: baseUrl, attachments,
        });
      }
    }
  });
  if (!messages.length && pageText && !loginRequired) {
    const subject = pageText.match(/Betreff\s*:\s*(.*?)(?=\s+(?:Datum|Veröffentlicht|Nachricht|Text)\s*:|$)/i)?.[1] || null;
    const publishedAt = pageText.match(/(?:Datum|Veröffentlicht(?: am)?)\s*:\s*([\d.\-/ :]+)/i)?.[1] || null;
    const body = subject ? pageText.replace(/Betreff\s*:\s*.*?(?=\s+(?:Datum|Veröffentlicht|Nachricht|Text)\s*:|$)/i, '').trim() : pageText;
    messages.push({
      portalMessageId: `message-${contentHash('nrw-message', subject, publishedAt, body)}`,
      subject, body, publishedAt: normalizeDate(publishedAt) || publishedAt, sourceUrl: baseUrl, attachments: [],
    });
  }
  return {
    messages,
    loginRequired,
    textSection: makeTextSection({
      sectionKey: 'communication',
      title: 'Kommunikation',
      sourceUrl: baseUrl,
      text: pageText,
      status: loginRequired ? 'login_required' : 'complete',
    }),
    snapshot: { kind: 'nrw:communication', sourceUrl: baseUrl, content: String(html), mimeType: 'text/html' },
  };
}

function absoluteLinks($, baseUrl) {
  return $('a[href]').map((_, node) => {
    try { return new URL($(node).attr('href'), baseUrl).toString(); } catch { return null; }
  }).get().filter(Boolean);
}

/** Ruft Übersicht, eForms, Unterlagen und anonyme Kommunikation getrennt ab. */
export async function fetchDetailBundle(url, {
  rateLimiter = null,
  requestDelayMs = config.requestDelayMs,
  crawlKind = 'full',
  fullCrawlSucceeded = true,
} = {}) {
  try {
    if (isDeferredDocumentUrl(url)) return null;
    await rateLimiter?.acquire();
    const response = await getWithRedirects(url, { rejectBinary: true }, 5);
    const overviewUrl = assertHtmlResponse(response, url);
    const overviewHtml = String(response.data);
    const overview = parseDetailPage(overviewHtml, overviewUrl);
    const $overview = cheerio.load(overviewHtml);
    const links = absoluteLinks($overview, overviewUrl);
    const overviewText = cleanText($overview('body').text());
    const cosinexProjectId = overviewUrl.match(/[?&](?:projectId|projectID|project)=([^&]+)/i)?.[1]
      || $overview('input[name], [data-project-id], [data-projectid]').filter((_, node) =>
        /project/i.test($overview(node).attr('name') || '') || $overview(node).attr('data-project-id') || $overview(node).attr('data-projectid'))
        .map((_, node) => $overview(node).attr('value') || $overview(node).attr('data-project-id') || $overview(node).attr('data-projectid'))
        .get().find(Boolean)
      || overviewHtml.match(/(?:project[_-]?id|projekt[-_ ]?id)\s*["'=:\s]+([A-Za-z0-9_-]+)/i)?.[1]
      || null;
    const findSection = (patterns) => links.find((link) => patterns.some((pattern) => pattern.test(link)));
    const eformsUrl = findSection([/processdata\/eforms/i, /eforms/i]);
    const documentsUrl = findSection([/\/documents?(?:\/|\?|$)/i, /vergabeunterlagen/i]);
    const communicationUrl = findSection([/communication\/anonym/i, /kommunikation/i, /bieterfragen/i]);
    const absentSectionStatus = (hints) => hints.some((pattern) => pattern.test(overviewText)) ? 'unknown_structure' : 'not_offered';
    const bundle = {
      metadata: { portal: 'nrw', overviewUrl, cosinexProjectId }, crawlKind, fullCrawlSucceeded,
      lots: [], criteria: [], documents: [], messages: [], snapshots: [],
      textSections: overview.textSections || [], facts: [],
      completeness: { overall: 'partial', sections: {} },
    };
    bundle.snapshots.push({ kind: 'nrw:overview', sourceUrl: overviewUrl, content: overviewHtml, mimeType: 'text/html' });
    bundle.completeness.sections.overview = 'complete';
    const pageFetch = async (sectionUrl) => {
      if (!sectionUrl) return null;
      if (isDeferredDocumentUrl(sectionUrl)) throw new Error('document_deferred');
      await rateLimiter?.acquire();
      const page = await getWithRedirects(sectionUrl, { rejectBinary: true }, 5);
      const finalUrl = assertHtmlResponse(page, sectionUrl);
      if (requestDelayMs > 0) await sleep(requestDelayMs);
      return { html: String(page.data), url: finalUrl };
    };
    if (eformsUrl) {
      try {
        const page = await pageFetch(eformsUrl);
        const parsed = parseEformsPage(page.html, page.url);
        Object.assign(overview, parsed);
        bundle.metadata = { ...bundle.metadata, ...parsed.metadata };
        bundle.lots.push(...parsed.lots);
        bundle.criteria.push(...parsed.criteria);
        bundle.textSections.push(...(parsed.textSections || []));
        bundle.facts.push(...(parsed.facts || []));
        bundle.snapshots.push({ ...parsed.snapshot, sourceUrl: page.url });
        const recognized = parsed.cpvCodes?.length || parsed.criteria?.length || parsed.metadata.procedureType
          || parsed.metadata.contractingAuthority || parsed.metadata.submissionDeadline;
        bundle.completeness.sections.eforms = /(?:login|anmelden|anmeldung erforderlich)/i.test(parsed.metadata.rawText)
          ? 'login_required'
          : (recognized ? 'complete' : 'unknown_structure');
      } catch (error) {
        bundle.completeness.sections.eforms = `temporary_error:${error.message}`;
      }
    } else bundle.completeness.sections.eforms = absentSectionStatus([/eforms|verfahrensangaben|verfahrensdaten/i]);
    if (documentsUrl) {
      try {
        const page = await pageFetch(documentsUrl);
        const parsed = parseDocumentsPage(page.html, page.url);
        bundle.documents.push(...parsed.documents);
        if (parsed.archiveUrl) bundle.documents.push({
          portalFileId: parsed.archiveUrl, category: 'archive', filename: 'Gesamtarchiv.zip', mimeType: 'application/zip',
          sourceUrl: page.url, locator: { href: parsed.archiveUrl, pageUrl: page.url }, accessStatus: 'public', downloadStatus: 'not_requested',
        });
        bundle.snapshots.push({ ...parsed.snapshot, sourceUrl: page.url });
        if (parsed.textSection) bundle.textSections.push({ ...parsed.textSection, sourceUrl: page.url });
        bundle.facts.push(makeFact({
          sectionKey: 'documents', key: 'documents:count', label: 'Dokumente inventarisiert',
          value: String(parsed.documents.length + (parsed.archiveUrl ? 1 : 0)), normalizedValue: parsed.documents.length + (parsed.archiveUrl ? 1 : 0), dataType: 'integer', sourceUrl: page.url,
        }));
        bundle.completeness.sections.documents = parsed.loginRequired
          ? 'login_required'
          : (parsed.documents.length || parsed.archiveUrl ? 'complete' : 'empty');
        if (parsed.loginRequired) bundle.metadata.loginRequired = true;
      } catch (error) {
        bundle.completeness.sections.documents = `temporary_error:${error.message}`;
      }
    } else bundle.completeness.sections.documents = absentSectionStatus([/dokument|unterlagen|anhang|datei/i]);
    if (communicationUrl) {
      try {
        const page = await pageFetch(communicationUrl);
        const parsed = parseCommunicationPage(page.html, page.url);
        bundle.messages.push(...parsed.messages);
        for (const message of parsed.messages) {
          for (const attachment of message.attachments || []) {
            if (!attachment?.href) continue;
            const filename = attachment.filename || attachment.href.split('/').pop()?.split('?')[0] || 'Anhang';
            if (bundle.documents.some((document) => document.portalFileId === attachment.href && document.filename === filename)) continue;
            bundle.documents.push({
              portalFileId: attachment.href,
              category: 'communication_attachment',
              filename,
              mimeType: /\.pdf(?:$|\?)/i.test(filename) ? 'application/pdf' : null,
              sourceUrl: page.url,
              locator: { href: attachment.href, pageUrl: page.url, messageId: message.portalMessageId },
              accessStatus: attachment.accessStatus || 'public',
              downloadStatus: 'not_requested',
            });
          }
        }
        bundle.snapshots.push({ ...parsed.snapshot, sourceUrl: page.url });
        if (parsed.textSection) bundle.textSections.push({ ...parsed.textSection, sourceUrl: page.url });
        bundle.facts.push(makeFact({
          sectionKey: 'communication', key: 'communication:count', label: 'Nachrichten inventarisiert',
          value: String(parsed.messages.length), normalizedValue: parsed.messages.length, dataType: 'integer', sourceUrl: page.url,
        }));
        bundle.completeness.sections.communication = parsed.loginRequired
          ? 'login_required'
          : (parsed.messages.length ? 'complete' : 'empty');
        if (parsed.loginRequired) bundle.metadata.loginRequired = true;
      } catch (error) {
        bundle.completeness.sections.communication = `temporary_error:${error.message}`;
      }
    } else bundle.completeness.sections.communication = absentSectionStatus([/kommunikation|bieterfrage|nachricht/i]);
    const failed = Object.values(bundle.completeness.sections).some((value) =>
      String(value).startsWith('temporary_error') || ['login_required', 'unknown_structure', 'document_deferred'].includes(value));
    bundle.completeness.overall = failed ? 'partial' : 'complete';
    bundle.facts = uniqueFacts(bundle.facts);
    bundle.textSections = bundle.textSections.filter((section, index, all) =>
      all.findIndex((candidate) => candidate.sectionKey === section.sectionKey) === index);
    bundle.fullCrawlSucceeded = Boolean(fullCrawlSucceeded && !failed);
    const portalProjectId = new URL(url, meta.baseUrl).searchParams.get('pid')
      || new URL(overviewUrl, meta.baseUrl).searchParams.get('pid')
      || overviewUrl.match(/[?&]project(?:Id|ID)=([^&]+)/i)?.[1] || null;
    return {
      ...overview,
      portalProjectId,
      detailStatus: failed ? 'partial' : 'complete',
      crawlKind,
      fullCrawlSucceeded: bundle.fullCrawlSucceeded,
      detailCrawledAt: new Date().toISOString(),
      detailCompleteness: bundle.completeness,
      portalMetadata: bundle.metadata,
      textSections: bundle.textSections,
      facts: bundle.facts,
      detailBundle: bundle,
    };
  } catch (error) {
    console.error(`[nrw] Detail-Bundle abrufen fehlgeschlagen: ${url} (${error.message})`);
    return null;
  }
}

/** Ruft die Detailseite inklusive möglicher Portal-Weiterleitung ab. */
export async function fetchDetail(url, { rateLimiter = null } = {}) {
  return fetchDetailBundle(url, { rateLimiter });
}

export default {
  meta,
  discover,
  crawlCategory,
  fetchDetail,
  fetchDetailBundle,
  parseResultsTable,
  parsePagination,
  parseDetailPage,
  parseEformsPage,
  parseDocumentsPage,
  parseCommunicationPage,
  NRW_CPV_CODES,
  OPTIONAL_CPV_CODES,
};
