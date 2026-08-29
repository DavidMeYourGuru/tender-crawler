import * as cheerio from 'cheerio';
import { contentHash, normalizeDate, normalizeCpv, parseMoneyToCents } from '../utils.js';
import { cleanDetailText, extractFactsFromDom, makeFact, makeTextSection, uniqueFacts } from '../detail-data.js';

// Cosinex-Installationen unterscheiden sich in ihren URLs und CSS-Klassen,
// teilen aber dieselbe öffentliche Seitenstruktur. Die Parser arbeiten daher
// bewusst mit semantischen Labels und behalten den vollständigen Rohtext als
// Snapshot bei.

function bodyLines($) {
  const selector = 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,label,legend,button,article,section';
  const leaves = $(selector).filter((_, node) => !$(node).find(selector).length)
    .map((_, node) => cleanDetailText($(node).text())).get().filter(Boolean);
  return leaves.length ? leaves : cleanDetailText($('body').text()).split(/\r?\n/).map(cleanDetailText).filter(Boolean);
}

function labelValue(text, labels) {
  const source = cleanDetailText(text);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`${escaped}\\s*:?\\s*(.{1,300}?)(?=\\s+(?:Auftraggeber|Vergabestelle|Verfahrensart|Status|Frist|Termin|Laufzeit|Auftragswert|CPV|Kriterien|Eignung|Einreichung|Sprache|Leistungsort|Los|Beschreibung)|$)`, 'i'));
    if (match?.[1]) return cleanDetailText(match[1]);
  }
  return null;
}

function germanNumber(value) {
  if (value == null) return null;
  const raw = String(value).replace(/\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const parsed = Number(raw.replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSize(value) {
  const match = String(value || '').replace(',', '.').match(/([\d.]+)\s*(bytes?|kb|mb|gb)/i);
  if (!match) return null;
  const factor = /^gb/i.test(match[2]) ? 1024 ** 3 : /^mb/i.test(match[2]) ? 1024 ** 2 : /^kb/i.test(match[2]) ? 1024 : 1;
  return Math.round(Number(match[1]) * factor);
}

function absoluteUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).toString(); } catch { return null; }
}

function isDocumentLink(url, text = '') {
  return /(?:download|document|file|unterlage|dokument|bekanntmach)/i.test(`${url} ${text}`)
    || /\.(?:pdf|docx?|xlsx?|zip|odt|ods|txt|rtf|xml|html?)(?:$|[?#])/i.test(url);
}

function extractCriteria(text) {
  const criteria = [];
  const patterns = [
    ['award', /Zuschlagskriter(?:ium|ien)\s*:?\s*([^]{0,600}?)(?=\s+(?:Eignung|Ausschluss|Ausführung|Einreichung|$))/gi],
    ['suitability', /Eignungskriter(?:ium|ien)\s*:?\s*([^]{0,600}?)(?=\s+(?:Zuschlag|Ausschluss|Ausführung|Einreichung|$))/gi],
    ['exclusion', /Ausschlussgr(?:ünde|und)\s*:?\s*([^]{0,600}?)(?=\s+(?:Eignung|Zuschlag|Ausführung|Einreichung|$))/gi],
    ['execution', /Ausführungsbeding(?:ungen|ung)\s*:?\s*([^]{0,600}?)(?=\s+(?:Einreichung|Sprache|$))/gi],
  ];
  for (const [kind, regex] of patterns) {
    for (const match of String(text || '').matchAll(regex)) {
      const description = cleanDetailText(match[1]);
      if (!description) continue;
      criteria.push({
        criterionKey: `${kind}-${contentHash(description).slice(0, 24)}`,
        kind,
        title: kind,
        description,
        required: kind !== 'award' ? true : null,
        sourceSection: 'eforms',
      });
    }
  }
  // Kompakte Kartenansichten stellen Kriterien häufig als einzelne Zeile
  // ohne nachfolgendes Abschnittslabel dar (z. B. "Preis 70 % Qualität
  // 30 %"). Diese Zeile ist dennoch ein öffentliches Kriterium und wird als
  // ein Rohkriterium gespeichert.
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/(Zuschlagskriterien?|Eignungskriterien?)\s*:?\s*(.+)$/i);
    if (!match) continue;
    const description = cleanDetailText(match[2]);
    if (!description) continue;
    const kind = /Eignung/i.test(match[1]) ? 'suitability' : 'award';
    const criterionKey = `${kind}-${contentHash(description).slice(0, 24)}`;
    if (!criteria.some((criterion) => criterion.criterionKey === criterionKey)) criteria.push({ criterionKey, kind, title: match[1], description, required: kind !== 'award' ? true : null, sourceSection: 'eforms' });
  }
  return criteria;
}

