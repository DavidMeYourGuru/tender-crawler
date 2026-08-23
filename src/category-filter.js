/**
 * Kategorie-Filter für den Interessenbereich des Nutzers.
 *
 * Legacy-/Anwendungsfilter für Quellen, die zusätzlich zur Quellensuche
 * lokal nach Interessen einschränken sollen. Der NRW-Adapter verwendet ihn
 * bewusst nicht mehr: NRW wird zunächst ausschließlich über aktive CPVs
 * vorgefiltert und innerhalb dieser Bereiche vollständig gespeichert.
 *
 * Filterlogik (ODER-Verknüpfung):
 *  - CPV-Codes (serverseitig/präzise): Bau (45xxxx), Landschaftsarchitektur
 *    (7122, 714), Garten/Landschaftspflege (773).
 *  - Stichworte (Substring auf Titel+Beschreibung): Schule, Kita,
 *    Kindertagesstätte, Kindergarten, Spielplatz, Schulhof, Spielgerät.
 *
 * Die Funktion bleibt für Niedersachsen und spätere lokale Suchfälle
 * verfügbar, ist aber keine globale Crawl-Regel.
 */

// CPV-Präfixe (erste Ziffern des 8-stelligen CPV-Codes, Versions-Suffix ignoriert).
export const INTEREST_CPV_PREFIXES = [
  '45', // Bauarbeiten (alle) – Nutzerinteresse "Bau"
  '7122', // Architekturentwurf (u. a. Landschaftsarchitektur-Büros)
  '714', // Stadt- und Landschaftsplanung
  '773', // Landschaftspflege und Gartenbau
];

// Stichworte für Nutzungsarten, die über CPV schlecht abbildbar sind.
export const INTEREST_KEYWORDS = [
  'schule',
  'schulhof',
  'schulgebäude',
  'kita',
  'kindertagesstätte',
  'kindertageseinrichtung',
  'kindergarten',
  'spielplatz',
  'spielgerät',
  'spielplatzgerät',
];

/**
 * Normalisiert einen CPV-Code auf seine führenden Ziffern (max. 4).
 * '45000000-7' -> '4500', '71400000-2' -> '7140'
 */
function normalizeCpvPrefix(code) {
  if (!code) return '';
  return String(code).replace(/[^0-9]/g, '').slice(0, 4);
}

/**
 * Prüft, ob ein Tender in den Interessenbereich fällt.
 * @param {object} tender – mind. { cpvCodes?, title?, description? }
 * @returns {boolean}
 */
export function matchesInterestCategories(tender) {
  if (!tender) return false;

  // 1) CPV-Codes
  const cpvCodes = Array.isArray(tender.cpvCodes)
    ? tender.cpvCodes
    : tender.cpvCodes
      ? [tender.cpvCodes]
      : [];
  for (const code of cpvCodes) {
    const prefix = normalizeCpvPrefix(code);
    if (INTEREST_CPV_PREFIXES.some((p) => prefix.startsWith(p))) {
      return true;
    }
  }

  // 2) Stichworte auf Titel + Beschreibung
  const haystack = `${tender.title || ''} ${tender.description || ''}`.toLowerCase();
  if (INTEREST_KEYWORDS.some((kw) => haystack.includes(kw))) {
    return true;
  }

  return false;
}

export default { INTEREST_CPV_PREFIXES, INTEREST_KEYWORDS, matchesInterestCategories };
