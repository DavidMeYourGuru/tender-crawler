#!/usr/bin/env node
/**
 * Einmalige Bereinigung des Förderbereichs:
 *  - Sicherung der Datenbank
 *  - Löschen aller Förderprogramme samt Kinddaten, Overrides, Logs, Inbox-/
 *    Rohdaten und Förder-/Mixed-Quellen
 *  - Förderinfo als einzige Förderquelle neu anlegen
 *  - FTS-Index neu aufbauen
 *
 * Tender-Daten und Tender-Quellen bleiben unverändert.
 *
 * Beispiele:
 *   node src/cli-clean-funding.js
 *   node src/cli-clean-funding.js --no-backup
 */
async function main() {
  const noBackup = process.argv.includes('--no-backup');
  const { cleanupFundingData } = await import('./db.js');
  console.log('[funding-cleanup] Starte Bereinigung …');
  const result = await cleanupFundingData({ backup: !noBackup });
  console.log(`[funding-cleanup] Beendet: ${result.deletedPrograms} Förderprogramme, ${result.deletedFundingSources} Förder-/Mixed-Quellen entfernt.`);
  console.log(`[funding-cleanup] Sicherung: ${result.backupPath || 'keine (--no-backup)'}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('[funding-cleanup] Fehlgeschlagen:', error);
  process.exit(1);
});