function parseCpv(text) {
  const codes = [];
  const labels = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const matches = [...line.matchAll(/(\d{8}(?:-\d)?)[\s:-]*([^\d]{0,180})/g)];
    for (const match of matches) {
      const code = match[1].replace(/[^0-9]/g, '').slice(0, 8);
      if (!code || codes.includes(code)) continue;
      codes.push(code);
      const label = cleanDetailText(match[2]);
      labels.push(label || null);
    }
  }
  return { cpvCodes: codes.length ? codes : null, cpvLabels: labels.some(Boolean) ? labels : null };
}

function canonicalFacts($, sourceUrl, metadata) {
  const aliases = {
    status: ['status'], procedureType: ['verfahrensart'], contractingAuthority: ['auftraggeber', 'vergabestelle'],
    submissionDeadline: ['angebotsfrist', 'teilnahmefrist', 'frist für den eingang der angebote'],
    questionDeadline: ['fragenfrist', 'frist für fragen'], openingDate: ['öffnungstermin', 'öffnung der angebote'],
    bindingPeriod: ['bindefrist'], publicationDate: ['veröffentlichungsdatum', 'datum der veröffentlichung'],
    estimatedValue: ['geschätzter auftragswert', 'geschätzter wert', 'auftragswert'],
    contractDuration: ['laufzeit', 'vertragslaufzeit'], placeOfPerformance: ['leistungsort', 'ort der leistung', 'erfüllungsort'],
  };
  const domFacts = extractFactsFromDom($, 'eforms', sourceUrl);
  return Object.entries(aliases).map(([key, names]) => {
    const match = domFacts.find((fact) => names.includes(cleanDetailText(fact.label).toLowerCase()));
    return match ? makeFact({ sectionKey: 'eforms', key: `eforms:${key}`, label: key, value: match.valueText, normalizedValue: match.valueText, dataType: 'structured', sourceUrl }) : null;
  }).filter(Boolean);
}

export function parseCosinexEformsPage(html, baseUrl) {
  const $ = cheerio.load(html);
  const lines = bodyLines($);
  const rawText = cleanDetailText(lines.join(' '));
  const cpv = parseCpv(lines.join('\n'));
  const metadata = {
    pageKind: 'eforms', rawText,
    status: labelValue(rawText, ['Status']), procedureType: labelValue(rawText, ['Verfahrensart']),
    procurementRegulation: labelValue(rawText, ['Vergabeordnung', 'Rechtsgrundlage']),
    contractingAuthority: labelValue(rawText, ['Auftraggeber', 'Vergabestelle']),
    questionDeadline: labelValue(rawText, ['Frist für Fragen', 'Fragenfrist']),
    submissionDeadline: labelValue(rawText, ['Frist für den Eingang der Angebote', 'Angebotsfrist', 'Teilnahmefrist']),
    openingDate: labelValue(rawText, ['Öffnungstermin', 'Öffnung der Angebote']), bindingPeriod: labelValue(rawText, ['Bindefrist']),
    publicationDate: labelValue(rawText, ['Veröffentlichungsdatum', 'Datum der Veröffentlichung']),
    estimatedValue: labelValue(rawText, ['Geschätzter Auftragswert', 'Geschätzter Wert', 'Auftragswert']),
    contractDuration: labelValue(rawText, ['Laufzeit', 'Vertragslaufzeit']), placeOfPerformance: labelValue(rawText, ['Leistungsort', 'Ort der Leistung', 'Erfüllungsort']),
    flags: {},
  };
  const core = {
    description: labelValue(rawText, ['Beschreibung', 'Kurzbeschreibung', 'Auftragsgegenstand']) || cleanDetailText($('main,article,.content,#content,.detail').first().text()) || rawText,
    ...cpv,
    submissionDeadline: normalizeDate(metadata.submissionDeadline) || metadata.submissionDeadline || null,
    questionDeadline: normalizeDate(metadata.questionDeadline) || metadata.questionDeadline || null,
    openingDate: normalizeDate(metadata.openingDate) || metadata.openingDate || null,
    bindingPeriod: normalizeDate(metadata.bindingPeriod) || metadata.bindingPeriod || null,
    estimatedValueCents: metadata.estimatedValue ? parseMoneyToCents(metadata.estimatedValue) : null,
    estimatedValueCurrency: /GBP|USD|CHF|EUR/i.exec(metadata.estimatedValue || '')?.[0]?.toUpperCase() || 'EUR',
    contractDuration: metadata.contractDuration,
    contractingAuthority: metadata.contractingAuthority,
    placeOfPerformance: metadata.placeOfPerformance,
    procedureType: metadata.procedureType,
    portalStatus: metadata.status,
    tenderType: metadata.procurementRegulation,
  };
  const lots = [];
  $('h1,h2,h3,h4,h5,legend').each((_, node) => {
    const heading = cleanDetailText($(node).text());
    const match = heading.match(/(?:Los|Lot)\s*([\w.-]+)/i);
    if (!match) return;
    lots.push({ lotKey: match[1], lotNumber: match[1], title: heading, description: cleanDetailText($(node).parent().text()).slice(0, 4000), cpvCodes: cpv.cpvCodes, cpvLabels: cpv.cpvLabels, metadata: { sourceSection: heading } });
  });
  const criteria = extractCriteria(lines.join('\n'));
  const facts = uniqueFacts([
    ...extractFactsFromDom($, 'eforms', baseUrl),
    ...canonicalFacts($, baseUrl, metadata),
    ...criteria.map((criterion) => makeFact({ sectionKey: 'eforms', key: `eforms:criterion:${criterion.criterionKey}`, label: criterion.title, value: criterion.description, normalizedValue: criterion, dataType: 'criterion', sourceUrl: baseUrl })),
  ].filter(Boolean));
  return {
    ...core, metadata, lots, criteria, facts,
    textSections: [makeTextSection({ sectionKey: 'eforms', title: 'Verfahrensdaten / eForms', sourceUrl: baseUrl, text: lines.join('\n') })],
    snapshot: { kind: 'cosinex:eforms', sourceUrl: baseUrl, content: String(html), mimeType: 'text/html' },
  };
}

