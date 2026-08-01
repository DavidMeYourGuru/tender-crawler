import { httpClient, getWithRedirects } from '../crawler/http-client.js';
import { contentHash, normalizeDate, deriveStatus } from '../utils.js';

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

  return {
    sourceId,
    externalId: id,
    title: String(title).trim(),
    url,
    description: null,
    contractingAuthority: project.organisationName ? String(project.organisationName).trim() : null,
    cpvCodes: null,
    cpvLabels: null,
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

    while (hasMore && tenders.length < maxResults) {
      await rateLimiter?.acquire();
      const data = await fetchProjectsPage(token, { pageNumber, pageSize });
      const projects = data?.projects || [];
      if (!projects.length) break;

      for (const project of projects) {
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

/**
 * Detail-Phase: DTVP-Detailseiten erfordern eine Anmeldung – hier nicht abrufbar.
 */
export async function fetchDetail() {
  return null;
}

export default { meta, discover, fetchDetail };
