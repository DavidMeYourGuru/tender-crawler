/**
 * Verarbeitet entdeckte Dokumente und führt sie der fachlichen
 * Speicherung zu (Förderprogramm oder Ausschreibung/Tender).
 */
import { fetchSourceDetail } from './sources.js';
import { extractFundingProgram } from '../funding/extractor.js';
import { saveFundingProgram, saveTender, linkDiscoveredDocument, getCrawlSource, ensureSourceRow, db } from '../db.js';
import { contentHash, normalizeDate, deriveStatus } from '../utils.js';
import config from '../config.js';

/**
 * Verarbeitet ein als 'funding' klassifiziertes Dokument zu einem Förderprogramm.
 */
export async function processFundingDocument(discovered, { source, llmEnabled = config.fundingLlmEnabled } = {}) {
  const docs = [await fetchSourceDetail(discovered.canonical_url, { source })];
  const program = await extractFundingProgram(docs, {
    base: {
      title: discovered.title || docs[0].title,
      publicationDate: discovered.publication_date || null,
      primaryUrl: discovered.canonical_url,
    },
  });
  program.sourceId = source ? `url:${source.source_key}` : 'url';
  program.externalId = discovered.id;
  program.extractedAt = new Date().toISOString();
  program.extractionModel = llmEnabled ? 'hybrid' : 'deterministic';

  const result = saveFundingProgram(program);
  linkDiscoveredDocument(discovered.id, { fundingId: result.programId });
  return { kind: 'funding', programId: result.programId, isNew: result.isNew, changed: result.changed };
}

/**
 * Baut aus einer Detailseite ein minimales Tender-Objekt.
 */
function buildTenderFromDetail(doc, discovered, source) {
  const text = doc.text || '';
  const deadlineMatch = text.match(/(?:Angebotsfrist|Bewerbungsfrist|Abgabefrist|Frist|Einreichungsfrist)(?:\s*:\s*|\s+)(\d{1,2}\.\d{1,2}\.\d{4})/i)
    || text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
  const submissionDeadline = deadlineMatch ? normalizeDate(deadlineMatch[1]) : null;
  const authorityMatch = text.match(/(?:Auftraggeber|Vergabestelle|Beschaffungsstelle)\s*:\s*([^\n|]{3,120})/i);
  const pubMatch = text.match(/(?:Veröffentlicht|Veröffentlichung|Bekanntmachung)\s*:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);

  const externalId = `discovered-${discovered.id}`;
  const title = discovered.title || doc.title || 'Unbenannte Ausschreibung';
  const url = discovered.canonical_url;
  const status = deriveStatus(submissionDeadline, 'open');

  return {
    sourceId: source ? `url:${source.source_key}` : 'url',
    externalId,
    title,
    url,
    description: text.slice(0, 4000) || null,
    contractingAuthority: authorityMatch ? authorityMatch[1].trim() : null,
    cpvCodes: null,
    cpvLabels: null,
    estimatedValueCents: null,
    estimatedValueCurrency: 'EUR',
    placeOfPerformance: null,
    awardCriteria: null,
    tenderType: null,
    publicationDate: pubMatch ? normalizeDate(pubMatch[1]) : discovered.publication_date || null,
    submissionDeadline,
    openingDate: null,
    contractDuration: null,
    documentUrl: null,
    status,
    contentHash: contentHash(title, url, text.slice(0, 500), submissionDeadline),
  };
}

/**
 * Verarbeitet ein als 'tender' klassifiziertes Dokument zu einer Ausschreibung.
 */
export async function processTenderDocument(discovered, { source } = {}) {
  const doc = await fetchSourceDetail(discovered.canonical_url, { source });
  const tender = buildTenderFromDetail(doc, discovered, source);
  // sources-FK erfüllen: `url:<key>` muss in `sources` existieren, bevor saveTender läuft.
  ensureSourceRow({ id: tender.sourceId, name: source?.name || 'Verwaltete Quelle', region: source?.region || 'de', type: 'html', enabled: 0 });
  const result = saveTender(tender);
  linkDiscoveredDocument(discovered.id, { tenderId: result.tenderId });
  return { kind: 'tender', tenderId: result.tenderId, isNew: result.isNew, changed: result.changed };
}

/**
 * Routet ein entdecktes Dokument an die passende Verarbeitung.
 */
export async function processDiscovered(discovered, { source } = {}) {
  if (discovered.classification === 'funding') {
    return processFundingDocument(discovered, { source });
  }
  if (discovered.classification === 'tender') {
    return processTenderDocument(discovered, { source });
  }
  return { kind: 'unknown', skipped: true };
}

/**
 * Verarbeitet alle 'new'-Dokumente der Inbox, die bereits klassifiziert wurden.
 */
export async function processDiscoveredInbox({ classification = null, limit = 50 } = {}) {
  const conditions = ["status = 'new'"];
  const params = {};
  if (classification) {
    conditions.push('classification = @classification');
    params.classification = classification;
  }
  const docs = dbQuery(conditions, params, limit);
  const results = [];
  for (const doc of docs) {
    try {
      const source = getSource(doc.source_id);
      results.push(await processDiscovered(doc, { source }));
    } catch (error) {
      results.push({ id: doc.id, error: error.message });
    }
  }
  return results;
}

function dbQuery(conditions, params, limit) {
  return db.prepare(`SELECT * FROM discovered_documents WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT @limit`)
    .all({ ...params, limit });
}

function getSource(id) {
  return id ? getCrawlSource(id) : null;
}

export default { processFundingDocument, processTenderDocument, processDiscovered, processDiscoveredInbox };
