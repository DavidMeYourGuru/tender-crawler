import * as cheerio from 'cheerio';
import { config } from '../config.js';
import { httpClient, getWithRedirects, postJson } from '../crawler/http-client.js';
import { contentHash, normalizeDate, deriveStatus, parseMoneyToCents, normalizeCpv } from '../utils.js';
import { cleanDetailText, makeFact, makeTextSection, uniqueFacts } from '../detail-data.js';

export const meta = { id: 'ted', name: 'TED (Tenders Electronic Daily)', region: 'eu', type: 'api', schedule: '0 */6 * * *', rateLimit: { maxRequests: 20, windowMs: 60000 } };
const TED_API_URL = 'https://api.ted.europa.eu/v3/notices/search';
const TED_DETAIL_URL = 'https://ted.europa.eu/de/notice';

export const TED_FIELDS = Object.freeze([
  'publication-number', 'notice-identifier', 'notice-title', 'publication-date', 'form-type', 'notice-type', 'notice-subtype', 'notice-status', 'status',
  'procedure-identifier', 'procedure-type', 'deadline-receipt-tender-date-lot', 'deadline-date-lot', 'estimated-value-lot',
  'estimated-value-cur-lot', 'buyer-name', 'organisation-name-buyer', 'classification-cpv', 'place-of-performance',
  'description-glo', 'description-proc', 'contract-duration-lot', 'award-criterion-type-lot', 'announcement-url',
]);
const TED_FIELDS_FALLBACK = ['publication-number', 'notice-title', 'publication-date', 'deadline-receipt-tender-date-lot', 'buyer-name', 'classification-cpv', 'announcement-url', 'form-type', 'notice-type', 'notice-subtype', 'notice-status', 'status'];

function asArray(value) { return value == null ? [] : (Array.isArray(value) ? value : [value]); }
function pickLang(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length ? pickLang(value[0]) : null;
  if (typeof value === 'object') {
    for (const key of ['deu', 'ger', 'eng', 'fra']) if (value[key] != null) return pickLang(value[key]);
    return pickLang(Object.values(value)[0]);
  }
  return String(value);
}
function firstValue(value) { return pickLang(asArray(value)[0]); }
function valuesOf(...values) {
  return values.flatMap((value) => asArray(value)
    .map((item) => String(pickLang(item) || '').toLowerCase().trim()))
    .filter(Boolean);
}
function noticeTypeValues(notice) {
  return valuesOf(notice?.['form-type'], notice?.formType, notice?.['notice-type'], notice?.noticeType,
    notice?.['notice-subtype'], notice?.noticeSubtype);
}
function noticeTypeGroups(notice) {
  return {
    form: valuesOf(notice?.['form-type'], notice?.formType),
    notice: valuesOf(notice?.['notice-type'], notice?.noticeType),
    subtype: valuesOf(notice?.['notice-subtype'], notice?.noticeSubtype),
  };
}

function explicitNoticeStatus(notice) {
  return firstValue(notice?.['notice-status']) || firstValue(notice?.noticeStatus)
    || firstValue(notice?.status) || firstValue(notice?.['status-code']);
}

/** Competition notices and their Change notices are active procedures. */
export function isInScopeNotice(notice) {
  const groups = noticeTypeGroups(notice);
  const values = [...groups.form, ...groups.notice, ...groups.subtype];
  if (!values.length) return false;
  const isCompetition = (value) => /competition|contract-notice|(?:^|[-_])cn(?:$|[-_])|cn-standard|cn-social|cn-desg|qu-sy|subco|pin-cfc/.test(value);
  const hasCompetitionCall = groups.form.some(isCompetition)
    || groups.notice.some(isCompetition)
    || groups.subtype.some(isCompetition);
  const hasChange = [...groups.form, ...groups.notice, ...groups.subtype]
    .some((value) => /(^|[-_])change($|[-_])|corrigendum|corrigenda/.test(value));
  // A correction is only meaningful in this scope when TED explicitly
  // identifies the related notice as a Competition/CN. A standalone
  // "change" without that association must not bypass the scope filter.
  const changeHasCompetitionParent = hasChange
    && [...groups.notice, ...groups.subtype].some(isCompetition);
  const excluded = values.some((value) => /planning|prior|result|award|completion|cont-modif|modification|veat|direct-award|pin-only/.test(value)) && !values.some((value) => /pin-cfc/.test(value));
  return !excluded && (hasCompetitionCall || changeHasCompetitionParent);
}
function noticeIdFromUrl(url) { return String(url || '').match(/(?:detail\/|notice\/)(\d{3,8}-\d{4})/)?.[1] || String(url || '').match(/notice[:/]([0-9]{3,8}-\d{4})/)?.[1] || null; }
function noticeStatus(deadline, explicitStatus = null) { return deadline ? deriveStatus(deadline, explicitStatus && /closed|cancel|ended/i.test(explicitStatus) ? 'closed' : 'open') : 'unknown'; }

