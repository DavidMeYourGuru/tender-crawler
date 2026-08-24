/**
 * Vergabeportal Niedersachsen (Deutsche eVergabe, Healy Hudson).
 *
 * Identisch mit der Bayern-Anbindung: Nur über den Browser erreichbar
 * (JavaScript + Session-Storage). Niedersachsen ist gegenüber Bayern
 * lediglich ein anderer Bundesland-Parameter: BL=03 (Bayern = BL=09).
 *
 * Startpunkt: https://portal.deutsche-evergabe.de/Dashboards/Dashboard_off?BL=03
 *
 * Datenmengen-Reduktion: Es werden nur Ausschreibungen aus dem
 * Interessenbereich (Bau, Landschaftsarchitektur, Garten, Schulen,
 * Kita, Spielplätze) mitgenommen – siehe category-filter.js.
 *
 * DOM (live inspiziert am 2026-08-21): DevExtreme dxDataGrid.
 *   - Datenzeilen: <tr class="dx-row dx-data-row"> mit 7 <td>; die
 *     Titel-Zelle (Index 2) enthält den Ausschreibungstitel + Verfahrenstyp.
 *   - Spalten: [0] Icon, [1] VOrdn. (VOB/VGV/SektVo), [2] Titel,
 *     [3] Vergabestelle, [4] Publikation, [5] Frist, [6] Icon.
 *   - Detail-Link: Klick auf die Titel-Zelle (kein href, JS-Navigation).
 *   - Pager: .dx-datagrid-pager mit .dx-page-Elementen (Seitenzahlen 1..N).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import config from '../config.js';
import {
  saveTender,
  getTenderById,
  getTenderByExternalId,
  getTenderByPortalProject,
  getDiscoveryCache,
  saveDiscoveryCache,
  startCrawlLog,
  finishCrawlLog,
  getCheckpoint,
  updateCheckpoint,
} from '../db.js';
import { RateLimiter } from '../crawler/rate-limiter.js';
import { contentHash, normalizeDate, deriveStatus } from '../utils.js';
import { matchesInterestCategories } from '../category-filter.js';
import { cleanDetailText, extractFactsFromDom, makeFact, makeTextSection, uniqueFacts } from '../detail-data.js';

export const meta = {
  id: 'niedersachsen',
  name: 'Vergabeportal Niedersachsen (Deutsche eVergabe)',
  region: 'niedersachsen',
  type: 'browser',
  schedule: '0 */8 * * *',
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://portal.deutsche-evergabe.de',
};

const DASHBOARD_URL = 'https://portal.deutsche-evergabe.de/Dashboards/Dashboard_off?BL=03';

// Verifizierte DevExtreme-dxDataGrid-Selektoren (live inspiziert).
const ROW_SELECTOR = 'tr.dx-row.dx-data-row';
const PAGER_SELECTOR = '.dx-datagrid-pager';
const PAGE_LINK_SELECTOR = '.dx-page';
const REJECTED_CACHE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const OPEN_DETAIL_REFRESH_MS = 24 * 60 * 60 * 1000;
const CLOSED_DETAIL_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

