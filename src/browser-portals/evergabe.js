import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import config from '../config.js';
import {
  saveTender,
  getTenderById,
  startCrawlLog,
  finishCrawlLog,
  getCheckpoint,
  updateCheckpoint,
} from '../db.js';
import { RateLimiter } from '../crawler/rate-limiter.js';
import { contentHash, normalizeDate, deriveStatus, normalizeCpv, parseMoneyToCents } from '../utils.js';
import { cleanDetailText, extractFactsFromDom, makeFact, makeTextSection, uniqueFacts } from '../detail-data.js';

export const meta = {
  id: 'evergabe',
  name: 'eVergabe Online (Vergabeplattform des Bundes)',
  region: 'de',
  type: 'browser',
  schedule: '0 */8 * * *',
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://www.evergabe-online.de',
};

const SEARCH_URL = 'https://www.evergabe-online.de/search.html';
const NAVIGATOR_LINK = 'a[href*="topToolbars"][href*="pageLink"]';
const ROW_SELECTOR = 'tr.even, tr.odd';
const DETAIL_REFRESH_MS = 24 * 60 * 60 * 1000;

/** Pure 24-hour refresh predicate for stored eVergabe detail data. */
export function detailDue(tender, now = Date.now()) {
  if (!tender?.detail_crawled_at || tender.detail_status !== 'complete') return true;
  const crawledAt = Date.parse(tender.detail_crawled_at);
  if (!Number.isFinite(crawledAt)) return true;
  const lastChanged = Date.parse(tender.last_changed_at || '');
  if (Number.isFinite(lastChanged) && lastChanged > crawledAt) return true;
  return now - crawledAt >= DETAIL_REFRESH_MS;
}

/** Pure target decision shared by normal discovery and detail backfills. */
export function shouldEnrichEvergabeTender({ result = {}, stored = null, now = Date.now() } = {}) {
  return Boolean(result.isNew || result.changed || detailDue(stored, now));
}

export function profileDir() {
  return path.join(config.browserProfileDir, 'evergabe');
}

/**
 * Pure Funktion: parst eine extrahierte Tabellenzeile in ein Tender-Objekt.
 * `raw` = { cells: string[], href: string|null }
 */
export function parseRow(raw) {
  if (!raw || !Array.isArray(raw.cells) || !raw.cells.length) return null;
  const href = raw.href || '';
  const idMatch = href.match(/[?&]id=(\d+)/);
  const externalId = idMatch ? idMatch[1] : null;
  if (!externalId) return null;

  const title = raw.cells[0] || 'Ohne Titel';
  const reference = raw.cells[1] || externalId;
  const deadline = normalizeDate(raw.cells[5]);
  const publicationDate = normalizeDate(raw.cells[6]);
  const status = deriveStatus(deadline, 'open');

  return {
    sourceId: 'evergabe',
    externalId: String(externalId),
    title: String(title).trim(),
    url: `${meta.baseUrl}/tenderdetails.html?id=${externalId}`,
    description: null,
    contractingAuthority: raw.cells[2] ? String(raw.cells[2]).trim() : null,
    cpvCodes: null,
    cpvLabels: null,
    estimatedValueCents: null,
    estimatedValueCurrency: 'EUR',
    placeOfPerformance: raw.cells[3] ? String(raw.cells[3]).trim() : null,
    awardCriteria: null,
    tenderType: raw.cells[4] ? String(raw.cells[4]).trim() : null,
    publicationDate,
    submissionDeadline: deadline,
    openingDate: null,
    contractDuration: null,
    documentUrl: null,
    status,
    contentHash: contentHash(externalId, reference, title, deadline, status, null),
  };
}

/**
 * Extrahiert alle Ergebniszeilen der aktuellen Seite aus dem Browser-DOM.
 */
async function extractRows(page) {
  return page.evaluate((rowSelector) => {
    const rows = [...document.querySelectorAll(rowSelector)];
    return rows.map((row) => {
      const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim());
      const link = row.querySelector('a[href*="tenderdetails"], a[href*="?id="]');
      return { cells, href: link ? link.getAttribute('href') : null };
    });
  }, ROW_SELECTOR);
}

/**
 * Sucht den Link zur nächsten Seite im Wicket-Navigator.
 * Liefert die absolute URL oder null (letzte Seite erreicht).
 */
async function getNextPageUrl(page, currentPage) {
  return page.evaluate(({ rowSelector, navLink, currentPage: cp }) => {
    const anchors = [...document.querySelectorAll(navLink)];
    const byNumber = (text) => new RegExp(`^\\s*${text}\\s*$`).test(String(text).trim());
    const next = anchors.find((a) => byNumber(a.textContent.trim()) && Number(a.textContent.trim()) === cp + 1);
    if (next) return next.getAttribute('href');
    // Fallback: "Weiter"-Pfeil im Navigator
    const arrow = anchors.find((a) => /^(\s*>\s*|\s*>>\s*|\u203A|\u00BB)$/.test(a.textContent));
    return arrow ? arrow.getAttribute('href') : null;
  }, { rowSelector: ROW_SELECTOR, navLink: NAVIGATOR_LINK, currentPage });
}

