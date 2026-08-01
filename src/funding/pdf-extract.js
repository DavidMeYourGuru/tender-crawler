/**
 * PDF-Download und Textextraktion für Förder-Bekanntmachungen.
 * Lädt verlinkte Richtlinien/Anhänge mit SSRF-Schutz und respektvollem
 * Rate-Limiting und extrahiert den Rohtext für die Extraktions-Pipeline.
 */

import { assertSafeUrl } from '../discovery/urls.js';
import config from '../config.js';

export const MAX_PDF_BYTES = 16 * 1024 * 1024; // 16 MB

/**
 * Lädt eine PDF-Datei und gibt den Buffer zurück.
 * Redirect-Hops werden jeweils SSRF-geprüft; das Rate-Limit gilt pro Hop.
 * Wirft bei HTTP-Fehlern oder Überschreitung der Maximalgröße.
 * @param {string} url
 * @param {{ rateLimiter?: object|null }} [opts]
 * @returns {Promise<{ buffer: Buffer, url: string }>}
 */
export async function downloadPdf(url, { rateLimiter = null } = {}) {
  const { httpClient } = await import('../crawler/http-client.js');
  let current = assertSafeUrl(url).toString();

  for (let hop = 0; hop <= 5; hop += 1) {
    if (rateLimiter) await rateLimiter.acquire();
    const target = assertSafeUrl(current);
    const response = await httpClient.get(target.toString(), {
      responseType: 'arraybuffer',
      maxRedirects: 0,
      timeout: config.requestTimeoutMs,
      headers: { Accept: 'application/pdf,*/*' },
      validateStatus: () => true,
    });
    const status = response.status;
    const location = response.headers?.location;
    if (status >= 300 && status < 400 && location) {
      current = assertSafeUrl(new URL(location, target).toString()).toString();
      continue;
    }
    if (status >= 400) {
      throw new Error(`HTTP ${status} für PDF`);
    }
    let buffer;
    if (Buffer.isBuffer(response.data)) {
      buffer = response.data;
    } else if (response.data instanceof ArrayBuffer) {
      buffer = Buffer.from(response.data);
    } else {
      buffer = Buffer.from(response.data ?? []);
    }
    if (buffer.length > MAX_PDF_BYTES) {
      throw new Error(`PDF zu groß (${buffer.length} Bytes > ${MAX_PDF_BYTES})`);
    }
    return { buffer, url: response.request?.res?.responseUrl || target.toString() };
  }
  throw new Error(`Zu viele Redirects für PDF: ${url}`);
}

/**
 * Extrahiert Rohtext aus einem PDF-Buffer. Gibt null bei Fehlern
 * (korrupt, passwortgeschützt, leere Seiten).
 * @param {Buffer} buffer
 * @returns {Promise<string|null>}
 */
export async function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  let parser = null;
  try {
    const { PDFParse } = await import('pdf-parse');
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = String(result?.text || '');
    // Seitenkennzeichnung ("-- N of M --") entfernen
    const cleaned = text.replace(/^--\s*\d+\s+of\s+\d+\s*--$/gm, '').replace(/\u0000/g, '').trim();
    return cleaned || null;
  } catch (error) {
    console.warn(`[pdf] Textextraktion fehlgeschlagen: ${error.message}`);
    return null;
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        // Ressourcenfreigabe best effort
      }
    }
  }
}

/**
 * Komfortfunktion: lädt und extrahiert ein PDF in einem Schritt.
 * @returns {Promise<string|null>} Rohtext oder null bei Fehlern.
 */
export async function fetchPdfText(url, { rateLimiter = null } = {}) {
  try {
    const { buffer } = await downloadPdf(url, { rateLimiter });
    return await extractPdfText(buffer);
  } catch (error) {
    console.warn(`[pdf] Abruf fehlgeschlagen (${url}): ${error.message}`);
    return null;
  }
}

export default { downloadPdf, extractPdfText, fetchPdfText, MAX_PDF_BYTES };