export function parseV3Notice(notice, sourceId = 'ted') {
  const id = String(notice?.['publication-number'] || notice?.publicationNumber || notice?.['notice-identifier'] || '').trim();
  if (!id || !isInScopeNotice(notice)) return null;
  const explicitStatus = explicitNoticeStatus(notice);
  if (explicitStatus && /(?:cancel|closed|ended|complete|terminated|withdrawn|awarded)/i.test(explicitStatus)) return null;
  const links = notice.links || {};
  const title = pickLang(notice['notice-title']) || 'Ohne Titel';
  const deadline = normalizeDate(firstValue(notice['deadline-receipt-tender-date-lot']) || firstValue(notice['deadline-date-lot']));
  const cpv = normalizeCpv(notice['classification-cpv'], null);
  const value = firstValue(notice['estimated-value-lot']);
  const types = noticeTypeValues(notice);
  return {
    sourceId, externalId: id, title: cleanDetailText(title), url: String(links.html?.DEU || links.html?.ENG || notice['announcement-url'] || `${TED_DETAIL_URL}/-/detail/${id}`).trim(),
    description: cleanDetailText(pickLang(notice['description-glo']) || pickLang(notice['description-proc']) || '') || null,
    contractingAuthority: cleanDetailText(pickLang(notice['buyer-name']) || pickLang(notice['organisation-name-buyer']) || '') || null,
    cpvCodes: cpv.cpvCodes, cpvLabels: cpv.cpvLabels, estimatedValueCents: value == null ? null : parseMoneyToCents(String(value)), estimatedValueCurrency: firstValue(notice['estimated-value-cur-lot']) || 'EUR',
    placeOfPerformance: cleanDetailText(firstValue(notice['place-of-performance']) || '') || null, awardCriteria: null, tenderType: firstValue(notice['procedure-type']) || null, procedureType: firstValue(notice['procedure-type']) || null,
    publicationDate: normalizeDate(firstValue(notice['publication-date'])), submissionDeadline: deadline, openingDate: null, contractDuration: firstValue(notice['contract-duration-lot']) || null, documentUrl: null,
    status: noticeStatus(deadline, explicitStatus), portalStatus: types.join(', '), referenceNumber: firstValue(notice['procedure-identifier']) || null,
    contentHash: contentHash(id, title, deadline, types.join(','), value),
  };
}

async function fetchSearchPage(body, fields = TED_FIELDS) {
  try { return await postJson(TED_API_URL, { ...body, fields }, {}); }
  catch (error) {
    if (fields === TED_FIELDS_FALLBACK || !error?.response || error.response.status < 400 || error.response.status >= 500) throw error;
    console.warn(`[ted] Erweiterter Feldsatz nicht akzeptiert, verwende Fallback: ${error.message}`);
    return postJson(TED_API_URL, { ...body, fields: TED_FIELDS_FALLBACK }, {});
  }
}
function nextToken(data) { return data?.iterationNextToken || data?.nextToken || data?.pagination?.iterationNextToken || data?.pagination?.nextToken || null; }

export async function fetchAllNotices({ query, limit = 250, rateLimiter = null } = {}) {
  const notices = []; const seen = new Set(); let token = null; let page = 1; let total = null; let iteration = true;
  while (true) {
    await rateLimiter?.acquire();
    const data = await fetchSearchPage({ query, limit: Math.min(250, limit), page, paginationMode: iteration ? 'ITERATION' : 'PAGE_NUMBER', ...(token ? { iterationNextToken: token } : {}) });
    const batch = Array.isArray(data?.notices) ? data.notices : Array.isArray(data?.results) ? data.results : [];
    const countBefore = notices.length;
    const totalRaw = data?.total ?? data?.totalNoticeCount ?? data?.pagination?.total;
    if (totalRaw != null && totalRaw !== '') {
      const parsedTotal = Number(totalRaw);
      total = Number.isFinite(parsedTotal) ? parsedTotal : null;
    }
    for (const notice of batch) {
      const key = String(notice?.['publication-number'] || notice?.publicationNumber || notice?.['notice-identifier'] || JSON.stringify(notice));
      if (!seen.has(key)) { seen.add(key); notices.push(notice); }
    }
    const newToken = nextToken(data);
    if (newToken && !seen.has(`token:${newToken}`)) { seen.add(`token:${newToken}`); token = newToken; page += 1; continue; }
    token = null;
    if (notices.length === countBefore) break;
    if (batch.length && Number.isFinite(total) && total > notices.length) { iteration = false; page += 1; continue; }
    if (batch.length === Math.min(250, limit) && !Number.isFinite(total)) { iteration = false; page += 1; continue; }
    break;
  }
  return notices;
}