function fieldValue(text, labels) {
  for (const label of labels) {
    const match = String(text || '').match(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*(.{1,300}?)(?=\\s+(?:CPV|Vergabestelle|Angebotsfrist|Frist|Publikation|Laufzeit|Beschreibung|Auftragswert|Los)|$)`, 'i'));
    if (match?.[1]) return cleanDetailText(match[1]);
  }
  return null;
}

function isLoginPage(text) { return /(?:login|anmelden|anmeldung erforderlich|registrieren)/i.test(text) && !/(?:Verfahrensnummer|Angebotsfrist|Vergabestelle|CPV)/i.test(text); }

/** Reiner Parser für die öffentliche Bekanntmachungsseite. */
export function parseEvergabeDetailHtml(html, baseUrl = meta.baseUrl) {
  const $ = cheerio.load(String(html || ''));
  const text = cleanDetailText($('main,article,.tender-detail,.detail,.content,#content,body').first().text());
  const cpvMatches = [...text.matchAll(/(?:CPV-Codes?|CPV)[^\n:]*:?\s*([^\n(]+?)\s*\((\d{8}(?:-\d)?)\)/gi)];
  const cpvCodes = [...new Set(cpvMatches.map((match) => match[2].replace(/[^0-9]/g, '').slice(0, 8)))];
  const cpvLabels = cpvMatches.map((match) => cleanDetailText(match[1])).filter(Boolean);
  const links = $('a[href]').map((_, node) => { try { return { href: new URL($(node).attr('href'), baseUrl).toString(), text: cleanDetailText($(node).text()) }; } catch { return null; } }).get().filter(Boolean);
  const documents = links.filter((link) => /\.(?:pdf|docx?|xlsx?|zip|odt|ods)(?:$|[?#])/i.test(link.href) || /download|dokument|unterlage/i.test(`${link.href} ${link.text}`)).map((link) => ({ portalFileId: link.href, category: 'announcement', filename: link.text || link.href.split('/').pop()?.split('?')[0] || 'Dokument', sourceUrl: baseUrl, locator: { href: link.href, sourceUrl: baseUrl }, accessStatus: 'public', downloadStatus: 'not_requested' }));
  const xmlUrl = links.find((link) => /(?:bekanntmach|announcement|notice).*\.xml(?:$|[?#])|\.xml(?:$|[?#])/i.test(link.href))?.href || null;
  const documentsUrl = links.find((link) => /tenderdocuments|documents?|vergabedokument|unterlagen/i.test(`${link.href} ${link.text}`) && !/\.(?:pdf|docx?|xlsx?|zip|xml)(?:$|[?#])/i.test(link.href))?.href || null;
  const metadata = { pageKind: 'announcement', pageUrl: baseUrl, rawText: text, referenceNumber: fieldValue(text, ['Verfahrensnummer', 'Aktenzeichen']), contractingAuthority: fieldValue(text, ['Vergabestelle', 'Auftraggeber']), procedureType: fieldValue(text, ['Verfahrensart']), publicationDate: normalizeDate(fieldValue(text, ['Publikation', 'Veröffentlichung'])), submissionDeadline: normalizeDate(fieldValue(text, ['Angebotsfrist', 'Teilnahmefrist', 'Frist'])), questionDeadline: normalizeDate(fieldValue(text, ['Fragenfrist', 'Frist für Fragen'])), openingDate: normalizeDate(fieldValue(text, ['Öffnungstermin'])), contractDuration: fieldValue(text, ['Laufzeit', 'Vertragslaufzeit']), placeOfPerformance: fieldValue(text, ['Leistungsort', 'Erfüllungsort']), estimatedValue: fieldValue(text, ['Geschätzter Auftragswert', 'Auftragswert']),
  };
  const criteria = [...text.matchAll(/(?:Zuschlagskriterien|Eignungskriterien)\s*:?\s*([^\n]{1,600})/gi)].map((match, index) => ({ criterionKey: `evergabe-${contentHash(match[1]).slice(0, 24)}`, kind: /Eignung/i.test(match[0]) ? 'suitability' : 'award', title: /Eignung/i.test(match[0]) ? 'Eignungskriterien' : 'Zuschlagskriterien', description: cleanDetailText(match[1]), sourceSection: 'announcement', required: /Eignung/i.test(match[0]) ? true : null, index }));
  const lots = [...text.matchAll(/(?:Los|Lot)\s*([\w.-]+)\s*:?\s*([^\n]{3,300})/gi)].map((match) => ({ lotKey: match[1], lotNumber: match[1], title: cleanDetailText(match[2]), description: null, cpvCodes, cpvLabels, metadata: { sourceSection: 'announcement' } }));
  const facts = uniqueFacts([...extractFactsFromDom($, 'announcement', baseUrl), ...Object.entries(metadata).map(([key, value]) => makeFact({ sectionKey: 'announcement', key: `announcement:${key}`, label: key, value, normalizedValue: value, dataType: 'known_field', sourceUrl: baseUrl })).filter(Boolean)]);
  return { description: cleanDetailText($('main,article,.tender-detail,.detail,.content,#content').first().text()) || text || null, cpvCodes: cpvCodes.length ? cpvCodes : null, cpvLabels: cpvLabels.length ? cpvLabels : null, contractingAuthority: metadata.contractingAuthority, referenceNumber: metadata.referenceNumber, procedureType: metadata.procedureType, publicationDate: metadata.publicationDate, submissionDeadline: metadata.submissionDeadline, questionDeadline: metadata.questionDeadline, openingDate: metadata.openingDate, contractDuration: metadata.contractDuration, placeOfPerformance: metadata.placeOfPerformance, estimatedValueCents: metadata.estimatedValue ? parseMoneyToCents(metadata.estimatedValue) : null, estimatedValueCurrency: /GBP|USD|CHF|EUR/i.exec(metadata.estimatedValue || '')?.[0]?.toUpperCase() || 'EUR', metadata, criteria, lots, documents, xmlUrl, documentsUrl, facts, textSections: [makeTextSection({ sectionKey: 'announcement', title: 'Bekanntmachung', sourceUrl: baseUrl, text })], snapshots: [{ kind: 'evergabe:announcement', sourceUrl: baseUrl, content: String(html), mimeType: 'text/html' }], loginRequired: isLoginPage(text) };
}

function xmlLocalName(node) { return String(node?.name || '').split(':').pop().toLowerCase(); }
function xmlNodes($, names, root = $.root()) { const wanted = new Set(names.map((name) => name.toLowerCase())); return root.find('*').toArray().filter((node) => wanted.has(xmlLocalName(node))); }
function xmlText($, names, root = $.root()) { const node = xmlNodes($, names, root)[0]; return node ? cleanDetailText($(node).text()) : null; }
function xmlAbsoluteUrl(value, baseUrl) { try { return new URL(value, baseUrl).toString(); } catch { return null; } }
function xmlLotForNode($, node) { return $(node).parents().toArray().find((parent) => xmlLocalName(parent) === 'procurementprojectlot') || null; }
function xmlLotKey($, node) { const lot = xmlLotForNode($, node); return lot ? xmlText($, ['ID', 'LotNumber'], $(lot)) : null; }
function xmlParseDateTime(rawDate, rawTime = null) {
  const dateText = cleanDetailText(rawDate); const timeText = cleanDetailText(rawTime);
  const embedded = dateText.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)$/);
  if (embedded) return { date: embedded[1], dateTime: `${embedded[1]}T${embedded[2]}`, rawDate: dateText, rawTime: null };
  const date = normalizeDate(dateText); if (!date) return null;
  if (!timeText) return { date, dateTime: null, rawDate: dateText, rawTime: null };
  const time = timeText.match(/\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/)?.[0] || timeText;
  return { date, dateTime: `${date}T${time}`, rawDate: dateText, rawTime: timeText };
}
function xmlDeadlineCandidates($, root = $.root(), { lotScope = false } = {}) {
  const dateNames = new Set(['enddate', 'duedate', 'tendersubmissiondeadline', 'tendersubmissiondeadlinedate', 'questiondeadline', 'questiondeadlinedate', 'openingdate']);
  const timeNames = new Set(['endtime', 'duetime', 'tendersubmissiondeadlinetime', 'questiondeadlinetime', 'openingtime']);
  const result = [];
  for (const node of xmlNodes($, [...dateNames], root)) {
    if (!lotScope && xmlLotForNode($, node)) continue;
    const context = [node, ...$(node).parents().toArray()].map(xmlLocalName).join(' ');
    if (!/submission|deadline|question|opening|tenderingprocess|receipt|offer/.test(context)) continue;
    const parent = $(node); const nodeName = xmlLocalName(node);
    const preferredTimeNames = nodeName === 'openingdate' ? ['openingtime'] : /question/.test(context) ? ['questiondeadlinetime', 'duetime', 'endtime'] : ['tendersubmissiondeadlinetime', 'endtime', 'duetime'];
    const timeNode = parent.parent().find('*').toArray().find((candidate) => preferredTimeNames.includes(xmlLocalName(candidate)))
      || parent.parents().toArray().slice(0, 3).flatMap((ancestor) => $(ancestor).find('*').toArray()).find((candidate) => preferredTimeNames.includes(xmlLocalName(candidate)));
    const parsed = xmlParseDateTime($(node).text(), timeNode ? $(timeNode).text() : null); if (!parsed) continue;
    const kind = /question/.test(context) ? 'question' : /opening/.test(context) ? 'opening' : 'submission';
    const candidate = { kind, lotKey: lotScope ? xmlLotKey($, node) : null, sourceNode: xmlLocalName(node), ...parsed };
    const key = JSON.stringify([candidate.kind, candidate.lotKey, candidate.dateTime || candidate.date]);
    if (!result.some((item) => item.key === key)) result.push({ ...candidate, key });
  }
  return result.map(({ key, ...candidate }) => candidate);
}
function xmlScopedCpv($, root = $.root()) {
  const rootIsLot = root.toArray?.().some((node) => xmlLocalName(node) === 'procurementprojectlot');
  const codes = xmlNodes($, ['ItemClassificationCode'], root).filter((node) => rootIsLot || !xmlLotForNode($, node)).map((node) => cleanDetailText($(node).text()).replace(/[^0-9]/g, '').slice(0, 8)).filter((code) => code.length === 8);
  const labels = xmlNodes($, ['ClassificationItem', 'ClassificationItemName'], root).filter((node) => rootIsLot || !xmlLotForNode($, node)).map((node) => cleanDetailText($(node).text())).filter(Boolean);
  return normalizeCpv([...new Set(codes)], [...new Set(labels)]);
}
function xmlStructuredFact(sectionKey, key, label, value, sourceUrl, dataType = 'xml') {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return null;
  return makeFact({ sectionKey, key, label, value: typeof value === 'string' ? value : JSON.stringify(value), normalizedValue: value, dataType, sourceUrl });
}
function xmlAttribute(node, names) {
  for (const name of names) {
    const value = node?.attribs?.[name] || node?.attribs?.[`efac:${name}`] || node?.attribs?.[name.toLowerCase()];
    if (value) return cleanDetailText(value);
  }
  return null;
}
function xmlReferenceValues($, root) {
  const values = [];
  for (const name of ['OrganizationReference', 'OrganizationRef', 'OrganizationID', 'CompanyReference', 'CompanyID', 'TouchPointReference', 'TouchPointRef', 'TouchPointID', 'EndpointID']) {
    values.push(...xmlNodes($, [name], root).map((node) => cleanDetailText($(node).text())));
  }
  for (const partyIdentification of xmlNodes($, ['PartyIdentification'], root)) values.push(...xmlNodes($, ['ID'], $(partyIdentification)).map((node) => cleanDetailText($(node).text())));
  for (const node of root.toArray()) {
    for (const [key, value] of Object.entries(node.attribs || {})) {
      if (/(?:organization|touchpoint|company|party).*(?:ref|id)|(?:ref|reference)/i.test(key)) values.push(cleanDetailText(value));
    }
  }
  return [...new Set(values.filter(Boolean).map((value) => value.replace(/^#/, '')))];
}
function xmlContact($, root, technicalId = null) {
  const contact = {
    technicalId: technicalId || xmlAttribute(root.toArray()[0], ['id', 'technicalId']) || xmlText($, ['TouchPointID', 'ContactID'], root),
    name: xmlText($, ['ContactName', 'Name', 'PersonName'], root),
    email: xmlText($, ['ElectronicMail', 'ElectronicMailAddress', 'Email', 'EmailAddress'], root),
    telephone: xmlText($, ['Telephone', 'TelephoneNumber', 'Phone'], root),
    fax: xmlText($, ['Telefax', 'Fax'], root),
    role: xmlText($, ['JobTitle', 'RoleCode', 'ContactType'], root) || xmlAttribute(root.toArray()[0], ['type']) || null,
  };
  return Object.values(contact).some(Boolean) ? contact : null;
}
function isEvergabeBinaryResponse(response, headers = {}) {
  const contentType = String(headers['content-type'] || '').toLowerCase();
  const disposition = String(headers['content-disposition'] || '').toLowerCase();
  return /application\/(?:pdf|zip|x-7z-compressed|msword|vnd\.|octet-stream)|(?:^|\s)binary(?:\s|$)/i.test(contentType)
    || (/(?:attachment|inline)/i.test(disposition) && /\.(?:pdf|zip|7z|docx?|xlsx?|pptx?)(?:["';]|$)/i.test(disposition));
}
function responseHeaderMap(response) {
  const headers = typeof response?.headers === 'function' ? response.headers() : (response?.headers || {});
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
}
export async function parseEvergabeXmlResponse(response, sourceUrl = null) {
  if (!response) return { recognized: false, loginRequired: false, binary: false, parsed: null };
  const headers = responseHeaderMap(response);
  if (isEvergabeBinaryResponse(response, headers)) return { recognized: false, loginRequired: false, binary: true, parsed: null };
  let text;
  try { text = await response.text(); } catch { return { recognized: false, loginRequired: false, binary: true, parsed: null }; }
  const contentType = headers['content-type'] || '';
  if (contentType && !/(?:xml|text\/|html)/i.test(contentType)) return { recognized: false, loginRequired: false, binary: true, parsed: null };
  const loginRequired = /(?:login|anmelden|anmeldung erforderlich|registrieren)/i.test(cleanDetailText(text))
    && !/(?:ContractFolderID|ProcurementProject|TenderingProcess|Verfahrensnummer|Angebotsfrist)/i.test(text);
  if (loginRequired) return { recognized: false, loginRequired: true, binary: false, content: text, parsed: null };
  const parsed = parseEvergabeDetailXml(text, sourceUrl || (typeof response.url === 'function' ? response.url() : null));
  return { ...parsed, content: text, binary: false, recognized: Boolean(parsed.recognized), loginRequired: Boolean(parsed.loginRequired) };
}
function xmlOrganizations($) {
  const organizationsById = new Map(); const contactsById = new Map();
  const addRole = (id, role) => {
    if (!id) return;
    const organization = organizationsById.get(id) || { technicalId: id, roles: [], contacts: [] };
    if (!organization.roles.includes(role)) organization.roles.push(role);
    organizationsById.set(id, organization);
  };
  for (const node of xmlNodes($, ['Organization'])) {
    const root = $(node); const technicalId = xmlAttribute(node, ['id', 'technicalId']) || xmlText($, ['OrganizationID', 'ID'], root);
    if (!technicalId) continue;
    const companyNode = xmlNodes($, ['Company'], root)[0]; const company = companyNode ? $(companyNode) : root;
    const organization = organizationsById.get(technicalId) || { technicalId, roles: [], contacts: [] };
    organization.name ||= xmlText($, ['CompanyName', 'RegistrationName', 'Name', 'PartyName'], company);
    organization.identifier ||= xmlText($, ['CompanyIdentifier', 'CompanyID', 'EndpointID', 'ID'], company) || technicalId;
    organization.address ||= { street: xmlText($, ['StreetName', 'AddressLine'], company), city: xmlText($, ['CityName'], company), postalCode: xmlText($, ['PostalZone'], company), country: xmlText($, ['IdentificationCode', 'CountrySubentity'], company) };
    for (const touchPoint of xmlNodes($, ['TouchPoint'], root)) {
      const touchId = xmlAttribute(touchPoint, ['id', 'technicalId']) || xmlText($, ['TouchPointID', 'ContactID'], $(touchPoint)) || `${technicalId}:touchpoint:${organization.contacts.length}`;
      const contact = xmlContact($, $(touchPoint), touchId); if (!contact) continue;
      contactsById.set(touchId, contact); if (!organization.contacts.some((item) => item.technicalId === touchId)) organization.contacts.push(contact);
    }
    for (const contactNode of xmlNodes($, ['Contact'], company)) {
      const contactId = xmlAttribute(contactNode, ['id', 'technicalId']) || xmlText($, ['ContactID', 'ID'], $(contactNode)) || `${technicalId}:company-contact:${organization.contacts.length}`;
      const contact = xmlContact($, $(contactNode), contactId); if (!contact) continue;
      const known = contactsById.get(contactId); const merged = known ? Object.fromEntries(Object.keys({ ...known, ...contact }).map((key) => [key, contact[key] || known[key] || null])) : contact;
      contactsById.set(contactId, merged); if (!organization.contacts.some((item) => item.technicalId === contactId)) organization.contacts.push(merged);
    }
    organizationsById.set(technicalId, organization);
  }
  const roleDefinitions = [['BuyerCustomerParty', 'buyer'], ['Buyer', 'buyer'], ['ContractingParty', 'contracting'], ['TendererParty', 'tenderer'], ['OriginatorCustomerParty', 'originator']];
  for (const [roleName, role] of roleDefinitions) {
    for (const roleNode of xmlNodes($, [roleName])) {
      const refs = xmlReferenceValues($, $(roleNode));
      for (const ref of refs) {
        if (organizationsById.has(ref)) addRole(ref, role);
        const contact = contactsById.get(ref); if (contact) contact.role ||= role;
      }
      if (!refs.length && organizationsById.size === 1) addRole([...organizationsById.keys()][0], role);
    }
  }
  // Klassische UBL-Partys bleiben als Fallback erhalten und werden nach ihrer
  // technischen ID mit den efac:Organization-Daten zusammengeführt.
  for (const [roleName, role] of roleDefinitions) {
    for (const roleNode of xmlNodes($, [roleName])) {
      const partyNode = xmlNodes($, ['Party'], $(roleNode))[0]; if (!partyNode) continue;
      const party = $(partyNode); const refs = xmlReferenceValues($, party); const id = refs.find((ref) => organizationsById.has(ref)) || refs[0] || `party:${roleName}:${organizationsById.size}`;
      addRole(id, role); const organization = organizationsById.get(id);
      organization.name ||= xmlText($, ['RegistrationName', 'Name', 'PartyName'], party); organization.identifier ||= id;
      organization.address ||= { street: xmlText($, ['StreetName', 'AddressLine'], party), city: xmlText($, ['CityName'], party), postalCode: xmlText($, ['PostalZone'], party), country: xmlText($, ['IdentificationCode', 'CountrySubentity'], party) };
      for (const contactNode of xmlNodes($, ['Contact'], party)) {
        const contactId = xmlAttribute(contactNode, ['id', 'technicalId']) || xmlText($, ['TouchPointID', 'ContactID', 'ID'], $(contactNode)) || `${id}:contact:${organization.contacts.length}`;
        const contact = xmlContact($, $(contactNode), contactId); if (!contact) continue;
        const known = contactsById.get(contactId); const merged = known ? Object.fromEntries(Object.keys({ ...known, ...contact }).map((key) => [key, contact[key] || known[key] || null])) : contact; contactsById.set(contactId, merged);
        if (!organization.contacts.some((item) => item.technicalId === contactId)) organization.contacts.push(merged);
      }
    }
  }
  const organizations = [...organizationsById.values()].filter((item) => item.name || item.identifier || item.contacts.length);
  const contacts = [...contactsById.values()].filter((item, index, all) => all.findIndex((candidate) => candidate.technicalId === item.technicalId) === index);
  return { organizations, contacts };
}
function xmlDurations($, root = $.root()) {
  return xmlNodes($, ['ContractDuration', 'DurationPeriod', 'Period'], root).map((node) => {
    const durationRoot = $(node); const measureNode = xmlNodes($, ['DurationMeasure', 'Duration'], durationRoot)[0];
    const startDate = xmlText($, ['StartDate'], durationRoot); const endDate = xmlText($, ['EndDate'], durationRoot);
    return { measure: measureNode ? cleanDetailText($(measureNode).text()) : null, unit: measureNode?.attribs?.unitCode || measureNode?.attribs?.unit || null, startDate: startDate ? normalizeDate(startDate) || startDate : null, endDate: endDate ? normalizeDate(endDate) || endDate : null, rawStartDate: startDate, rawEndDate: endDate };
  }).filter((item) => item.measure || item.startDate || item.endDate).filter((item, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index);
}

export function parseEvergabeDetailXml(xml, sourceUrl = null) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true }); const rawText = cleanDetailText($.root().text());
  const loginRequired = /(?:login|anmelden|anmeldung erforderlich|registrieren)/i.test(rawText)
    && !/(?:ContractFolderID|ProcurementProject|TenderingProcess|Verfahrensnummer|Angebotsfrist)/i.test(rawText);
  const recognized = !loginRequired && ['ContractFolderID', 'ProcurementProject', 'TenderingProcess', 'Organizations', 'ProcurementProjectLot']
    .some((name) => xmlNodes($, [name]).length > 0);
  const organizationData = xmlOrganizations($); const globalDeadlines = xmlDeadlineCandidates($); const lotNodes = xmlNodes($, ['ProcurementProjectLot']);
  const lotDeadlines = lotNodes.flatMap((node) => xmlDeadlineCandidates($, $(node), { lotScope: true })); const deadlines = [...globalDeadlines, ...lotDeadlines];
  const globalCpv = xmlScopedCpv($); const durations = xmlDurations($);
  const metadata = { pageKind: 'notice-xml', rawText, referenceNumber: xmlText($, ['ContractFolderID']), contractingAuthority: organizationData.organizations.find((item) => item.roles?.some((role) => /buyer|contracting/.test(role)))?.name || xmlText($, ['RegistrationName', 'Name']), procedureType: xmlText($, ['ProcedureTypeCode']), publicationDate: normalizeDate(xmlText($, ['IssueDate', 'PublicationDate'])), placeOfPerformance: xmlText($, ['CityName', 'CountrySubentity']), organizations: organizationData.organizations, contacts: organizationData.contacts, deadlines, contractDurations: durations };
  const lots = lotNodes.map((node, index) => { const root = $(node); const lotNumber = xmlText($, ['ID', 'LotNumber'], root) || String(index + 1); const cpv = xmlScopedCpv($, root); const scopedDeadlines = xmlDeadlineCandidates($, root, { lotScope: true }); const estimatedValue = xmlText($, ['EstimatedOverallContractAmount', 'MaximumAmount'], root); return { lotKey: lotNumber, lotNumber, title: xmlText($, ['Name'], root), description: xmlText($, ['Description', 'Note'], root), cpvCodes: cpv.cpvCodes, cpvLabels: cpv.cpvLabels, submissionDeadline: scopedDeadlines.find((item) => item.kind === 'submission')?.date || null, metadata: { source: 'evergabe-xml', deadlines: scopedDeadlines, estimatedValue, contractDurations: xmlDurations($, root) } }; });
  const criteria = xmlNodes($, ['AwardingCriterion', 'EvaluationCriterion', 'Criterion']).map((node) => { const root = $(node); const description = xmlText($, ['Description', 'Name'], root); if (!description) return null; const weight = xmlText($, ['WeightNumeric', 'Weight'], root); const kind = /award|awarding/i.test(xmlLocalName(node)) || /award/i.test(node.attribs?.criterionTypeCode || node.attribs?.typeCode || '') ? 'award' : 'suitability'; return { criterionKey: `evergabe-xml-${contentHash(xmlLotKey($, node) || 'global', description).slice(0, 24)}`, kind, title: xmlText($, ['Name'], root) || 'Kriterium', description, weight: weight ? Number(weight.replace(',', '.')) || null : null, lotKey: xmlLotKey($, node), sourceSection: 'notice-xml' }; }).filter(Boolean);
  const documents = xmlNodes($, ['AdditionalDocumentReference', 'DocumentReference']).map((node) => { const uri = xmlText($, ['URI'], $(node)); if (!uri) return null; const href = xmlAbsoluteUrl(uri, sourceUrl); return { portalFileId: href || uri, category: 'tenderdocuments', filename: xmlText($, ['DocumentDescription', 'ID'], $(node)) || (href || uri).split('/').pop() || 'Dokument', sourceUrl, locator: { href: href || uri, sourceUrl }, accessStatus: 'public', downloadStatus: 'not_requested' }; }).filter(Boolean);
  const submission = globalDeadlines.find((item) => item.kind === 'submission'); const question = globalDeadlines.find((item) => item.kind === 'question'); const opening = globalDeadlines.find((item) => item.kind === 'opening');
  const facts = uniqueFacts([...Object.entries(metadata).map(([key, value]) => xmlStructuredFact('notice-xml', `evergabe:xml:${key}`, key, value, sourceUrl)), ...deadlines.map((value, index) => xmlStructuredFact('notice-xml', `evergabe:deadline:${index}`, `${value.kind}${value.lotKey ? ` Los ${value.lotKey}` : ''}`, value, sourceUrl, 'date-time')), ...organizationData.organizations.map((value, index) => xmlStructuredFact('notice-xml', `evergabe:organization:${index}`, `Organisation ${index + 1}`, value, sourceUrl, 'organization')), ...organizationData.contacts.map((value, index) => xmlStructuredFact('notice-xml', `evergabe:contact:${index}`, `Kontakt ${index + 1}`, value, sourceUrl, 'contact')), ...durations.map((value, index) => xmlStructuredFact('notice-xml', `evergabe:duration:${index}`, `Laufzeit ${index + 1}`, value, sourceUrl, 'duration'))].filter(Boolean));
  return { description: xmlText($, ['ProcurementProjectDescription', 'Description', 'Note']) || rawText || null, contractingAuthority: metadata.contractingAuthority, referenceNumber: metadata.referenceNumber, procedureType: metadata.procedureType, publicationDate: metadata.publicationDate, submissionDeadline: submission?.date || null, questionDeadline: question?.date || null, openingDate: opening?.date || null, contractDuration: durations[0] ? [durations[0].measure, durations[0].unit].filter(Boolean).join(' ') : null, placeOfPerformance: metadata.placeOfPerformance, cpvCodes: globalCpv.cpvCodes, cpvLabels: globalCpv.cpvLabels, lots, criteria, documents, facts, metadata, recognized, loginRequired, textSections: [makeTextSection({ sectionKey: 'notice-xml', title: 'Bekanntmachungs-XML', sourceUrl, text: rawText })], snapshots: [{ kind: 'evergabe:notice-xml', sourceUrl, content: String(xml), mimeType: 'application/xml' }] };
}

export function parseEvergabeDocumentsHtml(html, baseUrl) {
  const $ = cheerio.load(String(html || '')); const documents = [];
  $('a[href]').each((_, node) => { const href = $(node).attr('href'); const label = cleanDetailText($(node).text()); if (!href) return; let absolute; try { absolute = new URL(href, baseUrl).toString(); } catch { return; } if (!/(?:download|document|file|unterlage|dokument|archive|gesamt|zip)|\.(?:pdf|docx?|xlsx?|zip|odt|ods|txt)(?:$|[?#])/i.test(`${absolute} ${label}`)) return; const filename = label || absolute.split('/').pop()?.split('?')[0] || 'Dokument'; if (!documents.some((item) => item.portalFileId === absolute && item.filename === filename)) documents.push({ portalFileId: absolute, category: /archive|gesamt|zip/i.test(`${absolute} ${label}`) ? 'archive' : 'tenderdocuments', filename, mimeType: /zip/i.test(`${absolute} ${label}`) ? 'application/zip' : null, sourceUrl: baseUrl, locator: { href: absolute, sourceUrl: baseUrl }, accessStatus: 'public', downloadStatus: 'not_requested' }); });
  const text = cleanDetailText($('body').text()); return { documents, loginRequired: isLoginPage(text), textSection: makeTextSection({ sectionKey: 'tenderdocuments', title: 'Vergabeunterlagen', sourceUrl: baseUrl, text, status: isLoginPage(text) ? 'login_required' : 'complete' }), snapshot: { kind: 'evergabe:tenderdocuments', sourceUrl: baseUrl, content: String(html), mimeType: 'text/html' } };
}

async function extractEvergabeDetailBundle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(config.browserPageWaitMs);
  const detail = parseEvergabeDetailHtml(await page.content(), page.url()); const bundle = { metadata: { portal: 'evergabe', ...detail.metadata }, crawlKind: 'full', fullCrawlSucceeded: true, lots: [...detail.lots], criteria: [...detail.criteria], documents: [...detail.documents], messages: [], snapshots: [...detail.snapshots], textSections: [...detail.textSections], facts: [...detail.facts], completeness: { overall: 'partial', sections: {} } };
  bundle.completeness.sections.overview = detail.loginRequired ? 'login_required' : (detail.description ? 'complete' : 'unknown_structure');
  if (detail.xmlUrl) { const documentsUrl = detail.documentsUrl; try { const xmlResponse = await page.goto(detail.xmlUrl, { waitUntil: 'domcontentloaded' }); const xmlResult = await parseEvergabeXmlResponse(xmlResponse, typeof xmlResponse?.url === 'function' ? xmlResponse.url() : page.url()); if (xmlResult.parsed || xmlResult.recognized) { const parsed = xmlResult.parsed || xmlResult; Object.assign(detail, parsed, { xmlUrl: detail.xmlUrl, documentsUrl }); bundle.metadata = { ...bundle.metadata, ...parsed.metadata }; bundle.lots.push(...parsed.lots); bundle.documents.push(...parsed.documents); bundle.facts.push(...parsed.facts); bundle.textSections.push(...parsed.textSections); if (!xmlResult.binary) bundle.snapshots.push(...(parsed.snapshots || [])); } bundle.completeness.sections.xml = xmlResult.loginRequired ? 'login_required' : (xmlResult.recognized ? 'complete' : 'unknown_structure'); if (xmlResult.loginRequired) bundle.metadata.loginRequired = true; } catch (error) { bundle.completeness.sections.xml = `temporary_error:${error.message}`; } } else bundle.completeness.sections.xml = 'not_offered';
  if (detail.documentsUrl) { try { await page.goto(detail.documentsUrl, { waitUntil: 'domcontentloaded' }); const parsed = parseEvergabeDocumentsHtml(await page.content(), page.url()); bundle.documents.push(...parsed.documents); bundle.textSections.push(parsed.textSection); bundle.snapshots.push(parsed.snapshot); bundle.completeness.sections.documents = parsed.loginRequired ? 'login_required' : (parsed.documents.length ? 'complete' : 'empty'); if (parsed.loginRequired) bundle.metadata.loginRequired = true; } catch (error) { bundle.completeness.sections.documents = `temporary_error:${error.message}`; } } else bundle.completeness.sections.documents = detail.documents.length ? 'complete' : 'empty';
  bundle.completeness.sections.communication = 'not_offered'; const failed = Object.values(bundle.completeness.sections).some((value) => String(value).startsWith('temporary_error') || ['login_required', 'unknown_structure'].includes(value)); bundle.completeness.overall = failed ? 'partial' : 'complete'; bundle.fullCrawlSucceeded = !failed; bundle.documents = bundle.documents.filter((doc, index, all) => all.findIndex((item) => item.portalFileId === doc.portalFileId && item.filename === doc.filename) === index); bundle.textSections = bundle.textSections.filter((section, index, all) => all.findIndex((item) => item.sectionKey === section.sectionKey) === index); bundle.facts = uniqueFacts(bundle.facts);
  return { ...detail, detailStatus: failed ? 'partial' : 'complete', detailCrawledAt: new Date().toISOString(), detailCompleteness: bundle.completeness, portalMetadata: bundle.metadata, detailBundle: bundle, fullCrawlSucceeded: bundle.fullCrawlSucceeded };
}

/**
 * Führt den eVergabe-Browser-Crawl aus.
 * - mode 'backfill': läuft bis zum 24-Monats-Stichtag, Checkpoint wird gesetzt
 * - mode 'incremental': stoppt nach mehreren vollständig bekannten Seiten
 */
export async function runEvergabeJob({ job, onProgress = () => {} } = {}) {
  const checkpoint = getCheckpoint('evergabe');
  const mode = job?.mode === 'detail_backfill' ? 'detail_backfill' : (checkpoint.backfill_complete ? 'incremental' : 'backfill');
  const log = startCrawlLog('evergabe');
  const stats = {
    pagesDone: 0,
    itemsDiscovered: 0,
    itemsNew: 0,
    itemsChanged: 0,
    knownStreak: checkpoint.known_page_streak || 0,
    oldestPublicationDate: checkpoint.oldest_publication_date || null,
    mode,
  };

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - config.evergabeBackfillMonths);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  fs.mkdirSync(config.browserProfileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir(), {
    headless: config.browserHeadless,
    viewport: { width: 1440, height: 900 },
    locale: 'de-DE',
    userAgent: config.userAgent,
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    // Startseite + Suche laden, Wicket initialisieren lassen
    await page.goto(meta.baseUrl + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.browserPageWaitMs);
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('select[name=rowsPerPageChoice]', { timeout: 60000 });
    await page.waitForTimeout(config.browserPageWaitMs);

    // Seitengröße auf 100 Ergebnisse setzen und abwarten
    await page.selectOption('select[name=rowsPerPageChoice]', '3');
    await page.waitForFunction(
      (rowSelector) => document.querySelectorAll(rowSelector).length >= 100,
      ROW_SELECTOR,
      { timeout: 30000 }
    );

    let pageNumber = 1;
    let backfillDone = false;
    let incrementalDone = false;
    const detailTargets = new Map();

    while (true) {
      if (job?.cancel_requested) {
        throw Object.assign(new Error('Job wurde abgebrochen'), { cancelled: true });
      }

      const rows = await extractRows(page);
      if (!rows.length) {
        throw new Error('eVergabe: keine Ergebniszeilen gefunden – DOM/Selektor geändert?');
      }

      let pageAllKnown = true;
      for (const raw of rows) {
        const tender = parseRow(raw);
        if (!tender) continue;
        stats.itemsDiscovered += 1;
        const result = saveTender(tender);
        if (result.isNew) {
          stats.itemsNew += 1;
        } else if (result.changed) {
          stats.itemsChanged += 1;
        }
        const stored = getTenderById(result.tenderId);
        if (shouldEnrichEvergabeTender({ result, stored })) detailTargets.set(result.tenderId, { id: result.tenderId, url: tender.url });
        if (result.isNew || result.changed) pageAllKnown = false;
        if (tender.publicationDate && (!stats.oldestPublicationDate || tender.publicationDate < stats.oldestPublicationDate)) {
          stats.oldestPublicationDate = tender.publicationDate;
        }
      }
      stats.pagesDone += 1;
      stats.knownStreak = pageAllKnown ? stats.knownStreak + 1 : 0;

      backfillDone = mode === 'backfill' && Boolean(stats.oldestPublicationDate) && stats.oldestPublicationDate < cutoffIso;
      incrementalDone = mode === 'incremental' && stats.knownStreak >= config.evergabeKnownPageStop;

      // Im inkrementellen Modus darf der Backfill-Status nicht zurückgesetzt werden
      updateCheckpoint('evergabe', {
        backfillComplete: mode === 'backfill' ? (backfillDone ? 1 : 0) : undefined,
        oldestPublicationDate: stats.oldestPublicationDate,
        lastPageKey: String(pageNumber),
        knownPageStreak: stats.knownStreak,
      });
      onProgress({ ...stats, pageNumber, backfillDone, incrementalDone });

      if (backfillDone || incrementalDone) break;

      const nextUrl = await getNextPageUrl(page, pageNumber);
      if (!nextUrl) {
        // Ende der Ergebnisliste erreicht → Backfill ist vollständig abgearbeitet
        if (['backfill', 'detail_backfill'].includes(mode)) {
          backfillDone = true;
          updateCheckpoint('evergabe', {
            backfillComplete: 1,
            oldestPublicationDate: stats.oldestPublicationDate,
            lastPageKey: String(pageNumber),
            knownPageStreak: stats.knownStreak,
          });
          onProgress({ ...stats, pageNumber, backfillDone, incrementalDone });
        }
        break;
      }

      await page.goto(new URL(nextUrl, SEARCH_URL).toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(ROW_SELECTOR, { timeout: 45000 });
      await page.waitForTimeout(config.browserPageWaitMs);
      pageNumber += 1;
    }

    // Neue, geänderte, unvollständige und fällige Tender werden angereichert.
    // Die eVergabe-Bekanntmachungsseite, XML und tenderdocuments sind anonym
    // lesbar; verlinkte PDF/ZIP/Office-Dateien werden nicht geöffnet.
    let enriched = 0;
    if (detailTargets.size) {
      console.log(`[evergabe] Enrich: ${detailTargets.size} Tender werden im Browser angereichert …`);
      const limit = meta.rateLimit;
      const limiter = new RateLimiter(limit.maxRequests, limit.windowMs);
      const detailPage = await context.newPage();
      try {
        for (const item of detailTargets.values()) {
          if (job?.cancel_requested) break;
          try {
            await limiter.acquire();
            const detail = await extractEvergabeDetailBundle(detailPage, item.url);
            const stored = detail ? getTenderById(item.id) : null;
            if (stored) {
              saveTender({
                sourceId: stored.source_id, externalId: stored.external_id, title: stored.title, url: stored.url,
                description: detail.description || stored.description,
                contractingAuthority: detail.contractingAuthority || stored.contracting_authority,
                cpvCodes: detail.cpvCodes || (stored.cpv_codes ? JSON.parse(stored.cpv_codes) : null),
                cpvLabels: detail.cpvLabels || (stored.cpv_labels ? JSON.parse(stored.cpv_labels) : null),
                estimatedValueCents: detail.estimatedValueCents ?? stored.estimated_value_cents,
                estimatedValueCurrency: detail.estimatedValueCurrency || stored.estimated_value_currency,
                placeOfPerformance: detail.placeOfPerformance || stored.place_of_performance,
                awardCriteria: detail.awardCriteria || stored.award_criteria || detail.criteria?.filter((criterion) => criterion.kind === 'award').map((criterion) => criterion.description).join(' | ') || null,
                tenderType: detail.tenderType || stored.tender_type, procedureType: detail.procedureType || stored.procedure_type,
                referenceNumber: detail.referenceNumber || stored.reference_number, publicationDate: detail.publicationDate || stored.publication_date,
                submissionDeadline: detail.submissionDeadline || stored.submission_deadline, questionDeadline: detail.questionDeadline || stored.question_deadline,
                openingDate: detail.openingDate || stored.opening_date, contractDuration: detail.contractDuration || stored.contract_duration,
                documentUrl: detail.documentUrl || stored.document_url, status: stored.status, portalStatus: detail.portalStatus || stored.portal_status,
                detailStatus: detail.detailStatus, detailCrawledAt: detail.detailCrawledAt, detailCompleteness: detail.detailCompleteness,
                portalMetadata: detail.portalMetadata, detailBundle: detail.detailBundle, fullCrawlSucceeded: detail.fullCrawlSucceeded,
                detailCrawlKind: 'full', contentHash: stored.content_hash,
              });
              stats.detailPagesSuccess = (stats.detailPagesSuccess || 0) + 1;
              stats.documentsInventoried = (stats.documentsInventoried || 0) + (detail.detailBundle?.documents?.length || 0);
              stats.messagesInventoried = (stats.messagesInventoried || 0) + (detail.detailBundle?.messages?.length || 0);
              if (detail.detailStatus === 'complete') stats.tendersComplete = (stats.tendersComplete || 0) + 1;
              else stats.tendersPartial = (stats.tendersPartial || 0) + 1;
              if (detail.portalMetadata?.loginRequired) stats.loginRequired = (stats.loginRequired || 0) + 1;
              if (Object.values(detail.detailCompleteness?.sections || {}).some((value) => value === 'unknown_structure')) stats.unknownPortalStructure = (stats.unknownPortalStructure || 0) + 1;
              enriched += 1;
            }
          } catch (error) {
            stats.detailPagesFailed = (stats.detailPagesFailed || 0) + 1;
            console.warn(`[evergabe] Detail-Anreicherung für ${item.id} fehlgeschlagen: ${error.message}`);
          }
        }
      } finally {
        await detailPage.close().catch(() => {});
      }
    }
    stats.enriched = enriched;

    finishCrawlLog({
      id: log.id,
      status: 'completed',
      itemsDiscovered: stats.itemsDiscovered,
      itemsNew: stats.itemsNew,
      itemsChanged: stats.itemsChanged,
      errors: stats.detailPagesFailed || 0,
      errorMessage: null,
      detailPagesSuccess: stats.detailPagesSuccess,
      detailPagesFailed: stats.detailPagesFailed,
      tendersComplete: stats.tendersComplete,
      tendersPartial: stats.tendersPartial,
      documentsInventoried: stats.documentsInventoried,
      messagesInventoried: stats.messagesInventoried,
      loginRequired: stats.loginRequired,
      unknownPortalStructure: stats.unknownPortalStructure,
    });
    return { ...stats, finished: true, backfillDone, incrementalDone };
  } catch (error) {
    finishCrawlLog({
      id: log.id,
      status: 'failed',
      itemsDiscovered: stats.itemsDiscovered,
      itemsNew: stats.itemsNew,
      itemsChanged: stats.itemsChanged,
      errors: 1,
      errorMessage: error.message,
    });
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

export default {
  meta, run: runEvergabeJob, profileDir, parseRow,
  parseEvergabeDetailHtml, parseEvergabeDetailXml, parseEvergabeDocumentsHtml, parseEvergabeXmlResponse, detailDue, shouldEnrichEvergabeTender,
};
