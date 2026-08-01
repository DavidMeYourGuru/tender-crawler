import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Lädt alle Portal-Module aus dem Ordner src/portals automatisch.
 * Ein Portal-Modul exportiert: meta (id, name, region, type) und discover().
 */
export async function loadPortalModules() {
  const files = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith('.js') && file !== 'registry.js');

  const portals = new Map();
  for (const file of files) {
    try {
      const module = await import(path.join(__dirname, file));
      if (module.meta?.id && typeof module.discover === 'function') {
        portals.set(module.meta.id, module);
      }
    } catch (error) {
      console.error(`[registry] Portal-Modul ${file} konnte nicht geladen werden:`, error.message);
    }
  }
  return portals;
}

/**
 * Gibt die Liste aller verfügbaren Portal-Module zurück (synchron für Anzeige).
 */
export function listPortalModuleFiles() {
  return fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith('.js') && file !== 'registry.js')
    .map((file) => file.replace(/\.js$/, ''));
}

export async function loadPortals() {
  return loadPortalModules();
}

export default { loadPortalModules, listPortalModuleFiles, loadPortals };