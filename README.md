# Tender Crawler

Crawler für deutsche und europäische Ausschreibungsportale mit LLM-Analyse und Web-Dashboard.

## Features

- **5 integrierte Portale**: TED (EU), eVergabe Online (Vergabeplattform des Bundes), bund.de, Vergabe Bayern, Deutsches Vergabeportal
- **Change-Detection**: Änderungen an bestehenden Ausschreibungen werden erkannt und protokolliert
- **LLM-Anreicherung**: Zusammenfassung, Relevanz-Score und Anforderungs-Extraktion per LLM (Ollama oder OpenAI-kompatibel)
- **Volltextsuche** über Titel, Beschreibung, Auftraggeber, CPV-Labels und Leistungsort (SQLite FTS5)
- **Umfangreiche Filter**: Quelle, Region, Status, CPV, Frist, Wert, Relevanz
- **Respektvolles Crawling**: Rate-Limiter pro Portal + konfigurierbare Verzögerung
- **Web-Dashboard**: Statistik, Suche, Detailansicht, Crawl-Verlauf, manuelles Starten von Crawl & Analyse
- **Geplanter Betrieb**: Cron-Scheduler und Crawl beim Start konfigurierbar

## Portal-Status

| Portal | Status | Hinweis |
|---|---|---|
| **TED (EU)** | Aktiv | Offizielle Search API (`api.ted.europa.eu/v3`) mit vollständiger Iteration; nur Competition-/Change-Bekanntmachungen, XML-Rohsnapshot und normalisierte Lose/Kriterien/Dokumentlinks |
| **DTVP (Deutsches Vergabeportal)** | Aktiv | Discovery über die JSON-API; öffentliche Satellite-Seiten (`processdata/eforms`, Dokumente und anonyme Kommunikation) werden als DetailBundle inkl. Roh-HTML inventarisiert |
| **eVergabe Online** | Aktiv | Vergabeplattform des Bundes (`evergabe-online.de`). Die Wicket-JS-Oberfläche wird von einem **separaten Playwright-Worker** vollständig paginiert; Bekanntmachungsseite, XML und `tenderdocuments` werden ergänzt, verlinkte Binärdateien nur inventarisiert |
| **bund.de** | Deaktiviert | leitet auf die eVergabe-Plattform weiter → Daten sind über die Quelle `evergabe` abgedeckt |
| **Vergabe Bayern** | Deaktiviert | Portal geschlossen; Vergaben erscheinen heute auf `portal.deutsche-evergabe.de` (nur über Browser erreichbar) |

Deaktivierte Quellen werden vom Crawler übersprungen (`enabled=0` in der Tabelle `sources`).

## Browser-Worker (eVergabe)

Die eVergabe-Plattform lädt ihre Ergebnisse per Wicket-JavaScript – ohne Browser sind nur die
10 neuesten Treffer verfügbar. Der Crawler löst das mit einem eigenen Worker-Prozess:

```
npm run worker        # optional: Playwright-Worker separat starten
```

### Ablauf
1. `POST /api/crawl` reiht Browser-Quellen sofort als persistenten Job in die SQLite-Queue
   (`crawl_jobs`) ein – die API-Antwort kommt umgehend, direkte Quellen (TED/DTVP) laufen asynchron.
2. Der mit dem Server gestartete Worker claimt den Job atomar, startet ein persistentes anonymes Chromium-Profil
   (`data/browser-profiles/evergabe`) und öffnet die eVergabe-Suche.
3. Er setzt die Seitengröße auf 100 und traversiert die Ergebnisliste über die Wicket-Pagination.
4. Neue Tender werden gespeichert und anschließend über die Detailseiten mit Beschreibungen
   angereichert (rate-limited, nur für neue/geänderte Einträge).
5. Checkpoints (`crawl_checkpoints`) speichern Fortschritt und Modus:
   - **Initialimport**: läuft bis der 24-Monats-Stichtag erreicht ist oder die Liste endet.
   - **Aktualisierung**: stoppt nach mehreren vollständig bekannten Seiten (idempotent).