export async function discover({ daysBack = null, rateLimiter = null } = {}) {
  const backDays = daysBack || config.tedDaysBack; const dateFrom = new Date(); dateFrom.setDate(dateFrom.getDate() - backDays); const dateFromNum = dateFrom.toISOString().slice(0, 10).replace(/-/g, '');
  try {
    const notices = await fetchAllNotices({ query: `PD >= ${dateFromNum}`, rateLimiter });
    const tenders = notices.map((notice) => parseV3Notice(notice)).filter(Boolean);
    console.log(`[ted] ${tenders.length} laufende Competition-/Change-Bekanntmachungen seit ${dateFrom.toISOString().slice(0, 10)} gefunden.`);
    return tenders;
  } catch (error) {
    // Kein RSS-Fallback: RSS liefert keine belastbare Notice-Typinformation
    // und könnte dadurch Awards oder Planungsbekanntmachungen importieren.
    throw new Error(`TED-Abruf fehlgeschlagen: ${error.message}`);
  }
}

function localName(node) { return String(node?.name || '').split(':').pop().toLowerCase(); }
function absoluteUrl(value, baseUrl) {
  try { return new URL(value, baseUrl).toString(); } catch { return null; }
}
function elements($, names, root = $.root()) { const wanted = new Set(names.map((name) => name.toLowerCase())); return root.find('*').toArray().filter((node) => wanted.has(localName(node))); }
function firstXmlText($, names, root = $.root()) { const node = elements($, names, root)[0]; return node ? cleanDetailText($(node).text()) : null; }
function xmlTexts($, names, root = $.root()) { return elements($, names, root).map((node) => cleanDetailText($(node).text())).filter(Boolean); }
function xmlDate($, names, root = $.root()) { return normalizeDate(firstXmlText($, names, root)); }

function firstXmlAttribute($, names, attributes, root = $.root()) {
  const node = elements($, names, root)[0];
  if (!node) return null;
  for (const attribute of attributes) {
    const value = node.attribs?.[attribute] || node.attribs?.[attribute.toLowerCase()];
    if (value) return cleanDetailText(value);
  }
  return null;
}

function nearestNode($, node, predicate) {
  return $(node).parents().toArray().find((parent) => predicate(parent)) || null;
}

function lotForNode($, node) {
  return nearestNode($, node, (parent) => localName(parent) === 'procurementprojectlot');
}

function lotKeyForNode($, node) {
  const lot = lotForNode($, node);
  return lot ? firstXmlText($, ['ID', 'LotNumber'], $(lot)) : null;
}

function parseDateTime(rawDate, rawTime = null) {
  const dateText = cleanDetailText(rawDate);
  const timeText = cleanDetailText(rawTime);
  const embedded = dateText.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)$/);
  if (embedded) return { date: embedded[1], dateTime: `${embedded[1]}T${embedded[2]}`, rawDate: dateText, rawTime: null };
  const date = normalizeDate(dateText);
  if (!date) return null;
  if (!timeText) return { date, dateTime: null, rawDate: dateText, rawTime: null };
  const time = timeText.match(/\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/)?.[0] || timeText;
  return { date, dateTime: `${date}T${time}`, rawDate: dateText, rawTime: timeText };
}

