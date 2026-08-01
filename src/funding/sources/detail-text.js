/**
 * Bereinigt Detailseiten von Bundesministerien und Extraktionsportalen.
 * Wählt den semantischen Hauptinhalt, entfernt Navigation/Footer/Cookiebanner
 * und erzeugt daraus einen lesbaren Text mit Abschnitts-/Zeilenstruktur sowie
 * das bereinigte HTML (für die Linkextraktion).
 */

import * as cheerio from 'cheerio';

const CONTENT_SELECTORS = ['main', 'article', '.l-main', '.content', '#content', '.c-content', '.text', '.rte'];

const JUNK_SELECTORS = [
  'nav', 'header', 'footer', 'aside', 'form',
  '[class*="cookie" i]', '[class*="Cookie" i]', '[id*="cookie" i]', '[id*="Cookie" i]',
  '[class*="share" i]', '[class*="breadcrumb" i]', '[class*="Breadcrumb" i]',
  '[class*="footer" i]', '[class*="Footer" i]',
  '[class*="service-nav" i]', '[class*="topbar" i]', '[class*="meta-nav" i]',
  '[class*="login" i]', '[class*="Login" i]', '[class*="searchbox" i]',
  '[class*="social" i]', '[class*="Social" i]',
  '.c-breadcrumb', '.c-share', '.c-cookie', '.c-navigation', '.c-nav',
  '.breadcrumb', '.pagination', '.back-to-top', '[aria-label*="navigation" i]',
];

/**
 * Wählt den Hauptinhalt einer HTML-Seite.
 */
export function selectMainContainer(html) {
  const $ = cheerio.load(html);
  let best = null;
  let bestLen = 0;
  for (const sel of CONTENT_SELECTORS) {
    const el = $(sel).first();
    if (!el.length) continue;
    const len = el.text().replace(/\s+/g, ' ').trim().length;
    if (len > bestLen) {
      bestLen = len;
      best = el;
    }
  }
  return { $, root: best || $('body'), textLen: bestLen || $('body').text().replace(/\s+/g, ' ').trim().length };
}

/**
 * Entfernt störende Elemente aus dem Hauptinhalt.
 */
export function stripJunk($, root) {
  $('script, style, iframe, noscript, template, svg, canvas, video, audio, picture')
    .remove();
  $('[hidden], [style*="display:none"], [style*="display: none"], [aria-hidden="true"]')
    .remove();
  for (const sel of JUNK_SELECTORS) {
    root.find(sel).remove();
  }
  // Header/Footer innerhalb des Hauptinhalts zusätzlich entfernen
  root.find('header, footer').remove();
  return root;
}

/**
 * Erzeugt lesbaren Text mit Abschnitts-/Zeilenstruktur aus dem Hauptinhalt.
 */
export function containerToText($, root) {
  const lines = [];
  const push = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text && text.length >= 2) lines.push(text);
  };

  // Tabellen zeilenweise
  root.find('table').each((_, table) => {
    $(table).find('tr').each((_, row) => {
      const cells = $(row).find('th, td').map((i, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
      if (cells.length) push(cells.join(' | '));
    });
  });

  root.find('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, dd, dt').each((_, el) => {
    const $el = $(el);
    if ($el.closest('table').length) return; // Tabellen bereits behandelt
    if ($el.closest('li').length && !$el.is('li')) return; // p in li → li deckt ab
    push($el.text());
  });

  return lines.join('\n');
}

/**
 * Extrahiert den bereinigten Hauptinhalt einer Detailseite.
 * @returns {{ text: string, html: string }}
 */
export function extractMainContent(html) {
  const { $, root: rawRoot, textLen } = selectMainContainer(html);
  const root = stripJunk($, rawRoot);
  const text = containerToText($, root);
  const cleanHtml = $.html(root);
  if (text.length < 100 && textLen > text.length * 3) {
    // Hauptinhalt wurde durch Bereinigung unplausibel geschrumpft –
    // dann auf den unbereinigten Text des Containers zurückfallen.
    return { text: rawRoot.text().replace(/\s+/g, ' ').trim(), html: cleanHtml };
  }
  return { text, html: cleanHtml };
}

export default { extractMainContent, selectMainContainer, stripJunk, containerToText };