6. Ein Crawl-Button macht beides automatisch – der Status zeigt `Initialimport` oder `Aktualisierung`.

### Betrieb
- Worker und API-Server laufen als **getrennte Prozesse** und kommunizieren über die SQLite-DB
  (WAL-Modus, atomare Claims, Heartbeats).
- Crash-/Neustart-Sicherheit: verwaiste Lauf-Jobs werden per Heartbeat erkannt und auf `retry`
  gesetzt; Checkpoints erlauben die Wiederaufnahme.
- Heartbeat, Job-Timeout, Retries und Backfill-Zeitraum sind konfigurierbar (siehe `.env.example`).

### Konfiguration (Auszug)
| Variable | Standard | Bedeutung |
|---|---|---|
| `BROWSER_WORKER_ENABLED` | `true` | Worker aktivieren |
| `BROWSER_PROFILE_DIR` | `./data/browser-profiles` | Persistente Browser-Profile |
| `BROWSER_PAGE_WAIT_MS` | `2500` | Wartezeit nach Seitenwechseln |
| `EVERGABE_BACKFILL_MONTHS` | `24` | Initialimport-Zeitraum |
| `EVERGABE_KNOWN_PAGE_STOP` | `3` | Stopp im Aktualisierungs-Modus |
| `WORKER_HEARTBEAT_MS` | `10000` | Heartbeat-Intervall |
| `WORKER_MAX_ATTEMPTS` | `3` | Retry-Versuche je Job |

## Voraussetzungen

- Node.js >= 20
- Optional: Ollama (lokales LLM) oder ein OpenAI-kompatibler API-Endpunkt

## Installation

```bash
cd tender-crawler
npm install
cp .env.example .env
# .env anpassen (insbesondere AUTH_TOKEN und ggf. LLM-Einstellungen)
```

## Start

```bash
npm start            # Server: http://localhost:3000
npm run dev          # Entwicklung mit Auto-Reload
```

Beim ersten Start wird automatisch ein Crawl ausgeführt, sofern `CRAWL_ON_START=true` ist.

## Kommandozeile

```bash
npm run crawl                    # Crawl aller Quellen
npm run crawl -- ted,bund        # Nur bestimmte Quellen
node src/cli-crawl.js analyze 10 # LLM-Analyse mit Limit 10
```

## Konfiguration

Alle Einstellungen erfolgen über Umgebungsvariablen (`.env`), siehe `.env.example`.

| Variable | Beschreibung | Standard |
|---|---|---|
| `PORT` / `HOST` | Server-Adresse | `3000` / `0.0.0.0` |
| `DB_PATH` | Pfad zur SQLite-Datenbank | `./data/tender-crawler.sqlite` |
| `CRAWL_CRON` | Cron-Ausdruck für regelmäßige Crawls | `0 */8 * * *` |
| `CRAWL_ON_START` | Crawl beim Serverstart | `true` |
| `REQUEST_DELAY_MS` | Verzögerung zwischen Requests | `1200` |
| `MAX_RESULTS_PER_PORTAL` | Max. Ergebnisse pro Portal & Lauf | `100` |
| `LLM_ENABLED` | LLM-Anreicherung aktivieren | `false` |
| `LLM_PROVIDER` | `ollama` oder `openai`/`custom` | `ollama` |
| `LLM_MAX_ANALYSES_PER_DAY` | Tageslimit für Analysen | `50` |
| `AUTH_ENABLED` / `AUTH_TOKEN` | Token-basierte Authentifizierung | `true` / – |
| `FUNDING_ENABLED` | Förderprogramm-Bereich aktivieren | `true` |
| `FUNDING_CRAWL_CRON` | Cron für den regelmäßigen Förder-Crawl | `30 6 * * *` |
| `FUNDING_REQUEST_DELAY_MS` | Verzögerung zwischen Förder-Requests | `1500` |
| `FUNDING_MAX_REQUESTS_PER_MINUTE` | Rate-Limit Förderquellen | `15` |
| `FUNDING_LLM_ENABLED` | LLM für Förder-Extraktion (Standard: wie `LLM_ENABLED`) | `false` |

## Förderprogramme

