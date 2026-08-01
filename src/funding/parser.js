/**
 * Deterministische Extraktion harter Fakten aus Förderquellen.
 * Alle Funktionen sind rein und liefern strukturierte Werte plus Belegtext.
 * Sie erfinden nie Werte – was nicht belegt ist, bleibt null/undefined.
 */

import { normalizeDate, parseMoneyToCents } from '../utils.js';

/**
 * Parst eine Frist-Angabe wie "30. September 2026" oder
 * "20.08.2026 um 15:00 Uhr". Liefert { deadlineAt, isOngoing, quote }.
 */
export function parseDeadline(text, timezone = 'Europe/Berlin') {
  if (!text) return null;

  // Laufende/dauerhafte Förderung
  if (/(laufend|dauerhaft|keine Frist|ohne Frist|fortlaufend|ständig möglich)/i.test(text)) {
    const quote = matchQuote(text, /[^;.\n]{0,60}(laufend|dauerhaft|keine Frist|ohne Frist|fortlaufend|ständig möglich)[^;.\n]{0,60}/i);
    return { deadlineAt: null, isOngoing: true, timezone, quote };
  }

  // Bevorzugt das Datum, das durch Frist-Kontext markiert ist:
  // "bis zum 30.09.2026", "spätestens am 30. September 2026" usw.
  const marked = parseMarkedDeadline(text, timezone);
  if (marked) return marked;

  // "30. September 2026" mit optionaler Uhrzeit
  const match = text.match(/(\d{1,2})\.\s+([A-Za-zäöüÄÖÜß]+)\s+(\d{4})/, 'i');
  if (match) {
    const monthMap = {
      Januar: 1, Februar: 2, März: 3, Maerz: 3, April: 4, Mai: 5, Juni: 6,
      Juli: 7, August: 8, September: 9, Oktober: 10, November: 11, Dezember: 12,
    };
    const monthName = Object.keys(monthMap).find((m) => m.toLowerCase() === match[2].toLowerCase())
      || Object.keys(monthMap).find((m) => m === match[2]);
    if (monthName) {
      const month = monthMap[monthName];
      const day = String(match[1]).padStart(2, '0');
      const year = match[3];
      let deadlineAt = `${year}-${String(month).padStart(2, '0')}-${day}`;
      const timeMatch = text.slice(match.index).match(/um\s+(\d{1,2})[:.](\d{2})/i);
      if (timeMatch) {
        deadlineAt += `T${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
      }
      const quote = text.slice(Math.max(0, match.index - 40), match.index + 60).trim();
      return { deadlineAt, isOngoing: false, timezone, quote };
    }
  }

  // "20.08.2026 um 15:00 Uhr" oder "30.09.2026" – Datum kann an beliebiger
  // Stelle im Text stehen (z. B. "Deadline: 20.08.2026 um 15:00 Uhr")
  const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dateMatch) {
    const [full, d, m, y] = dateMatch;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (isValidDate(iso)) {
      let deadlineAt = iso;
      const timeMatch = text.match(/um\s+(\d{1,2})[:.](\d{2})/i);
      if (timeMatch) {
        deadlineAt += `T${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
      }
      const quote = text.slice(Math.max(0, dateMatch.index - 20), dateMatch.index + full.length + 30).trim();
      return { deadlineAt, isOngoing: false, timezone, quote };
    }
  }

  return null;
}

/**
 * Erkennt ein Datum, das durch Frist-Kontext markiert ist ("bis zum", "spätestens",
 * "Frist", "Antragsfrist", "Einreichung", "Ablauf"). Bevorzugt gegenüber
 * generischen Datumsangaben (z. B. historischen Referenzen im Text).
 */
function parseMarkedDeadline(text, timezone) {
  const markers = /(?:bis\s+(?:zum\s+)?|spätestens\s+(?:am\s+)?|Frist(?:en)?(?:\s*:|\))\s*|Antragsfrist\s*:|Einreichung(?:sfrist)?\s*:|Ablauf(?:sfrist)?\s*:|Deadline\s*:|Bewerbungsfrist\s*:|Einreichungsfrist\s*:)([^;.!]{0,80})/i;
  const m = text.match(markers);
  if (!m) return null;
  const rest = m[1];

  // Punkt-Datum "30.09.2026"
  const dot = rest.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dot) {
    const iso = `${dot[3]}-${dot[2].padStart(2, '0')}-${dot[1].padStart(2, '0')}`;
    if (isValidDate(iso)) {
      let deadlineAt = iso;
      const timeMatch = rest.match(/um\s+(\d{1,2})[:.](\d{2})/i);
      if (timeMatch) deadlineAt += `T${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
      return { deadlineAt, isOngoing: false, timezone, quote: m[0].trim() };
    }
  }

  // Monatsname "30. September 2026"
  const named = rest.match(/(\d{1,2})\.\s+([A-Za-zäöüÄÖÜß]+)\s+(\d{4})/);
  if (named) {
    const monthMap = { Januar: 1, Februar: 2, März: 3, Maerz: 3, April: 4, Mai: 5, Juni: 6, Juli: 7, August: 8, September: 9, Oktober: 10, November: 11, Dezember: 12 };
    const monthName = Object.keys(monthMap).find((k) => k.toLowerCase() === named[2].toLowerCase());
    if (monthName) {
      const iso = `${named[3]}-${String(monthMap[monthName]).padStart(2, '0')}-${named[1].padStart(2, '0')}`;
      if (isValidDate(iso)) return { deadlineAt: iso, isOngoing: false, timezone, quote: m[0].trim() };
    }
  }

  // 2-stellige Jahresangabe "30.09.26"
  const short = rest.match(/(\d{1,2})\.(\d{1,2})\.(\d{2})\b/);
  if (short) {
    const year = Number(short[3]) < 70 ? `20${short[3]}` : `19${short[3]}`;
    const iso = `${year}-${short[2].padStart(2, '0')}-${short[1].padStart(2, '0')}`;
    if (isValidDate(iso)) return { deadlineAt: iso, isOngoing: false, timezone, quote: m[0].trim() };
  }

  return null;
}

function isValidDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parst eine Laufzeit wie "bis zu 36 Monate", "max. 12 Monate",
 * "48 Monate" oder einen Bereich "12–24 Monate".
 * Liefert { minMonths, maxMonths, quote }.
 */
export function parseDurationMonths(text) {
  if (!text) return null;
  const ranges = [
    { re: /(?:bis\s+zu|max(?:imal)?\.?)\s+(\d{1,3})\s*(?:Monate|Monaten)/i, maxOnly: true },
    { re: /(\d{1,3})\s*(?:bis|–|-)\s*(\d{1,3})\s*(?:Monate|Monaten)/i },
    { re: /(\d{1,3})\s*(?:Monate|Monaten)/i },
  ];
  for (const { re, maxOnly } of ranges) {
    const m = text.match(re);
    if (!m) continue;
    const a = Number.parseInt(m[1], 10);
    const b = m[2] ? Number.parseInt(m[2], 10) : null;
    const quote = m[0];
    if (maxOnly) return { minMonths: null, maxMonths: a, quote };
    if (b != null) return { minMonths: Math.min(a, b), maxMonths: Math.max(a, b), quote };
    return { minMonths: a, maxMonths: a, quote };
  }
  return null;
}

/**
 * Parst einen Geldbetrag oder -bereich wie "400.000 €", "bis zu 330.000 €",
 * "400.000 bis 800.000 €". Liefert { minCents, maxCents, currency, quote }.
 * Fallback: Beträge ohne €/EUR-Zeichen, wenn ein deutscher Förder-Kontext
 * vorangeht ("Fördersumme beträgt bis zu 800.000").
 */
export function parseEuroAmount(text) {
  if (!text) return null;
  const currency = 'EUR';

  // Bereich: "400.000 € bis 800.000 €" / "1.500.000 €"
  const range = text.match(/([\d.,\s]+)\s*(?:€|EUR)\s*(?:bis|–|-)\s*(?:([\d.,\s]+))\s*(?:€|EUR)?/i);
  if (range) {
    const a = parseMoneyToCents(range[1]);
    const b = parseMoneyToCents(range[2]);
    if (a != null && b != null) return { minCents: Math.min(a, b), maxCents: Math.max(a, b), currency, quote: range[0] };
  }

  // Einzelbetrag
  const single = text.match(/([\d.,\s]+)\s*(?:€|EUR)/i);
  if (single) {
    const v = parseMoneyToCents(single[1]);
    if (v != null) return { minCents: v, maxCents: v, currency, quote: single[0] };
  }

  // Ohne Währungssymbol, aber im Förder-Kontext:
  // "Fördersumme beträgt bis zu 800.000" / "Zuwendung in Höhe von 500.000"
  const context = text.match(/(?:Fördersumme|Förderhöhe|Förderbetrag|Zuwendung|Höhe von|beträgt|betragen|Förderung von)[^0-9]{0,60}([\d.,]+)\s*(?:bis|–|-)\s*([\d.,]+)/i);
  if (context) {
    const a = parseMoneyToCents(context[1]);
    const b = parseMoneyToCents(context[2]);
    if (a != null && b != null) return { minCents: Math.min(a, b), maxCents: Math.max(a, b), currency, quote: context[0] };
  }
  const contextSingle = text.match(/(?:Fördersumme|Förderhöhe|Förderbetrag|Zuwendung|Höhe von|beträgt|betragen|Förderung von)[^0-9]{0,60}([\d.,]+)/i);
  if (contextSingle) {
    const v = parseMoneyToCents(contextSingle[1]);
    if (v != null) return { minCents: v, maxCents: v, currency, quote: contextSingle[0] };
  }

  return null;
}

/**
 * Parst eine Förderquote wie "100%", "bis zu 80%", "60–80%",
 * "100% (+20% bei Hochschulen)".
 * Liefert { min, max, quote, note } (in Prozentpunkten, 0–100).
 */
export function parseFundingQuote(text) {
  if (!text) return null;
  const range = text.match(/(\d{1,3})\s*(?:bis|–|-)\s*(\d{1,3})\s*%/);
  if (range) {
    const a = Number.parseInt(range[1], 10);
    const b = Number.parseInt(range[2], 10);
    return { min: Math.min(a, b), max: Math.max(a, b), quote: range[0], note: null };
  }
  const single = text.match(/(?:bis\s+zu\s+)?(\d{1,3})\s*%/);
  if (single) {
    const v = Number.parseInt(single[1], 10);
    const noteMatch = text.match(/\(([^)]+)\)/);
    return { min: v, max: v, quote: single[0], note: noteMatch ? noteMatch[1] : null };
  }
  return null;
}

/**
 * Parst einen Förderhöchstbetrag ("Förderhöchstbetrag: 180.000 €").
 */
export function parseMaxAmount(text) {
  if (!text) return null;
  const m = text.match(/[Ff]örderhöchstbetrag[^0-9]{0,60}([\d.,\s]+)\s*(?:€|EUR)/);
  if (m) {
    const v = parseMoneyToCents(m[1]);
    return v != null ? { maxAmountCents: v, quote: m[0] } : null;
  }
  return null;
}

/**
 * Parst ALLE Eurobeträge in einem Text und liefert sie als Array von
 * { cents, quote }. Berücksichtigt auch Bereiche "400.000 bis 800.000 €".
 */
export function parseAllEuroAmounts(text) {
  if (!text) return [];
  const result = [];

  // Bereiche zuerst: "400.000 € bis 800.000 €"
  const rangeRe = /([\d.,\s]+)\s*(?:€|EUR)\s*(?:bis|–|-)\s*([\d.,\s]+)\s*(?:€|EUR)?/gi;
  let m;
  while ((m = rangeRe.exec(text)) !== null) {
    const a = parseMoneyToCents(m[1]);
    const b = parseMoneyToCents(m[2]);
    if (a != null && b != null) {
      result.push({ cents: Math.min(a, b), quote: m[0] });
      result.push({ cents: Math.max(a, b), quote: m[0] });
    }
  }

  const singleRe = /([\d.,\s]+)\s*(?:€|EUR)/gi;
  while ((m = singleRe.exec(text)) !== null) {
    const v = parseMoneyToCents(m[1]);
    if (v != null) result.push({ cents: v, quote: m[0] });
  }

  // Beträge ohne Währungssymbol im Förder-Kontext
  const contextRe = /(?:Fördersumme|Förderhöhe|Förderbetrag|Zuwendung|Höhe von|beträgt|betragen)[^0-9]{0,60}([\d.,]+)/gi;
  while ((m = contextRe.exec(text)) !== null) {
    const v = parseMoneyToCents(m[1]);
    if (v != null && !result.some((r) => r.cents === v)) result.push({ cents: v, quote: m[0] });
  }

  return result;
}

/**
 * Sammelt offizielle Links aus einem HTML-Dokument.
 */
export function extractLinksFromHtml(cheerioRoot, baseUrl) {
  const links = [];
  const seen = new Set();
  cheerioRoot('a').each((_, el) => {
    const href = cheerioRoot(el).attr('href');
    if (!href) return;
    let url;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    const title = cheerioRoot(el).text().trim().slice(0, 200);
    let kind = 'other';
    if (/\.pdf($|\?)/i.test(url)) kind = 'document';
    if (/richtlinie|förderrichtlinie|foerderrichtlinie/i.test(title) || /richtlinie/i.test(url)) kind = 'guideline';
    if (/antrag|bewerbung|einreichung|antragstellung/i.test(title)) kind = 'application';
    if (/call|aufruf|bekanntmachung/i.test(title) || /igp\.html|di|bekanntmachung/i.test(url)) kind = 'call';
    if (kind === 'other' && links.length === 0) kind = 'primary';
    const key = url;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ kind, url, title });
  });
  return links.slice(0, 30);
}

function matchQuote(text, re) {
  const m = text.match(re);
  return m ? m[0].trim() : null;
}

export default { parseDeadline, parseDurationMonths, parseEuroAmount, parseFundingQuote, parseMaxAmount, parseAllEuroAmounts, extractLinksFromHtml };
