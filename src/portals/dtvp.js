import { httpClient, getWithRedirects } from '../crawler/http-client.js';
import * as cheerio from 'cheerio';
import { contentHash, normalizeDate, deriveStatus, normalizeCpv } from '../utils.js';
import { parseCosinexCommunicationPage, parseCosinexDocumentsPage, parseCosinexEformsPage, parseCosinexOverviewPage } from './cosinex-detail.js';
import { cleanDetailText, makeFact, uniqueFacts } from '../detail-data.js';

export const meta = {
  id: 'dtvp',
  name: 'Deutsches Vergabeportal (dtvp.de)',
  region: 'de',
  type: 'api',
  schedule: '0 */8 * * *', // alle 8h
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://www.dtvp.de',
};

const SEARCH_URL = 'https://www.dtvp.de/Center/common/project/search.do?method=showExtendedSearch&fromExternal=true';
const API_URL = 'https://www.dtvp.de/Center/api/v2/project/search';

const DEFERRED_DOCUMENT_RE = /\.(?:pdf|docx?|xlsx?|zip|7z|rar|odt|ods|txt|rtf)(?:$|[?#])|(?:download|directdocload|filedownload)(?:[/?_.?&=-]|$)/i;

function assertPublicHtml(response, requestedUrl) {
  const finalUrl = response?.request?.res?.responseUrl || response?.config?.url || requestedUrl;
  const contentType = String(response?.headers?.['content-type'] || '').toLowerCase();
  if (DEFERRED_DOCUMENT_RE.test(finalUrl) || DEFERRED_DOCUMENT_RE.test(requestedUrl)
    || /(?:application\/(?:pdf|zip|msword|vnd\.|octet-stream)|image\/|audio\/|video\/)/i.test(contentType)
    || /attachment\s*;/i.test(String(response?.headers?.['content-disposition'] || ''))) throw new Error('document_deferred');
  return finalUrl;
}

function absoluteLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  return $('a[href]').map((_, node) => {
    try { return new URL($(node).attr('href'), baseUrl).toString(); } catch { return null; }
  }).get().filter(Boolean);
}

function sectionLink(links, patterns) {
  return links.find((link) => patterns.some((pattern) => pattern.test(link)));
}

function inScopeProject(project) {
  const type = String(project?.publicationType || project?.publicationTypeName || project?.noticeType || project?.type || '').toLowerCase();
  const status = String(project?.status || project?.projectStatus || '').toLowerCase();
  if (/(award|result|zuschlag|ergebnis|prior|vorinformation|contractaward)/i.test(type)) return false;
  if (/(award|result|zuschlag|ergebnis|closed|abgeschlossen)/i.test(status)) return false;
  const deadline = normalizeDate(project?.relevantDate || project?.submissionDeadline || project?.publishUntilDate);
  return !deadline || deriveStatus(deadline, 'open') !== 'closed';
}

/**
 * Baut die Session auf und liefert das JWT (Token) für die API.
 * Ablauf: Suchseite laden (legt Session an) → Suchformular posten (Token in der Antwort).
 */
async function acquireToken() {
  await getWithRedirects(SEARCH_URL);
  const response = await httpClient.post(
    SEARCH_URL,
    new URLSearchParams({
      searchText: '',
      sortField: 'publicationDate',
      order: 'desc',
      page: 1,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const match = String(response.data).match(/id="token"\s+value="([^"]*)"/);
  if (!match || !match[1]) {
    throw new Error('DTVP-Token konnte nicht extrahiert werden.');
  }
  return match[1];
}

/**
 * Ruft die Such-API mit dem JWT ab und liefert eine Seite Projekte.
 */
async function fetchProjectsPage(token, { pageNumber = 1, pageSize = 100 } = {}) {
  const response = await httpClient.post(
    API_URL,
    {
      pageNumber,
      pageSize,
      sort: { order: [{ property: 'PROJECT_PUBLICATION_DATE_LNG', direction: 'DESC' }] },
      searchText: '',
      cpvCodes: null,
      contractingRules: null,
      publicationTypes: ['Tender'], // nur Ausschreibungen, keine vergebenen Aufträge
      location: null,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-JWT': token,
      },
    }
  );
  return response.data;
}

/**
 * Parst einen DTVP-Projekt-Eintrag in das einheitliche Tender-Format.
 */
export function parseProject(project, sourceId = 'dtvp') {
  if (!project?.projectId) return null;

  const id = String(project.projectId);
  const title = project.title || 'Ohne Titel';
  const url = project.links?.enterprojectroom || `${meta.baseUrl}/Center/public/company/projectForwarding.do?pid=${id}`;
  const deadline = normalizeDate(project.relevantDate || project.publishUntilDate);
  const publicationDate = normalizeDate(project.publishingDate);
  const status = deriveStatus(deadline, 'open');

  // CPV aus der List-API (Feld cpvCodes/cpvLabels; Form variiert zwischen
  // String-Array und Objekt-Array – normalizeCpv deckt beides ab).
  const { cpvCodes, cpvLabels } = normalizeCpv(project.cpvCodes, project.cpvLabels);

  return {
    sourceId,
    externalId: id,
    title: String(title).trim(),
    url,
    description: null,
    contractingAuthority: project.organisationName ? String(project.organisationName).trim() : null,
    cpvCodes,
    cpvLabels,
    estimatedValueCents: null,
    estimatedValueCurrency: 'EUR',
    placeOfPerformance: null,
    awardCriteria: null,
    tenderType: project.contractingRule ? String(project.contractingRule).trim() : null,
    publicationDate,
    submissionDeadline: deadline,
    openingDate: null,
    contractDuration: null,
    documentUrl: null,
    status,
    contentHash: contentHash(id, title, deadline, status, null),
  };
}

/**
 * Discover-Phase: Holt aktuell veröffentlichte Ausschreibungen über die JWT-API.
 */
export async function discover({ maxResults = 100, rateLimiter = null } = {}) {
  try {
    await rateLimiter?.acquire();
    const token = await acquireToken();

    const tenders = [];
    let pageNumber = 1;
    const pageSize = Math.min(100, maxResults || 100);
    let hasMore = true;
    let loggedProjectShape = false;

    while (hasMore && tenders.length < maxResults) {
      await rateLimiter?.acquire();
      const data = await fetchProjectsPage(token, { pageNumber, pageSize });
      const projects = data?.projects || [];
      if (!projects.length) break;

      // Einmalig die rohe Projektstruktur loggen, um das CPV-Feld zu verifizieren.
      if (!loggedProjectShape && projects[0]) {
        loggedProjectShape = true;
        console.log(`[dtvp] Projekt-Keys: ${Object.keys(projects[0]).join(', ')}`);
        const sample = projects[0];
        console.log(`[dtvp] CPV-Rohwerte: cpvCodes=${JSON.stringify(sample.cpvCodes)} cpvLabels=${JSON.stringify(sample.cpvLabels)}`);
      }

      for (const project of projects) {
        if (!inScopeProject(project)) continue;
        const tender = parseProject(project);
        if (tender) tenders.push(tender);
        if (tenders.length >= maxResults) break;
      }

      const current = data?.searchParameter?.pageNumber || pageNumber;
      const allPages = data?.allPages;
      pageNumber = current + 1;
      hasMore = projects.length === pageSize && (allPages == null || pageNumber <= allPages);
    }

    console.log(`[dtvp] ${tenders.length} Ausschreibungen gefunden.`);
    return tenders;
  } catch (error) {
    console.error(`[dtvp] Abruf fehlgeschlagen: ${error.message}`);
    throw new Error(`DTVP-Abruf fehlgeschlagen: ${error.message}`);
  }
}

function enrichFromEforms(overview, parsed) {
  const fields = ['description', 'cpvCodes', 'cpvLabels', 'estimatedValueCents', 'estimatedValueCurrency', 'contractingAuthority', 'placeOfPerformance', 'procedureType', 'submissionDeadline', 'questionDeadline', 'openingDate', 'bindingPeriod', 'contractDuration', 'awardCriteria', 'portalStatus', 'tenderType'];
  for (const field of fields) if (parsed[field] != null && parsed[field] !== '' && (!Array.isArray(parsed[field]) || parsed[field].length)) overview[field] = parsed[field];
}

/** Ruft den öffentlichen DTVP-Projektraum und alle anonym erreichbaren
 * Satellite-Seiten ab. Dateien werden lediglich inventarisiert, nie geladen. */
export async function fetchDetailBundle(url, { rateLimiter = null, requestDelayMs = 0, crawlKind = 'full', fullCrawlSucceeded = true } = {}) {
  try {
    if (DEFERRED_DOCUMENT_RE.test(url)) return null;
    await rateLimiter?.acquire();
    const response = await getWithRedirects(url, { rejectBinary: true }, 5);
    const overviewUrl = assertPublicHtml(response, url);
    const overviewHtml = String(response.data);
    const overview = parseCosinexOverviewPage(overviewHtml, overviewUrl);
    const links = absoluteLinks(overviewHtml, overviewUrl);
    const overviewText = cleanDetailText(overviewHtml.replace(/<[^>]+>/g, ' '));
    const eformsUrl = sectionLink(links, [/processdata/i, /eforms/i, /verfahrensdaten/i]);
    const documentsUrl = sectionLink(links, [/documents?/i, /vergabeunterlagen/i, /tenderdocuments/i]);
    const communicationUrl = sectionLink(links, [/communication/i, /kommunikation/i, /bieterfragen/i, /messages?/i]);
    const bundle = {
      metadata: { portal: 'dtvp', overviewUrl, satelliteUrls: { eformsUrl: eformsUrl || null, documentsUrl: documentsUrl || null, communicationUrl: communicationUrl || null } },
      crawlKind, fullCrawlSucceeded, lots: [], criteria: [], documents: [], messages: [], snapshots: [],
      textSections: overview.textSections || [], facts: overview.facts || [], completeness: { overall: 'partial', sections: {} },
    };
    bundle.snapshots.push({ ...overview.snapshot, kind: 'dtvp:overview' });
    const overviewLogin = /(?:login|anmelden|anmeldung erforderlich|nur für registrierte)/i.test(overviewText)
      && !/(?:Angebotsfrist|Verfahrensart|Vergabestelle|CPV)/i.test(overviewText);
    bundle.completeness.sections.overview = overviewLogin ? 'login_required' : (overviewText ? 'complete' : 'unknown_structure');
    if (overviewLogin) bundle.metadata.loginRequired = true;
    const fetchPage = async (pageUrl) => {
      if (DEFERRED_DOCUMENT_RE.test(pageUrl)) throw new Error('document_deferred');
      await rateLimiter?.acquire();
      const page = await getWithRedirects(pageUrl, { rejectBinary: true }, 5);
      const finalUrl = assertPublicHtml(page, pageUrl);
      if (requestDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
      return { html: String(page.data), url: finalUrl };
    };
    if (eformsUrl) {
      try {
        const page = await fetchPage(eformsUrl);
        const parsed = parseCosinexEformsPage(page.html, page.url);
        enrichFromEforms(overview, parsed);
        bundle.metadata = { ...bundle.metadata, ...parsed.metadata };
        bundle.lots.push(...parsed.lots); bundle.criteria.push(...parsed.criteria); bundle.facts.push(...parsed.facts); bundle.textSections.push(...parsed.textSections);
        bundle.snapshots.push({ ...parsed.snapshot, kind: 'dtvp:eforms', sourceUrl: page.url });
        const login = /(?:login|anmelden|anmeldung erforderlich|nur für registrierte)/i.test(parsed.metadata.rawText);
        bundle.completeness.sections.eforms = login ? 'login_required' : ((parsed.cpvCodes?.length || parsed.criteria.length || parsed.metadata.procedureType || parsed.metadata.submissionDeadline) ? 'complete' : 'unknown_structure');
        if (login) bundle.metadata.loginRequired = true;
      } catch (error) { bundle.completeness.sections.eforms = `temporary_error:${error.message}`; }
    } else bundle.completeness.sections.eforms = /eforms|verfahrensdaten|verfahrensangaben/i.test(overviewText) ? 'unknown_structure' : 'not_offered';
    if (documentsUrl) {
      try {
        const page = await fetchPage(documentsUrl);
        const parsed = parseCosinexDocumentsPage(page.html, page.url);
        bundle.documents.push(...parsed.documents); bundle.textSections.push(parsed.textSection); bundle.snapshots.push({ ...parsed.snapshot, kind: 'dtvp:documents', sourceUrl: page.url });
        bundle.facts.push(makeFact({ sectionKey: 'documents', key: 'documents:count', label: 'Dokumente inventarisiert', value: String(parsed.documents.length), normalizedValue: parsed.documents.length, dataType: 'integer', sourceUrl: page.url }));
        bundle.completeness.sections.documents = parsed.loginRequired ? 'login_required' : (parsed.documents.length ? 'complete' : 'empty');
        if (parsed.loginRequired) bundle.metadata.loginRequired = true;
      } catch (error) { bundle.completeness.sections.documents = `temporary_error:${error.message}`; }
    } else bundle.completeness.sections.documents = /dokument|unterlagen|anhang|datei/i.test(overviewText) ? 'unknown_structure' : 'not_offered';
    if (communicationUrl) {
      try {
        const page = await fetchPage(communicationUrl);
        const parsed = parseCosinexCommunicationPage(page.html, page.url);
        bundle.messages.push(...parsed.messages); bundle.textSections.push(parsed.textSection); bundle.snapshots.push({ ...parsed.snapshot, kind: 'dtvp:communication', sourceUrl: page.url });
        bundle.facts.push(makeFact({ sectionKey: 'communication', key: 'communication:count', label: 'Nachrichten inventarisiert', value: String(parsed.messages.length), normalizedValue: parsed.messages.length, dataType: 'integer', sourceUrl: page.url }));
        bundle.completeness.sections.communication = parsed.loginRequired ? 'login_required' : (parsed.messages.length ? 'complete' : 'empty');
        if (parsed.loginRequired) bundle.metadata.loginRequired = true;
      } catch (error) { bundle.completeness.sections.communication = `temporary_error:${error.message}`; }
    } else bundle.completeness.sections.communication = 'not_offered';
    const failed = Object.values(bundle.completeness.sections).some((status) => String(status).startsWith('temporary_error') || ['login_required', 'unknown_structure'].includes(status));
    bundle.completeness.overall = failed ? 'partial' : 'complete';
    bundle.fullCrawlSucceeded = Boolean(fullCrawlSucceeded && !failed);
    bundle.facts = uniqueFacts(bundle.facts);
    bundle.textSections = bundle.textSections.filter((section, index, all) => all.findIndex((candidate) => candidate.sectionKey === section.sectionKey) === index);
    return { ...overview, detailStatus: failed ? 'partial' : 'complete', crawlKind, fullCrawlSucceeded: bundle.fullCrawlSucceeded, detailCrawledAt: new Date().toISOString(), detailCompleteness: bundle.completeness, portalMetadata: bundle.metadata, detailBundle: bundle };
  } catch (error) {
    console.error(`[dtvp] Detail-Bundle abrufen fehlgeschlagen: ${url} (${error.message})`);
    return null;
  }
}

export async function fetchDetail(url, options = {}) {
  return fetchDetailBundle(url, options);
}

export default { meta, discover, fetchDetail, fetchDetailBundle, parseProject, inScopeProject };