function deadlineCandidates($, root = $.root(), { lotScope = false } = {}) {
  const dateNames = new Set(['enddate', 'duedate', 'tendersubmissiondeadline', 'tendersubmissiondeadlinedate', 'questiondeadline', 'questiondeadlinedate', 'openingdate']);
  const timeNames = new Set(['endtime', 'duetime', 'tendersubmissiondeadlinetime', 'questiondeadlinetime', 'openingtime']);
  const result = [];
  for (const node of elements($, [...dateNames], root)) {
    if (!lotScope && lotForNode($, node)) continue;
    const ancestors = [node, ...$(node).parents().toArray()];
    const context = ancestors.map(localName).join(' ');
    const nodeName = localName(node);
    const hasDeadlineContext = /submission|deadline|question|opening|tenderingprocess|receipt|offer/.test(context);
    if (!hasDeadlineContext) continue;
    const rawDate = cleanDetailText($(node).text());
    const parent = $(node).parent();
    const preferredTimeNames = nodeName === 'openingdate' ? ['openingtime']
      : /question/.test(context) ? ['questiondeadlinetime', 'duetime', 'endtime']
        : ['tendersubmissiondeadlinetime', 'endtime', 'duetime'];
    const timeNode = parent.find('*').toArray().find((candidate) => preferredTimeNames.includes(localName(candidate)))
      || $(node).parents().toArray().slice(0, 3).flatMap((ancestor) => $(ancestor).find('*').toArray()).find((candidate) => preferredTimeNames.includes(localName(candidate)));
    const parsed = parseDateTime(rawDate, timeNode ? $(timeNode).text() : null);
    if (!parsed) continue;
    const kind = /question/.test(context) ? 'question' : /opening/.test(context) ? 'opening' : 'submission';
    const lotKey = lotScope ? (lotKeyForNode($, node) || null) : null;
    const candidate = { kind, lotKey, ...parsed, sourceNode: nodeName };
    const key = JSON.stringify([candidate.kind, candidate.lotKey, candidate.dateTime || candidate.date, candidate.rawTime]);
    if (!result.some((item) => item.key === key)) result.push({ ...candidate, key });
  }
  return result.map(({ key, ...candidate }) => candidate);
}

function scopedCpv($, root = $.root()) {
  const rootIsLot = root.toArray?.().some((node) => localName(node) === 'procurementprojectlot');
  const codes = elements($, ['ItemClassificationCode'], root)
    .filter((node) => rootIsLot || !lotForNode($, node))
    .map((node) => cleanDetailText($(node).text()).replace(/[^0-9]/g, '').slice(0, 8)).filter((value) => value.length === 8);
  const labels = elements($, ['ClassificationItem', 'ClassificationItemName'], root)
    .filter((node) => rootIsLot || !lotForNode($, node))
    .map((node) => cleanDetailText($(node).text())).filter(Boolean);
  return normalizeCpv([...new Set(codes)], [...new Set(labels)]);
}

function parseContact($, root) {
  const name = firstXmlText($, ['ContactName', 'Name', 'PersonName'], root);
  const email = firstXmlText($, ['ElectronicMail', 'ElectronicMailAddress', 'Email', 'EmailAddress'], root);
  const telephone = firstXmlText($, ['Telephone', 'TelephoneNumber', 'Phone'], root);
  const fax = firstXmlText($, ['Telefax', 'Fax'], root);
  const role = firstXmlText($, ['JobTitle', 'RoleCode', 'ContactType'], root) || root.attr?.('type') || null;
  const technicalId = root.attr?.('id') || root.attr?.('efac:id') || root.attr?.('ID') || firstXmlText($, ['TouchPointID', 'ContactID'], root);
  if (!name && !email && !telephone && !fax) return null;
  return { technicalId: technicalId || null, name, email, telephone, fax, role };
}