export function parseCosinexDocumentsPage(html, baseUrl) {
  const $ = cheerio.load(html);
  const pageText = cleanDetailText($('body').text());
  const loginRequired = /(?:login|anmelden|anmeldung erforderlich|nur für registrierte)/i.test(pageText)
    && !$('a[href]').toArray().some((link) => isDocumentLink($(link).attr('href') || '', $(link).text()));
  const documents = [];
  let category = 'unknown';
  $('h1,h2,h3,h4,h5,legend').each((_, node) => {
    const text = cleanDetailText($(node).text());
    if (/unterlagen|dokument|bekanntmach|anhang|formular|sonstig/i.test(text)) category = text;
  });
  const add = (href, filename, values = {}) => {
    const absolute = absoluteUrl(href, baseUrl);
    const cleanName = cleanDetailText(filename) || absolute?.split('/').pop()?.split('?')[0] || 'Dokument';
    if (!absolute || documents.some((doc) => doc.portalFileId === absolute)) return;
    documents.push({ portalFileId: absolute, category, filename: cleanName, mimeType: values.mimeType || null, extension: cleanName.split('.').pop()?.toLowerCase() || null, sizeBytes: values.sizeBytes || null, publishedAt: values.publishedAt || null, sourceUrl: baseUrl, locator: { pageUrl: baseUrl, href: absolute, filename: cleanName, category }, accessStatus: 'public', downloadStatus: 'not_requested' });
  };
  $('tr').each((_, row) => {
    const cells = $(row).find('td,th').map((__, cell) => cleanDetailText($(cell).text())).get().filter(Boolean);
    $(row).find('a[href]').each((__, link) => add($(link).attr('href'), cells.find((cell) => /\.[a-z0-9]{2,5}$/i.test(cell)) || $(link).text(), { sizeBytes: parseSize(cells.find((cell) => /\d+(?:[.,]\d+)?\s*(?:KB|MB|Bytes?)/i.test(cell))) }));
  });
  $('a[href]').each((_, link) => {
    const href = $(link).attr('href');
    const text = cleanDetailText($(link).text());
    if (href && isDocumentLink(href, text) && !/zip|gesamt|alle unterlagen/i.test(`${href} ${text}`)) add(href, text);
  });
  const archives = $('a[href]').map((_, link) => {
    const href = $(link).attr('href'); const text = $(link).text();
    return href && /zip|gesamt|alle unterlagen/i.test(`${href} ${text}`) ? absoluteUrl(href, baseUrl) : null;
  }).get().filter(Boolean);
  if (archives[0]) add(archives[0], 'Gesamtarchiv.zip', { mimeType: 'application/zip' });
  return {
    documents, loginRequired,
    textSection: makeTextSection({ sectionKey: 'documents', title: 'Vergabeunterlagen', sourceUrl: baseUrl, text: bodyLines($).join('\n'), status: loginRequired ? 'login_required' : 'complete' }),
    snapshot: { kind: 'cosinex:documents', sourceUrl: baseUrl, content: String(html), mimeType: 'text/html' },
  };
}