function parseGermanAmountCents(value) {
  if (!value) return null;
  const normalized = String(value).replace(/\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function isDeferredDocumentRequest(url) {
  const value = String(url || '');
  return /\.(?:pdf|docx?|xlsx?|zip|7z|rar|odt|ods|txt|rtf)(?:$|[?#])/i.test(value)
    || /(?:^|[/?_.?&-])(?:directdocload|download(?:document|file)?|filedownload)(?:[/?_.?&=-]|$)/i.test(value)
    || /(?:[?&](?:download|downloadFile|fileDownload|inlineFile)(?:=true)?(?:&|$))/i.test(value);
}

function detailDue(existing, now = Date.now()) {
  if (!existing?.detail_crawled_at || existing.detail_status !== 'complete') return true;
  const crawled = Date.parse(existing.detail_crawled_at);
  if (!Number.isFinite(crawled)) return true;
  const changed = Date.parse(existing.last_changed_at || '');
  if (Number.isFinite(changed) && changed > crawled) return true;
  return now - crawled >= (existing.status === 'closed' ? CLOSED_DETAIL_REFRESH_MS : OPEN_DETAIL_REFRESH_MS);
}

function isSpecificProjectTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title || /^(?:verfahren|zusammenfassung|bekanntmachung|dokumente?)$/i.test(title)) return false;
  if (/^(?:verfahren\s*)?(?:nr\.?|nummer)\s*[\w/-]+$/i.test(title)) return false;
  return title.length >= 5;
}

// Kernfelder sind durch die Portalbezeichnungen semantisch bekannt. Sie
// werden als Fakten nur für diese Whitelist materialisiert; unbekannte
// `Label: Wert`-Zeilen bleiben ausschließlich im Abschnittstext.
function knownSummaryFacts(summary, sourceUrl) {
  const fields = ['referenceNumber', 'contractingAuthority', 'procedureType', 'procurementRegulation',
    'publicationDate', 'submissionDeadline', 'questionDeadline', 'openingDate', 'bindingPeriod',
    'description', 'placeOfPerformance', 'contractDuration', 'awardCriteria', 'portalStatus'];
  return fields.map((key) => makeFact({
    sectionKey: 'summary', key: `summary:${key}`, label: key, value: summary[key],
    normalizedValue: summary[key], dataType: 'known_field', sourceUrl,
  })).filter(Boolean);
}

export function profileDir() {
  return path.join(config.browserProfileDir, 'niedersachsen');
}

/**
 * Pure Funktion: parst eine extrahierte Tabellenzeile in ein Tender-Objekt.
 * `raw` = { cells: string[], href: string|null }
 */
export function parseRow(raw) {
  if (!raw || !Array.isArray(raw.cells) || raw.cells.length < 6) return null;

  // Spalten (DevExtreme dxDataGrid, live inspiziert):
  // [0] Icon, [1] VOrdn., [2] Titel, [3] Vergabestelle, [4] Publikation, [5] Frist, [6] Icon
  // Die Titel-Zelle enthält oft den Verfahrenstyp angehängt
  // (z. B. "Entsorgung SperrmüllOffenes Verfahren"). Wir trennen bekannte
  // Verfahrenstyp-Suffixe sauber ab.
  const VERFAHREN_TYPEN = ['Offenes Verfahren', 'Öffentliches Verfahren', 'Öffentliche Ausschreibung', 'Vergebener Auftrag', 'Bekanntmachung', 'Interessenbekundung', 'Wettbewerb', 'Verhandlungsverfahren', 'Nichtoffenes Verfahren'];
  let title = (raw.cells[2] || '').toString().replace(/\s+/g, ' ').trim();
  let procedureType = raw.procedureType || null;
  for (const vt of VERFAHREN_TYPEN) {
    const idx = title.indexOf(vt);
    if (idx > 0) {
      procedureType = procedureType || vt;
      title = title.slice(0, idx).trim();
      break;
    }
  }
  if (!title) return null;

  const portalProjectId = raw.portalProjectId || raw.uuid || raw.dataButton || null;
  // Die UUID aus data-button ist die stabile Portal-ID. Der Hash bleibt nur
  // als Migrations-Fallback für alte Gridzeilen ohne Detail-Link erhalten.
  const contractingAuthority = (raw.cells[3] || '').toString().replace(/\s+/g, ' ').trim() || null;
  const publicationDate = normalizeDate(raw.cells[4]);
  const deadline = normalizeDate(raw.cells[5]);
  const externalId = portalProjectId || contentHash(title, contractingAuthority, deadline);
  const status = deriveStatus(deadline, 'open');
  const discoveryFingerprint = contentHash(
    title, contractingAuthority, publicationDate, deadline,
    raw.cells[1] || '', procedureType || ''
  );

  return {
    sourceId: 'niedersachsen',
    externalId: String(externalId),
    title,
    url: `${meta.baseUrl}/Dashboards/Dashboard_off?BL=03`,
    portalProjectId,
    referenceNumber: raw.referenceNumber || null,
    description: null,
    contractingAuthority,
    cpvCodes: null,
    cpvLabels: null,
    estimatedValueCents: null,
    estimatedValueCurrency: 'EUR',
    placeOfPerformance: null,
    awardCriteria: null,
    tenderType: (raw.cells[1] || '').toString().trim() || null,
    procedureType,
    publicationDate,
    submissionDeadline: deadline,
    openingDate: null,
    contractDuration: null,
    documentUrl: null,
    status,
    contentHash: contentHash(externalId, title, deadline, status, null),
    discoveryFingerprint,
  };
}

/**
 * Extrahiert alle Ergebniszeilen der aktuellen Seite aus dem Browser-DOM.
 * DevExtreme dxDataGrid: Datenzeilen = tr.dx-row.dx-data-row mit 7 <td>.
 */
async function extractRows(page) {
  return page.evaluate((rowSelector) => {
    const rows = [...document.querySelectorAll(rowSelector)];
    return rows.map((row) => {
      const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim());
      const link = row.querySelector('a.BekSummary, a[data-button], [data-button]');
      return {
        cells,
        href: link?.getAttribute('href') || null,
        portalProjectId: link?.getAttribute('data-button') || row.getAttribute('data-button') || null,
        procedureType: link?.getAttribute('data-procedure-type') || null,
      };
    });
  }, ROW_SELECTOR);
}

/**
 * Liest CPV-Codes + Bezeichnungen aus dem geöffneten Verfahrens-Detail-Dialog
 * (Deutsche eVergabe, DevExtreme). Der Dialog enthält einen Block
 * "CPV-Klassifizierung"; darunter stehen ein oder mehrere Code/Label-Paare.
 * Mehrere Dialoge können "CPV-Klassifizierung" enthalten (z. B. ein Filter-
 * Dialog) – wir wählen den aus, der zusätzlich "Verfahren" enthält.
 */
async function extractDetailCpv(page) {
  return page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('.dx-dialog, [role="dialog"], .modal')];
    const dialog = dialogs.find(
      (d) => /CPV-Klassifizierung/i.test(d.textContent) && /Verfahren/i.test(d.textContent)
    );
    if (!dialog) return { cpvCodes: null, cpvLabels: null };
    const header = [...dialog.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && /CPV-Klassifizierung/i.test(el.textContent)
    );
    if (!header) return { cpvCodes: null, cpvLabels: null };
    const valueBlock = header.parentElement ? header.parentElement.nextElementSibling : null;
    if (!valueBlock) return { cpvCodes: null, cpvLabels: null };
    const text = valueBlock.innerText || valueBlock.textContent;
    const cpvCodes = [...text.matchAll(/\d{8}-\d/g)].map((m) => m[0]);
    const cpvLabels = text
      .replace(/\d{8}-\d/g, '|')
      .split('|')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return {
      cpvCodes: cpvCodes.length ? cpvCodes : null,
      cpvLabels: cpvLabels.length ? cpvLabels : null,
    };
  });
}