function parseOrganizations($) {
  const organizationsById = new Map();
  const contactsById = new Map();
  const roleRefs = [];
  const valuesFromNode = (root, names) => {
    const values = elements($, names, root).map((node) => cleanDetailText($(node).text()));
    for (const node of elements($, ['PartyIdentification'], root)) values.push(...elements($, ['ID'], $(node)).map((item) => cleanDetailText($(item).text())));
    for (const node of root.toArray()) {
      for (const [key, value] of Object.entries(node.attribs || {})) {
        if (/(?:organization|touchpoint|company|party).*(?:ref|id)|(?:ref|reference)/i.test(key)) values.push(cleanDetailText(value));
      }
    }
    return [...new Set(values.filter(Boolean).map((value) => value.replace(/^#/, '')))];
  };
  const addRole = (id, role) => {
    if (!id) return;
    const entry = organizationsById.get(id) || { technicalId: id, roles: [], contacts: [] };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    organizationsById.set(id, entry);
  };
  for (const node of elements($, ['Organization'])) {
    const root = $(node); const technicalId = node.attribs?.['efac:id'] || node.attribs?.id || firstXmlText($, ['OrganizationID', 'ID'], root);
    if (!technicalId) continue;
    const company = elements($, ['Company'], root)[0] ? $(elements($, ['Company'], root)[0]) : root;
    const existing = organizationsById.get(technicalId) || { technicalId, roles: [], contacts: [] };
    existing.name = firstXmlText($, ['CompanyName', 'RegistrationName', 'Name', 'PartyName'], company) || existing.name || null;
    existing.identifier = firstXmlText($, ['CompanyIdentifier', 'CompanyID', 'EndpointID', 'ID'], company) || existing.identifier || technicalId;
    existing.address = { street: firstXmlText($, ['StreetName', 'AddressLine'], company), city: firstXmlText($, ['CityName'], company), postalCode: firstXmlText($, ['PostalZone'], company), country: firstXmlText($, ['IdentificationCode', 'CountrySubentity'], company) };
    for (const touchPoint of elements($, ['TouchPoint'], root)) {
      const touchRoot = $(touchPoint); const contact = parseContact($, touchRoot); if (!contact) continue;
      const touchId = touchPoint.attribs?.['efac:id'] || touchPoint.attribs?.id || contact.technicalId || `${technicalId}:touchpoint:${existing.contacts.length}`;
      contact.technicalId = touchId; contact.role = contact.role || touchPoint.attribs?.['efac:type'] || touchPoint.attribs?.type || null;
      contactsById.set(touchId, contact); if (!existing.contacts.some((item) => item.technicalId === touchId)) existing.contacts.push(contact);
    }
    for (const contactNode of elements($, ['Contact'], company)) {
      const contactRoot = $(contactNode);
      const contactId = contactRoot.attr?.('id') || contactRoot.attr?.('efac:id') || firstXmlText($, ['ContactID', 'ID'], contactRoot) || `${technicalId}:company-contact:${existing.contacts.length}`;
      const contact = parseContact($, contactRoot); if (!contact) continue;
      contact.technicalId = contactId;
      const known = contactsById.get(contactId);
      const merged = known ? Object.fromEntries(Object.keys({ ...known, ...contact }).map((key) => [key, contact[key] || known[key] || null])) : contact;
      contactsById.set(contactId, merged); if (!existing.contacts.some((item) => item.technicalId === contactId)) existing.contacts.push(merged);
    }
    organizationsById.set(technicalId, existing);
  }
  for (const role of ['BuyerCustomerParty', 'ContractingParty', 'TendererParty', 'OriginatorCustomerParty']) {
    for (const node of elements($, [role])) {
      const roleName = role.replace(/CustomerParty|Party/g, '').toLowerCase() || 'party';
      const refs = valuesFromNode($(node), ['OrganizationID', 'OrganizationRef', 'CompanyID', 'TouchPointID', 'EndpointID', 'ID']);
      roleRefs.push(...refs.map((id) => ({ id, role: roleName })));
      for (const ref of refs) addRole(ref, roleName);
    }
  }
  for (const ref of roleRefs) {
    const organization = organizationsById.get(ref.id);
    if (organization && !organization.roles.includes(ref.role)) organization.roles.push(ref.role);
  }
  // Fallback für klassische UBL-Party-Strukturen, wenn keine efac Company
  // zugeordnet werden konnte.
  for (const role of ['BuyerCustomerParty', 'ContractingParty', 'TendererParty', 'OriginatorCustomerParty']) {
    for (const node of elements($, [role])) {
      const party = elements($, ['Party'], $(node))[0]; if (!party) continue;
      const root = $(party); const id = firstXmlText($, ['CompanyID', 'EndpointID', 'ID'], root) || `party:${role}:${organizationsById.size}`;
      const existing = organizationsById.get(id) || { technicalId: id, roles: [], contacts: [] };
      addRole(id, role.replace(/CustomerParty|Party/g, '').toLowerCase() || 'party');
      const merged = organizationsById.get(id);
      merged.name ||= firstXmlText($, ['RegistrationName', 'Name', 'PartyName'], root);
      merged.identifier ||= id;
      merged.address ||= { street: firstXmlText($, ['StreetName', 'AddressLine'], root), city: firstXmlText($, ['CityName'], root), postalCode: firstXmlText($, ['PostalZone'], root), country: firstXmlText($, ['IdentificationCode', 'CountrySubentity'], root) };
      for (const contactNode of elements($, ['Contact'], root)) {
        const contact = parseContact($, $(contactNode)); if (!contact) continue;
        const contactId = contact.technicalId || `${id}:contact:${merged.contacts.length}`; contact.technicalId = contactId; contactsById.set(contactId, contact);
        if (!merged.contacts.some((item) => item.technicalId === contactId)) merged.contacts.push(contact);
      }
      organizationsById.set(id, { ...existing, ...merged });
    }
  }
  const organizations = [...organizationsById.values()].filter((organization) => organization.name || organization.identifier || organization.contacts.length);
  const contacts = [...contactsById.values()].filter((contact, index, all) => all.findIndex((candidate) => candidate.technicalId === contact.technicalId) === index);
  return { organizations, contacts };
}

function parseDurations($, root = $.root()) {
  const durations = [];
  for (const node of elements($, ['ContractDuration', 'DurationPeriod', 'Period'], root)) {
    const root = $(node);
    const measureNode = elements($, ['DurationMeasure', 'Duration'], root)[0];
    const measure = measureNode ? cleanDetailText($(measureNode).text()) : null;
    const unit = measureNode?.attribs?.unitCode || measureNode?.attribs?.unit || null;
    const startDate = firstXmlText($, ['StartDate'], root);
    const endDate = firstXmlText($, ['EndDate'], root);
    if (!measure && !startDate && !endDate) continue;
    durations.push({ measure, unit, startDate: startDate ? normalizeDate(startDate) || startDate : null, endDate: endDate ? normalizeDate(endDate) || endDate : null, rawStartDate: startDate, rawEndDate: endDate });
  }
  return durations.filter((duration, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(duration)) === index);
}

function structuredXmlFact(sectionKey, key, label, value, sourceUrl, dataType = 'xml') {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return null;
  const serialised = typeof value === 'string' ? value : JSON.stringify(value);
  return makeFact({ sectionKey, key, label, value: serialised, normalizedValue: value, dataType, sourceUrl });
}

export function parseTedXml(xml, sourceUrl = null, noticeId = null) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const text = cleanDetailText($.root().text());
  const noticeType = firstXmlText($, ['NoticeTypeCode']);
  const formType = firstXmlAttribute($, ['NoticeTypeCode'], ['listName', 'listname', 'listURI', 'listUri']) || noticeType;
  const organizationData = parseOrganizations($);
  const globalDeadlines = deadlineCandidates($);
  const lotNodes = elements($, ['ProcurementProjectLot']);
  const lotDeadlines = lotNodes.flatMap((node) => deadlineCandidates($, $(node), { lotScope: true }));
  const deadlines = [...globalDeadlines, ...lotDeadlines];
  const globalCpv = scopedCpv($);
  const lotCpv = (node) => scopedCpv($, $(node));
  const durations = parseDurations($);
  const metadata = {
    portal: 'ted', noticeId, noticeType, formType,
    noticeSubtype: firstXmlText($, ['SubTypeCode']),
    procedureIdentifier: firstXmlText($, ['ContractFolderID']),
    procedureType: firstXmlText($, ['ProcedureTypeCode']),
    legalBasis: firstXmlText($, ['RegulatoryDomain']),
    publicationDate: xmlDate($, ['IssueDate', 'PublicationDate']),
    organizations: organizationData.organizations,
    contacts: organizationData.contacts,
    deadlines,
    contractDurations: durations,
  };
  const lots = lotNodes.map((node, index) => {
    const root = $(node);
    const lotNumber = firstXmlText($, ['ID', 'LotNumber'], root) || String(index + 1);
    const scopedDeadlines = deadlineCandidates($, root, { lotScope: true });
    const cpv = lotCpv(node);
    const estimatedValue = firstXmlText($, ['EstimatedOverallContractAmount', 'MaximumAmount'], root);
    return {
      lotKey: lotNumber, lotNumber, title: firstXmlText($, ['Name'], root),
      description: firstXmlText($, ['Description', 'Note'], root),
      cpvCodes: cpv.cpvCodes, cpvLabels: cpv.cpvLabels,
      submissionDeadline: scopedDeadlines.find((deadline) => deadline.kind === 'submission')?.date || null,
      metadata: { source: 'ted-xml', deadlines: scopedDeadlines, estimatedValue, contractDurations: parseDurations($, root) },
      criteria: elements($, ['AwardingCriterion', 'EvaluationCriterion', 'Criterion'], root).map((criterion) => firstXmlText($, ['Name', 'Description'], $(criterion))).filter(Boolean),
    };
  });
  const criteria = elements($, ['AwardingCriterion', 'EvaluationCriterion', 'Criterion']).map((node) => {
    const root = $(node);
    const description = firstXmlText($, ['Description', 'Name'], root);
    if (!description) return null;
    const weightText = firstXmlText($, ['WeightNumeric', 'Weight'], root);
    const lotKey = lotKeyForNode($, node);
    return {
      criterionKey: `ted-${contentHash(lotKey || 'global', description).slice(0, 24)}`,
      kind: /award|awarding/i.test(localName(node)) || /award/i.test(node.attribs?.['criterionTypeCode'] || node.attribs?.typeCode || '') ? 'award' : 'suitability',
      title: firstXmlText($, ['Name'], root) || 'Kriterium', description,
      weight: weightText ? Number(String(weightText).replace(',', '.')) || null : null,
      lotKey: lotKey || null, sourceSection: 'ted-xml',
    };
  }).filter(Boolean);
  const documents = [];
  for (const node of elements($, ['AdditionalDocumentReference', 'DocumentReference'])) {
    const uri = firstXmlText($, ['URI'], $(node));
    if (!uri) continue;
    const href = absoluteUrl(uri, sourceUrl || 'https://ted.europa.eu');
    documents.push({ portalFileId: href || uri, category: 'ted-external', filename: firstXmlText($, ['DocumentDescription', 'ID'], $(node)) || (href || uri).split('/').pop()?.split('?')[0] || 'Dokument', sourceUrl, locator: { href: href || uri, sourceUrl }, accessStatus: 'public', downloadStatus: 'not_requested' });
  }
  if (noticeId) documents.push({ portalFileId: `ted-xml:${noticeId}`, category: 'notice_xml', filename: `${noticeId}.xml`, mimeType: 'application/xml', sourceUrl, locator: { href: sourceUrl, format: 'xml' }, accessStatus: 'public', downloadStatus: 'not_requested' });
  const submission = globalDeadlines.find((deadline) => deadline.kind === 'submission') || null;
  const estimatedValue = firstXmlText($, ['EstimatedOverallContractAmount', 'PayableAmount']);
  const facts = uniqueFacts([
    ...Object.entries(metadata).map(([key, value]) => structuredXmlFact('ted-xml', `ted:${key}`, key, value, sourceUrl)),
    ...deadlines.map((deadline, index) => structuredXmlFact('ted-xml', `ted:deadline:${index}`, `${deadline.kind}${deadline.lotKey ? ` Los ${deadline.lotKey}` : ''}`, deadline, sourceUrl, 'date-time')),
    ...organizationData.organizations.map((organization, index) => structuredXmlFact('ted-xml', `ted:organization:${index}`, `Organisation ${index + 1}`, organization, sourceUrl, 'organization')),
    ...organizationData.contacts.map((contact, index) => structuredXmlFact('ted-xml', `ted:contact:${index}`, `Kontakt ${index + 1}`, contact, sourceUrl, 'contact')),
    ...durations.map((duration, index) => structuredXmlFact('ted-xml', `ted:duration:${index}`, `Laufzeit ${index + 1}`, duration, sourceUrl, 'duration')),
  ].filter(Boolean));
  const description = firstXmlText($, ['ProcurementProjectDescription', 'Description', 'Note']) || text;
  const authority = organizationData.organizations.find((organization) => organization.roles?.some((role) => /buyer|contracting/.test(role)))?.name || firstXmlText($, ['RegistrationName']);
  return {
    description, contractingAuthority: authority || null, cpvCodes: globalCpv.cpvCodes, cpvLabels: globalCpv.cpvLabels,
    submissionDeadline: submission?.date || null, estimatedValueCents: estimatedValue ? parseMoneyToCents(estimatedValue) : null,
    estimatedValueCurrency: firstXmlText($, ['CurrencyID']) || 'EUR', procedureType: metadata.procedureType,
    tenderType: metadata.legalBasis, portalStatus: metadata.noticeType, metadata, lots, criteria, documents,
    messages: [], facts, textSections: [makeTextSection({ sectionKey: 'ted-xml', title: 'TED XML', sourceUrl, text })],
    snapshot: { kind: 'ted:xml', sourceUrl, content: String(xml), mimeType: 'application/xml' },
  };
}

function parseTedHtml(html, sourceUrl) { const $ = cheerio.load(String(html || '')); const text = cleanDetailText($('main,article,#content,.notice-content,body').first().text()); const documents = $('a[href]').map((_, node) => { try { const href = new URL($(node).attr('href'), sourceUrl).toString(); const label = cleanDetailText($(node).text()); if (!/\.(?:pdf|docx?|xlsx?|zip|odt)(?:$|[?#])/i.test(href) && !/document|annex|unterlage/i.test(`${href} ${label}`)) return null; return { portalFileId: href, category: 'ted-html', filename: label || href.split('/').pop()?.split('?')[0] || 'Dokument', sourceUrl, locator: { href, sourceUrl }, accessStatus: 'public', downloadStatus: 'not_requested' }; } catch { return null; } }).get().filter(Boolean); return { description: text || null, documents, textSections: [makeTextSection({ sectionKey: 'ted-html', title: 'TED HTML', sourceUrl, text })], snapshot: { kind: 'ted:html', sourceUrl, content: String(html), mimeType: 'text/html' } }; }

export async function fetchDetailBundle(url, { rateLimiter = null, crawlKind = 'full', fullCrawlSucceeded = true } = {}) {
  const noticeId = noticeIdFromUrl(url); if (!noticeId) return null;
  const bundle = { metadata: { portal: 'ted', noticeId, overviewUrl: url }, crawlKind, fullCrawlSucceeded, lots: [], criteria: [], documents: [], messages: [], snapshots: [], textSections: [], facts: [], completeness: { overall: 'partial', sections: {} } }; let parsedXml = null;
  try { await rateLimiter?.acquire(); const response = await getWithRedirects(`${TED_DETAIL_URL}/${noticeId}/xml`, { rejectBinary: true }, 5); const xml = String(response.data || ''); parsedXml = parseTedXml(xml, `${TED_DETAIL_URL}/${noticeId}/xml`, noticeId); bundle.metadata = { ...bundle.metadata, ...parsedXml.metadata }; bundle.lots.push(...parsedXml.lots); bundle.criteria.push(...parsedXml.criteria); bundle.documents.push(...parsedXml.documents); bundle.facts.push(...parsedXml.facts); bundle.textSections.push(...parsedXml.textSections); bundle.snapshots.push(parsedXml.snapshot); bundle.completeness.sections.xml = /<\?xml|<(?:[^:>]+:)?(?:notice|contractnotice|ted_export|form_section)\b/i.test(xml) && parsedXml.description ? 'complete' : 'unknown_structure'; }
  catch (error) { bundle.completeness.sections.xml = `temporary_error:${error.message}`; }
  try { await rateLimiter?.acquire(); const response = await getWithRedirects(`${TED_DETAIL_URL}/${noticeId}/html`, { rejectBinary: true }, 5); const parsedHtml = parseTedHtml(String(response.data || ''), `${TED_DETAIL_URL}/${noticeId}/html`); if (parsedHtml.description && (!parsedXml?.description || parsedXml.description.length < parsedHtml.description.length)) parsedXml = { ...(parsedXml || {}), description: parsedHtml.description }; bundle.documents.push(...parsedHtml.documents); bundle.textSections.push(...parsedHtml.textSections); bundle.snapshots.push(parsedHtml.snapshot); bundle.completeness.sections.html = parsedHtml.description ? 'complete' : 'unknown_structure'; }
  catch (error) { bundle.completeness.sections.html = `temporary_error:${error.message}`; }
  bundle.completeness.sections.documents = bundle.documents.length ? 'complete' : 'empty'; bundle.completeness.sections.communication = 'not_offered'; const failed = Object.values(bundle.completeness.sections).some((status) => String(status).startsWith('temporary_error') || ['unknown_structure', 'login_required'].includes(status)); bundle.completeness.overall = failed ? 'partial' : 'complete'; bundle.fullCrawlSucceeded = Boolean(fullCrawlSucceeded && !failed); bundle.documents = bundle.documents.filter((doc, index, all) => all.findIndex((candidate) => candidate.portalFileId === doc.portalFileId && candidate.filename === doc.filename) === index); bundle.textSections = bundle.textSections.filter((section, index, all) => all.findIndex((candidate) => candidate.sectionKey === section.sectionKey) === index); bundle.facts = uniqueFacts(bundle.facts);
  return { ...(parsedXml || {}), description: parsedXml?.description || null, detailStatus: failed ? 'partial' : 'complete', crawlKind, fullCrawlSucceeded: bundle.fullCrawlSucceeded, detailCrawledAt: new Date().toISOString(), detailCompleteness: bundle.completeness, portalMetadata: bundle.metadata, detailBundle: bundle };
}
export async function fetchDetail(url, options = {}) { try { return await fetchDetailBundle(url, options); } catch (error) { console.error(`[ted] Detail abrufen fehlgeschlagen: ${url} (${error.message})`); return null; } }
export default { meta, discover, fetchDetail, fetchDetailBundle, parseV3Notice, parseTedXml, fetchAllNotices, isInScopeNotice };
