/**
 * Generischer HTML-Listen-Parser mit konfigurierbaren Selektoren und
 * robusten Fallbacks für gängige CMS-/Tabellen-/Suchlisten-Strukturen.
 */
import * as cheerio from 'cheerio';
import { normalizeUrl } from './urls.js';

const FALLBACK_ITEM_SELECTORS = [
  'article', 'li.result', '.result', '.result-item', '.search-result',
  '.search-result-item', '.teaser', '.c-teaser', '.news-item', '.list-item',
  'tbody tr', '.tabelle tbody tr', '.table tbody tr', 'li',
];

const FALLBACK_TITLE_SELECTORS = ['h2', 'h3', 'h4', 'a', '.title', '.headline', '.c-heading'];

const FALLBACK_DATE_SELECTORS = ['time', '.date', '.datum', '.c-date'];

/**
 * Parst ein HTML-Dokument und liefert Listeneinträge.
 * @param {string} html
 * @param {string} baseUrl
 * @param {object} cfg { listItemSelector, titleSelector, linkSelector, dateSelector }
 * @returns {Array<{title, url, publicationDate, rawText}>}
 */
export function parseHtmlList(html, baseUrl, cfg = {}) {
  const $ = cheerio.load(html);
  const itemSelector = cfg.listItemSelector || pickSelector($, FALLBACK_ITEM_SELECTORS, 1);
  const nodes = itemSelector ? $(itemSelector).toArray() : [];
  const results = [];
  const seen = new Set();

  for (const node of nodes.slice(0, 100)) {
    const $node = $(node);
    const title = extractTitle($node, cfg);
    const href = extractLink($node, cfg);
    if (!title || !href) continue;
    const url = normalizeUrl(href, baseUrl);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    results.push({
      title: title.slice(0, 300),
      url,
      publicationDate: extractDate($node, cfg),
      rawText: $node.text().replace(/\s+/g, ' ').trim().slice(0, 1000),
    });
  }
  return results;
}

function pickSelector($, selectors, minMatches = 3) {
  for (const sel of selectors) {
    if ($(sel).length >= minMatches) return sel;
  }
  return null;
}

function extractTitle($node, cfg) {
  if (cfg.titleSelector) {
    const v = $node.find(cfg.titleSelector).first().text().trim();
    if (v) return v;
  }
  for (const sel of FALLBACK_TITLE_SELECTORS) {
    const v = $node.find(sel).first().text().trim();
    if (v && v.length >= 4) return v;
  }
  // Direkter Link als Fallback
  const link = $node.find('a').first().text().trim();
  return link || null;
}

function extractLink($node, cfg) {
  if (cfg.linkSelector) {
    const href = $node.find(cfg.linkSelector).first().attr('href');
    if (href) return href;
  }
  return $node.find('a').first().attr('href') || null;
}

function extractDate($node, cfg) {
  if (cfg.dateSelector) {
    const v = $node.find(cfg.dateSelector).first().text().trim();
    if (v) return v;
  }
  for (const sel of FALLBACK_DATE_SELECTORS) {
    const v = $node.find(sel).first().text().trim();
    if (v) return v;
  }
  const m = $node.text().match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  return m ? m[0] : null;
}

/**
 * Extrahiert den Haupttext einer Detailseite.
 */
export function extractDetailText(html, cfg = {}) {
  const $ = cheerio.load(html);
  if (cfg.detailTextSelector) {
    const el = $(cfg.detailTextSelector).first();
    if (el.length && el.text().trim().length > 40) {
      return { text: el.text().trim(), html: $.html(el) };
    }
  }
  const candidates = ['main', 'article', '.content', '#content', '.text', '.c-content', '.rte'];
  let best = '';
  let bestHtml = '';
  for (const sel of candidates) {
    const el = $(sel).first();
    const t = el.text().replace(/\s+/g, ' ').trim();
    if (t.length > best.length) {
      best = t;
      bestHtml = $.html(el);
    }
  }
  if (best.length > 40) return { text: best, html: bestHtml };
  return { text: $( 'body' ).text().replace(/\s+/g, ' ').trim(), html: html };
}

export default { parseHtmlList, extractDetailText };