/** Reiner Parser für gespeicherte Zusammenfassungs-/Dialog-Fixtures. */
export function parseDetailSummaryHtml(html, baseUrl = DASHBOARD_URL) {
  const $ = cheerio.load(html);
  const dialog = $('.dx-dialog, [role="dialog"], .modal').filter((_, node) => /Verfahren/i.test($(node).text())).first();
  const text = (dialog.length ? dialog : $('body')).text().replace(/\s+/g, ' ').trim();
  const cpvPairs = [...text.matchAll(/(\d{8}-\d)\s*([^]*?)(?=\d{8}-\d|$)/g)].map((match) => ({
    code: match[1], label: match[2].replace(/\s+(?:Aktenzeichen|Elektronische Angebotsabgabe|Publikation|Angebotsfrist)\b.*$/i, '').trim(),
  }));
  const cpvCodes = cpvPairs.map((pair) => pair.code);
  const cpvLabels = cpvPairs.map((pair) => pair.label).filter(Boolean);
  const valueAfter = (labels) => {
    for (const label of labels) {
      const match = text.match(new RegExp(`${label}\\s*:?\\s*(.{1,180}?)(?=\\s+(?:\u00d6ffentlich|CPV|Aktenzeichen|Verfahren|Angebots|Publikation|Leistungsort|Laufzeit|Zuschlags?|Öffnung|Bindefrist|Beschreibung|Auftragswert)|$)`, 'i'));
      if (match?.[1]) return match[1].trim();
    }
    return null;
  };
  const number = text.match(/(?:Nr\.?|Verfahrensnummer)\s*[:#]?\s*([\w/-]+)/i)?.[1] || null;
  const title = dialog.find('h1,h2,h3,.title,.dx-popup-title').first().text().replace(/\s+/g, ' ').trim()
    || text.match(/(?:Titel|Bezeichnung)\s*:?\s*(.*?)(?=\s+(?:Offenes|Nichtoffenes|Vergabestelle|CPV))/i)?.[1]?.trim()
    || null;
  const procedure = text.match(/(Offenes Verfahren|Nichtoffenes Verfahren|Verhandlungsverfahren|Öffentliche Ausschreibung|Interessenbekundung|Wettbewerb)/i)?.[1] || null;
  const parseGermanNumber = (value) => {
    if (!value) return null;
    const normalized = String(value).replace(/\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
    const numberValue = Number(normalized);
    return Number.isFinite(numberValue) ? numberValue : null;
  };
  const estimatedValueText = valueAfter(['Geschätzter Auftragswert', 'Geschätzter Wert', 'Auftragswert']);
  const result = {
    portalProjectId: dialog.attr('data-button') || dialog.find('[data-button]').first().attr('data-button') || null,
    title,
    referenceNumber: number,
    contractingAuthority: valueAfter(['Auftraggeber', 'Vergabestelle']),
    portalStatus: valueAfter(['Status']),
    procedureType: procedure,
    procurementRegulation: text.match(/\b(VOB|VGV|UVgO|SektVO)\b/i)?.[1]?.toUpperCase() || null,
    publicationDate: normalizeDate(valueAfter(['Publikation', 'Veröffentlichung'])),
    submissionDeadline: normalizeDate(valueAfter(['Angebotsfrist', 'Frist'])),
    questionDeadline: normalizeDate(valueAfter(['Frist für Fragen', 'Fragenfrist'])),
    openingDate: normalizeDate(valueAfter(['Öffnungstermin', 'Öffnung der Angebote'])),
    bindingPeriod: normalizeDate(valueAfter(['Bindefrist'])) || valueAfter(['Bindefrist']),
    description: valueAfter(['Auftragsgegenstand', 'Kurzbeschreibung', 'Beschreibung']),
    placeOfPerformance: valueAfter(['Leistungsort', 'Ort der Leistung', 'Erfüllungsort']),
    contractDuration: valueAfter(['Laufzeit', 'Vertragslaufzeit']),
    awardCriteria: valueAfter(['Zuschlagskriterien', 'Zuschlagskriterium']),
    estimatedValueCents: estimatedValueText && parseGermanNumber(estimatedValueText) != null ? Math.round(parseGermanNumber(estimatedValueText) * 100) : null,
    estimatedValueCurrency: /GBP|USD|CHF|EUR/i.exec(estimatedValueText || '')?.[0]?.toUpperCase() || 'EUR',
    cpvCodes: [...new Set(cpvCodes)],
    cpvLabels: cpvLabels.length ? cpvLabels : null,
    electronicSubmission: /elektronische Angebotsabgabe|elektronisch/i.test(text),
    rawText: text,
    sourceUrl: baseUrl,
  };
  result.textSections = [makeTextSection({
    sectionKey: 'summary', title: 'Verfahrenszusammenfassung', sourceUrl: baseUrl, text,
  })];
  result.facts = uniqueFacts([
    ...extractFactsFromDom(dialog.length ? dialog : $, 'summary', baseUrl),
    ...knownSummaryFacts(result, baseUrl),
    ...result.cpvCodes.map((code, index) => makeFact({
      sectionKey: 'summary', key: `summary:cpv:${code}`, label: `CPV ${code}`,
      value: result.cpvLabels?.[index] || code, normalizedValue: code, dataType: 'cpv', sourceUrl: baseUrl,
    })),
  ].filter(Boolean));
  return result;
}

async function extractSummaryFromDialog(page) {
  return page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('.dx-dialog, [role="dialog"], .modal')];
    const dialog = dialogs.find((d) => /Verfahren/i.test(d.textContent || '') && /CPV|Auftraggeber|Vergabestelle/i.test(d.textContent || ''));
    if (!dialog) return null;
    const text = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
    const valueAfter = (labels) => {
      for (const label of labels) {
        const match = text.match(new RegExp(`${label}\\s*:?\\s*(.{1,180}?)(?=\\s+(?:Öffentlich|CPV|Aktenzeichen|Verfahren|Angebots|Publikation|Leistungsort|Laufzeit|Zuschlags?|Öffnung|Bindefrist|Beschreibung|Auftragswert)|$)`, 'i'));
        if (match?.[1]) return match[1].trim();
      }
      return null;
    };
    const cpvPairs = [...text.matchAll(/(\d{8}-\d)\s*([^]*?)(?=\d{8}-\d|$)/g)].map((match) => ({
      code: match[1], label: match[2].replace(/\s+(?:Aktenzeichen|Elektronische Angebotsabgabe|Publikation|Angebotsfrist)\b.*$/i, '').trim(),
    }));
    const cpvCodes = cpvPairs.map((pair) => pair.code);
    const cpvLabels = cpvPairs.map((pair) => pair.label).filter(Boolean);
    const heading = dialog.querySelector('h1,h2,h3,.title,.dx-popup-title');
    return {
      rawText: text,
      portalProjectId: dialog.getAttribute('data-button') || dialog.querySelector('[data-button]')?.getAttribute('data-button') || null,
      title: heading?.textContent?.replace(/\s+/g, ' ').trim() || null,
      referenceNumber: text.match(/(?:Nr\.?|Verfahrensnummer)\s*[:#]?\s*([\w/-]+)/i)?.[1] || null,
      contractingAuthority: valueAfter(['Auftraggeber', 'Vergabestelle']),
      portalStatus: valueAfter(['Status']),
      procedureType: text.match(/(Offenes Verfahren|Nichtoffenes Verfahren|Verhandlungsverfahren|Öffentliche Ausschreibung|Interessenbekundung|Wettbewerb)/i)?.[1] || null,
      procurementRegulation: text.match(/\b(VOB|VGV|UVgO|SektVO)\b/i)?.[1]?.toUpperCase() || null,
      publicationDate: valueAfter(['Publikation', 'Veröffentlichung']),
      submissionDeadline: valueAfter(['Angebotsfrist', 'Frist']),
      questionDeadline: valueAfter(['Frist für Fragen', 'Fragenfrist']),
      openingDate: valueAfter(['Öffnungstermin', 'Öffnung der Angebote']),
      bindingPeriod: valueAfter(['Bindefrist']),
      description: valueAfter(['Auftragsgegenstand', 'Kurzbeschreibung', 'Beschreibung']),
      placeOfPerformance: valueAfter(['Leistungsort', 'Ort der Leistung', 'Erfüllungsort']),
      contractDuration: valueAfter(['Laufzeit', 'Vertragslaufzeit']),
      awardCriteria: valueAfter(['Zuschlagskriterien', 'Zuschlagskriterium']),
      estimatedValueText: valueAfter(['Geschätzter Auftragswert', 'Geschätzter Wert', 'Auftragswert']),
      cpvCodes: [...new Set(cpvCodes)],
      cpvLabels: cpvLabels.length ? cpvLabels : null,
      electronicSubmission: /elektronische Angebotsabgabe|elektronisch/i.test(text),
      dialogHtml: dialog.outerHTML,
    };
  });
}

async function extractDocumentsFromDialog(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#DIV_Dokumente, [data-url*="dxVUFilesForSupplier"], .documents, .Dokumente');
    if (!root) return { documents: [], endpoint: null, html: '', text: '', loginRequired: false };
    const endpoint = root.getAttribute('data-url') || null;
    const rootText = root.innerText || '';
    const hasFileLink = [...root.querySelectorAll('a[href]')].some((link) =>
      /\.(?:pdf|docx?|xlsx?|zip|odt|txt|html?)(?:$|[?#])/i.test(link.getAttribute('href') || ''));
    const hasFileEntry = root.querySelector('[id^="REL_"], [data-file-id], [data-id]');
    const loginRequired = /(?:anmelden|login|registriert)/i.test(rootText) && !hasFileLink && !hasFileEntry;
    const documents = [];
    const icons = [...root.querySelectorAll('[id^="REL_"], [data-file-id], [data-id]')];
    for (const icon of icons) {
      const parent = icon.closest('li, tr, .dx-list-item, .file, .document, .row') || icon.parentElement;
      const text = (parent?.innerText || icon.parentElement?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const filename = text.match(/[^|\n]+\.(?:pdf|docx?|xlsx?|zip|odt|txt|html?)(?:\s|$)/i)?.[0]?.trim()
        || text.split(/\s{2,}/)[0]?.trim() || text.slice(0, 180);
      const date = text.match(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s+\d{1,2}:\d{2})?/)?.[0] || null;
      const id = icon.getAttribute('id') || icon.getAttribute('data-file-id') || icon.getAttribute('data-id');
      const document = {
        portalFileId: id,
        filename,
        publishedAt: date,
        category: 'documents',
        mimeType: /\.pdf(?:$|\?)/i.test(filename) ? 'application/pdf' : null,
        sourceUrl: location.href,
        locator: { endpoint, fileId: id, pageUrl: location.href },
        accessStatus: 'public',
        downloadStatus: 'not_requested',
      };
      if (!documents.some((item) => item.portalFileId === document.portalFileId && item.filename === document.filename)) {
        documents.push(document);
      }
    }
    // Einige Portalvarianten rendern Dateien nur als Download-Link und ohne
    // REL_-Icon. Diese Links werden ergänzend inventarisiert.
    for (const link of root.querySelectorAll('a[href]')) {
      const href = link.href || link.getAttribute('href') || '';
      const linkText = (link.textContent || '').replace(/\s+/g, ' ').trim();
      if (!href || !/(?:download|directdocload|file|dokument|unterlage)|\.(?:pdf|docx?|xlsx?|zip|odt|txt|html?)(?:$|[?#])/i.test(`${href} ${linkText}`)) continue;
      const parentText = (link.closest('li, tr, .dx-list-item, .file, .document, .row')?.innerText || linkText)
        .replace(/\s+/g, ' ').trim();
      const filename = linkText.match(/[^|]+\.(?:pdf|docx?|xlsx?|zip|odt|txt|html?)/i)?.[0]?.trim()
        || href.split('/').pop()?.split('?')[0] || 'Dokument';
      const id = link.getAttribute('data-file-id') || link.getAttribute('data-id') || href;
      const date = parentText.match(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s+\d{1,2}:\d{2})?/)?.[0] || null;
      const document = {
        portalFileId: id, filename, publishedAt: date, category: 'documents',
        mimeType: /\.pdf(?:$|\?)/i.test(filename) ? 'application/pdf' : null,
        sourceUrl: location.href, locator: { endpoint, fileId: id, href, pageUrl: location.href },
        accessStatus: 'public', downloadStatus: 'not_requested',
      };
      if (!documents.some((item) => item.portalFileId === document.portalFileId && item.filename === document.filename)) {
        documents.push(document);
      }
    }
    return { documents, endpoint, html: root.outerHTML, text: rootText, loginRequired };
  });
}

async function extractMessagesFromDialog(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#DIV_Dokumente, .documents, .Dokumente, [role="dialog"]');
    if (!root) return [];
    const messages = [];
    const elements = [...root.querySelectorAll('li, tr, .message, .question, .news, .dx-list-item')];
    for (const element of elements) {
      const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || !/(Bieterfrage|Nachricht|Mitteilung|Antwort)/i.test(text)) continue;
      const date = text.match(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s+\d{1,2}:\d{2})?/)?.[0] || null;
      messages.push({
        portalMessageId: element.getAttribute('data-id') || element.id || null,
        subject: text.slice(0, 180), body: text, publishedAt: date,
        sourceUrl: location.href, attachments: [...element.querySelectorAll('a[href]')].map((a) => ({ filename: a.textContent.trim(), href: a.href })),
      });
    }
    return messages;
  });
}

async function clickDialogTab(page, label) {
  return page.evaluate((wanted) => {
    const nodes = [...document.querySelectorAll('button, a, [role="tab"], .dx-tab')];
    const node = nodes.find((item) => new RegExp(`^\\s*${wanted}\\s*$`, 'i').test(item.textContent || ''));
    if (!node) return false;
    node.click();
    return true;
  }, label);
}

/** Öffnet Zusammenfassung, Bekanntmachung und Dokumente ohne Binärdownload. */
async function openAndExtractDetail(page, liveRow, portalProjectId, { crawlKind = 'incremental', fullCrawlSucceeded = false } = {}) {
  const link = await liveRow?.$('a.BekSummary, a[data-button], [data-button]');
  if (!link) return null;
  try {
    await link.evaluate((el) => el.click());
    await page.waitForFunction(() => [...document.querySelectorAll('.dx-dialog, [role="dialog"], .modal')]
      .some((d) => /Verfahren/i.test(d.textContent || '') && /CPV|Auftraggeber|Vergabestelle/i.test(d.textContent || '')), { timeout: 10000 }).catch(() => {});
    const summary = await extractSummaryFromDialog(page);
    if (!summary) return null;
    summary.publicationDate = normalizeDate(summary.publicationDate) || summary.publicationDate;
    summary.submissionDeadline = normalizeDate(summary.submissionDeadline) || summary.submissionDeadline;
    summary.questionDeadline = normalizeDate(summary.questionDeadline) || summary.questionDeadline;
    summary.openingDate = normalizeDate(summary.openingDate) || summary.openingDate;
    summary.bindingPeriod = normalizeDate(summary.bindingPeriod) || summary.bindingPeriod;
    summary.estimatedValueCents = parseGermanAmountCents(summary.estimatedValueText);
    summary.estimatedValueCurrency = /GBP|USD|CHF|EUR/i.exec(summary.estimatedValueText || '')?.[0]?.toUpperCase() || 'EUR';
    summary.textSections = [makeTextSection({
      sectionKey: 'summary', title: 'Verfahrenszusammenfassung', sourceUrl: DASHBOARD_URL, text: summary.rawText,
    })];
    const summaryDom = summary.dialogHtml ? cheerio.load(summary.dialogHtml) : null;
    summary.facts = uniqueFacts([
      ...(summaryDom ? extractFactsFromDom(summaryDom, 'summary', DASHBOARD_URL) : []),
      ...knownSummaryFacts(summary, DASHBOARD_URL),
      ...(summary.cpvCodes || []).map((code, index) => makeFact({
        sectionKey: 'summary', key: `summary:cpv:${code}`, label: `CPV ${code}`,
        value: summary.cpvLabels?.[index] || code, normalizedValue: code, dataType: 'cpv', sourceUrl: DASHBOARD_URL,
      })),
    ].filter(Boolean));
    const detailBundle = {
      metadata: {
        portal: 'niedersachsen', portalProjectId, summary,
        electronicSubmission: summary.electronicSubmission,
      },
      crawlKind,
      fullCrawlSucceeded,
      lots: [], criteria: [], documents: [], messages: [], textSections: summary.textSections, facts: summary.facts, snapshots: [
        { kind: 'ni:summary', sourceUrl: DASHBOARD_URL, content: summary.dialogHtml || summary.rawText, mimeType: 'text/html' },
      ],
      completeness: { overall: 'partial', sections: { summary: 'complete', announcement: 'empty', documents: 'empty', communication: 'not_offered' } },
    };
    const announcementTabAvailable = await clickDialogTab(page, 'Bekanntmachung');
    await page.waitForTimeout(250);
    const announcement = await page.evaluate(() => {
      const frame = document.querySelector('.dx-dialog iframe, [role="dialog"] iframe, iframe');
      return { iframeSrc: frame?.src || frame?.getAttribute('src') || null, html: frame?.outerHTML || '' };
    });
    let announcementUrl = announcement.iframeSrc;
    let announcementText = '';
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameData = await frame.evaluate(() => {
          const links = [...document.querySelectorAll('a[href]')];
          return {
            linkHref: links.find((a) => /DirectDocload|Bekanntmach|\.pdf(?:$|\?)/i.test(`${a.href} ${a.textContent || ''}`))?.href || null,
            text: document.body?.innerText || '',
          };
        });
        if (frameData.text && frameData.text.trim().length > announcementText.length) announcementText = frameData.text.trim();
        if (frameData.linkHref) { announcementUrl = frameData.linkHref; break; }
      } catch { /* Cross-origin frame – src bleibt ein reproduzierbarer Locator. */ }
    }
    const announcementIsFile = Boolean(announcementUrl && isDeferredDocumentRequest(announcementUrl));
    if (!announcementTabAvailable) {
      detailBundle.completeness.sections.announcement = 'unknown_structure';
    } else if (announcementIsFile) {
      detailBundle.documents.push({
        portalFileId: announcementUrl, filename: 'Bekanntmachung.pdf', category: 'announcement',
        mimeType: 'application/pdf', sourceUrl: DASHBOARD_URL,
        locator: { href: announcementUrl, iframe: announcement.iframeSrc }, accessStatus: 'public', downloadStatus: 'not_requested',
      });
      detailBundle.snapshots.push({
        kind: 'ni:announcement', sourceUrl: announcementUrl,
        content: announcement.html || announcementUrl, mimeType: 'text/html',
      });
      detailBundle.textSections.push(makeTextSection({
        sectionKey: 'announcement', title: 'Bekanntmachung', sourceUrl: announcementUrl,
        text: cleanDetailText(announcement.html || ''), status: 'document_deferred',
      }));
      detailBundle.facts.push(makeFact({
        sectionKey: 'announcement', key: 'announcement:locator', label: 'Bekanntmachung verfügbar',
        value: 'Dokument inventarisiert; Inhalt wird erst bei Nutzeranforderung geladen',
        normalizedValue: announcementUrl, dataType: 'document_locator', sourceUrl: DASHBOARD_URL,
      }));
      detailBundle.completeness.sections.announcement = 'document_deferred';
    } else if (announcementText) {
      detailBundle.snapshots.push({
        kind: 'ni:announcement-html', sourceUrl: announcementUrl || DASHBOARD_URL,
        content: announcementText, mimeType: 'text/html',
      });
      detailBundle.textSections.push(makeTextSection({
        sectionKey: 'announcement', title: 'Bekanntmachung', sourceUrl: announcementUrl || DASHBOARD_URL,
        text: announcementText, status: 'complete',
      }));
      detailBundle.completeness.sections.announcement = 'complete';
    } else if (announcementUrl) {
      detailBundle.textSections.push(makeTextSection({
        sectionKey: 'announcement', title: 'Bekanntmachung', sourceUrl: announcementUrl,
        text: '', status: 'unknown_structure',
      }));
      detailBundle.completeness.sections.announcement = 'unknown_structure';
    } else detailBundle.completeness.sections.announcement = 'empty';
    const documentsTabAvailable = await clickDialogTab(page, 'Dokumente');
    await page.waitForTimeout(250);
    const docs = await extractDocumentsFromDialog(page);
    docs.documents = docs.documents.map((document) => ({
      ...document,
      portalFileId: document.portalFileId
        || `file-${contentHash(document.filename, document.publishedAt, docs.endpoint).slice(0, 32)}`,
    }));
    detailBundle.documents.push(...docs.documents);
    detailBundle.metadata.documentsEndpoint = docs.endpoint;
    detailBundle.snapshots.push({ kind: 'ni:documents', sourceUrl: DASHBOARD_URL, content: docs.html, mimeType: 'text/html' });
    detailBundle.textSections.push(makeTextSection({
      sectionKey: 'documents', title: 'Dokumentinventar', sourceUrl: DASHBOARD_URL,
      text: docs.text || '', status: !documentsTabAvailable ? 'unknown_structure' : (docs.loginRequired ? 'login_required' : 'complete'),
    }));
    detailBundle.facts.push(makeFact({
      sectionKey: 'documents', key: 'documents:count', label: 'Dokumente inventarisiert',
      value: String(docs.documents.length), normalizedValue: docs.documents.length, dataType: 'integer', sourceUrl: DASHBOARD_URL,
    }));
    detailBundle.completeness.sections.documents = !documentsTabAvailable
      ? 'unknown_structure'
      : (docs.loginRequired
        ? 'login_required'
        : (!docs.html ? 'unknown_structure' : (docs.documents.length ? 'complete' : 'empty')));
    if (docs.loginRequired) detailBundle.metadata.loginRequired = true;

    // Kommunikation/Bieterfragen ist ein eigener Dialogbereich. Manche
    // Portalvarianten benennen den Tab unterschiedlich; wir probieren die
    // bekannten Bezeichnungen und inventarisieren die Anhänge zusätzlich.
    const communicationTabAvailable = (await clickDialogTab(page, 'Kommunikation'))
      || (await clickDialogTab(page, 'Bieterfragen'))
      || (await clickDialogTab(page, 'Nachrichten'));
    await page.waitForTimeout(250);
    const rawMessages = await extractMessagesFromDialog(page);
    const messages = rawMessages.map((message) => ({
      ...message,
      portalMessageId: message.portalMessageId
        || `message-${contentHash(message.subject, message.publishedAt, message.body).slice(0, 32)}`,
    })).filter((message, index, all) => all.findIndex((candidate) =>
      candidate.portalMessageId === message.portalMessageId && candidate.body === message.body) === index);
    detailBundle.messages.push(...messages);
    for (const message of messages) {
      for (const attachment of message.attachments || []) {
        if (!attachment?.href) continue;
        const filename = attachment.filename || attachment.href.split('/').pop()?.split('?')[0] || 'Anhang';
        if (detailBundle.documents.some((document) => document.portalFileId === attachment.href && document.filename === filename)) continue;
        detailBundle.documents.push({
          portalFileId: attachment.href,
          category: 'communication_attachment', filename,
          mimeType: /\.pdf(?:$|\?)/i.test(filename) ? 'application/pdf' : null,
          sourceUrl: DASHBOARD_URL,
          locator: { href: attachment.href, pageUrl: DASHBOARD_URL, messageId: message.portalMessageId },
          accessStatus: 'public', downloadStatus: 'not_requested',
        });
      }
    }
    detailBundle.snapshots.push({
      kind: 'ni:communication', sourceUrl: DASHBOARD_URL,
      content: await page.evaluate(() => document.querySelector('[role="dialog"], .dx-dialog')?.outerHTML || ''),
      mimeType: 'text/html',
    });
    const communicationText = await page.evaluate(() => document.querySelector('[role="dialog"], .dx-dialog')?.innerText || '');
    detailBundle.textSections.push(makeTextSection({
      sectionKey: 'communication', title: 'Kommunikation', sourceUrl: DASHBOARD_URL,
      text: communicationText, status: communicationTabAvailable ? 'complete' : 'not_offered',
    }));
    detailBundle.facts.push(makeFact({
      sectionKey: 'communication', key: 'communication:count', label: 'Nachrichten inventarisiert',
      value: String(messages.length), normalizedValue: messages.length, dataType: 'integer', sourceUrl: DASHBOARD_URL,
    }));
    const communicationLoginRequired = communicationTabAvailable && await page.evaluate(() => {
      const text = document.querySelector('[role="dialog"], .dx-dialog')?.innerText || '';
      return /(?:anmelden|login|registriert)/i.test(text) && !/(?:Bieterfrage|Nachricht|Mitteilung|Antwort)/i.test(text);
    });
    if (communicationLoginRequired) detailBundle.metadata.loginRequired = true;
    detailBundle.completeness.sections.communication = communicationLoginRequired
      ? 'login_required'
      : (messages.length ? 'complete' : (communicationTabAvailable ? 'empty' : 'not_offered'));
    detailBundle.facts = uniqueFacts(detailBundle.facts);
    detailBundle.textSections = detailBundle.textSections.filter((section, index, all) =>
      all.findIndex((candidate) => candidate.sectionKey === section.sectionKey) === index);
    detailBundle.completeness.overall = Object.values(detailBundle.completeness.sections)
      .some((value) => String(value).startsWith('temporary') || ['login_required', 'unknown_structure', 'document_deferred'].includes(value)) ? 'partial' : 'complete';
    // Ein Vollcrawl darf Sichtbarkeiten nur dann fortschreiben, wenn alle
    // angebotenen Bereiche erfolgreich verarbeitet wurden. Login- und
    // Strukturfehler dürfen vorhandene Dokumente nicht als verschwunden
    // markieren.
    detailBundle.fullCrawlSucceeded = Boolean(fullCrawlSucceeded && detailBundle.completeness.overall === 'complete');
    return {
      ...summary,
      portalProjectId: portalProjectId || summary.portalProjectId,
      publicationDate: normalizeDate(summary.publicationDate) || summary.publicationDate,
      submissionDeadline: normalizeDate(summary.submissionDeadline) || summary.submissionDeadline,
      questionDeadline: normalizeDate(summary.questionDeadline) || summary.questionDeadline,
      tenderType: summary.procurementRegulation,
      documentUrl: announcementIsFile ? announcementUrl : null,
      detailStatus: detailBundle.completeness.overall,
      fullCrawlSucceeded: detailBundle.fullCrawlSucceeded,
      detailCompleteness: detailBundle.completeness,
      portalMetadata: detailBundle.metadata,
      textSections: detailBundle.textSections,
      facts: detailBundle.facts,
      detailBundle,
    };
  } finally {
    await page.evaluate(() => {
      const d = [...document.querySelectorAll('.dx-dialog, [role="dialog"], .modal')].find((x) => /Verfahren/i.test(x.textContent || ''));
      const btn = d && [...d.querySelectorAll('button')].find((b) => /schließen|close/i.test(b.textContent || '') || b.getAttribute('aria-label')?.match(/schließen|close/i));
      if (btn) btn.click();
    }).catch(() => {});
    await page.waitForTimeout(250);
  }
}

