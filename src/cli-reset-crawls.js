#!/usr/bin/env node
/**
 * Setzt Tender-Crawls zurück (Tender + Crawl-Log + Checkpoints + Jobs) und
 * bereitet so einen vollständigen Neu-Crawl vor. Förderdaten und Quellen
 * bleiben erhalten. Vor dem Löschen wird die Datenbank gesichert.
 *
 * Optionen:
 *   --source <id>   nur eine Quelle zurücksetzen (Tender + Checkpoint + Jobs)
 *   --no-backup     keine DB-Sicherung anlegen
 *
 * Beispiele:
 *   node src/cli-reset-crawls.js
 *   node src/cli-reset-crawls.js --source evergabe
 *   node src/cli-reset-crawls.js --no-backup
 */
async function main() {
  const noBackup = process.argv.includes('--no-backup');
  const sourceArg = process.argv.find((a) => a.startsWith('--source='));
  const sourceId = sourceArg ? sourceArg.split('=')[1] : null;
  const { cleanupTenderData } = await import('./db.js');
  console.log(`[reset] Starte Zurücksetzung${sourceId ? ` (Quelle: ${sourceId})` : ' (alle Quellen)'} …`);
  const result = await cleanupTenderData({ backup: !noBackup, sourceId });
  console.log(`[reset] ${result.deletedTenders} Tender gelöscht; Crawl-Log, Checkpoints und Jobs geleert.`);
  console.log(`[reset] Sicherung: ${result.backupPath || 'keine (--no-backup)'}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('[reset] Fehlgeschlagen:', error);
  process.exit(1);
});