Der Förderbereich ist ein eigener Dokumenttyp neben den Ausschreibungen. Er erfasst
Förderbekanntmachungen aus Bundesanzeiger und offiziellen Ministeriumsseiten und stellt
sie mit typgerechten Feldern dar:

- **Kernangaben**: Titel/Call, Fördergeber (mit Abkürzung), Status, Fristen (mit Zeitzone),
  Fördergegenstand.
- **Projektformen/Module**: getrennt pro Modul mit Laufzeit, Fördersumme (min/max),
  Förderquote und Förderhöchstbetrag – beliebig viele Varianten je Programm.
- **Antragsberechtigte / Zielgruppen / Voraussetzungen**: typisierte Listeneinträge.
- **Belege**: Jedes Feld mit Herkunft, Dokument/Seite, Textzitat, Methode und Konfidenz.
- **Prüfmodus**: Nutzer können Werte korrigieren und den Datensatz als geprüft bestätigen.
  Manuelle Overrides gewinnen bei Folgeläufen; neue Quellenwerte erzeugen einen
  Prüfhinweis statt den manuellen Wert zu überschreiben.

Die Extraktion ist hybrid: deterministische Parser erfassen Fristen, Laufzeiten, Beträge
und Quoten; optional ergänzt das LLM uneinheitliche Inhalte. LLM-Werte werden serverseitig
gegen den Quelltext validiert – unbelegbare Werte werden verworfen und der Datensatz als
`needs_review` markiert. Kein Wert wird erfunden; fehlende Angaben bleiben als
„nicht genannt“ sichtbar.

CLI: `npm run funding` (Förder-Crawl) bzw. `node src/cli-fetch-funding.js --source=seed`.

## API (Auszug)

