import axios from 'axios';
import * as cookie from 'cookie';
import { config } from '../config.js';

/**
 * Gemeinsamer HTTP-Client mit respektvollem User-Agent.
 * Führt einen einfachen Cookie-Jar für Portale, die Session-Cookies verlangen.
 */
export const httpClient = axios.create({
  timeout: config.requestTimeoutMs,
  maxRedirects: 5,
  // Rohbytes holen, damit wir den Charset aus dem Content-Type selbst
  // korrekt dekodieren können (manche Portale liefern ISO-8859-1, was
  // axios sonst als UTF-8 verstümmelt – siehe Response-Interceptor).
  responseType: 'arraybuffer',
  headers: {
    'User-Agent': config.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
  },
  validateStatus: (status) => status >= 200 && status < 400,
});

/**
 * Dekodiert einen rohen Response-Body unter Beachtung des Charsets.
 * - UTF-8 (Default) → utf8
 * - ISO-8859-1 / latin1 / windows-1252 → latin1 (1:1 Byte-Mapping,
 *   für deutsche Umlaute identisch)
 */
export function decodeBody(data, contentType = '') {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const ct = contentType.toLowerCase();
  const charsetMatch = ct.match(/charset=([^;]+)/);
  const charset = charsetMatch ? charsetMatch[1].trim().toLowerCase() : 'utf-8';
  if (charset === 'utf-8' || charset === 'utf8') {
    return buf.toString('utf8');
  }
  return buf.toString('latin1');
}

// Textuelle Content-Types, die dekodiert werden sollen (Binär wie PDF/Bilder
// bleibt als Buffer unangetastet).
const TEXT_CONTENT_RE = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|atom\+xml|rss\+xml))/i;
const JSON_CONTENT_RE = /application\/(json|ld\+json)/i;
const BINARY_CONTENT_RE = /(?:application\/(?:pdf|zip|msword|vnd\.|octet-stream)|image\/|audio\/|video\/)/i;

function isBinaryUrl(url) {
  return /\.(?:pdf|docx?|xlsx?|zip|7z|rar|odt|ods|txt|rtf)(?:$|[?#])/i.test(String(url || ''))
    || /(?:^|[/?_.?&-])(?:directdocload|download(?:document|file)?|filedownload)(?:[/?_.?&=-]|$)/i.test(String(url || ''))
    || /(?:[?&](?:download|downloadFile|fileDownload|inlineFile)(?:=true)?(?:&|$))/i.test(String(url || ''));
}

// Einfacher Cookie-Jar: Hostname -> Map(name -> value)
const cookieJar = new Map();

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function storeCookies(response) {
  const setCookies = response.headers?.['set-cookie'];
  if (!setCookies) return;
  const domain = getDomain(response.config?.url || '');
  if (!domain) return;
  const jar = cookieJar.get(domain) || new Map();
  const list = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const setCookie of list) {
    // Nur das erste name=value-Paar übernehmen (Attribute wie Expires/Path ignorieren,
    // da `cookie.parse` an Kommas im GMT-Datum scheitert).
    const nameValue = String(setCookie).split(';')[0];
    const eq = nameValue.indexOf('=');
    if (eq <= 0) continue;
    const name = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1).trim();
    jar.set(name, value);
  }
  cookieJar.set(domain, jar);
}

function cookieHeader(url) {
  const jar = cookieJar.get(getDomain(url));
  if (!jar) return '';
  return [...jar.entries()]
    .map(([name, value]) => cookie.serialize(name, value))
    .join('; ');
}

httpClient.interceptors.request.use((requestConfig) => {
  const stored = cookieHeader(requestConfig.url);
  if (!stored) return requestConfig;
  const existing = requestConfig.headers?.Cookie || requestConfig.headers?.cookie;
  requestConfig.headers.Cookie = existing ? `${existing}; ${stored}` : stored;
  return requestConfig;
});

httpClient.interceptors.response.use(
  (response) => {
    storeCookies(response);
    const data = response.data;
    // Nur rohe Bytes (Buffer/ArrayBuffer) dekodieren – Binärantworten
    // (PDF, Bilder) und bereits als String vorliegende Antworten unverändert.
    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
      const ct = response.headers?.['content-type'] || '';
      if (JSON_CONTENT_RE.test(ct)) {
        // JSON wieder als Objekt zurückgeben (axios default-Verhalten),
        // aber charset-bewusst dekodiert.
        response.data = JSON.parse(decodeBody(data, ct));
      } else if (TEXT_CONTENT_RE.test(ct) || ct.includes('html')) {
        response.data = decodeBody(data, ct);
      }
    }
    return response;
  },
  (error) => {
    if (error.response) storeCookies(error.response);
    return Promise.reject(error);
  }
);

/**
 * Lädt HTML und liefert { html, url } (URL nach Redirects).
 */
export async function fetchHtml(url, { referer = null } = {}) {
  const response = await httpClient.get(url, {
    headers: referer ? { Referer: referer } : {},
  });
  return {
    html: String(response.data),
    url: response.request?.res?.responseUrl || response.config?.url || url,
  };
}

/**
 * GET mit manueller Redirect-Verfolgung – Cookies werden bei jedem
 * Zwischenschritt übernommen (für Portale mit Session-Cookie-Setup).
 */
export async function getWithRedirects(url, options = {}, maxRedirects = 5) {
  const { rejectBinary = false, ...requestOptions } = options || {};
  const streamMode = rejectBinary && requestOptions.responseType == null;
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i += 1) {
    if (rejectBinary && isBinaryUrl(currentUrl)) throw new Error('document_deferred');
    // Redirects manuell folgen, damit Set-Cookie aus 3xx-Antworten übernommen wird
    const response = await httpClient.get(currentUrl, {
      ...requestOptions, ...(streamMode ? { responseType: 'stream' } : {}), maxRedirects: 0,
    });
    storeCookies(response);
    const location = response.headers?.location;
    if (response.status >= 300 && response.status < 400 && location) {
      response.data?.destroy?.();
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (rejectBinary && (isBinaryUrl(currentUrl)
      || BINARY_CONTENT_RE.test(String(response.headers?.['content-type'] || ''))
      || /attachment\s*;/i.test(String(response.headers?.['content-disposition'] || '')))) {
      response.data?.destroy?.();
      throw new Error('document_deferred');
    }
    if (streamMode && response.data && typeof response.data.on === 'function') {
      const chunks = [];
      for await (const chunk of response.data) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      response.data = decodeBody(Buffer.concat(chunks), response.headers?.['content-type'] || '');
    }
    return response;
  }
  throw new Error(`Zu viele Redirects für ${url}`);
}

/**
 * Lädt JSON und liefert das geparste Objekt.
 */
export async function fetchJson(url, { params = null, headers = {} } = {}) {
  const response = await httpClient.get(url, {
    params,
    headers: { Accept: 'application/json', ...headers },
  });
  return response.data;
}

/**
 * POST-Request für Such-APIs.
 */
export async function postJson(url, body, { headers = {} } = {}) {
  const response = await httpClient.post(url, body, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
  });
  return response.data;
}
