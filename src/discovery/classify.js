/**
 * Deterministische Klassifikation eines entdeckten Dokuments:
 * 'funding' | 'tender' | 'unknown', mit Konfidenz und Begründung.
 */

const TENDER_TERMS = [
  'vergabe', 'vergabeverfahren', 'ausschreibung', 'offenes verfahren',
  'nichtoffenes verfahren', 'verhandlungsverfahren', 'teilnahmewettbewerb',
  'losnummer', 'cpv', 'leistungsbeschreibung', 'angebotsfrist', 'angebot eröffnung',
  'zusschlags', 'bieter', 'gebotstermin', 'eignungskriterien', 'zuschlagskriterien',
  'elektronische ausschreibung', 'vergabekammer', 'european union', 'ojs veröffentlichung',
];

const FUNDING_TERMS = [
  'foerderrichtlinie', 'förderrichtlinie', 'foerderprogramm', 'förderprogramm',
  'foerderaufruf', 'förderaufruf', 'foerderbekanntmachung', 'förderbekanntmachung',
  'foerdermittel', 'fördermittel', 'foerderung', 'förderung', 'zuwendung',
  'zuwendungsbescheid', 'zuwendungszweck', 'antragsberechtigt', 'zuwendungsvoraussetzung',
  'foerderquote', 'förderquote', 'foerderfaehige', 'förderfähige', 'projektfoerderung',
  'projektförderung', 'einzelprojekt', 'verbundprojekt', 'modul', 'metavorhaben',
  'antragsfrist', 'einreichungsfrist', 'antragstellung', 'teilnahmeantrag', 'skizze',
  'interessenbekundung', 'foerdergeber', 'fördergeber', 'foerderstelle', 'förderstelle',
  'fördergegenstand', 'foerdergegenstand', 'zuwendungsfaehige', 'zuwendungsfähige',
  'foerderfaehigkeit', 'förderfähigkeit', 'hochschulforschung', 'anwendungsnahe forschung',
];

const TENDER_STRONG = ['vergabeverfahren', 'offenes verfahren', 'teilnahmewettbewerb', 'angebotsfrist', 'vergabekammer', 'bieter', 'zuschlagskriterien'];
const FUNDING_STRONG = ['foerderrichtlinie', 'förderrichtlinie', 'foerderaufruf', 'förderaufruf', 'zuwendung', 'antragsberechtigt', 'foerderquote', 'förderquote', 'foerdergeber', 'fördergeber', 'foerderbekanntmachung', 'förderbekanntmachung'];

function countMatches(text, terms) {
  const lower = ` ${text.toLowerCase()} `;
  let count = 0;
  for (const term of terms) {
    // Wortgrenzen mit Umlaut-Unterstützung
    if (new RegExp(`(^|[^a-zäöüß])${term}([^a-zäöüß]|$)`, 'i').test(lower)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Klassifiziert einen entdeckten Treffer.
 * @param {string} title
 * @param {string|null} rawText
 * @param {object} opts { declaredKind, useLlm }
 * @returns {{classification: 'funding'|'tender'|'unknown', confidence, reason}}
 */
export function classifyDocument(title, rawText, { declaredKind = 'mixed' } = {}) {
  const haystack = `${title || ''} ${rawText || ''}`;
  const fundingHits = countMatches(haystack, FUNDING_TERMS);
  const tenderHits = countMatches(haystack, TENDER_TERMS);
  const fundingStrong = countMatches(haystack, FUNDING_STRONG);
  const tenderStrong = countMatches(haystack, TENDER_STRONG);

  let classification = 'unknown';
  let confidence = 0.3;
  let reason = '';

  const fundingScore = fundingHits + fundingStrong * 2;
  const tenderScore = tenderHits + tenderStrong * 2;

  if (fundingStrong > 0 && fundingScore >= tenderScore + 1) {
    classification = 'funding';
    confidence = Math.min(0.95, 0.5 + fundingStrong * 0.15);
    reason = `${fundingStrong} starke Förderbegriffe, ${tenderHits} Vergabebegriffe`;
  } else if (tenderStrong > 0 && tenderScore >= fundingScore + 1) {
    classification = 'tender';
    confidence = Math.min(0.95, 0.5 + tenderStrong * 0.15);
    reason = `${tenderStrong} starke Vergabebegriffe, ${fundingHits} Förderbegriffe`;
  } else if (fundingScore >= 3 && fundingScore >= tenderScore) {
    classification = 'funding';
    confidence = Math.min(0.85, 0.4 + fundingScore * 0.1);
    reason = `Überwiegend Förderbegriffe (${fundingHits}), Vergabebegriffe ${tenderHits}`;
  } else if (tenderScore >= 3 && tenderScore >= fundingScore) {
    classification = 'tender';
    confidence = Math.min(0.85, 0.4 + tenderScore * 0.1);
    reason = `Überwiegend Vergabebegriffe (${tenderHits}), Förderbegriffe ${fundingHits}`;
  } else if (fundingScore > 0 || tenderScore > 0) {
    classification = fundingScore > tenderScore ? 'funding' : 'tender';
    confidence = 0.5;
    reason = `Schwache Signale (Förderung ${fundingHits}, Vergabe ${tenderHits})`;
  } else {
    reason = 'Keine eindeutigen Förder-/Vergabesignale';
  }

  // Deklaration der Quelle als Hinweis nutzen
  if (classification === 'unknown') {
    if (declaredKind === 'funding') {
      classification = 'funding';
      confidence = 0.5;
      reason = 'Quelle ist als Förderquelle deklariert, keine Textsignale';
    } else if (declaredKind === 'tender') {
      classification = 'tender';
      confidence = 0.5;
      reason = 'Quelle ist als Vergabequelle deklariert, keine Textsignale';
    }
  }

  return { classification, confidence, reason };
}

export default { classifyDocument };
