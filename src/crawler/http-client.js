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
  headers: {
    'User-Agent': config.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
  },
  validateStatus: (status) => status >= 200 && status < 400,
});

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
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i += 1) {
    // Redirects manuell folgen, damit Set-Cookie aus 3xx-Antworten übernommen wird
    const response = await httpClient.get(currentUrl, { ...options, maxRedirects: 0 });
    storeCookies(response);
    const location = response.headers?.location;
    if (response.status >= 300 && response.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
      continue;
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
