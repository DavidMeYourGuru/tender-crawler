import crypto from 'node:crypto';

/**
 * Erzeugt einen SHA-256-Hash über die relevanten Inhaltsfelder.
 * Wird zur Change-Detection verwendet.
 */
export function contentHash(...parts) {
  const normalized = parts
    .map((part) => (part == null ? '' : String(part).trim().toLowerCase()))
    .join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

const MONTHS_DE = {
  Januar: 1, Februar: 2, März: 3, Maerz: 3, 'März': 3,
  April: 4, Mai: 5, Juni: 6, Juli: 7, August: 8, September: 9,
  Oktober: 10, November: 11, Dezember: 12,
};

/**
 * Normalisiert verschiedene Datumsformate zu ISO 8601 (YYYY-MM-DD).
 * Unterstützt: ISO, DD.MM.YYYY, YYYY-MM-DD, "15. August 2026", etc.
 * Gibt null zurück, wenn kein Datum erkannt wird.
 */
export function normalizeDate(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;

  // Bereits ISO (YYYY-MM-DD...)
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const [, y, m, d] = match;
    const date = `${y}-${m}-${d}`;
    return isValidIsoDate(date) ? date : null;
  }

  // DD.MM.YYYY oder DD.MM.YY
  match = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (match) {
    let [, d, m, y] = match;
    if (y.length === 2) y = `20${y}`;
    const paddedM = m.padStart(2, '0');
    const paddedD = d.padStart(2, '0');
    const date = `${y}-${paddedM}-${paddedD}`;
    return isValidIsoDate(date) ? date : null;
  }

  // "15. August 2026" oder "15. August 2026, 12:00"
  match = text.match(/(\d{1,2})\.\s+([A-Za-zäöüÄÖÜß]+)\s+(\d{4})/);
  if (match) {
    const [, d, monthName, y] = match;
    const m = MONTHS_DE[monthName] || MONTHS_DE[monthName.toLowerCase()];
    if (m) {
      const date = `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}`;
      return isValidIsoDate(date) ? date : null;
    }
  }

  // "2026-08-15T10:00:00" bereits abgedeckt; versuche Date.parse als Fallback
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) {
    const iso = new Date(parsed).toISOString().slice(0, 10);
    return isValidIsoDate(iso) ? iso : null;
  }

  return null;
}

function isValidIsoDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Berechnet die Tage bis zur Frist (submission_deadline).
 * Negative Werte bedeuten: Frist bereits abgelaufen.
 */
export function daysUntil(isoDate) {
  if (!isoDate) return null;
  const target = new Date(`${isoDate}T23:59:59`);
  const now = new Date();
  const diff = target.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

/**
 * Leitet den Status aus der Frist ab:
 * - Frist in < 7 Tagen → 'closing_soon'
 * - Frist abgelaufen → 'closed'
 * - sonst bleibt der übergebene Status
 */
export function deriveStatus(deadline, currentStatus = 'open') {
  const days = daysUntil(deadline);
  if (days == null) return currentStatus;
  if (days < 0) return 'closed';
  if (days <= 7) return 'closing_soon';
  return currentStatus === 'closing_soon' ? 'open' : currentStatus;
}

/**
 * Parst einen Geldbetrag ("1.250.000 EUR", "250000", "€ 50.000") zu Cent.
 */
export function parseMoneyToCents(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  const text = String(value)
    .replace(/€/g, '')
    .replace(/EUR/gi, '')
    .replace(/[^\d.,-]/g, '')
    .trim();
  if (!text) return null;
  let normalized = text;
  // "1.250.000,50" → 1250000.50 | "1,250,000.50" → 1250000.50
  if (normalized.includes(',')) {
    // Europäisches Format: Tausenderpunkt + Komma als Dezimaltrenner
    if (normalized.includes('.')) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else if (normalized.lastIndexOf(',') === normalized.length - 3) {
      normalized = normalized.replace(/,/g, '');
    } else {
      normalized = normalized.replace(',', '.');
    }
  } else {
    normalized = normalized.replace(/\./g, '');
  }
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/**
 * Formatiert Cent-Beträge für die Anzeige.
 */
export function formatCents(cents, currency = 'EUR') {
  if (cents == null) return null;
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/**
 * Trunkiert einen Text auf maxLength Zeichen.
 */
export function truncate(text, maxLength = 200) {
  if (!text) return '';
  const str = String(text);
  return str.length > maxLength ? `${str.slice(0, maxLength - 1)}…` : str;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Führt `fn` über die Elemente von `items` mit begrenzter Parallelität aus.
 * Liefert die Ergebnisse in Eingabereihenfolge zurück.
 * Fehler in einem Item werden NICHT abgefangen (Propagation wie Promise.all).
 */
export async function mapLimit(items, limit, fn) {
  const input = Array.from(items);
  const results = new Array(input.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, input.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = index;
      index += 1;
      if (i >= input.length) return;
      results[i] = await fn(input[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Extrahiert Domains aus URLs für die Anzeige.
 */
export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Normalisiert CPV-Codes/Labels aus den unterschiedlichen Quellenformaten
 * (String, String-Array, Objekt-Array mit code/label) in einheitliche
 * { cpvCodes, cpvLabels }-Felder. Codes werden auf 8 Ziffern reduziert.
 * Liefert null für beide, wenn nichts gefunden wurde.
 */
export function normalizeCpv(codes, labels) {
  const toArr = (v) => {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v ? [v] : [];
    return [v];
  };

  const cpvCodes = [];
  const cpvLabels = [];

  for (const c of toArr(codes)) {
    if (typeof c === 'string') {
      const code = c.replace(/[^0-9]/g, '').slice(0, 8);
      if (code) cpvCodes.push(code);
    } else if (c && typeof c === 'object') {
      const code = c.code || c.cpvCode || c.cpv || c.id;
      if (code != null) {
        const norm = String(code).replace(/[^0-9]/g, '').slice(0, 8);
        if (norm) cpvCodes.push(norm);
      }
      const label = c.label || c.cpvLabel || c.name || c.text;
      if (label != null && String(label).trim()) cpvLabels.push(String(label).trim());
    }
  }

  for (const l of toArr(labels)) {
    if (typeof l === 'string' && l.trim()) cpvLabels.push(l.trim());
  }

  return {
    cpvCodes: cpvCodes.length ? [...new Set(cpvCodes)] : null,
    cpvLabels: cpvLabels.length ? [...new Set(cpvLabels)] : null,
  };
}