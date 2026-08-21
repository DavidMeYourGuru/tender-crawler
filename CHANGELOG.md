# Changelog – Session 2026-08-21

Zusammenfassung der Änderungen am `tender-crawler` in dieser Session.

## 2. Was gemacht wurde

| # | Bereich | Datei(en) | Inhalt |
|---|---------|-----------|--------|
| 1 | **NRW-Quelle** | `src/portals/nrw.js` (neu) | HTTP-Crawler für `evergabe.nrw.de` (cosinex VMP). Iteriert CPV-Codes, parst server-gerendertes HTML-Table, Dedupe per `pid`. Live validiert: 136 roh → 9 im Interessenbereich. |
| 2 | **Niedersachsen-Quelle** | `src/browser-portals/niedersachsen.js` (neu) + `src/portals/niedersachsen.js` (Stub) | Playwright-Crawler für Deutsche eVergabe (DevExtreme dxDataGrid SPA). PageSize 100, volle Pagination. Live validiert: 138 Treffer über 2 Seiten. |
| 3 | **Kategorie-Filter** | `src/category-filter.js` (neu) | `matchesInterestCategories()` mit CPV-Präfixen `45/7122/714/773` + Keywords (schule, kita, spielplatz …). **Nur auf NRW+NDS angewandt.** |
| 4 | **DB-Seeding** | `src/db.js` | Neue Quellen `nrw` (html, 480s) + `niedersachsen` (browser, 480s) geseedet. |
| 5 | **Worker-Runner** | `src/worker.js` | `runners`-Map um `evergabe` + `niedersachsen` erweitert. |
| 6 | **Sanftes Crawling** | `src/config.js` | `maxRequestsPerMinute` 40 → **20**. |
| 7 | **Referenzquellen deaktiviert** | `src/discovery/sources.js` | ZIM/BBSR/BayFOR auf `state='reference'` → vom Crawl übersprungen, bleiben als Katalog-Referenz. |
| 8 | **Tests** | `test/category-filter.test.js`, `test/niedersachsen.test.js` (neu) | 11 Tests für die neuen Module. |
| 9 | **Git-Repo / .gitignore** | `.gitignore` | Repo existierte bereits (main + origin). `.gitignore` erweitert (SQLite, Logs, Coverage, Scratch-Dateien); Scratch-Dateien aus Tracking entfernt. |

## 3. Begründung der Entscheidungen

### NRW via HTTP statt Browser
cosinex rendert die Ergebnistabelle serverseitig (Struts `.do`-Actions). Ein Browser wäre Overhead. Erst war die POST-Suche (`companyNotice.do?method=search`) falsch (lieferte CPV-Baum, 404/500) → umgestellt auf `categoryOverview.do?method=showTable&cpvCode=<CPV>` (GET).

### Niedersachsen via Playwright
Deutsche eVergabe ist eine DevExtreme-SPA (dxDataGrid), keine klassische Tabelle. Erst vermutete Kendo/Table-Selektoren waren falsch → per Live-DOM-Inspektion auf `tr.dx-row.dx-data-row` + `.dx-page` umgestellt. PageSize auf 100 gesetzt, damit alle 138 Treffer in 2 Seiten kommen (statt vieler Kleinseiten).

### Kategorie-Filter nur für NRW/NDS
Die anderen Portale (Bund, TED, Bayern) sind breiter angelegt; dort den Filter zuerst nur auf die neuen Länderquellen anzuwenden vermeidet, dass bestehende Quellen plötzlich leerlaufen. Erweiterbar.

### Sanftes Crawling
Ziel war "gentle". Da lokale SQLite-Writes unkritisch sind, wurde nur die Request-Rate halbiert (20/min), statt komplexe Backoff-Logik einzubauen.

### ZIM/BBSR/BayFOR deaktiviert
Diese sind FuE-Förderung (ZIM=Förderkredite, BBSR=Stadtforschung, BayFOR=Bayern-Förderberatung), passen nicht in Bau/Garten/Schule/Kita/Spielplatz. Statt sie zu löschen: `state='reference'`, weil der Crawler ohnehin nur `state='active'` verarbeitet — sie bleiben als Referenz im `SOURCE_CATALOG` sichtbar, werden aber übersprungen. (Hinweis: `crawl_sources` hat **keine** `enabled`-Spalte — daher `state`, nicht `enabled`.)

### Git
Repo war schon da (erster Commit + Remote `origin`). `git init` unnötig. `.gitignore` war zu minimal (deckte nur `node_modules/`, `data/`, `.env`, `*.log`). Erweitert um SQLite-WAL/SHM, Coverage, Playwright-Reports, OS/Editor-Junk und die Scratch-Dateien (`validate*.cjs` etc.), die noch getrackt waren.