Alle Endpunkte außer `/api/health` erfordern den Header `Authorization: Bearer <AUTH_TOKEN>`.

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/health` | Health-Check |
| GET | `/api/status` | Crawl- & Analyse-Status |
| POST | `/api/crawl` | Crawl starten (`{ sources: [...], enrich: true }`) |
| POST | `/api/analysis/run` | LLM-Analyse starten (`{ limit }`) |
| GET | `/api/stats` | Dashboard-Statistiken |
| GET | `/api/tenders` | Tender-Liste mit Filtern & Paginierung |
| GET | `/api/tenders/:id` | Tender-Detail mit Änderungshistorie |
| GET | `/api/sources` | Quellen-Liste |
| GET | `/api/crawls` | Crawl-Verlauf |
| GET/POST/DELETE | `/api/searches` | Gespeicherte Suchen |
| GET | `/api/funding-programs` | Förderprogramm-Liste mit Filtern & Suche |
| GET | `/api/funding-programs/:id` | Förderprogramm-Detail mit Belegen & Overrides |
| GET | `/api/funding/stats` | Förder-Statistiken |
| POST | `/api/funding/crawl` | Förder-Crawl starten (asynchron) |
| GET | `/api/funding/status` | Förder-Crawl-Status |
| GET | `/api/funding/crawls` | Förder-Crawl-Verlauf |
| GET | `/api/funding/sources` | Verfügbare Förderquellen |
| POST | `/api/funding-programs/:id/override` | Feld-Override setzen/löschen |
| POST | `/api/funding-programs/:id/confirm` | Datensatz als geprüft bestätigen |
| GET/POST/DELETE | `/api/crawl-sources` | Verwaltete Quellen auflisten/anlegen/löschen |
| POST | `/api/crawl-sources/:id/probe` | Probe-Crawl einer Quelle ausführen |
| GET | `/api/crawl-sources/:id/runs` | Läufe einer Quelle |
| GET | `/api/discovered` | Inbox der entdeckten Dokumente |
| POST | `/api/discovered/:id/process` | Entdecktes Dokument verarbeiten (Funding/Tender) |
| POST | `/api/rag/backfill` | RAG-Backfill (search_text_full + Chunks) |

Tender-Details enthalten zusätzlich aktuelle `text_sections` (bereinigter Seitenklartext),
generische `facts` sowie das Dokumentinventar. Dokumentdateien werden beim Crawl nicht
geladen. Eine kontrollierte Nachanreicherung des Bestands startet mit
`npm run backfill:details -- --sources=ted,dtvp,evergabe,nrw,niedersachsen`; der Lauf erstellt vorher eine
SQLite-Sicherung, paginiert TED vollständig, reichert DTVP direkt an und benötigt für eVergabe/Niedersachsen den Browser-Worker.

## Verwaltete Quellen & RAG

- **`crawl_sources`**: Katalog mit 66+ Förder-/Ausschreibungsquellen. Quellen werden erst nach einem erfolgreichen **Probe-Crawl** aktiviert; Status `unprobed`/`active`/`blocked`/`needs_config`/`disabled`.
- **Discovery**: Gemeinsame Module unter `src/discovery/` (URL-Normalisierung inkl. SSRF-Schutz, generischer HTML-Listen-Parser mit Fallback-Selektoren, deterministische Klassifikation `funding`/`tender`/`unknown`, Probe- und Discovery-Service).
- **Browser-Quellen** (Bundesanzeiger, EU-Portal, Landesförderbanken) laufen über die persistente Worker-Queue (Heartbeat/Retry/Cancel) mit einem generischen Playwright-Runner – nie im API-Prozess.
- **RAG-Vorbereitung**: Jeder Datensatz speichert eine Rohdokumentversion (`source_documents`) und strukturorientierte, überlappende Chunks mit stabilen `chunk_key`s (`document_chunks`), bereit für spätere Vektor-Embeddings (`embedding_models`, sqlite-vec vorbereitet).

CLI: `npm run probe` (Quellen prüfen), `npm run rag:backfill` (Bestand nachträglich chunken).

## Projektstruktur

```
tender-crawler/
├── public/               # Web-Dashboard (statisch)
├── src/
│   ├── config.js         # Umgebungs-Konfiguration
│   ├── db.js             # SQLite-Schema, Queries, Change-Detection
│   ├── llm.js            # LLM-Anreicherung (Ollama / OpenAI-kompatibel)
│   ├── server.js         # Fastify-API + Dashboard-Server
│   ├── cli-crawl.js      # CLI für Crawl/Analyse
│   ├── cli-fetch-funding.js # CLI für den Förder-Crawl
│   ├── cli-probe-sources.js # CLI für Quellen-Probe
│   ├── crawler/          # Orchestrator, HTTP-Client, Rate-Limiter
│   ├── portals/          # Portal-Adapter (ted, bund, evergabe, bayern, dtvp)
│   ├── funding/          # Förderprogramm-Bereich
│   │   ├── parser.js     # Deterministische Extraktion (Fristen, Beträge, …)
│   │   ├── extractor.js  # Hybride Pipeline (Parser + LLM, Beleg-Validierung)
│   │   ├── llm-client.js # JSON-LLM-Client
│   │   ├── orchestrator.js # Förder-Crawl-Orchestrator
│   │   └── sources/      # Förderquellen (seed, bundesanzeiger, registry)
│   └── discovery/        # Verwaltete Quellen
│       ├── catalog.js    # 66+ Quellen (URLs, Typ, Zugang, Priorität)
│       ├── html-list.js  # Generischer HTML-Listen-Parser
│       ├── classify.js   # Deterministische Funding/Tender-Klassifikation
│       ├── urls.js       # URL-Normalisierung + SSRF-Schutz
│       ├── sources.js    # Probe/Discovery/Dedup-Service
│       ├── browser.js    # Generischer Playwright-Runner
│       └── pipeline.js   # Routing entdeckter Dokumente → Funding/Tender
└── data/                 # SQLite-Datenbank (generiert)
```

## Hinweise zum respektvollen Crawling

- Der User-Agent identifiziert den Crawler eindeutig.
- Pro Portal gilt ein konfigurierbarer Rate-Limiter (Standard: 40 req/min global).
- Zwischen Requests wird eine Verzögerung eingehalten (`REQUEST_DELAY_MS`).
- Die Portale werden regelmäßig aktualisiert – bei Fragen zu Datenquellen die jeweiligen Nutzungsbedingungen beachten.# tender-crawler
