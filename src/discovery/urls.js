/**
 * URL-Normalisierung, SSRF-Schutz und sicheres Abrufen.
 */
import net from 'node:net';

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export function isHttpUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalisiert eine URL: absolute URL, Hash entfernt, Trailing-Slash behalten.
 * Gibt null bei ungültiger Eingabe oder privatem Host zurück.
 */
export function normalizeUrl(value, base = null) {
  if (!value) return null;
  try {
    const u = new URL(value, base || undefined);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!isSafeHostname(u.hostname)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export function isPrivateHost(hostname) {
  const lower = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  // IPv6 (bracketed from URL.hostname)
  if (lower.startsWith('[') && lower.endsWith(']')) {
    return isPrivateIpv6(lower.slice(1, -1));
  }
  if (net.isIP(lower) !== 4) {
    // keine gültige IPv4-Adresse → kein Direkt-IP-Risiko durch IP; Domain-Namen
    // werden als potenziell sicher behandelt (DNS-Rebinding ist separat zu lösen)
    return false;
  }
  const [a, b] = lower.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isPrivateIpv6(ip) {
  if (ip === '::1' || ip === '::') return true;
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateHost(mapped[1]);
  if (net.isIP(ip) !== 6) return true; // ungültige IPv6 → unsicher behandeln
  const hextets = ip.toLowerCase().split(':');
  const first = Number.parseInt(hextets[0], 16);
  if (Number.isNaN(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  return false;
}

export function isSafeHostname(hostname) {
  if (BLOCKED_HOSTS.has(String(hostname).toLowerCase())) return false;
  return !isPrivateHost(hostname);
}

/**
 * Wirft, wenn die URL nicht sicher abgerufen werden darf (nicht http/https
 * oder privater Host). Wird unmittelbar vor jedem Fetch und auf jedem
 * Redirect-Hop aufgerufen.
 */
export function assertSafeUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unzulässiges Protokoll: ${u.protocol}`);
  }
  if (!isSafeHostname(u.hostname)) {
    throw new Error(`Unzulässiger Host: ${u.hostname}`);
  }
  return u;
}

/**
 * Sicheres HTTP-GET mit manueller Redirect-Verfolgung, bei dem JEDER
 * Redirect-Hop gegen die Private-Host-Prüfung validiert wird.
 * Liefert { html, url, status }.
 */
export async function fetchSafeHtml(url, { maxRedirects = 5, timeout = 20000 } = {}) {
  const { httpClient } = await import('../crawler/http-client.js');
  let current = assertSafeUrl(url).toString();
  for (let i = 0; i <= maxRedirects; i += 1) {
    const u = assertSafeUrl(current);
    const response = await httpClient.get(u.toString(), {
      maxRedirects: 0,
      // arraybuffer (statt 'text'), damit der Response-Interceptor den
      // Charset aus dem Content-Type korrekt dekodiert (z. B. ISO-8859-1).
      responseType: 'arraybuffer',
      timeout,
      validateStatus: () => true,
    });
    const status = response.status;
    const location = response.headers?.location;
    if (status >= 300 && status < 400 && location) {
      current = assertSafeUrl(new URL(location, u).toString()).toString();
      continue;
    }
    return {
      html: typeof response.data === 'string' ? response.data : String(response.data ?? ''),
      url: response.request?.res?.responseUrl || u.toString(),
      status,
    };
  }
  throw new Error('Zu viele Redirects');
}

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export default { isHttpUrl, normalizeUrl, isPrivateHost, isSafeHostname, assertSafeUrl, fetchSafeHtml, hostname };
