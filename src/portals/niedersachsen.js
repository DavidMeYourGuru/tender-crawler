/**
 * Vergabeportal Niedersachsen – Registry-Eintrag.
 *
 * Die eigentliche Datenerfassung läuft über den Browser-Worker
 * (src/browser-portals/niedersachsen.js), da die Plattform nur per
 * JavaScript/Session-Storage erreichbar ist. Dieses Modul dient nur
 * dazu, dass loadPortalModules() die Quelle registriert; discover()
 * ist ein No-op, da der Crawl asynchron über die Browser-Queue erfolgt.
 */
export const meta = {
  id: 'niedersachsen',
  name: 'Vergabeportal Niedersachsen (Deutsche eVergabe)',
  region: 'niedersachsen',
  type: 'browser',
  schedule: '0 */8 * * *',
  rateLimit: { maxRequests: 15, windowMs: 60000 },
  baseUrl: 'https://portal.deutsche-evergabe.de',
};

export async function discover() {
  // Vom Browser-Worker (runNiedersachsenJob) asynchron verarbeitet.
  return [];
}

export default { meta, discover };