/**
 * Öffnet das Verfahrens-Detail für eine Grid-Zeile (Klick auf die
 * BekSummary-Verknüpfung), liest den CPV aus und schließt den Dialog wieder.
 * Fehlschläge werden abgefangen – sie dürfen den Crawl nicht abbrechen.
 */
async function openAndExtractCpv(page, liveRow) {
  // Ggf. einen noch offenen Detail-Dialog schließen (verhindert Stapelung).
  await page
    .evaluate(() => {
      const d = [...document.querySelectorAll('.dx-dialog, [role="dialog"], .modal')].find(
        (x) => /CPV-Klassifizierung/i.test(x.textContent) && /Verfahren/i.test(x.textContent)
      );
      const btn = d && [...d.querySelectorAll('button')].find((b) => /schließen/i.test(b.textContent));
      if (btn) btn.click();
    })
    .catch(() => {});
  const link = await liveRow.$('a.BekSummary');
  if (!link) return { cpvCodes: null, cpvLabels: null };
  try {
    await link.evaluate((el) => el.click());
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('.dx-dialog, [role="dialog"], .modal')].some(
            (d) => /CPV-Klassifizierung/i.test(d.textContent) && /Verfahren/i.test(d.textContent)
          ),
        { timeout: 8000 }
      )
      .catch(() => {});
    return await extractDetailCpv(page);
  } catch {
    return { cpvCodes: null, cpvLabels: null };
  } finally {
    await page
      .evaluate(() => {
        const d = [...document.querySelectorAll('.dx-dialog, [role="dialog"], .modal')].find(
          (x) => /CPV-Klassifizierung/i.test(x.textContent) && /Verfahren/i.test(x.textContent)
        );
        const btn = d && [...d.querySelectorAll('button')].find((b) => /schließen/i.test(b.textContent));
        if (btn) btn.click();
      })
      .catch(() => {});
    await page.waitForTimeout(400);
  }
}