export function parseCosinexCommunicationPage(html, baseUrl) {
  const $ = cheerio.load(html);
  const text = cleanDetailText(bodyLines($).join(' '));
  const loginRequired = /(?:login|anmelden|anmeldung erforderlich|nur für registrierte)/i.test(text)
    && !/(?:Betreff|Bieterfrage|Nachricht)\s*:/i.test(text);
  const messages = [];
  const candidates = $('body *').filter((_, node) => /Betreff\s*:/i.test($(node).text()) && $(node).children().length < 8).toArray();
  const outer = candidates.filter((node) => !$(node).parents().toArray().some((parent) => candidates.includes(parent)));
  for (const node of outer) {
    const parts = $(node).find('p,li,td,th,div,br').map((_, child) => cleanDetailText($(child).text())).get().filter(Boolean);
    const value = cleanDetailText((parts.length ? parts : [$(node).text()]).join(' '));
    const subject = value.match(/Betreff\s*:\s*(.*?)(?=\s+(?:Datum|Veröffentlicht|Nachricht|Text)\s*:|$)/i)?.[1] || null;
    const publishedAtRaw = value.match(/(?:Datum|Veröffentlicht(?: am)?)\s*:\s*([\d.\-/ :]+)/i)?.[1] || null;
    const body = value.replace(/Betreff\s*:\s*.*?(?=\s+(?:Datum|Veröffentlicht|Nachricht|Text)\s*:|$)/i, '').replace(/(?:Datum|Veröffentlicht(?: am)?)\s*:\s*[\d.\-/ :]+/i, '').trim();
    if (!subject && !body) continue;
    const attachments = $(node).find('a[href]').map((__, link) => ({ filename: cleanDetailText($(link).text()) || 'Anhang', href: absoluteUrl($(link).attr('href'), baseUrl), accessStatus: 'public' })).get().filter((item) => item.href);
    const id = `message-${contentHash('cosinex-message', subject, publishedAtRaw, body)}`;
    if (!messages.some((item) => item.portalMessageId === id)) messages.push({ portalMessageId: id, subject, body, publishedAt: normalizeDate(publishedAtRaw) || publishedAtRaw, sourceUrl: baseUrl, attachments });
  }
  if (!messages.length && !loginRequired && /(?:Betreff|Bieterfrage|Nachricht)\s*:/i.test(text)) {
    messages.push({ portalMessageId: `message-${contentHash('cosinex-message', text)}`, subject: null, body: text, publishedAt: null, sourceUrl: baseUrl, attachments: [] });
  }
  return {
    messages, loginRequired,
    textSection: makeTextSection({ sectionKey: 'communication', title: 'Kommunikation', sourceUrl: baseUrl, text, status: loginRequired ? 'login_required' : 'complete' }),
    snapshot: { kind: 'cosinex:communication', sourceUrl: baseUrl, content: String(html), mimeType: 'text/html' },
  };
}

export function parseCosinexOverviewPage(html, baseUrl) {
  const $ = cheerio.load(html);
  const text = cleanDetailText(bodyLines($).join('\n'));
  const cpv = normalizeCpv([...text.matchAll(/(\d{8}(?:-\d)?)/g)].map((match) => match[1]), null);
  const title = cleanDetailText($('h1,h2,.title,.project-title').first().text()) || null;
  return {
    title, description: cleanDetailText($('main,article,.content,#content,.detail').first().text()) || text || null,
    cpvCodes: cpv.cpvCodes, cpvLabels: cpv.cpvLabels,
    textSections: [makeTextSection({ sectionKey: 'overview', title: 'Übersicht', sourceUrl: baseUrl, text })],
    facts: extractFactsFromDom($, 'overview', baseUrl),
    snapshot: { kind: 'cosinex:overview', sourceUrl: baseUrl, content: String(html), mimeType: 'text/html' },
  };
}

export default { parseCosinexOverviewPage, parseCosinexEformsPage, parseCosinexDocumentsPage, parseCosinexCommunicationPage };