/**
 * Liefert die Nummer der nächsten Seite (DevExtreme .dx-page-Links) oder null.
 * Wir klicken im Crawl-Loop auf die Seitenzahl, nicht auf einen href.
 */
async function getNextPageNumber(page, currentPage) {
  return page.evaluate(
    ({ pagerSelector, pageLinkSelector, currentPage: cp }) => {
      const pager = document.querySelector(pagerSelector);
      if (!pager) return null;
      const links = [...pager.querySelectorAll(pageLinkSelector)];
      const numbers = links
        .map((l) => Number(l.textContent.trim()))
        .filter((n) => Number.isInteger(n));
      if (!numbers.length) return null;
      const maxPage = Math.max(...numbers);
      return cp < maxPage ? cp + 1 : null;
    },
    { pagerSelector: PAGER_SELECTOR, pageLinkSelector: PAGE_LINK_SELECTOR, currentPage }
  );
}

/**
 * Führt den Niedersachsen-Browser-Crawl aus.
 */
export async function runNiedersachsenJob({ job, onProgress = () => {} } = {}) {
  const checkpoint = getCheckpoint('niedersachsen');
  const detailBackfill = job?.mode === 'detail_backfill';
  const mode = detailBackfill ? 'backfill' : (checkpoint.backfill_complete ? 'incremental' : 'backfill');
  const log = startCrawlLog('niedersachsen');
  const stats = {
    pagesDone: 0,
    itemsDiscovered: 0,
    itemsNew: 0,
    itemsChanged: 0,
    detailPagesSuccess: 0,
    detailPagesFailed: 0,
    tendersComplete: 0,
    tendersPartial: 0,
    documentsInventoried: 0,
    messagesInventoried: 0,
    loginRequired: 0,
    unknownPortalStructure: 0,
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
    await context.route('**/*', async (route) => {
      if (isDeferredDocumentRequest(route.request().url())) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
    // Auf das Rendern der Ergebnisliste warten (SPA)
    await page.waitForSelector(ROW_SELECTOR, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(config.browserPageWaitMs);

    // Seitengröße auf 100 setzen, um die Anzahl der zu durchsuchenden
    // Seiten zu minimieren (DevExtreme-Pager: .dx-page-size "100").
    const pageSizeSet = await page.evaluate(() => {
      const size = [...document.querySelectorAll('.dx-page-size')].find(
        (s) => s.textContent.trim() === '100'
      );
      if (size && !size.classList.contains('dx-selection')) {
        size.click();
        return true;
      }
      return false;
    });
    if (pageSizeSet) {
      await page.waitForTimeout(config.browserPageWaitMs);
      await page.waitForSelector(ROW_SELECTOR, { timeout: 60000 }).catch(() => {});
    }

    let pageNumber = 1;
    let backfillDone = false;
    let incrementalDone = false;
    const newTenderIds = [];

    while (true) {
      if (job?.cancel_requested) {
        throw Object.assign(new Error('Job wurde abgebrochen'), { cancelled: true });
      }

      const rows = await extractRows(page);
      if (!rows.length) {
        console.warn('[niedersachsen] Keine Ergebniszeilen gefunden – DOM/Selektor geändert?');
        break;
      }

      let pageAllKnown = true;
      for (let i = 0; i < rows.length; i += 1) {
        const raw = rows[i];
        const tender = parseRow(raw);
        if (!tender) continue;
        const existing = tender.portalProjectId
          ? (getTenderByPortalProject('niedersachsen', tender.portalProjectId)
            || getTenderByExternalId('niedersachsen', tender.externalId))
          : getTenderByExternalId('niedersachsen', tender.externalId);
        const cache = tender.portalProjectId ? getDiscoveryCache('niedersachsen', tender.portalProjectId) : null;
        let detail = null;
        // CPVs und Scope-Entscheidung werden vor dem Filter aus dem
        // Zusammenfassungsdialog gelesen. Bereits entschiedene Kandidaten
        // bleiben im Discovery-Cache und werden nicht erneut geöffnet.
        const cacheTimestamp = cache?.last_detail_at ? Date.parse(cache.last_detail_at) : NaN;
        const cacheAge = Number.isFinite(cacheTimestamp) ? Date.now() - cacheTimestamp : Infinity;
        const fingerprintChanged = Boolean(cache && cache.discovery_fingerprint !== tender.discoveryFingerprint);
        const needsDetail = detailBackfill
          || !cache
          || fingerprintChanged
          || (cache.in_scope
            ? (!cache.detail_status || !existing || detailDue(existing))
            : cacheAge >= REJECTED_CACHE_REFRESH_MS);
        if (needsDetail) {
          const liveRow = (await page.$$('tr.dx-row.dx-data-row'))[i];
          if (liveRow) {
            detail = await openAndExtractDetail(page, liveRow, tender.portalProjectId, {
              crawlKind: mode === 'backfill' ? 'full' : 'incremental',
              fullCrawlSucceeded: true,
            });
            if (detail) {
              stats.detailPagesSuccess += 1;
              stats.documentsInventoried += detail.detailBundle?.documents?.length || 0;
              stats.messagesInventoried += detail.detailBundle?.messages?.length || 0;
              if (detail.detailBundle?.completeness?.overall === 'complete') stats.tendersComplete += 1;
              else stats.tendersPartial += 1;
              if (detail.portalMetadata?.loginRequired) stats.loginRequired += 1;
              if (detail.detailBundle?.completeness?.sections
                && Object.values(detail.detailBundle.completeness.sections)
                  .some((value) => String(value).startsWith('unknown_structure'))) {
                stats.unknownPortalStructure += 1;
              }
              if (isSpecificProjectTitle(detail.title)) tender.title = detail.title;
              tender.referenceNumber = detail.referenceNumber || tender.referenceNumber;
              tender.contractingAuthority = detail.contractingAuthority || tender.contractingAuthority;
              tender.portalStatus = detail.portalStatus || tender.portalStatus;
              tender.procedureType = detail.procedureType || tender.procedureType;
              tender.tenderType = detail.procurementRegulation || tender.tenderType;
              tender.publicationDate = detail.publicationDate || tender.publicationDate;
              tender.submissionDeadline = detail.submissionDeadline || tender.submissionDeadline;
              tender.bindingPeriod = detail.bindingPeriod || tender.bindingPeriod;
              tender.questionDeadline = detail.questionDeadline || null;
              tender.openingDate = detail.openingDate || tender.openingDate;
              tender.contractDuration = detail.contractDuration || tender.contractDuration;
              tender.description = detail.description || tender.description;
              tender.placeOfPerformance = detail.placeOfPerformance || tender.placeOfPerformance;
              tender.awardCriteria = detail.awardCriteria || tender.awardCriteria;
              tender.estimatedValueCents = detail.estimatedValueCents ?? tender.estimatedValueCents;
              tender.estimatedValueCurrency = detail.estimatedValueCurrency || tender.estimatedValueCurrency;
              tender.cpvCodes = detail.cpvCodes?.length ? detail.cpvCodes : tender.cpvCodes;
              tender.cpvLabels = detail.cpvLabels?.length ? detail.cpvLabels : tender.cpvLabels;
              tender.documentUrl = detail.documentUrl || tender.documentUrl;
              tender.detailStatus = detail.detailStatus;
              tender.detailCrawlKind = detail.detailBundle?.crawlKind || 'incremental';
              tender.fullCrawlSucceeded = detail.detailBundle?.fullCrawlSucceeded || false;
              tender.detailCompleteness = detail.detailCompleteness;
              tender.portalMetadata = detail.portalMetadata;
              tender.detailBundle = detail.detailBundle;
            } else stats.detailPagesFailed += 1;
          }
        } else if (cache?.cpv_codes) {
          try { tender.cpvCodes = JSON.parse(cache.cpv_codes); } catch { /* leerer Cache */ }
          try { tender.cpvLabels = cache.cpv_labels ? JSON.parse(cache.cpv_labels) : null; } catch { /* leerer Cache */ }
        }

        const inScope = matchesInterestCategories(tender);
        if (tender.portalProjectId) {
          saveDiscoveryCache({
            sourceId: 'niedersachsen', portalProjectId: tender.portalProjectId,
            title: tender.title, contractingAuthority: tender.contractingAuthority,
            publicationDate: tender.publicationDate, submissionDeadline: tender.submissionDeadline,
            cpvCodes: tender.cpvCodes, cpvLabels: tender.cpvLabels, inScope,
            discoveryFingerprint: tender.discoveryFingerprint,
            detailAt: detail ? new Date().toISOString() : null,
            detailStatus: detail?.detailStatus || null,
          });
        }
        if (!inScope) continue;

        stats.itemsDiscovered += 1;
        const result = saveTender(tender);
        if (result.isNew) {
          stats.itemsNew += 1;
          newTenderIds.push({ id: result.tenderId, url: tender.url });
        } else if (result.changed) {
          stats.itemsChanged += 1;
        }
        if (result.isNew || result.changed) pageAllKnown = false;
        if (tender.publicationDate && (!stats.oldestPublicationDate || tender.publicationDate < stats.oldestPublicationDate)) {
          stats.oldestPublicationDate = tender.publicationDate;
        }
      }
      stats.pagesDone += 1;
      stats.knownStreak = pageAllKnown ? stats.knownStreak + 1 : 0;

      backfillDone = !detailBackfill && mode === 'backfill'
        && Boolean(stats.oldestPublicationDate) && stats.oldestPublicationDate < cutoffIso;
      incrementalDone = mode === 'incremental' && stats.knownStreak >= config.evergabeKnownPageStop;

      updateCheckpoint('niedersachsen', {
        backfillComplete: mode === 'backfill' ? (backfillDone ? 1 : 0) : undefined,
        oldestPublicationDate: stats.oldestPublicationDate,
        lastPageKey: String(pageNumber),
        knownPageStreak: stats.knownStreak,
      });
      onProgress({ ...stats, pageNumber, backfillDone, incrementalDone });

      if (backfillDone || incrementalDone) break;

      const nextPage = await getNextPageNumber(page, pageNumber);
      if (!nextPage) {
        if (mode === 'backfill') {
          backfillDone = true;
          updateCheckpoint('niedersachsen', {
            backfillComplete: 1,
            oldestPublicationDate: stats.oldestPublicationDate,
            lastPageKey: String(pageNumber),
            knownPageStreak: stats.knownStreak,
          });
          onProgress({ ...stats, pageNumber, backfillDone, incrementalDone });
        }
        break;
      }

      // DevExtreme-Pager: auf die Seitenzahl klicken (kein href-Navigation)
      const clicked = await page.evaluate(
        ({ pagerSelector, pageLinkSelector, target }) => {
          const pager = document.querySelector(pagerSelector);
          if (!pager) return false;
          const link = [...pager.querySelectorAll(pageLinkSelector)].find(
            (l) => Number(l.textContent.trim()) === target
          );
          if (!link) return false;
          link.click();
          return true;
        },
        { pagerSelector: PAGER_SELECTOR, pageLinkSelector: PAGE_LINK_SELECTOR, target: nextPage }
      );
      if (!clicked) {
        console.warn('[niedersachsen] Pager-Link für Seite ' + nextPage + ' nicht klickbar.');
        break;
      }
      await page.waitForSelector(ROW_SELECTOR, { timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(config.browserPageWaitMs);
      pageNumber = nextPage;
    }

    finishCrawlLog({
      id: log.id,
      status: 'completed',
      itemsDiscovered: stats.itemsDiscovered,
      itemsNew: stats.itemsNew,
      itemsChanged: stats.itemsChanged,
      errors: 0,
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
      detailPagesSuccess: stats.detailPagesSuccess,
      detailPagesFailed: stats.detailPagesFailed,
      tendersComplete: stats.tendersComplete,
      tendersPartial: stats.tendersPartial,
      documentsInventoried: stats.documentsInventoried,
      messagesInventoried: stats.messagesInventoried,
      loginRequired: stats.loginRequired,
      unknownPortalStructure: stats.unknownPortalStructure,
    });
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

export default { meta, run: runNiedersachsenJob, profileDir, parseRow, parseDetailSummaryHtml };
