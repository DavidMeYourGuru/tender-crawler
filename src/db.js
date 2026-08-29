import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import config from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Hohes busy_timeout: Worker (Browser-Jobs) und Crawler können als
// separate Prozesse gleichzeitig auf dieselbe SQLite-Datei schreiben;
// bei Sperren wird gewartet statt sofort mit "database is locked" abzubrechen.
db.pragma('busy_timeout = 60000');

db.exec(`
-- Quellen (Portale)
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'api',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_crawl_at TEXT,
  crawl_interval_min INTEGER NOT NULL DEFAULT 480
);

-- Kern-Tabelle: Ausschreibungen
CREATE TABLE IF NOT EXISTS tenders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  contracting_authority TEXT,
  cpv_codes TEXT,
  cpv_labels TEXT,
  estimated_value_cents INTEGER,
  estimated_value_currency TEXT NOT NULL DEFAULT 'EUR',
  place_of_performance TEXT,
  award_criteria TEXT,
  tender_type TEXT,
  publication_date TEXT,
  submission_deadline TEXT,
  binding_period TEXT,
  opening_date TEXT,
  contract_duration TEXT,
  document_url TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  portal_status TEXT,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  llm_summary TEXT,
  llm_relevance_score REAL,
  llm_relevance_reason TEXT,
  llm_requirements TEXT,
  llm_analyzed_at TEXT,
  llm_model TEXT,
  UNIQUE(source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders(status);
CREATE INDEX IF NOT EXISTS idx_tenders_deadline ON tenders(submission_deadline);
CREATE INDEX IF NOT EXISTS idx_tenders_publication ON tenders(publication_date DESC);
CREATE INDEX IF NOT EXISTS idx_tenders_first_seen ON tenders(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenders_source ON tenders(source_id);
CREATE INDEX IF NOT EXISTS idx_tenders_relevance ON tenders(llm_relevance_score);

-- Änderungshistorie
CREATE TABLE IF NOT EXISTS tender_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  changed_at TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  entity_type TEXT NOT NULL DEFAULT 'tender',
  entity_key TEXT,
  change_kind TEXT NOT NULL DEFAULT 'updated'
);

CREATE INDEX IF NOT EXISTS idx_tender_changes_tender ON tender_changes(tender_id);

-- Crawl-Log
CREATE TABLE IF NOT EXISTS crawl_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT REFERENCES sources(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  items_discovered INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  items_changed INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  error_detail TEXT,
  detail_pages_success INTEGER NOT NULL DEFAULT 0,
  detail_pages_failed INTEGER NOT NULL DEFAULT 0,
  tenders_complete INTEGER NOT NULL DEFAULT 0,
  tenders_partial INTEGER NOT NULL DEFAULT 0,
  documents_inventoried INTEGER NOT NULL DEFAULT 0,
  messages_inventoried INTEGER NOT NULL DEFAULT 0,
  login_required INTEGER NOT NULL DEFAULT 0,
  unknown_portal_structure INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_crawl_log_started ON crawl_log(started_at DESC);

-- Gespeicherte Suchen
CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  keywords TEXT,
  cpv_codes TEXT,
  sources TEXT,
  regions TEXT,
  status_filter TEXT NOT NULL DEFAULT 'open',
  min_relevance REAL,
  notify_email TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- LLM-Quota-Log
CREATE TABLE IF NOT EXISTS llm_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id INTEGER REFERENCES tenders(id) ON DELETE CASCADE,
  analyzed_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_chars INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 1,
  error_message TEXT
);

-- Browser-Job-Queue (Browser-Worker)
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id),
  mode TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'queued',
  requested_at TEXT NOT NULL,
  started_at TEXT,
  heartbeat_at TEXT,
  finished_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_by TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  pages_done INTEGER NOT NULL DEFAULT 0,
  items_discovered INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  items_changed INTEGER NOT NULL DEFAULT 0,
  error_detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status ON crawl_jobs(status);
CREATE INDEX IF NOT EXISTS idx_crawl_jobs_source_status ON crawl_jobs(source_id, status);

-- Checkpoints für wiederaufnehmbare Browser-Crawls
CREATE TABLE IF NOT EXISTS crawl_checkpoints (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  oldest_publication_date TEXT,
  last_page_key TEXT,
  last_success_at TEXT,
  known_page_streak INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Zusätzliche öffentliche Verfahrensdaten. Die Tabellen sind für die
-- Metadateninventarisierung gedacht; Binärdateien werden in dieser Phase
-- ausdrücklich noch nicht gespeichert.
CREATE TABLE IF NOT EXISTS tender_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  lot_key TEXT NOT NULL,
  lot_number TEXT,
  title TEXT,
  description TEXT,
  cpv_codes TEXT,
  cpv_labels TEXT,
  estimated_value_cents INTEGER,
  estimated_value_currency TEXT DEFAULT 'EUR',
  place_of_performance TEXT,
  contract_duration TEXT,
  metadata_json TEXT,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(tender_id, lot_key)
);
CREATE INDEX IF NOT EXISTS idx_tender_lots_tender ON tender_lots(tender_id);

CREATE TABLE IF NOT EXISTS tender_criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  lot_id INTEGER REFERENCES tender_lots(id) ON DELETE CASCADE,
  criterion_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  code TEXT,
  title TEXT,
  description TEXT,
  weight REAL,
  minimum_value TEXT,
  required INTEGER,
  source_section TEXT,
  metadata_json TEXT,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(tender_id, criterion_key)
);
CREATE INDEX IF NOT EXISTS idx_tender_criteria_tender ON tender_criteria(tender_id);

CREATE TABLE IF NOT EXISTS tender_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  portal_file_id TEXT,
  category TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT,
  extension TEXT,
  size_bytes INTEGER,
  published_at TEXT,
  source_url TEXT,
  locator_json TEXT,
  access_status TEXT NOT NULL DEFAULT 'public',
  download_status TEXT NOT NULL DEFAULT 'not_requested',
  local_path TEXT,
  binary_hash TEXT,
  document_text TEXT,
  version_key TEXT,
  version_label TEXT,
  supersedes_document_id INTEGER REFERENCES tender_documents(id),
  visibility_status TEXT NOT NULL DEFAULT 'active',
  not_seen_count INTEGER NOT NULL DEFAULT 0,
  last_full_seen_at TEXT,
  last_seen_crawl_token TEXT,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(tender_id, portal_file_id, filename)
);
CREATE INDEX IF NOT EXISTS idx_tender_documents_tender ON tender_documents(tender_id);

CREATE TABLE IF NOT EXISTS tender_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  portal_message_id TEXT,
  subject TEXT,
  body TEXT,
  published_at TEXT,
  source_url TEXT,
  attachments_json TEXT,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(tender_id, portal_message_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_tender_messages_tender ON tender_messages(tender_id);

CREATE TABLE IF NOT EXISTS tender_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source_url TEXT,
  mime_type TEXT,
  content TEXT,
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL,
  UNIQUE(tender_id, kind, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_tender_snapshots_tender ON tender_snapshots(tender_id, kind, version);

-- Aktuelle, bereinigte Abschnittstexte und sichere Label-Wert-Fakten.
-- Roh-HTML bleibt in tender_snapshots; diese Tabellen sind bewusst current-only.
CREATE TABLE IF NOT EXISTS tender_text_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  title TEXT,
  source_url TEXT,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(tender_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_tender_text_sections_tender ON tender_text_sections(tender_id);

CREATE TABLE IF NOT EXISTS tender_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  section_key TEXT,
  label TEXT NOT NULL,
  value_text TEXT,
  normalized_value_json TEXT,
  data_type TEXT,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(tender_id, fact_key)
);
CREATE INDEX IF NOT EXISTS idx_tender_facts_tender ON tender_facts(tender_id);

CREATE TABLE IF NOT EXISTS tender_discovery_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  portal_project_id TEXT NOT NULL,
  title TEXT,
  contracting_authority TEXT,
  publication_date TEXT,
  submission_deadline TEXT,
  cpv_codes TEXT,
  cpv_labels TEXT,
  in_scope INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  UNIQUE(source_id, portal_project_id)
);
CREATE INDEX IF NOT EXISTS idx_tender_discovery_cache_source ON tender_discovery_cache(source_id, last_seen_at);

CREATE TABLE IF NOT EXISTS tender_migration_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  portal_project_id TEXT NOT NULL,
  title TEXT,
  candidate_count INTEGER NOT NULL,
  candidate_ids TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Persönliche Zustände pro Ausschreibung (Inbox-Aktionen)
CREATE TABLE IF NOT EXISTS tender_user_states (
  tender_id INTEGER PRIMARY KEY REFERENCES tenders(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'unseen' CHECK (state IN ('unseen', 'seen', 'watch', 'dismiss')),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tender_user_states_state ON tender_user_states(state);
`);

// FTS5 Volltextsuche – muss nach dem Erstellen von tenders ausgeführt werden.
// `search_text_full` ist absichtlich ein eigenes FTS-Feld: Der aggregierte
// Detailtext kann deutlich mehr enthalten als die kurzen Kernspalten.
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS tenders_fts USING fts5(
  title,
  description,
  contracting_authority,
  cpv_labels,
  place_of_performance,
  search_text_full,
  content='tenders',
  content_rowid='id'
);
`);

db.exec(`
-- Trigger zur Synchronisierung des FTS-Index
CREATE TRIGGER IF NOT EXISTS tenders_ai AFTER INSERT ON tenders BEGIN
  INSERT INTO tenders_fts(rowid, title, description, contracting_authority, cpv_labels, place_of_performance)
  VALUES (new.id, new.title, COALESCE(new.description,''), COALESCE(new.contracting_authority,''), COALESCE(new.cpv_labels,''), COALESCE(new.place_of_performance,''));
END;

CREATE TRIGGER IF NOT EXISTS tenders_ad AFTER DELETE ON tenders BEGIN
  INSERT INTO tenders_fts(tenders_fts, rowid, title, description, contracting_authority, cpv_labels, place_of_performance)
  VALUES ('delete', old.id, old.title, COALESCE(old.description,''), COALESCE(old.contracting_authority,''), COALESCE(old.cpv_labels,''), COALESCE(old.place_of_performance,''));
END;

CREATE TRIGGER IF NOT EXISTS tenders_au AFTER UPDATE ON tenders BEGIN
  INSERT INTO tenders_fts(tenders_fts, rowid, title, description, contracting_authority, cpv_labels, place_of_performance)
  VALUES ('delete', old.id, old.title, COALESCE(old.description,''), COALESCE(old.contracting_authority,''), COALESCE(old.cpv_labels,''), COALESCE(old.place_of_performance,''));
  INSERT INTO tenders_fts(rowid, title, description, contracting_authority, cpv_labels, place_of_performance)
  VALUES (new.id, new.title, COALESCE(new.description,''), COALESCE(new.contracting_authority,''), COALESCE(new.cpv_labels,''), COALESCE(new.place_of_performance,''));
END;
`);

// ── Förderprogramme (eigener Dokumenttyp) ─────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS funding_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  current_call TEXT,
  short_description TEXT,
  funding_gegenstand TEXT,
  funding_geber TEXT,
  funding_geber_short TEXT,
  search_text TEXT,
  publication_date TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  primary_url TEXT,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  extracted_at TEXT,
  extraction_model TEXT,
  UNIQUE(source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_funding_programs_status ON funding_programs(status);
CREATE INDEX IF NOT EXISTS idx_funding_programs_review ON funding_programs(review_status);
CREATE INDEX IF NOT EXISTS idx_funding_programs_source ON funding_programs(source_id);

CREATE TABLE IF NOT EXISTS funding_deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES funding_programs(id) ON DELETE CASCADE,
  label TEXT,
  deadline_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
  is_ongoing INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_funding_deadlines_program ON funding_deadlines(program_id);
CREATE INDEX IF NOT EXISTS idx_funding_deadlines_at ON funding_deadlines(deadline_at);

CREATE TABLE IF NOT EXISTS funding_project_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES funding_programs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  duration_min_months INTEGER,
  duration_max_months INTEGER,
  amount_min_cents INTEGER,
  amount_max_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  funding_quote_min REAL,
  funding_quote_max REAL,
  max_amount_cents INTEGER,
  conditions TEXT
);

CREATE INDEX IF NOT EXISTS idx_funding_project_types_program ON funding_project_types(program_id);

CREATE TABLE IF NOT EXISTS funding_eligibility (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES funding_programs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_funding_eligibility_program ON funding_eligibility(program_id);

CREATE TABLE IF NOT EXISTS funding_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES funding_programs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  UNIQUE(program_id, url)
);

CREATE INDEX IF NOT EXISTS idx_funding_links_program ON funding_links(program_id);

CREATE TABLE IF NOT EXISTS funding_field_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES funding_programs(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  field TEXT NOT NULL,
  source_url TEXT,
  document_title TEXT,
  page TEXT,
  quote TEXT,
  method TEXT NOT NULL DEFAULT 'parser',
  confidence REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_funding_evidence_program ON funding_field_evidence(program_id);

CREATE TABLE IF NOT EXISTS funding_field_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES funding_programs(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  is_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(program_id, entity, field)
);

CREATE TABLE IF NOT EXISTS funding_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES funding_programs(id) ON DELETE CASCADE,
  changed_at TEXT NOT NULL,
  entity TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT NOT NULL DEFAULT 'crawl'
);

CREATE INDEX IF NOT EXISTS idx_funding_changes_program ON funding_changes(program_id);

CREATE TABLE IF NOT EXISTS funding_crawl_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  items_discovered INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  items_changed INTEGER NOT NULL DEFAULT 0,
  documents_loaded INTEGER NOT NULL DEFAULT 0,
  extraction_errors INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  error_detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_funding_crawl_log_started ON funding_crawl_log(started_at DESC);

-- Verwaltete Quellen (Förderungen & Ausschreibungen)
CREATE TABLE IF NOT EXISTS crawl_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  region TEXT DEFAULT 'de',
  url TEXT NOT NULL,
  declared_kind TEXT NOT NULL DEFAULT 'funding',
  access TEXT NOT NULL DEFAULT 'http',
  format TEXT NOT NULL DEFAULT 'html_list',
  search_params TEXT,
  list_item_selector TEXT,
  title_selector TEXT,
  link_selector TEXT,
  date_selector TEXT,
  detail_text_selector TEXT,
  rate_limit_rpm INTEGER NOT NULL DEFAULT 10,
  state TEXT NOT NULL DEFAULT 'unprobed',
  priority INTEGER NOT NULL DEFAULT 5,
  last_http_status INTEGER,
  last_item_count INTEGER,
  last_error_type TEXT,
  last_error TEXT,
  parser_version TEXT,
  last_crawl_at TEXT,
  last_success_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crawl_sources_state ON crawl_sources(state);
CREATE INDEX IF NOT EXISTS idx_crawl_sources_kind ON crawl_sources(declared_kind, access, state);

-- Läufe pro Quelle (Probe & Produktion)
CREATE TABLE IF NOT EXISTS crawl_source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES crawl_sources(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'probe',
  document_kind TEXT,
  http_status INTEGER,
  items_discovered INTEGER NOT NULL DEFAULT 0,
  items_imported INTEGER NOT NULL DEFAULT 0,
  items_rejected INTEGER NOT NULL DEFAULT 0,
  items_classified_unknown INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  error_detail TEXT,
  parser_version TEXT,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawl_source_runs_source ON crawl_source_runs(source_id);

-- Gemeinsame Inbox vor fachlicher Speicherung
CREATE TABLE IF NOT EXISTS discovered_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES crawl_sources(id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  title TEXT,
  publication_date TEXT,
  fingerprint TEXT,
  classification TEXT,
  classification_confidence REAL,
  classification_reason TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  target_funding_id INTEGER REFERENCES funding_programs(id) ON DELETE SET NULL,
  target_tender_id INTEGER REFERENCES tenders(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(canonical_url, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_discovered_status ON discovered_documents(status, classification);

-- Rohdokumente für RAG
CREATE TABLE IF NOT EXISTS source_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_kind TEXT NOT NULL,
  entity_id INTEGER,
  canonical_url TEXT,
  mime_type TEXT,
  document_title TEXT,
  content TEXT,
  content_hash TEXT,
  content_length INTEGER NOT NULL DEFAULT 0,
  doc_version INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_documents_entity ON source_documents(doc_kind, entity_id);
CREATE INDEX IF NOT EXISTS idx_source_documents_url ON source_documents(canonical_url);

-- RAG-Vorbereitung: Text-Chunks für spätere Vektor-Embeddings
CREATE TABLE IF NOT EXISTS document_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_kind TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  doc_version INTEGER NOT NULL DEFAULT 1,
  chunk_key TEXT NOT NULL UNIQUE,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  heading TEXT,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  offset_chars INTEGER NOT NULL DEFAULT 0,
  chunker_version TEXT NOT NULL DEFAULT '1',
  embedding_model_id INTEGER,
  embedding TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks(doc_kind, entity_id, doc_version);

-- Embedding-Modelle
CREATE TABLE IF NOT EXISTS embedding_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER,
  version TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(provider, model, version)
);
`);

// Migrationen: search_text_full-Spalten für bestehende Tabellen
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('tenders', 'search_text_full', 'TEXT');
ensureColumn('funding_programs', 'search_text_full', 'TEXT');
ensureColumn('tenders', 'portal_project_id', 'TEXT');
ensureColumn('tenders', 'reference_number', 'TEXT');
ensureColumn('tenders', 'procedure_type', 'TEXT');
ensureColumn('tenders', 'question_deadline', 'TEXT');
ensureColumn('tenders', 'binding_period', 'TEXT');
ensureColumn('tenders', 'portal_status', 'TEXT');
ensureColumn('tenders', 'detail_status', 'TEXT');
ensureColumn('tenders', 'detail_crawled_at', 'TEXT');
ensureColumn('tenders', 'detail_completeness', 'TEXT');
ensureColumn('tenders', 'portal_metadata_json', 'TEXT');
ensureColumn('tenders', 'detail_crawl_kind', "TEXT NOT NULL DEFAULT 'unknown'");
ensureColumn('tenders', 'last_full_seen_at', 'TEXT');
ensureColumn('tender_changes', 'entity_type', "TEXT NOT NULL DEFAULT 'tender'");
ensureColumn('tender_changes', 'entity_key', 'TEXT');
ensureColumn('tender_changes', 'change_kind', "TEXT NOT NULL DEFAULT 'updated'");
ensureColumn('tender_documents', 'version_key', 'TEXT');
ensureColumn('tender_documents', 'version_label', 'TEXT');
ensureColumn('tender_documents', 'supersedes_document_id', 'INTEGER');
ensureColumn('tender_documents', 'visibility_status', "TEXT NOT NULL DEFAULT 'active'");
ensureColumn('tender_documents', 'not_seen_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tender_documents', 'last_full_seen_at', 'TEXT');
ensureColumn('tender_documents', 'last_seen_crawl_token', 'TEXT');
ensureColumn('tender_snapshots', 'version', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('tender_discovery_cache', 'discovery_fingerprint', 'TEXT');
ensureColumn('tender_discovery_cache', 'last_detail_at', 'TEXT');
ensureColumn('tender_discovery_cache', 'detail_status', 'TEXT');
ensureColumn('crawl_log', 'detail_pages_success', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('crawl_log', 'detail_pages_failed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('crawl_log', 'tenders_complete', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('crawl_log', 'tenders_partial', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('crawl_log', 'documents_inventoried', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('crawl_log', 'messages_inventoried', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('crawl_log', 'login_required', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('crawl_log', 'unknown_portal_structure', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('saved_searches', 'min_lead_days', 'INTEGER');
ensureColumn('saved_searches', 'updated_at', 'TEXT');

// Bestehende Installationen haben einen FTS5-Index ohne `search_text_full`.
// FTS5 kann Spalten nicht per ALTER TABLE erweitern; der abgeleitete Index
// wird deshalb sicher (und ohne Nutzdatenverlust) neu angelegt. Die Trigger
// werden immer neu definiert, damit auch ein bereits migrierter Index die
// Volltextspalte bei INSERT/UPDATE synchron hält.
const tenderFtsColumns = db.prepare(`PRAGMA table_info(tenders_fts)`).all();
const tenderFtsNeedsMigration = tenderFtsColumns.length > 0
  && !tenderFtsColumns.some((column) => column.name === 'search_text_full');
db.exec(`DROP TRIGGER IF EXISTS tenders_ai; DROP TRIGGER IF EXISTS tenders_ad; DROP TRIGGER IF EXISTS tenders_au;`);
if (tenderFtsNeedsMigration) {
  db.exec(`DROP TABLE IF EXISTS tenders_fts;`);
}
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS tenders_fts USING fts5(
  title, description, contracting_authority, cpv_labels,
  place_of_performance, search_text_full,
  content='tenders', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS tenders_ai AFTER INSERT ON tenders BEGIN
  INSERT INTO tenders_fts(rowid, title, description, contracting_authority, cpv_labels, place_of_performance, search_text_full)
  VALUES (new.id, new.title, COALESCE(new.description,''), COALESCE(new.contracting_authority,''), COALESCE(new.cpv_labels,''), COALESCE(new.place_of_performance,''), COALESCE(new.search_text_full,''));
END;
CREATE TRIGGER IF NOT EXISTS tenders_ad AFTER DELETE ON tenders BEGIN
  INSERT INTO tenders_fts(tenders_fts, rowid, title, description, contracting_authority, cpv_labels, place_of_performance, search_text_full)
  VALUES ('delete', old.id, old.title, COALESCE(old.description,''), COALESCE(old.contracting_authority,''), COALESCE(old.cpv_labels,''), COALESCE(old.place_of_performance,''), COALESCE(old.search_text_full,''));
END;
CREATE TRIGGER IF NOT EXISTS tenders_au AFTER UPDATE ON tenders BEGIN
  INSERT INTO tenders_fts(tenders_fts, rowid, title, description, contracting_authority, cpv_labels, place_of_performance, search_text_full)
  VALUES ('delete', old.id, old.title, COALESCE(old.description,''), COALESCE(old.contracting_authority,''), COALESCE(old.cpv_labels,''), COALESCE(old.place_of_performance,''), COALESCE(old.search_text_full,''));
  INSERT INTO tenders_fts(rowid, title, description, contracting_authority, cpv_labels, place_of_performance, search_text_full)
  VALUES (new.id, new.title, COALESCE(new.description,''), COALESCE(new.contracting_authority,''), COALESCE(new.cpv_labels,''), COALESCE(new.place_of_performance,''), COALESCE(new.search_text_full,''));
END;
`);
// Ein Rebuild ist bei der Migration erforderlich; bei einem bereits neuen
// Index stellt er nach manuellen DB-Reparaturen ebenfalls Konsistenz her.
db.exec(`INSERT INTO tenders_fts(tenders_fts) VALUES ('rebuild');`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenders_source_portal_project
  ON tenders(source_id, portal_project_id) WHERE portal_project_id IS NOT NULL`);

// document_chunks: alte (unbenutzte) Version ohne UNIQUE(chunk_key) sicher ersetzen
try {
  const chunkCols = db.prepare(`PRAGMA table_info(document_chunks)`).all();
  const hasChunkKey = chunkCols.some((c) => c.name === 'chunk_key');
  const hasUniqueChunkKey = db.prepare(`PRAGMA index_list(document_chunks)`).all().some((i) => i.unique);
  if (hasChunkKey && !hasUniqueChunkKey) {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM document_chunks`).get().c;
    if (count === 0) {
      db.exec(`DROP TABLE document_chunks`);
    }
  }
} catch {
  // Tabelle fehlt – kein Problem
}
// Nach DROP erneut mit neuem Schema anlegen (falls entfernt)
db.exec(`
CREATE TABLE IF NOT EXISTS document_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_kind TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  doc_version INTEGER NOT NULL DEFAULT 1,
  chunk_key TEXT NOT NULL UNIQUE,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  heading TEXT,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  offset_chars INTEGER NOT NULL DEFAULT 0,
  chunker_version TEXT NOT NULL DEFAULT '1',
  embedding_model_id INTEGER,
  embedding TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks(doc_kind, entity_id, doc_version);
`);

// source_documents: canonical_url darf null sein (aggregierte Text-Versionen)
try {
  const sdCols = db.prepare(`PRAGMA table_info(source_documents)`).all();
  const urlCol = sdCols.find((c) => c.name === 'canonical_url');
  if (urlCol && String(urlCol.notnull) === '1') {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM source_documents`).get().c;
    if (count === 0) {
      db.exec(`DROP TABLE source_documents`);
    }
  }
} catch {
  // fehlt – egal
}
db.exec(`
CREATE TABLE IF NOT EXISTS source_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_kind TEXT NOT NULL,
  entity_id INTEGER,
  canonical_url TEXT,
  mime_type TEXT,
  document_title TEXT,
  content TEXT,
  content_hash TEXT,
  content_length INTEGER NOT NULL DEFAULT 0,
  doc_version INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_documents_entity ON source_documents(doc_kind, entity_id);
CREATE INDEX IF NOT EXISTS idx_source_documents_url ON source_documents(canonical_url);
`);

// FTS5-Index über die Förder-Chunks für die Chat-Chunk-Auswahl.
// Standalone (ohne content=): beim Start wird der Index immer sauber aus
// document_chunks neu aufgebaut (keine Trigger, keine Abhängigkeit auf alte
// externe-content-Versionen mit möglicherweise inkonsistenten rowids).
db.exec(`DROP TABLE IF EXISTS funding_chunks_fts`);
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS funding_chunks_fts USING fts5(
  entity_id UNINDEXED,
  chunk_key UNINDEXED,
  doc_version UNINDEXED,
  heading,
  text
);
`);
// Datenbestand sofort neu aufbauen (falls Chunks existieren)
try {
  rebuildFundingChunkFts();
} catch (error) {
  console.warn('[db] funding_chunks_fts Rebuild fehlgeschlagen:', error.message);
}

// Alte, unbenutzte crawl_urls-Tabelle entfernen (leer), falls vorhanden
try {
  const legacyCount = db.prepare(`SELECT COUNT(*) AS c FROM crawl_urls`).get().c;
  if (legacyCount === 0) {
    db.exec(`DROP TABLE IF EXISTS crawl_urls`);
  }
} catch {
  // Tabelle existiert nicht – kein Problem
}

// FTS5 für Förderprogramme – inkl. Suchtext aus Kindentitäten und Volltext.
// Migration: bestehende Tabellen ohne `search_text_full` werden einmalig
// neu erstellt und neu indiziert.
let fundingFtsNeedsMigration = false;
try {
  const fundingFtsInfo = db.prepare(`PRAGMA table_info(funding_programs_fts)`).all();
  fundingFtsNeedsMigration = fundingFtsInfo.length > 0 && !fundingFtsInfo.some((c) => c.name === 'search_text_full');
} catch {
  fundingFtsNeedsMigration = false;
}
if (fundingFtsNeedsMigration) {
  db.exec(`DROP TRIGGER IF EXISTS funding_ai; DROP TRIGGER IF EXISTS funding_ad; DROP TRIGGER IF EXISTS funding_au; DROP TABLE IF EXISTS funding_programs_fts;`);
}

db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS funding_programs_fts USING fts5(
  title,
  current_call,
  funding_geber,
  funding_gegenstand,
  short_description,
  search_text,
  search_text_full,
  content='funding_programs',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS funding_ai AFTER INSERT ON funding_programs BEGIN
  INSERT INTO funding_programs_fts(rowid, title, current_call, funding_geber, funding_gegenstand, short_description, search_text, search_text_full)
  VALUES (new.id, new.title, COALESCE(new.current_call,''), COALESCE(new.funding_geber,''), COALESCE(new.funding_gegenstand,''), COALESCE(new.short_description,''), COALESCE(new.search_text,''), COALESCE(new.search_text_full,''));
END;

CREATE TRIGGER IF NOT EXISTS funding_ad AFTER DELETE ON funding_programs BEGIN
  INSERT INTO funding_programs_fts(funding_programs_fts, rowid, title, current_call, funding_geber, funding_gegenstand, short_description, search_text, search_text_full)
  VALUES ('delete', old.id, old.title, COALESCE(old.current_call,''), COALESCE(old.funding_geber,''), COALESCE(old.funding_gegenstand,''), COALESCE(old.short_description,''), COALESCE(old.search_text,''), COALESCE(old.search_text_full,''));
END;

CREATE TRIGGER IF NOT EXISTS funding_au AFTER UPDATE ON funding_programs BEGIN
  INSERT INTO funding_programs_fts(funding_programs_fts, rowid, title, current_call, funding_geber, funding_gegenstand, short_description, search_text, search_text_full)
  VALUES ('delete', old.id, old.title, COALESCE(old.current_call,''), COALESCE(old.funding_geber,''), COALESCE(old.funding_gegenstand,''), COALESCE(old.short_description,''), COALESCE(old.search_text,''), COALESCE(old.search_text_full,''));
  INSERT INTO funding_programs_fts(rowid, title, current_call, funding_geber, funding_gegenstand, short_description, search_text, search_text_full)
  VALUES (new.id, new.title, COALESCE(new.current_call,''), COALESCE(new.funding_geber,''), COALESCE(new.funding_gegenstand,''), COALESCE(new.short_description,''), COALESCE(new.search_text,''), COALESCE(new.search_text_full,''));
END;
`);

if (fundingFtsNeedsMigration) {
  db.exec(`INSERT INTO funding_programs_fts(funding_programs_fts) VALUES('rebuild')`);
  console.log('[db] funding_programs_fts um search_text_full erweitert und neu indiziert.');
}

// Seed: Standardquellen
const seedSources = db.transaction(() => {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO sources (id, name, region, type, crawl_interval_min, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // enabled=0: bund.de leitet auf die eVergabe-Plattform weiter (→ evergabe-Quelle),
  // Bayern-Portal ist geschlossen (→ deutsche-evergabe.de, nur Browser).
  const sources = [
    ['ted', 'TED (Tenders Electronic Daily)', 'eu', 'api', 360, 1],
    ['bund', 'Bundesvergabeportal (bund.de → eVergabe)', 'de', 'html', 480, 0],
    ['evergabe', 'eVergabe Online (Vergabeplattform des Bundes)', 'de', 'html', 480, 1],
    ['bayern', 'Vergabe Bayern (auftraege.bayern.de)', 'bayern', 'html', 480, 0],
    ['dtvp', 'Deutsches Vergabeportal (dtvp.de)', 'de', 'html', 480, 1],
    ['nrw', 'Vergabemarktplatz NRW (evergabe.nrw.de)', 'nrw', 'html', 480, 1],
    ['niedersachsen', 'Vergabeportal Niedersachsen (Deutsche eVergabe)', 'niedersachsen', 'browser', 480, 1],
  ];
  for (const [id, name, region, type, interval, enabled] of sources) {
    insert.run(id, name, region, type, interval, enabled);
  }

  // Migration für bestehende Datenbanken: Quelle aktualisieren
  const updateSource = db.prepare(`
    UPDATE sources SET name = ?, enabled = ? WHERE id = ?
  `);
  updateSource.run('Bundesvergabeportal (bund.de → eVergabe)', 0, 'bund');
  updateSource.run('Vergabe Bayern (auftraege.bayern.de)', 0, 'bayern');
  updateSource.run('eVergabe Online (Vergabeplattform des Bundes)', 1, 'evergabe');

  // eVergabe läuft jetzt über den Browser-Worker
  db.prepare(`UPDATE sources SET type = 'browser' WHERE id = 'evergabe'`).run();
  // Niedersachsen (Deutsche eVergabe) läuft über den Browser-Worker
  db.prepare(`UPDATE sources SET type = 'browser' WHERE id = 'niedersachsen'`).run();
});
seedSources();

export const stmts = {
  getTenderBySourceAndExternalId: db.prepare(
    `SELECT * FROM tenders WHERE source_id = ? AND external_id = ?`
  ),
  getTenderBySourceAndPortalProject: db.prepare(
    `SELECT * FROM tenders WHERE source_id = ? AND portal_project_id = ?`
  ),
  getTenderById: db.prepare(`SELECT * FROM tenders WHERE id = ?`),
  selectNewTenderIds: db.prepare(`
    SELECT id FROM tenders
    WHERE last_changed_at = first_seen_at
      AND strftime('%s', last_changed_at) >= strftime('%s', 'now', '-1 day')
    ORDER BY id DESC
    LIMIT ?
  `),
  upsertSourceLastCrawl: db.prepare(
    `UPDATE sources SET last_crawl_at = ? WHERE id = ?`
  ),
  getSource: db.prepare(`SELECT * FROM sources WHERE id = ?`),
  allSources: db.prepare(`SELECT * FROM sources ORDER BY name`),
  insertCrawlLog: db.prepare(
    `INSERT INTO crawl_log (source_id, started_at) VALUES (?, ?)`
  ),
  finishCrawlLog: db.prepare(`
    UPDATE crawl_log SET finished_at = @finished_at, status = @status,
      items_discovered = @items_discovered, items_new = @items_new,
      items_changed = @items_changed, errors = @errors, error_detail = @error_detail,
      detail_pages_success = @detail_pages_success, detail_pages_failed = @detail_pages_failed,
      tenders_complete = @tenders_complete, tenders_partial = @tenders_partial,
      documents_inventoried = @documents_inventoried, messages_inventoried = @messages_inventoried,
      login_required = @login_required, unknown_portal_structure = @unknown_portal_structure
    WHERE id = @id
  `),
  updateCrawlDetailMetrics: db.prepare(`
    UPDATE crawl_log SET
      detail_pages_success = @detail_pages_success,
      detail_pages_failed = @detail_pages_failed,
      tenders_complete = @tenders_complete,
      tenders_partial = @tenders_partial,
      documents_inventoried = @documents_inventoried,
      messages_inventoried = @messages_inventoried,
      login_required = @login_required,
      unknown_portal_structure = @unknown_portal_structure
    WHERE id = @id
  `),
  insertTender: db.prepare(`
    INSERT INTO tenders (
      source_id, external_id, title, url, description, contracting_authority,
      cpv_codes, cpv_labels, estimated_value_cents, estimated_value_currency,
      place_of_performance, award_criteria, tender_type, publication_date,
      submission_deadline, binding_period, opening_date, contract_duration, document_url,
      status, portal_status, content_hash, search_text_full, portal_project_id, reference_number,
      procedure_type, question_deadline, detail_status, detail_crawled_at,
      detail_completeness, portal_metadata_json, detail_crawl_kind, last_full_seen_at,
      first_seen_at, last_seen_at, last_changed_at
    ) VALUES (
      @source_id, @external_id, @title, @url, @description, @contracting_authority,
      @cpv_codes, @cpv_labels, @estimated_value_cents, @estimated_value_currency,
      @place_of_performance, @award_criteria, @tender_type, @publication_date,
      @submission_deadline, @binding_period, @opening_date, @contract_duration, @document_url,
      @status, @portal_status, @content_hash, @search_text_full, @portal_project_id, @reference_number,
      @procedure_type, @question_deadline, @detail_status, @detail_crawled_at,
      @detail_completeness, @portal_metadata_json, @detail_crawl_kind, @last_full_seen_at,
      @now, @now, @now
    )
  `),
  updateTender: db.prepare(`
    UPDATE tenders SET
      external_id = @external_id,
      title = @title,
      url = @url,
      description = COALESCE(@description, description),
      contracting_authority = COALESCE(@contracting_authority, contracting_authority),
      cpv_codes = COALESCE(@cpv_codes, cpv_codes),
      cpv_labels = COALESCE(@cpv_labels, cpv_labels),
      estimated_value_cents = COALESCE(@estimated_value_cents, estimated_value_cents),
      estimated_value_currency = COALESCE(@estimated_value_currency, estimated_value_currency),
      place_of_performance = COALESCE(@place_of_performance, place_of_performance),
      award_criteria = COALESCE(@award_criteria, award_criteria),
      tender_type = COALESCE(@tender_type, tender_type),
      publication_date = COALESCE(@publication_date, publication_date),
      submission_deadline = COALESCE(@submission_deadline, submission_deadline),
      binding_period = COALESCE(@binding_period, binding_period),
      opening_date = COALESCE(@opening_date, opening_date),
      contract_duration = COALESCE(@contract_duration, contract_duration),
      document_url = COALESCE(@document_url, document_url),
      status = @status,
      portal_status = COALESCE(@portal_status, portal_status),
      content_hash = @content_hash,
      search_text_full = COALESCE(@search_text_full, search_text_full),
      portal_project_id = COALESCE(@portal_project_id, portal_project_id),
      reference_number = COALESCE(@reference_number, reference_number),
      procedure_type = COALESCE(@procedure_type, procedure_type),
      question_deadline = COALESCE(@question_deadline, question_deadline),
      detail_status = COALESCE(@detail_status, detail_status),
      detail_crawled_at = COALESCE(@detail_crawled_at, detail_crawled_at),
      detail_completeness = COALESCE(@detail_completeness, detail_completeness),
      portal_metadata_json = COALESCE(@portal_metadata_json, portal_metadata_json),
      detail_crawl_kind = COALESCE(@detail_crawl_kind, detail_crawl_kind),
      last_full_seen_at = COALESCE(@last_full_seen_at, last_full_seen_at),
      last_seen_at = @now,
      last_changed_at = CASE WHEN @changed = 1 THEN @now ELSE last_changed_at END
    WHERE id = @id
  `),
  insertChange: db.prepare(`
    INSERT INTO tender_changes (tender_id, changed_at, field, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `),
  insertEntityChange: db.prepare(`
    INSERT INTO tender_changes (
      tender_id, changed_at, field, old_value, new_value,
      entity_type, entity_key, change_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateLlamaAnalysis: db.prepare(`
    UPDATE tenders SET
      llm_summary = @llm_summary,
      llm_relevance_score = @llm_relevance_score,
      llm_relevance_reason = @llm_relevance_reason,
      llm_requirements = @llm_requirements,
      llm_analyzed_at = @llm_analyzed_at,
      llm_model = @llm_model
    WHERE id = @id
  `),
  insertLlmLog: db.prepare(`
    INSERT INTO llm_log (tender_id, analyzed_at, provider, model, input_chars, output_chars, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  countLlmAnalysesToday: db.prepare(`
    SELECT COUNT(*) AS count FROM llm_log
    WHERE analyzed_at >= ? AND success = 1
  `),
  insertSavedSearch: db.prepare(`
    INSERT INTO saved_searches (name, keywords, cpv_codes, sources, regions, status_filter, min_relevance, min_lead_days, notify_email, active, created_at, updated_at)
    VALUES (@name, @keywords, @cpv_codes, @sources, @regions, @status_filter, @min_relevance, @min_lead_days, @notify_email, 1, @created_at, @created_at)
  `),
  allSavedSearches: db.prepare(`SELECT * FROM saved_searches ORDER BY created_at DESC`),
  getSavedSearch: db.prepare(`SELECT * FROM saved_searches WHERE id = ?`),
  updateSavedSearch: db.prepare(`
    UPDATE saved_searches SET name=@name, keywords=@keywords, cpv_codes=@cpv_codes,
      sources=@sources, regions=@regions, status_filter=@status_filter,
      min_relevance=@min_relevance, min_lead_days=@min_lead_days,
      active=@active, updated_at=@updated_at WHERE id=@id
  `),
  deleteSavedSearch: db.prepare(`DELETE FROM saved_searches WHERE id = ?`),
  getTenderState: db.prepare(`SELECT state, updated_at FROM tender_user_states WHERE tender_id = ?`),
  setTenderState: db.prepare(`
    INSERT INTO tender_user_states (tender_id, state, updated_at) VALUES (@tender_id, @state, @updated_at)
    ON CONFLICT(tender_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at
  `),
  getCrawlLogs: db.prepare(`
    SELECT cl.*, s.name AS source_name,
      CASE WHEN cl.finished_at IS NOT NULL AND cl.started_at IS NOT NULL
        THEN CAST((julianday(cl.finished_at) - julianday(cl.started_at)) * 86400000 AS INTEGER)
        ELSE NULL END AS duration_ms
    FROM crawl_log cl
    LEFT JOIN sources s ON s.id = cl.source_id
    ORDER BY cl.id DESC LIMIT ?
  `),
  recentCrawlLogs: db.prepare(`
    SELECT * FROM crawl_log ORDER BY id DESC LIMIT 25
  `),

  // ── Browser-Job-Queue ───────────────────────────────────────
  enqueueBrowserJob: db.prepare(`
    INSERT INTO crawl_jobs (source_id, mode, status, requested_at, max_attempts)
    VALUES (@source_id, @mode, 'queued', @requested_at, @max_attempts)
  `),
  hasActiveBrowserJob: db.prepare(`
    SELECT id FROM crawl_jobs
    WHERE source_id = @source_id AND status IN ('queued', 'running', 'retry')
    ORDER BY id DESC LIMIT 1
  `),
  claimNextBrowserJob: db.prepare(`
    UPDATE crawl_jobs
    SET status = 'running', started_at = @now, heartbeat_at = @now,
        attempt = attempt + 1, locked_by = @worker_id,
        error_detail = NULL
    WHERE id = (
      SELECT id FROM crawl_jobs
      WHERE status IN ('queued', 'retry') AND cancel_requested = 0
      ORDER BY id ASC LIMIT 1
    )
    RETURNING *
  `),
  getBrowserJobById: db.prepare(`SELECT * FROM crawl_jobs WHERE id = ?`),
  updateJobProgress: db.prepare(`
    UPDATE crawl_jobs SET
      heartbeat_at = @now,
      pages_done = @pages_done,
      items_discovered = @items_discovered,
      items_new = @items_new,
      items_changed = @items_changed
    WHERE id = @id
  `),
  completeBrowserJob: db.prepare(`
    UPDATE crawl_jobs SET
      status = 'completed', finished_at = @now, heartbeat_at = @now,
      pages_done = @pages_done, items_discovered = @items_discovered,
      items_new = @items_new, items_changed = @items_changed,
      error_detail = NULL
    WHERE id = @id AND status IN ('queued', 'running', 'retry') AND cancel_requested = 0
  `),
  finishBrowserJob: db.prepare(`
    UPDATE crawl_jobs SET
      status = @status, finished_at = @now, heartbeat_at = @now,
      pages_done = @pages_done, items_discovered = @items_discovered,
      items_new = @items_new, items_changed = @items_changed,
      error_detail = @error_detail
    WHERE id = @id
  `),
  requestCancel: db.prepare(`UPDATE crawl_jobs SET cancel_requested = 1 WHERE id = ?`),
  cancelInactiveJob: db.prepare(`
    UPDATE crawl_jobs SET
      status = 'cancelled', finished_at = @now, heartbeat_at = @now,
      locked_by = NULL, error_detail = @error
    WHERE id = @id AND (
      status IN ('queued', 'retry') OR
      (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < @stale))
    )
  `),
  recoverStaleJobs: db.prepare(`
    UPDATE crawl_jobs SET
      status = CASE WHEN cancel_requested = 1 THEN 'cancelled' ELSE 'retry' END,
      finished_at = CASE WHEN cancel_requested = 1 THEN @now ELSE NULL END,
      heartbeat_at = @now,
      locked_by = NULL,
      error_detail = CASE WHEN cancel_requested = 1 THEN @cancel_error ELSE @error END
    WHERE status = 'running' AND heartbeat_at < @stale
  `),
  getRecentJobs: db.prepare(`
    SELECT j.*, s.name AS source_name
    FROM crawl_jobs j LEFT JOIN sources s ON s.id = j.source_id
    ORDER BY j.id DESC LIMIT ?
  `),
  // ── Förderprogramme ─────────────────────────────────────────
  getFundingBySourceExternal: db.prepare(`SELECT * FROM funding_programs WHERE source_id = ? AND external_id = ?`),
  getFundingById: db.prepare(`SELECT * FROM funding_programs WHERE id = ?`),
  insertFunding: db.prepare(`
    INSERT INTO funding_programs (
      source_id, external_id, title, current_call, short_description,
      funding_gegenstand, funding_geber, funding_geber_short, search_text, search_text_full,
      publication_date, status, review_status, primary_url, content_hash,
      first_seen_at, last_seen_at, last_changed_at, extracted_at, extraction_model
    ) VALUES (
      @source_id, @external_id, @title, @current_call, @short_description,
      @funding_gegenstand, @funding_geber, @funding_geber_short, @search_text, @search_text_full,
      @publication_date, @status, @review_status, @primary_url, @content_hash,
      @now, @now, @now, @extracted_at, @extraction_model
    )
  `),
  updateFunding: db.prepare(`
    UPDATE funding_programs SET
      title = @title,
      current_call = COALESCE(@current_call, current_call),
      short_description = COALESCE(@short_description, short_description),
      funding_gegenstand = COALESCE(@funding_gegenstand, funding_gegenstand),
      funding_geber = COALESCE(@funding_geber, funding_geber),
      funding_geber_short = COALESCE(@funding_geber_short, funding_geber_short),
      search_text = COALESCE(@search_text, search_text),
      search_text_full = COALESCE(@search_text_full, search_text_full),
      publication_date = COALESCE(@publication_date, publication_date),
      status = @status,
      review_status = @review_status,
      primary_url = COALESCE(@primary_url, primary_url),
      content_hash = @content_hash,
      last_seen_at = @now,
      last_changed_at = CASE WHEN @changed = 1 THEN @now ELSE last_changed_at END,
      extracted_at = @extracted_at,
      extraction_model = @extraction_model
    WHERE id = @id
  `),
  replaceDeadlines: db.prepare(`DELETE FROM funding_deadlines WHERE program_id = ?`),
  replaceProjectTypes: db.prepare(`DELETE FROM funding_project_types WHERE program_id = ?`),
  replaceEligibility: db.prepare(`DELETE FROM funding_eligibility WHERE program_id = ?`),
  replaceLinks: db.prepare(`DELETE FROM funding_links WHERE program_id = ?`),
  insertDeadline: db.prepare(`
    INSERT INTO funding_deadlines (program_id, label, deadline_at, timezone, is_ongoing, note)
    VALUES (@program_id, @label, @deadline_at, @timezone, @is_ongoing, @note)
  `),
  insertProjectType: db.prepare(`
    INSERT INTO funding_project_types (
      program_id, name, description, duration_min_months, duration_max_months,
      amount_min_cents, amount_max_cents, currency, funding_quote_min, funding_quote_max,
      max_amount_cents, conditions
    ) VALUES (
      @program_id, @name, @description, @duration_min_months, @duration_max_months,
      @amount_min_cents, @amount_max_cents, @currency, @funding_quote_min, @funding_quote_max,
      @max_amount_cents, @conditions
    )
  `),
  insertEligibility: db.prepare(`
    INSERT INTO funding_eligibility (program_id, kind, text, sort)
    VALUES (@program_id, @kind, @text, @sort)
  `),
  insertLink: db.prepare(`
    INSERT INTO funding_links (program_id, kind, url, title)
    VALUES (@program_id, @kind, @url, @title)
  `),
  insertEvidence: db.prepare(`
    INSERT INTO funding_field_evidence (program_id, entity, field, source_url, document_title, page, quote, method, confidence, created_at)
    VALUES (@program_id, @entity, @field, @source_url, @document_title, @page, @quote, @method, @confidence, @created_at)
  `),
  clearEvidence: db.prepare(`DELETE FROM funding_field_evidence WHERE program_id = ?`),
  insertFundingChange: db.prepare(`
    INSERT INTO funding_changes (program_id, changed_at, entity, field, old_value, new_value, source)
    VALUES (@program_id, @changed_at, @entity, @field, @old_value, @new_value, @source)
  `),
  getFundingDeadlines: db.prepare(`SELECT * FROM funding_deadlines WHERE program_id = ? ORDER BY deadline_at`),
  getFundingProjectTypes: db.prepare(`SELECT * FROM funding_project_types WHERE program_id = ? ORDER BY id`),
  getFundingEligibility: db.prepare(`SELECT * FROM funding_eligibility WHERE program_id = ? ORDER BY sort, id`),
  getFundingLinks: db.prepare(`SELECT * FROM funding_links WHERE program_id = ? ORDER BY kind, id`),
  getFundingEvidence: db.prepare(`SELECT * FROM funding_field_evidence WHERE program_id = ? ORDER BY id`),
  getFundingOverrides: db.prepare(`SELECT * FROM funding_field_overrides WHERE program_id = ? ORDER BY id`),
  getFundingOverride: db.prepare(`SELECT * FROM funding_field_overrides WHERE program_id = ? AND entity = ? AND field = ?`),
  upsertFundingOverride: db.prepare(`
    INSERT INTO funding_field_overrides (program_id, entity, field, value, is_confirmed, created_at, updated_at)
    VALUES (@program_id, @entity, @field, @value, @is_confirmed, @created_at, @updated_at)
    ON CONFLICT(program_id, entity, field) DO UPDATE SET
      value = excluded.value,
      is_confirmed = excluded.is_confirmed,
      updated_at = excluded.updated_at
  `),
  deleteFundingOverride: db.prepare(`DELETE FROM funding_field_overrides WHERE program_id = ? AND entity = ? AND field = ?`),
  getFundingChanges: db.prepare(`SELECT * FROM funding_changes WHERE program_id = ? ORDER BY id DESC LIMIT 50`),
  insertFundingCrawlLog: db.prepare(`INSERT INTO funding_crawl_log (source_id, started_at) VALUES (?, ?)`),
  finishFundingCrawlLog: db.prepare(`
    UPDATE funding_crawl_log SET
      finished_at = @finished_at, status = @status,
      items_discovered = @items_discovered, items_new = @items_new,
      items_changed = @items_changed, documents_loaded = @documents_loaded,
      extraction_errors = @extraction_errors, needs_review = @needs_review,
      error_detail = @error_detail
    WHERE id = @id
  `),
  getFundingCrawlLogs: db.prepare(`SELECT * FROM funding_crawl_log ORDER BY id DESC LIMIT ?`),

  // ── Checkpoints ─────────────────────────────────────────────
  getCheckpoint: db.prepare(`SELECT * FROM crawl_checkpoints WHERE source_id = ?`),
  upsertCheckpoint: db.prepare(`
    INSERT INTO crawl_checkpoints (
      source_id, backfill_complete, oldest_publication_date, last_page_key,
      last_success_at, known_page_streak, updated_at
    ) VALUES (
      @source_id, @backfill_complete, @oldest_publication_date, @last_page_key,
      @last_success_at, @known_page_streak, @now
    )
    ON CONFLICT(source_id) DO UPDATE SET
      backfill_complete = excluded.backfill_complete,
      oldest_publication_date = excluded.oldest_publication_date,
      last_page_key = excluded.last_page_key,
      last_success_at = excluded.last_success_at,
      known_page_streak = excluded.known_page_streak,
      updated_at = excluded.updated_at
  `),
};

/**
 * Listet Tender mit Filtern, Suche, Sortierung und Paginierung.
 */
export function listTenders({
  q = null,
  sources = null,
  regions = null,
  status = null,
  cpv = null,
  deadlineBefore = null,
  deadlineAfter = null,
  valueMinCents = null,
  valueMaxCents = null,
  relevanceMin = null,
  analyzedOnly = false,
  profileId = null,
  userState = null,
  sort = 'newest',
  page = 1,
  limit = 25,
} = {}) {
  const conditions = [];
  const params = {};

  if (q) {
    // FTS5 Volltextsuche
    conditions.push(`t.id IN (SELECT rowid FROM tenders_fts WHERE tenders_fts MATCH @fts_query)`);
    params.fts_query = q
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term.replace(/"/g, '')}"*`)
      .join(' AND ');
    if (!params.fts_query) params.fts_query = q;
  }

  // sources/regions/status werden über sourceSql weiter unten mit sicherer
  // Escaping-Logik in die WHERE-Klausel eingebaut, da better-sqlite3 keine
  // Mischung aus anonymen (?) und benannten (@) Parametern in einer Query
  // erlaubt. Alle Werte stammen aus Query-Parametern und werden hier
  // durch doppelte Hochkommata SQL-sicher gemacht.

  const escapeSql = (value) => String(value).replace(/'/g, "''");

  let sourceSql = '';
  if (sources?.length) {
    sourceSql += ` AND t.source_id IN (${sources.map((s) => `'${escapeSql(s)}'`).join(', ')})`;
  }
  if (regions?.length) {
    sourceSql += ` AND s.region IN (${regions.map((r) => `'${escapeSql(r)}'`).join(', ')})`;
  }
  if (status?.length) {
    sourceSql += ` AND t.status IN (${status.map((st) => `'${escapeSql(st)}'`).join(', ')})`;
  }

  if (cpv) {
    const cpvs = Array.isArray(cpv) ? cpv : String(cpv).split(',').map((value) => value.trim()).filter(Boolean);
    if (cpvs.length) {
      conditions.push(`(${cpvs.map((_, index) => `t.cpv_codes LIKE @cpv_${index}`).join(' OR ')})`);
      cpvs.forEach((value, index) => { params[`cpv_${index}`] = `%"${value}%`; });
    }
  }

  if (deadlineBefore) {
    conditions.push(`t.submission_deadline <= @deadline_before`);
    params.deadline_before = deadlineBefore;
  }

  if (deadlineAfter) {
    conditions.push(`t.submission_deadline >= @deadline_after`);
    params.deadline_after = deadlineAfter;
  }

  if (valueMinCents != null) {
    conditions.push(`t.estimated_value_cents >= @value_min`);
    params.value_min = valueMinCents;
  }

  if (valueMaxCents != null) {
    conditions.push(`t.estimated_value_cents <= @value_max`);
    params.value_max = valueMaxCents;
  }

  if (relevanceMin != null) {
    conditions.push(`t.llm_relevance_score >= @relevance_min`);
    params.relevance_min = relevanceMin;
  }

  if (analyzedOnly) {
    conditions.push(`t.llm_analyzed_at IS NOT NULL`);
  }

  if (profileId != null) {
    const profile = stmts.getSavedSearch.get(Number(profileId));
    if (!profile) {
      // Nie ungefiltert auf einen unbekannten/stale Profilverweis zurückfallen.
      conditions.push('1 = 0');
    } else {
      const profileKeywords = profile.keywords ? String(profile.keywords).split(/[,\n]+/).map((value) => value.trim()).filter(Boolean) : [];
      const profileCpvs = profile.cpv_codes ? safeParseJson(profile.cpv_codes) : [];
      const profileSources = profile.sources ? safeParseJson(profile.sources) : [];
      const profileRegions = profile.regions ? safeParseJson(profile.regions) : [];
      if (profileKeywords.length) {
        conditions.push(`(${profileKeywords.map((_, index) => `LOWER(COALESCE(t.search_text_full, '')) LIKE @profile_keyword_${index}`).join(' OR ')})`);
        profileKeywords.forEach((value, index) => { params[`profile_keyword_${index}`] = `%${value.toLowerCase().replace(/[%_]/g, '')}%`; });
      }
      if (profileCpvs?.length) {
        conditions.push(`(${profileCpvs.map((_, index) => `t.cpv_codes LIKE @profile_cpv_${index}`).join(' OR ')})`);
        profileCpvs.forEach((value, index) => { params[`profile_cpv_${index}`] = `%"${value}%`; });
      }
      if (profileSources?.length) sourceSql += ` AND t.source_id IN (${profileSources.map((s) => `'${escapeSql(s)}'`).join(', ')})`;
      if (profileRegions?.length) sourceSql += ` AND s.region IN (${profileRegions.map((r) => `'${escapeSql(r)}'`).join(', ')})`;
      if (profile.status_filter) sourceSql += ` AND t.status IN (${String(profile.status_filter).split(',').map((s) => `'${escapeSql(s.trim())}'`).join(', ')})`;
      if (profile.min_lead_days != null) {
        const date = new Date(Date.now() + Number(profile.min_lead_days) * 86400000).toISOString().slice(0, 10);
        conditions.push(`(t.submission_deadline IS NULL OR t.submission_deadline >= @profile_min_deadline)`);
        params.profile_min_deadline = date;
      }
    }
  }
  if (userState === 'watch' || userState === 'dismiss' || userState === 'seen' || userState === 'unseen') {
    conditions.push(userState === 'unseen' ? `COALESCE(us.state, 'unseen') = 'unseen'` : `us.state = @user_state`);
    params.user_state = userState;
  } else {
    conditions.push(`COALESCE(us.state, 'unseen') != 'dismiss'`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortClauses = {
    newest: 't.publication_date DESC, t.id DESC',
    oldest: 't.publication_date ASC, t.id ASC',
    deadline: 't.submission_deadline ASC, t.id DESC',
    deadline_desc: 't.submission_deadline DESC, t.id DESC',
    value_desc: 't.estimated_value_cents DESC, t.id DESC',
    value_asc: 't.estimated_value_cents ASC, t.id DESC',
    title: 't.title ASC, t.id DESC',
    relevance: 't.llm_relevance_score DESC, t.id DESC',
  };
  const orderBy = sortClauses[sort] || sortClauses.newest;

  const baseWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const finalWhere = sourceSql ? baseWhere ? `${baseWhere}${sourceSql}` : `WHERE 1=1${sourceSql}` : baseWhere;

  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM tenders t
    LEFT JOIN sources s ON s.id = t.source_id
    LEFT JOIN tender_user_states us ON us.tender_id = t.id
    ${finalWhere}
  `).get(params);

  const limitInt = Math.max(1, Math.min(Number(limit) || 25, 100));
  const pageInt = Math.max(1, Number(page) || 1);
  const offset = (pageInt - 1) * limitInt;

  const rows = db.prepare(`
    SELECT t.*, s.name AS source_name, s.region AS source_region,
      COALESCE(us.state, 'unseen') AS user_state, us.updated_at AS user_state_updated_at
    FROM tenders t
    LEFT JOIN sources s ON s.id = t.source_id
    LEFT JOIN tender_user_states us ON us.tender_id = t.id
    ${finalWhere}
    ORDER BY ${orderBy}
    LIMIT ${limitInt} OFFSET ${offset}
  `).all(params);

  // Ergebnisse für JSON-Spalten parsen
  const tenders = rows.map((row) => ({
    ...row,
    cpv_codes: row.cpv_codes ? JSON.parse(row.cpv_codes) : null,
    cpv_labels: row.cpv_labels ? JSON.parse(row.cpv_labels) : null,
    llm_requirements: row.llm_requirements ? JSON.parse(row.llm_requirements) : null,
    portal_metadata: row.portal_metadata_json ? safeParseJson(row.portal_metadata_json) : null,
    detail_completeness: row.detail_completeness ? safeParseJson(row.detail_completeness) || row.detail_completeness : null,
  }));

  return {
    total: countRow.count,
    page: pageInt,
    limit: limitInt,
    totalPages: Math.ceil(countRow.count / limitInt),
    tenders,
  };
}

export function startCrawlLog(sourceId) {
  const now = new Date().toISOString();
  const result = stmts.insertCrawlLog.run(sourceId, now);
  return { id: Number(result.lastInsertRowid), startedAt: now };
}

export function finishCrawlLog(summary) {
  stmts.finishCrawlLog.run({
    id: summary.id,
    finished_at: new Date().toISOString(),
    status: summary.status,
    items_discovered: summary.itemsDiscovered,
    items_new: summary.itemsNew,
    items_changed: summary.itemsChanged,
    errors: summary.errors,
    error_detail: summary.errorMessage || null,
    detail_pages_success: summary.detailPagesSuccess || 0,
    detail_pages_failed: summary.detailPagesFailed || 0,
    tenders_complete: summary.tendersComplete || 0,
    tenders_partial: summary.tendersPartial || 0,
    documents_inventoried: summary.documentsInventoried || 0,
    messages_inventoried: summary.messagesInventoried || 0,
    login_required: summary.loginRequired || 0,
    unknown_portal_structure: summary.unknownPortalStructure || 0,
  });
}

export function updateCrawlDetailMetrics(metrics) {
  stmts.updateCrawlDetailMetrics.run({
    id: metrics.id,
    detail_pages_success: metrics.detailPagesSuccess || 0,
    detail_pages_failed: metrics.detailPagesFailed || 0,
    tenders_complete: metrics.tendersComplete || 0,
    tenders_partial: metrics.tendersPartial || 0,
    documents_inventoried: metrics.documentsInventoried || 0,
    messages_inventoried: metrics.messagesInventoried || 0,
    login_required: metrics.loginRequired || 0,
    unknown_portal_structure: metrics.unknownPortalStructure || 0,
  });
}

export function updateSourceCrawlTime(sourceId, now = new Date().toISOString()) {
  stmts.upsertSourceLastCrawl.run(now, sourceId);
}

/**
 * Speichert einen Tender und erkennt Änderungen. Detailtreffer werden mit dem
 * vorhandenen Datensatz zusammengeführt: ein späterer, dünner Listentreffer
 * kann weder Beschreibung noch Suchtext oder Detaildaten zurücksetzen.
 */
function jsonOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function normalizedArray(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  return [value];
}

function tenderContentHash(fields) {
  const payload = {
    title: fields.title,
    url: fields.url,
    description: fields.description,
    authority: fields.contracting_authority,
    cpvCodes: fields.cpv_codes,
    cpvLabels: fields.cpv_labels,
    value: fields.estimated_value_cents,
    currency: fields.estimated_value_currency,
    place: fields.place_of_performance,
    award: fields.award_criteria,
    type: fields.tender_type,
    publication: fields.publication_date,
    deadline: fields.submission_deadline,
    bindingPeriod: fields.binding_period,
    opening: fields.opening_date,
    duration: fields.contract_duration,
    document: fields.document_url,
    portalProjectId: fields.portal_project_id,
    referenceNumber: fields.reference_number,
    procedureType: fields.procedure_type,
    questionDeadline: fields.question_deadline,
    metadata: fields.portal_metadata_json,
    portalStatus: fields.portal_status,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function effectiveValue(incoming, previous, fallback = null) {
  return incoming != null && incoming !== '' ? incoming : (previous != null ? previous : fallback);
}

const saveTenderTx = db.transaction(({ tender, now }) => {
  let existing = tender.portalProjectId
    ? stmts.getTenderBySourceAndPortalProject.get(tender.sourceId, tender.portalProjectId)
      || (tender.externalId != null ? stmts.getTenderBySourceAndExternalId.get(tender.sourceId, tender.externalId) : null)
    : stmts.getTenderBySourceAndExternalId.get(tender.sourceId, tender.externalId);
  // Einmalige Migration alter Hash-IDs (vor allem Niedersachsen): nur ein
  // eindeutig passender Titel/Auftraggeber/Publikation wird übernommen.
  if (!existing && tender.portalProjectId && tender.title && tender.publicationDate) {
    const candidates = db.prepare(`
      SELECT * FROM tenders
      WHERE source_id = ?
        AND portal_project_id IS NULL
        AND lower(trim(title)) = lower(trim(?))
        AND lower(trim(coalesce(contracting_authority, ''))) = lower(trim(coalesce(?, '')))
        AND substr(coalesce(publication_date, ''), 1, 10) = substr(?, 1, 10)
        AND external_id <> ?
    `).all(tender.sourceId, tender.title, tender.contractingAuthority || '', tender.publicationDate, tender.portalProjectId);
    if (candidates.length === 1) {
      existing = candidates[0];
      db.prepare(`
        INSERT INTO tender_migration_log
          (source_id, portal_project_id, title, candidate_count, candidate_ids, status, created_at)
        VALUES (?, ?, ?, 1, ?, 'migrated', ?)
      `).run(tender.sourceId, tender.portalProjectId, tender.title, JSON.stringify([existing.id]), now);
    }
    else if (candidates.length > 1) {
      console.warn(`[db] Mehrdeutige UUID-Migration für ${tender.sourceId}/${tender.portalProjectId}: ${candidates.length} Kandidaten`);
      db.prepare(`
        INSERT INTO tender_migration_log
          (source_id, portal_project_id, title, candidate_count, candidate_ids, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'ambiguous', ?)
      `).run(tender.sourceId, tender.portalProjectId, tender.title, candidates.length,
        JSON.stringify(candidates.map((candidate) => candidate.id)), now);
    }
  }
  const detailBundle = tender.detailBundle || tender.bundle || null;
  const metadata = tender.portalMetadata ?? detailBundle?.metadata ?? null;
  const fullCrawlSucceeded = tender.fullCrawlSucceeded ?? detailBundle?.fullCrawlSucceeded ?? false;

  // Ein unvollständiger Folgeabruf darf einen bereits vollständigen Stand
  // nicht mit einer verkürzten Beschreibung, Metadaten oder Kinddaten
  // überschreiben. Der nächste fällige Vollabruf versucht es erneut.
  if (existing?.detail_status === 'complete' && detailBundle && detailBundle.fullCrawlSucceeded === false) {
    return { isNew: false, changed: false, tenderId: existing.id, changes: [] };
  }

  const completenessInput = tender.detailCompleteness ?? detailBundle?.completeness ?? null;
  const effective = {
    source_id: tender.sourceId,
    external_id: effectiveValue(tender.externalId, existing?.external_id, tender.portalProjectId || null),
    title: effectiveValue(tender.title, existing?.title, 'Unbenannte Ausschreibung'),
    url: effectiveValue(tender.url, existing?.url, ''),
    description: effectiveValue(tender.description, existing?.description),
    contracting_authority: effectiveValue(tender.contractingAuthority, existing?.contracting_authority),
    cpv_codes: jsonOrNull(
      tender.cpvCodes != null && (normalizedArray(tender.cpvCodes)?.length || !existing)
        ? normalizedArray(tender.cpvCodes)
        : safeParseJson(existing?.cpv_codes)
    ),
    cpv_labels: jsonOrNull(
      tender.cpvLabels != null && (normalizedArray(tender.cpvLabels)?.length || !existing)
        ? normalizedArray(tender.cpvLabels)
        : safeParseJson(existing?.cpv_labels)
    ),
    estimated_value_cents: effectiveValue(tender.estimatedValueCents, existing?.estimated_value_cents),
    estimated_value_currency: effectiveValue(tender.estimatedValueCurrency, existing?.estimated_value_currency, 'EUR'),
    place_of_performance: effectiveValue(tender.placeOfPerformance, existing?.place_of_performance),
    award_criteria: effectiveValue(tender.awardCriteria, existing?.award_criteria),
    tender_type: effectiveValue(tender.tenderType, existing?.tender_type),
    publication_date: effectiveValue(tender.publicationDate, existing?.publication_date),
    submission_deadline: effectiveValue(tender.submissionDeadline, existing?.submission_deadline),
    binding_period: effectiveValue(tender.bindingPeriod, existing?.binding_period),
    opening_date: effectiveValue(tender.openingDate, existing?.opening_date),
    contract_duration: effectiveValue(tender.contractDuration, existing?.contract_duration),
    document_url: effectiveValue(tender.documentUrl, existing?.document_url),
    status: effectiveValue(tender.status, existing?.status, 'open'),
    portal_status: effectiveValue(tender.portalStatus, existing?.portal_status),
    portal_project_id: effectiveValue(tender.portalProjectId, existing?.portal_project_id),
    reference_number: effectiveValue(tender.referenceNumber, existing?.reference_number),
    procedure_type: effectiveValue(tender.procedureType, existing?.procedure_type),
    question_deadline: effectiveValue(tender.questionDeadline, existing?.question_deadline),
    detail_status: effectiveValue(tender.detailStatus ?? detailBundle?.detailStatus, existing?.detail_status),
    detail_crawled_at: tender.detailCrawledAt ?? detailBundle?.detailCrawledAt ?? existing?.detail_crawled_at ?? null,
    detail_crawl_kind: effectiveValue(tender.detailCrawlKind ?? detailBundle?.crawlKind, existing?.detail_crawl_kind, 'unknown'),
    last_full_seen_at: fullCrawlSucceeded ? (tender.detailCrawledAt || now) : (existing?.last_full_seen_at ?? null),
    detail_completeness: jsonOrNull(completenessInput) ?? existing?.detail_completeness ?? null,
    portal_metadata_json: jsonOrNull(metadata) ?? existing?.portal_metadata_json ?? null,
    now,
  };
  effective.content_hash = tender.contentHash || tenderContentHash(effective);
  // Nach einer Vollanreicherung können spätere Gridzeilen bewusst nur Titel
  // und Frist enthalten. Ihr kurzlebiger List-Hash darf den Detail-Hash nicht
  // zurücksetzen oder unnötige Änderungsereignisse erzeugen.
  if (existing?.detail_status === 'complete' && !detailBundle
    && tender.description == null && tender.cpvCodes == null && tender.cpvLabels == null) {
    effective.content_hash = existing.content_hash;
  }
  effective.search_text_full = buildTenderSearchText({
    ...tender,
    title: effective.title,
    description: effective.description,
    contractingAuthority: effective.contracting_authority,
    cpvCodes: safeParseJson(effective.cpv_codes),
    cpvLabels: safeParseJson(effective.cpv_labels),
    placeOfPerformance: effective.place_of_performance,
    awardCriteria: effective.award_criteria,
    llmSummary: tender.llmSummary ?? existing?.llm_summary ?? null,
    llmRequirements: tender.llmRequirements
      ?? (existing?.llm_requirements ? safeParseJson(existing.llm_requirements) : null),
    textSections: detailBundle?.textSections || [],
    facts: detailBundle?.facts || [],
  });

  if (!existing) {
    const result = stmts.insertTender.run({ ...effective, portal_metadata_json: effective.portal_metadata_json });
    const tenderId = Number(result.lastInsertRowid);
    saveSourceDocument({
      docKind: 'tender', entityId: tenderId, canonicalUrl: effective.url,
      documentTitle: effective.title, content: effective.search_text_full, replaceCurrent: true,
    });
    if (detailBundle) persistTenderDetailBundleRaw(tenderId, detailBundle, now);
    return { isNew: true, changed: true, tenderId, changes: [{ field: 'created', oldValue: null, newValue: effective.title }] };
  }

  const comparisons = [
    ['external_id', existing.external_id, effective.external_id],
    ['title', existing.title, effective.title],
    ['status', existing.status, effective.status],
    ['submission_deadline', existing.submission_deadline, effective.submission_deadline],
    ['binding_period', existing.binding_period, effective.binding_period],
    ['estimated_value_cents', existing.estimated_value_cents, effective.estimated_value_cents],
    ['contracting_authority', existing.contracting_authority, effective.contracting_authority],
    ['description', existing.description, effective.description],
    ['cpv_codes', existing.cpv_codes, effective.cpv_codes],
    ['cpv_labels', existing.cpv_labels, effective.cpv_labels],
    ['estimated_value_currency', existing.estimated_value_currency, effective.estimated_value_currency],
    ['place_of_performance', existing.place_of_performance, effective.place_of_performance],
    ['award_criteria', existing.award_criteria, effective.award_criteria],
    ['tender_type', existing.tender_type, effective.tender_type],
    ['publication_date', existing.publication_date, effective.publication_date],
    ['document_url', existing.document_url, effective.document_url],
    ['opening_date', existing.opening_date, effective.opening_date],
    ['contract_duration', existing.contract_duration, effective.contract_duration],
    ['portal_project_id', existing.portal_project_id, effective.portal_project_id],
    ['reference_number', existing.reference_number, effective.reference_number],
    ['procedure_type', existing.procedure_type, effective.procedure_type],
    ['question_deadline', existing.question_deadline, effective.question_deadline],
    ['detail_status', existing.detail_status, effective.detail_status],
    ['portal_status', existing.portal_status, effective.portal_status],
    ['detail_completeness', existing.detail_completeness, effective.detail_completeness],
    ['detail_crawl_kind', existing.detail_crawl_kind, effective.detail_crawl_kind],
    ['portal_metadata_json', existing.portal_metadata_json, effective.portal_metadata_json],
  ];
  const changes = [];
  for (const [field, oldValue, newValue] of comparisons) {
    if (String(oldValue ?? '') !== String(newValue ?? '')) changes.push({ field, oldValue, newValue });
  }
  const changed = changes.length > 0 || existing.content_hash !== effective.content_hash;
  if (existing.content_hash !== effective.content_hash && !changes.some((c) => c.field === 'content')) {
    changes.push({ field: 'content', oldValue: existing.content_hash, newValue: effective.content_hash });
  }
  for (const change of changes) {
    stmts.insertEntityChange.run(existing.id, now, change.field,
      change.oldValue == null ? null : String(change.oldValue),
      change.newValue == null ? null : String(change.newValue),
      'tender', change.field, change.field === 'content' ? 'content_changed' : 'updated');
  }
  stmts.updateTender.run({ ...effective, id: existing.id, changed: changed ? 1 : 0 });
  if (changed) {
    saveSourceDocument({
      docKind: 'tender', entityId: existing.id, canonicalUrl: effective.url,
      documentTitle: effective.title, content: effective.search_text_full, replaceCurrent: true,
    });
  }
  if (detailBundle) persistTenderDetailBundleRaw(existing.id, detailBundle, now);
  return { isNew: false, changed, tenderId: existing.id, changes };
});

export function saveTender(tender, now = new Date().toISOString()) {
  return saveTenderTx({ tender, now });
}

export function getTenderById(id) {
  return stmts.getTenderById.get(id);
}

export function getTenderByExternalId(sourceId, externalId) {
  return stmts.getTenderBySourceAndExternalId.get(sourceId, externalId);
}

export function getTenderByPortalProject(sourceId, portalProjectId) {
  if (!portalProjectId) return null;
  return stmts.getTenderBySourceAndPortalProject.get(sourceId, portalProjectId);
}

function bundleValue(object, ...keys) {
  for (const key of keys) {
    if (object && object[key] != null) return object[key];
  }
  return null;
}

function detailHash(value) {
  if (value == null) return createHash('sha256').update('').digest('hex');
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/** Persistiert Kindentitäten und rohe Seiten-Snapshots eines Detail-Bundles. */
const persistTenderDetailBundleRaw = (tenderId, bundle, now) => {
  if (!bundle) return { tenderId, sections: {} };
  const lots = Array.isArray(bundle.lots) ? bundle.lots : [];
  const criteria = Array.isArray(bundle.criteria) ? bundle.criteria : [];
  const documents = Array.isArray(bundle.documents) ? bundle.documents : [];
  const messages = Array.isArray(bundle.messages) ? bundle.messages : [];
  const snapshots = Array.isArray(bundle.snapshots) ? bundle.snapshots : [];
  const textSections = Array.isArray(bundle.textSections) ? bundle.textSections : [];
  const facts = Array.isArray(bundle.facts) ? bundle.facts : [];
  // ISO-Zeitstempel haben Millisekundenauflösung. Zwei schnelle Vollcrawls
  // dürfen trotzdem nicht denselben "gesehen"-Marker verwenden, sonst kann
  // ein Dokument in einem Lauf doppelt als fehlend gezählt werden.
  const fullCrawlToken = bundle.fullCrawlSucceeded === true
    ? (bundle.crawlToken || `${now}:${randomUUID()}`)
    : null;
  const recordEntityChange = (entityType, entityKey, changeKind, oldValue, newValue) => {
    if (String(oldValue ?? '') === String(newValue ?? '') && changeKind !== 'created') return;
    stmts.insertEntityChange.run(
      tenderId, now, `${entityType}:${entityKey}`,
      oldValue == null ? null : String(oldValue),
      newValue == null ? null : String(newValue),
      entityType, String(entityKey), changeKind
    );
  };

  const findTextSection = db.prepare(`SELECT * FROM tender_text_sections WHERE tender_id = ? AND section_key = ?`);
  const upsertTextSection = db.prepare(`
    INSERT INTO tender_text_sections (
      tender_id, section_key, title, source_url, text, status, content_hash, fetched_at
    ) VALUES (@tender_id, @section_key, @title, @source_url, @text, @status, @content_hash, @now)
    ON CONFLICT(tender_id, section_key) DO UPDATE SET
      title=excluded.title, source_url=excluded.source_url, text=excluded.text,
      status=excluded.status, content_hash=excluded.content_hash, fetched_at=excluded.fetched_at
  `);
  const seenSectionKeys = new Set();
  for (const section of textSections) {
    const sectionKey = String(bundleValue(section, 'sectionKey', 'section_key', 'kind', 'key') || 'detail');
    const text = String(bundleValue(section, 'text', 'content', 'rawText', 'raw_text') || '');
    const values = {
      tender_id: tenderId,
      section_key: sectionKey,
      title: bundleValue(section, 'title', 'heading', 'label'),
      source_url: bundleValue(section, 'sourceUrl', 'source_url', 'url'),
      text,
      status: bundleValue(section, 'status') || 'complete',
      content_hash: bundleValue(section, 'contentHash', 'content_hash') || detailHash(text),
    };
    const old = findTextSection.get(tenderId, sectionKey);
    upsertTextSection.run({ ...values, now });
    recordEntityChange('text_section', sectionKey, old ? 'updated' : 'created', old?.content_hash, values.content_hash);
    seenSectionKeys.add(sectionKey);
  }
  if (bundle.fullCrawlSucceeded === true && Object.prototype.hasOwnProperty.call(bundle, 'textSections')) {
    const staleSections = db.prepare(`SELECT section_key, content_hash FROM tender_text_sections WHERE tender_id = ?`).all(tenderId);
    const removeSection = db.prepare(`DELETE FROM tender_text_sections WHERE tender_id = ? AND section_key = ?`);
    for (const section of staleSections) {
      if (seenSectionKeys.has(section.section_key)) continue;
      removeSection.run(tenderId, section.section_key);
      recordEntityChange('text_section', section.section_key, 'removed', section.content_hash, null);
    }
  }

  const findFact = db.prepare(`SELECT * FROM tender_facts WHERE tender_id = ? AND fact_key = ?`);
  const upsertFact = db.prepare(`
    INSERT INTO tender_facts (
      tender_id, fact_key, section_key, label, value_text, normalized_value_json,
      data_type, source_url, content_hash, fetched_at
    ) VALUES (@tender_id, @fact_key, @section_key, @label, @value_text, @normalized_value_json,
      @data_type, @source_url, @content_hash, @now)
    ON CONFLICT(tender_id, fact_key) DO UPDATE SET
      section_key=excluded.section_key, label=excluded.label, value_text=excluded.value_text,
      normalized_value_json=excluded.normalized_value_json, data_type=excluded.data_type,
      source_url=excluded.source_url, content_hash=excluded.content_hash, fetched_at=excluded.fetched_at
  `);
  const seenFactKeys = new Set();
  for (const fact of facts) {
    const factKey = String(bundleValue(fact, 'factKey', 'fact_key', 'key') || `fact-${detailHash(fact).slice(0, 32)}`);
    const label = String(bundleValue(fact, 'label', 'name', 'title') || factKey);
    const valueText = bundleValue(fact, 'valueText', 'value_text', 'value', 'text');
    const normalizedValue = bundleValue(fact, 'normalizedValue', 'normalized_value', 'normalizedValueJson', 'normalized_value_json');
    const values = {
      tender_id: tenderId,
      fact_key: factKey,
      section_key: bundleValue(fact, 'sectionKey', 'section_key', 'section'),
      label,
      value_text: valueText == null ? null : String(valueText),
      normalized_value_json: normalizedValue == null ? null : jsonOrNull(normalizedValue),
      data_type: bundleValue(fact, 'dataType', 'data_type', 'type'),
      source_url: bundleValue(fact, 'sourceUrl', 'source_url', 'url'),
    };
    values.content_hash = bundleValue(fact, 'contentHash', 'content_hash') || detailHash(values);
    const old = findFact.get(tenderId, factKey);
    upsertFact.run({ ...values, now });
    recordEntityChange('fact', factKey, old ? 'updated' : 'created', old?.content_hash, values.content_hash);
    seenFactKeys.add(factKey);
  }
  if (bundle.fullCrawlSucceeded === true && Object.prototype.hasOwnProperty.call(bundle, 'facts')) {
    const staleFacts = db.prepare(`SELECT fact_key, content_hash FROM tender_facts WHERE tender_id = ?`).all(tenderId);
    const removeFact = db.prepare(`DELETE FROM tender_facts WHERE tender_id = ? AND fact_key = ?`);
    for (const fact of staleFacts) {
      if (seenFactKeys.has(fact.fact_key)) continue;
      removeFact.run(tenderId, fact.fact_key);
      recordEntityChange('fact', fact.fact_key, 'removed', fact.content_hash, null);
    }
  }

  const lotIdByKey = new Map();
  const seenLotKeys = new Set();
  const findLot = db.prepare(`SELECT * FROM tender_lots WHERE tender_id = ? AND lot_key = ?`);
  const insertLot = db.prepare(`
    INSERT INTO tender_lots (
      tender_id, lot_key, lot_number, title, description, cpv_codes, cpv_labels,
      estimated_value_cents, estimated_value_currency, place_of_performance,
      contract_duration, metadata_json, content_hash, first_seen_at, last_seen_at
    ) VALUES (@tender_id, @lot_key, @lot_number, @title, @description, @cpv_codes, @cpv_labels,
      @estimated_value_cents, @estimated_value_currency, @place_of_performance,
      @contract_duration, @metadata_json, @content_hash, @now, @now)
  `);
  const updateLot = db.prepare(`
    UPDATE tender_lots SET lot_number=@lot_number, title=@title, description=@description,
      cpv_codes=@cpv_codes, cpv_labels=@cpv_labels, estimated_value_cents=@estimated_value_cents,
      estimated_value_currency=@estimated_value_currency, place_of_performance=@place_of_performance,
      contract_duration=@contract_duration, metadata_json=@metadata_json, content_hash=@content_hash,
      last_seen_at=@now WHERE id=@id
  `);
  for (const lot of lots) {
    const suppliedLotKey = bundleValue(lot, 'lotKey', 'key', 'lotNumber', 'number');
    const lotKey = String(suppliedLotKey || `hash:${detailHash({
      title: bundleValue(lot, 'title', 'name'),
      description: bundleValue(lot, 'description'),
      cpvCodes: bundleValue(lot, 'cpvCodes', 'cpv_codes'),
      placeOfPerformance: bundleValue(lot, 'placeOfPerformance', 'place_of_performance'),
    }).slice(0, 32)}`);
    const values = {
      tender_id: tenderId,
      lot_key: lotKey,
      lot_number: bundleValue(lot, 'lotNumber', 'number'),
      title: bundleValue(lot, 'title', 'name'),
      description: bundleValue(lot, 'description'),
      cpv_codes: jsonOrNull(bundleValue(lot, 'cpvCodes', 'cpv_codes')),
      cpv_labels: jsonOrNull(bundleValue(lot, 'cpvLabels', 'cpv_labels')),
      estimated_value_cents: bundleValue(lot, 'estimatedValueCents', 'estimated_value_cents'),
      estimated_value_currency: bundleValue(lot, 'estimatedValueCurrency', 'estimated_value_currency') || 'EUR',
      place_of_performance: bundleValue(lot, 'placeOfPerformance', 'place_of_performance'),
      contract_duration: bundleValue(lot, 'contractDuration', 'contract_duration'),
      metadata_json: jsonOrNull(bundleValue(lot, 'metadata', 'metadataJson', 'metadata_json')),
    };
    values.content_hash = bundleValue(lot, 'contentHash', 'content_hash') || detailHash(values);
    const old = findLot.get(tenderId, lotKey);
    if (old) {
      updateLot.run({ ...values, id: old.id, now });
      recordEntityChange('lot', lotKey, 'updated', old.content_hash, values.content_hash);
      lotIdByKey.set(lotKey, old.id);
    } else {
      const result = insertLot.run({ ...values, now });
      recordEntityChange('lot', lotKey, 'created', null, values.content_hash);
      lotIdByKey.set(lotKey, Number(result.lastInsertRowid));
    }
    seenLotKeys.add(lotKey);
  }
  if (bundle.fullCrawlSucceeded === true && Object.prototype.hasOwnProperty.call(bundle, 'lots')) {
    const staleLots = db.prepare(`SELECT lot_key, content_hash FROM tender_lots WHERE tender_id = ?`).all(tenderId);
    for (const lot of staleLots) {
      if (seenLotKeys.has(lot.lot_key)) continue;
      db.prepare(`DELETE FROM tender_lots WHERE tender_id = ? AND lot_key = ?`).run(tenderId, lot.lot_key);
      recordEntityChange('lot', lot.lot_key, 'removed', lot.content_hash, null);
    }
  }

  const findCriterion = db.prepare(`SELECT * FROM tender_criteria WHERE tender_id = ? AND criterion_key = ?`);
  const seenCriterionKeys = new Set();
  const insertCriterion = db.prepare(`
    INSERT INTO tender_criteria (
      tender_id, lot_id, criterion_key, kind, code, title, description, weight,
      minimum_value, required, source_section, metadata_json, content_hash, first_seen_at, last_seen_at
    ) VALUES (@tender_id, @lot_id, @criterion_key, @kind, @code, @title, @description, @weight,
      @minimum_value, @required, @source_section, @metadata_json, @content_hash, @now, @now)
  `);
  const updateCriterion = db.prepare(`
    UPDATE tender_criteria SET lot_id=@lot_id, kind=@kind, code=@code, title=@title,
      description=@description, weight=@weight, minimum_value=@minimum_value, required=@required,
      source_section=@source_section, metadata_json=@metadata_json, content_hash=@content_hash,
      last_seen_at=@now WHERE id=@id
  `);
  for (const criterion of criteria) {
    const lotKey = bundleValue(criterion, 'lotKey', 'lot_key');
    const suppliedCriterionKey = bundleValue(criterion, 'criterionKey', 'key', 'code');
    const criterionKey = String(suppliedCriterionKey || `hash:${detailHash({
      kind: bundleValue(criterion, 'kind', 'type'),
      title: bundleValue(criterion, 'title', 'name'),
      description: bundleValue(criterion, 'description', 'text'),
      weight: bundleValue(criterion, 'weight'),
    }).slice(0, 32)}`);
    const values = {
      tender_id: tenderId,
      lot_id: lotKey ? (lotIdByKey.get(String(lotKey)) || null) : null,
      criterion_key: criterionKey,
      kind: bundleValue(criterion, 'kind', 'type') || 'unknown',
      code: bundleValue(criterion, 'code'),
      title: bundleValue(criterion, 'title', 'name'),
      description: bundleValue(criterion, 'description', 'text'),
      weight: bundleValue(criterion, 'weight'),
      minimum_value: bundleValue(criterion, 'minimumValue', 'minimum_value'),
      required: bundleValue(criterion, 'required') == null ? null : (bundleValue(criterion, 'required') ? 1 : 0),
      source_section: bundleValue(criterion, 'sourceSection', 'source_section'),
      metadata_json: jsonOrNull(bundleValue(criterion, 'metadata', 'metadataJson', 'metadata_json')),
    };
    values.content_hash = bundleValue(criterion, 'contentHash', 'content_hash') || detailHash(values);
    const old = findCriterion.get(tenderId, criterionKey);
    if (old) {
      updateCriterion.run({ ...values, id: old.id, now });
      recordEntityChange('criterion', criterionKey, 'updated', old.content_hash, values.content_hash);
    } else {
      insertCriterion.run({ ...values, now });
      recordEntityChange('criterion', criterionKey, 'created', null, values.content_hash);
    }
    seenCriterionKeys.add(criterionKey);
  }
  if (bundle.fullCrawlSucceeded === true && Object.prototype.hasOwnProperty.call(bundle, 'criteria')) {
    const staleCriteria = db.prepare(`SELECT criterion_key, content_hash FROM tender_criteria WHERE tender_id = ?`).all(tenderId);
    for (const criterion of staleCriteria) {
      if (seenCriterionKeys.has(criterion.criterion_key)) continue;
      db.prepare(`DELETE FROM tender_criteria WHERE tender_id = ? AND criterion_key = ?`).run(tenderId, criterion.criterion_key);
      recordEntityChange('criterion', criterion.criterion_key, 'removed', criterion.content_hash, null);
    }
  }

  const findDocument = db.prepare(`SELECT * FROM tender_documents WHERE tender_id = ? AND portal_file_id = ? AND filename = ?`);
  const insertDocument = db.prepare(`
    INSERT INTO tender_documents (
      tender_id, portal_file_id, category, filename, mime_type, extension, size_bytes,
      published_at, source_url, locator_json, access_status, download_status, local_path,
      binary_hash, document_text, content_hash, first_seen_at, last_seen_at
      , version_key, version_label, supersedes_document_id, visibility_status, not_seen_count, last_full_seen_at,
      last_seen_crawl_token
    ) VALUES (@tender_id, @portal_file_id, @category, @filename, @mime_type, @extension, @size_bytes,
      @published_at, @source_url, @locator_json, @access_status, @download_status, @local_path,
      @binary_hash, @document_text, @content_hash, @now, @now,
      @version_key, @version_label, @supersedes_document_id, @visibility_status, @not_seen_count, @last_full_seen_at,
      @last_seen_crawl_token)
  `);
  const updateDocument = db.prepare(`
    UPDATE tender_documents SET category=@category, mime_type=@mime_type, extension=@extension,
      size_bytes=@size_bytes, published_at=@published_at, source_url=@source_url, locator_json=@locator_json,
      access_status=@access_status,
      download_status=CASE WHEN @download_status = 'not_requested' THEN download_status ELSE @download_status END,
      local_path=COALESCE(@local_path, local_path), binary_hash=COALESCE(@binary_hash, binary_hash),
      document_text=COALESCE(@document_text, document_text), content_hash=@content_hash, last_seen_at=@now
      , version_key=@version_key, version_label=@version_label,
      supersedes_document_id=COALESCE(@supersedes_document_id, supersedes_document_id),
      visibility_status=@visibility_status, not_seen_count=@not_seen_count,
      last_full_seen_at=COALESCE(@last_full_seen_at, last_full_seen_at),
      last_seen_crawl_token=COALESCE(@last_seen_crawl_token, last_seen_crawl_token)
    WHERE id=@id
  `);
  for (const [index, document] of documents.entries()) {
    const filename = String(bundleValue(document, 'filename', 'name', 'fileName') || `document-${index + 1}`);
    const locator = bundleValue(document, 'locator', 'locatorJson', 'locator_json');
    const portalFileId = String(bundleValue(document, 'portalFileId', 'portal_file_id', 'fileId')
      || locator?.fileId || locator?.id || `${bundleValue(document, 'category') || 'document'}:${filename}`);
    const extension = bundleValue(document, 'extension') || path.extname(filename).replace(/^\./, '').toLowerCase() || null;
    const values = {
      tender_id: tenderId,
      portal_file_id: portalFileId,
      category: bundleValue(document, 'category', 'section'),
      filename,
      mime_type: bundleValue(document, 'mimeType', 'mime_type', 'type'),
      extension,
      size_bytes: bundleValue(document, 'sizeBytes', 'size_bytes', 'size'),
      published_at: bundleValue(document, 'publishedAt', 'published_at', 'addedAt'),
      source_url: bundleValue(document, 'sourceUrl', 'source_url', 'pageUrl'),
      locator_json: jsonOrNull(locator),
      access_status: bundleValue(document, 'accessStatus', 'access_status') || 'public',
      download_status: bundleValue(document, 'downloadStatus', 'download_status') || 'not_requested',
      local_path: bundleValue(document, 'localPath', 'local_path'),
      binary_hash: bundleValue(document, 'binaryHash', 'binary_hash'),
      document_text: bundleValue(document, 'documentText', 'document_text'),
      version_key: bundleValue(document, 'versionKey', 'version_key'),
      version_label: bundleValue(document, 'versionLabel', 'version_label'),
      supersedes_document_id: bundleValue(document, 'supersedesDocumentId', 'supersedes_document_id'),
      visibility_status: bundleValue(document, 'visibilityStatus', 'visibility_status') || 'active',
      not_seen_count: 0,
      last_full_seen_at: bundle.fullCrawlSucceeded ? now : null,
      last_seen_crawl_token: fullCrawlToken,
    };
    values.content_hash = bundleValue(document, 'contentHash', 'content_hash') || detailHash(values);
    values.version_key ||= values.content_hash;
    const old = findDocument.get(tenderId, portalFileId, filename);
    if (old) {
      updateDocument.run({ ...values, id: old.id, now, not_seen_count: 0 });
      recordEntityChange('document', portalFileId,
        old.content_hash !== values.content_hash ? 'versioned' : 'updated',
        old.content_hash, values.content_hash);
      if (old.visibility_status !== values.visibility_status) {
        recordEntityChange('document', portalFileId, 'visibility_changed', old.visibility_status, values.visibility_status);
      }
    } else {
      insertDocument.run({ ...values, now });
      recordEntityChange('document', portalFileId, 'created', null, values.content_hash);
    }
  }
  if (bundle.fullCrawlSucceeded === true) {
    const unseen = db.prepare(`
      SELECT id, portal_file_id, visibility_status, not_seen_count
      FROM tender_documents
      WHERE tender_id = ? AND (last_seen_crawl_token IS NULL OR last_seen_crawl_token <> ?)
        AND visibility_status <> 'removed'
    `).all(tenderId, fullCrawlToken);
    db.prepare(`
      UPDATE tender_documents
      SET visibility_status = 'active', not_seen_count = 0, last_full_seen_at = ?
      WHERE tender_id = ? AND last_seen_crawl_token = ?
    `).run(now, tenderId, fullCrawlToken);
    db.prepare(`
      UPDATE tender_documents
      SET not_seen_count = not_seen_count + 1,
          visibility_status = CASE WHEN not_seen_count + 1 >= 2 THEN 'removed' ELSE 'not_seen' END,
          last_full_seen_at = ?
      WHERE tender_id = ? AND (last_seen_crawl_token IS NULL OR last_seen_crawl_token <> ?)
        AND visibility_status <> 'removed'
    `).run(now, tenderId, fullCrawlToken);
    for (const document of unseen) {
      const nextStatus = document.not_seen_count + 1 >= 2 ? 'removed' : 'not_seen';
      recordEntityChange('document', document.portal_file_id || document.id, 'visibility_changed',
        document.visibility_status, nextStatus);
    }
  }

  const findMessage = db.prepare(`SELECT * FROM tender_messages WHERE tender_id = ? AND portal_message_id = ? AND content_hash = ?`);
  const seenMessageIds = new Set();
  const insertMessage = db.prepare(`
    INSERT INTO tender_messages (
      tender_id, portal_message_id, subject, body, published_at, source_url, attachments_json,
      content_hash, first_seen_at, last_seen_at
    ) VALUES (@tender_id, @portal_message_id, @subject, @body, @published_at, @source_url,
      @attachments_json, @content_hash, @now, @now)
  `);
  const updateMessage = db.prepare(`
    UPDATE tender_messages SET subject=@subject, body=@body, published_at=@published_at,
      source_url=@source_url, attachments_json=@attachments_json, last_seen_at=@now
    WHERE id=@id
  `);
  for (const message of messages) {
    const attachments = bundleValue(message, 'attachments');
    const subject = bundleValue(message, 'subject', 'title');
    const body = bundleValue(message, 'body', 'text', 'message');
    const contentHash = bundleValue(message, 'contentHash', 'content_hash') || detailHash({ subject, body, attachments });
    const portalMessageId = String(bundleValue(message, 'portalMessageId', 'portal_message_id', 'messageId') || `message-${contentHash.slice(0, 32)}`);
    seenMessageIds.add(portalMessageId);
    const values = {
      tender_id: tenderId,
      portal_message_id: portalMessageId,
      subject,
      body,
      published_at: bundleValue(message, 'publishedAt', 'published_at', 'date'),
      source_url: bundleValue(message, 'sourceUrl', 'source_url', 'pageUrl'),
      attachments_json: jsonOrNull(attachments),
      content_hash: contentHash,
    };
    const old = findMessage.get(tenderId, portalMessageId, contentHash);
    if (old) {
      updateMessage.run({ ...values, id: old.id, now });
      recordEntityChange('message', portalMessageId, 'updated', old.content_hash, contentHash);
    } else {
      insertMessage.run({ ...values, now });
      recordEntityChange('message', portalMessageId, 'created', null, contentHash);
    }
  }
  if (bundle.fullCrawlSucceeded === true && Object.prototype.hasOwnProperty.call(bundle, 'messages')) {
    const staleMessages = db.prepare(`SELECT id, portal_message_id, content_hash FROM tender_messages WHERE tender_id = ?`).all(tenderId);
    for (const message of staleMessages) {
      if (seenMessageIds.has(String(message.portal_message_id || ''))) continue;
      db.prepare(`DELETE FROM tender_messages WHERE id = ?`).run(message.id);
      recordEntityChange('message', message.portal_message_id || message.id, 'removed', message.content_hash, null);
    }
  }

  const findSnapshot = db.prepare(`SELECT id, content_hash FROM tender_snapshots WHERE tender_id = ? AND kind = ? ORDER BY version DESC, id DESC LIMIT 1`);
  const deleteSnapshots = db.prepare(`DELETE FROM tender_snapshots WHERE tender_id = ? AND kind = ?`);
  const insertSnapshot = db.prepare(`
    INSERT INTO tender_snapshots (
      tender_id, kind, source_url, mime_type, content, content_hash, version, fetched_at
    ) VALUES (@tender_id, @kind, @source_url, @mime_type, @content, @content_hash, 1, @fetched_at)
  `);
  for (const snapshot of snapshots) {
    const content = bundleValue(snapshot, 'content', 'text', 'html') || '';
    const kind = String(bundleValue(snapshot, 'kind', 'section') || 'detail');
    const contentHash = bundleValue(snapshot, 'contentHash', 'content_hash') || detailHash(content);
    const previous = findSnapshot.get(tenderId, kind);
    if (previous?.content_hash === contentHash) continue;
    deleteSnapshots.run(tenderId, kind);
    insertSnapshot.run({
      tender_id: tenderId,
      kind,
      source_url: bundleValue(snapshot, 'sourceUrl', 'source_url', 'url'),
      mime_type: bundleValue(snapshot, 'mimeType', 'mime_type') || 'text/html',
      content,
      content_hash: contentHash,
      fetched_at: bundleValue(snapshot, 'fetchedAt', 'fetched_at') || now,
    });
    recordEntityChange('snapshot', kind, previous ? 'updated' : 'created', previous?.content_hash, contentHash);
  }
  if (bundle.fullCrawlSucceeded === true && Object.prototype.hasOwnProperty.call(bundle, 'snapshots')) {
    const seenSnapshotKinds = new Set(snapshots.map((snapshot) => String(bundleValue(snapshot, 'kind', 'section') || 'detail')));
    const staleSnapshots = db.prepare(`SELECT kind, content_hash FROM tender_snapshots WHERE tender_id = ?`).all(tenderId);
    for (const snapshot of staleSnapshots) {
      if (seenSnapshotKinds.has(snapshot.kind)) continue;
      db.prepare(`DELETE FROM tender_snapshots WHERE tender_id = ? AND kind = ?`).run(tenderId, snapshot.kind);
      recordEntityChange('snapshot', snapshot.kind, 'removed', snapshot.content_hash, null);
    }
  }

  // Der lokale Suchtext enthält nach einer Detailanreicherung auch die
  // aktuellen Abschnittstexte und generischen Fakten. Tender-Quelldokumente
  // werden bewusst current-only gehalten; Förderprogramm-Versionen bleiben
  // von dieser Regel unberührt.
  const currentTender = stmts.getTenderById.get(tenderId);
  const currentSections = db.prepare(`SELECT section_key, title, text FROM tender_text_sections WHERE tender_id = ? ORDER BY section_key`).all(tenderId);
  const currentFacts = db.prepare(`SELECT section_key, label, value_text FROM tender_facts WHERE tender_id = ? ORDER BY section_key, label`).all(tenderId);
  const aggregateSearchText = buildTenderSearchText({
    title: currentTender?.title,
    description: currentTender?.description,
    contractingAuthority: currentTender?.contracting_authority,
    cpvLabels: safeParseJson(currentTender?.cpv_labels),
    placeOfPerformance: currentTender?.place_of_performance,
    bindingPeriod: currentTender?.binding_period,
    portalStatus: currentTender?.portal_status,
    awardCriteria: currentTender?.award_criteria,
    textSections: currentSections,
    facts: currentFacts,
  });
  db.prepare(`UPDATE tenders SET search_text_full = ? WHERE id = ?`).run(aggregateSearchText, tenderId);
  saveSourceDocument({
    docKind: 'tender', entityId: tenderId, canonicalUrl: currentTender?.url,
    documentTitle: currentTender?.title, content: aggregateSearchText, replaceCurrent: true,
  });

  const completeness = bundle.completeness || bundle.detailCompleteness || null;
  const overall = typeof completeness === 'string' ? completeness : completeness?.overall;
  const detailStatus = bundle.detailStatus || (overall === 'complete' ? 'complete' : 'partial');
  const detailCompleteness = completeness == null ? null : (typeof completeness === 'string' ? completeness : JSON.stringify(completeness));
  const metadata = bundle.metadata == null ? null : jsonOrNull(bundle.metadata);
  const oldTender = stmts.getTenderById.get(tenderId);
  if (oldTender && String(oldTender.detail_status ?? '') !== String(detailStatus ?? '')) {
    recordEntityChange('tender', 'detail_status', 'updated', oldTender.detail_status, detailStatus);
  }
  db.prepare(`
    UPDATE tenders SET detail_status = COALESCE(?, detail_status), detail_crawled_at = ?,
      detail_completeness = COALESCE(?, detail_completeness), portal_metadata_json = COALESCE(?, portal_metadata_json)
    WHERE id = ?
  `).run(detailStatus, now, detailCompleteness, metadata, tenderId);
  return {
    tenderId,
    sections: completeness?.sections || completeness || {},
    lots: lots.length,
    criteria: criteria.length,
    documents: documents.length,
    messages: messages.length,
    snapshots: snapshots.length,
  };
};

const persistTenderDetailBundleTx = db.transaction(persistTenderDetailBundleRaw);

export function persistTenderDetailBundle(tenderId, bundle, now = new Date().toISOString()) {
  return persistTenderDetailBundleTx(tenderId, bundle, now);
}

export function getTenderBundleById(tenderId) {
  const tender = stmts.getTenderById.get(tenderId);
  if (!tender) return null;
  const parseRows = (rows, fields = []) => rows.map((row) => {
    const result = { ...row };
    for (const field of fields) if (result[field]) result[field] = safeParseJson(result[field]);
    return result;
  });
  const bundle = {
    lots: parseRows(db.prepare(`SELECT * FROM tender_lots WHERE tender_id = ? ORDER BY id`).all(tenderId), ['cpv_codes', 'cpv_labels', 'metadata_json']),
    criteria: parseRows(db.prepare(`SELECT * FROM tender_criteria WHERE tender_id = ? ORDER BY id`).all(tenderId), ['metadata_json']),
    documents: parseRows(db.prepare(`SELECT * FROM tender_documents WHERE tender_id = ? ORDER BY id`).all(tenderId), ['locator_json']),
    messages: parseRows(db.prepare(`SELECT * FROM tender_messages WHERE tender_id = ? ORDER BY published_at, id`).all(tenderId), ['attachments_json']),
    snapshots: db.prepare(`SELECT * FROM tender_snapshots WHERE tender_id = ? ORDER BY kind, version`).all(tenderId),
    textSections: db.prepare(`SELECT * FROM tender_text_sections WHERE tender_id = ? ORDER BY section_key`).all(tenderId),
    facts: parseRows(db.prepare(`SELECT * FROM tender_facts WHERE tender_id = ? ORDER BY section_key, label, fact_key`).all(tenderId), ['normalized_value_json']),
  };
  bundle.metadata = safeParseJson(tender.portal_metadata_json);
  bundle.completeness = safeParseJson(tender.detail_completeness) || tender.detail_completeness || null;
  return bundle;
}

export function getDiscoveryCache(sourceId, portalProjectId) {
  if (!portalProjectId) return null;
  return db.prepare(`SELECT * FROM tender_discovery_cache WHERE source_id = ? AND portal_project_id = ?`)
    .get(sourceId, portalProjectId);
}

export function saveDiscoveryCache({
  sourceId,
  portalProjectId,
  title = null,
  contractingAuthority = null,
  publicationDate = null,
  submissionDeadline = null,
  cpvCodes = null,
  cpvLabels = null,
  inScope = false,
  discoveryFingerprint = null,
  detailAt = null,
  detailStatus = null,
  now = new Date().toISOString(),
}) {
  db.prepare(`
    INSERT INTO tender_discovery_cache (
      source_id, portal_project_id, title, contracting_authority, publication_date,
      submission_deadline, cpv_codes, cpv_labels, in_scope, last_seen_at,
      discovery_fingerprint, last_detail_at, detail_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, portal_project_id) DO UPDATE SET
      title=excluded.title, contracting_authority=excluded.contracting_authority,
      publication_date=excluded.publication_date, submission_deadline=excluded.submission_deadline,
      cpv_codes=excluded.cpv_codes, cpv_labels=excluded.cpv_labels,
      in_scope=excluded.in_scope, last_seen_at=excluded.last_seen_at,
      discovery_fingerprint=excluded.discovery_fingerprint,
      last_detail_at=COALESCE(excluded.last_detail_at, tender_discovery_cache.last_detail_at),
      detail_status=COALESCE(excluded.detail_status, tender_discovery_cache.detail_status)
  `).run(sourceId, portalProjectId, title, contractingAuthority, publicationDate,
    submissionDeadline, jsonOrNull(cpvCodes), jsonOrNull(cpvLabels), inScope ? 1 : 0, now,
    discoveryFingerprint, detailAt, detailStatus);
}

export function getTenderChanges(tenderId) {
  return db.prepare(`SELECT * FROM tender_changes WHERE tender_id = ? ORDER BY id DESC`).all(tenderId);
}

export function getSources() {
  return stmts.allSources.all();
}

export function getSource(id) {
  return stmts.getSource.get(id);
}

export function updateLlmAnalysis({ tenderId, summary, relevanceScore, relevanceReason, requirements, model, now }) {
  stmts.updateLlamaAnalysis.run({
    id: tenderId,
    llm_summary: summary ?? null,
    llm_relevance_score: relevanceScore == null ? null : relevanceScore,
    llm_relevance_reason: relevanceReason ?? null,
    llm_requirements: requirements ? JSON.stringify(requirements) : null,
    llm_analyzed_at: now,
    llm_model: model,
  });
}

export function logLlmAnalysis({ tenderId, provider, model, inputChars, outputChars, success, errorMessage, now }) {
  stmts.insertLlmLog.run(
    tenderId ?? null,
    now,
    provider,
    model,
    inputChars,
    outputChars,
    success ? 1 : 0,
    errorMessage ?? null
  );
}

export function countLlmAnalysesToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return stmts.countLlmAnalysesToday.get(startOfDay.toISOString()).count;
}

export function createSavedSearch(data) {
  const now = new Date().toISOString();
  const result = stmts.insertSavedSearch.run({
    name: String(data.name || 'Unbenanntes Suchprofil').trim(),
    keywords: data.keywords ?? null,
    cpv_codes: data.cpvCodes ? JSON.stringify(data.cpvCodes) : null,
    sources: data.sources ? JSON.stringify(data.sources) : null,
    regions: data.regions ? JSON.stringify(data.regions) : null,
    status_filter: data.statusFilter || 'open',
    min_relevance: data.minRelevance ?? null,
    min_lead_days: data.minLeadDays ?? data.min_lead_days ?? null,
    notify_email: data.notifyEmail ?? null,
    created_at: now,
  });
  return stmts.getSavedSearch.get(Number(result.lastInsertRowid));
}

export function getSavedSearches() {
  return stmts.allSavedSearches.all();
}

export function deleteSavedSearch(id) {
  stmts.deleteSavedSearch.run(id);
}

export function updateSavedSearch(id, data) {
  const existing = stmts.getSavedSearch.get(Number(id));
  if (!existing) return null;
  const updatedAt = new Date().toISOString();
  stmts.updateSavedSearch.run({
    id: Number(id),
    name: String(data.name ?? existing.name).trim() || existing.name,
    keywords: Object.prototype.hasOwnProperty.call(data, 'keywords') ? (data.keywords || null) : existing.keywords,
    cpv_codes: Object.prototype.hasOwnProperty.call(data, 'cpvCodes') ? (data.cpvCodes?.length ? JSON.stringify(data.cpvCodes) : null) : existing.cpv_codes,
    sources: Object.prototype.hasOwnProperty.call(data, 'sources') ? (data.sources?.length ? JSON.stringify(data.sources) : null) : existing.sources,
    regions: Object.prototype.hasOwnProperty.call(data, 'regions') ? (data.regions?.length ? JSON.stringify(data.regions) : null) : existing.regions,
    status_filter: data.statusFilter ?? existing.status_filter ?? 'open',
    min_relevance: Object.prototype.hasOwnProperty.call(data, 'minRelevance') ? (data.minRelevance ?? null) : (existing.min_relevance ?? null),
    min_lead_days: Object.prototype.hasOwnProperty.call(data, 'minLeadDays') || Object.prototype.hasOwnProperty.call(data, 'min_lead_days')
      ? (data.minLeadDays ?? data.min_lead_days ?? null) : (existing.min_lead_days ?? null),
    active: data.active === undefined ? existing.active : (data.active ? 1 : 0),
    updated_at: updatedAt,
  });
  return stmts.getSavedSearch.get(Number(id));
}

export function getTenderUserState(tenderId) {
  return stmts.getTenderState.get(Number(tenderId)) || { state: 'unseen', updated_at: null };
}

export function setTenderUserState(tenderId, state) {
  const valid = ['unseen', 'seen', 'watch', 'dismiss'];
  if (!valid.includes(state)) throw new Error(`Ungültiger Ausschreibungsstatus: ${state}`);
  stmts.setTenderState.run({ tender_id: Number(tenderId), state, updated_at: new Date().toISOString() });
  return getTenderUserState(tenderId);
}

export function getSearchProfileCounts(profileId) {
  const base = listTenders({ profileId, limit: 1 });
  const watch = listTenders({ profileId, userState: 'watch', limit: 1 });
  const unseen = listTenders({ profileId, userState: 'unseen', limit: 1 });
  return { total: base.total, watch: watch.total, unseen: unseen.total };
}

export function getCrawlHistory(limit = 10) {
  return stmts.getCrawlLogs.all(limit);
}

/**
 * Liefert nur deterministisch NEUE, noch nicht analysierte Tender.
 * Ein Tender gilt als neu, wenn er seit seiner ersten Erfassung nie aktualisiert
 * wurde (last_changed_at = first_seen_at). Aktualisierte Bestandstender werden
 * nicht erneut/erstmalig analysiert – das LLM läuft nur für neu gefundene
 * Ausschreibungen.
 */
export function getTendersForLlmAnalysis(limit = 20) {
  return db.prepare(`
    SELECT t.* FROM tenders t
    WHERE t.llm_analyzed_at IS NULL
      AND t.last_changed_at = t.first_seen_at
      AND (t.description IS NOT NULL OR t.title IS NOT NULL)
    ORDER BY t.first_seen_at DESC
    LIMIT ?
  `).all(limit);
}

export function getStats() {
  const now = new Date();
  const nowIso = now.toISOString();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const weekFromNow = new Date(now);
  weekFromNow.setDate(weekFromNow.getDate() + 7);
  const monthFromNow = new Date(now);
  monthFromNow.setDate(monthFromNow.getDate() + 30);

  const totalOpen = db.prepare(`SELECT COUNT(*) AS count FROM tenders WHERE status IN ('open', 'closing_soon')`).get().count;
  const newToday = db.prepare(`SELECT COUNT(*) AS count FROM tenders WHERE first_seen_at >= ?`).get(startOfToday.toISOString()).count;
  const newSevenDays = db.prepare(`SELECT COUNT(*) AS count FROM tenders WHERE first_seen_at >= ?`).get(sevenDaysAgo.toISOString()).count;
  const closingWeek = db.prepare(`
    SELECT COUNT(*) AS count FROM tenders
    WHERE submission_deadline IS NOT NULL
      AND submission_deadline >= ? AND submission_deadline <= ?
  `).get(nowIso, weekFromNow.toISOString()).count;
  const closingMonth = db.prepare(`
    SELECT COUNT(*) AS count FROM tenders
    WHERE submission_deadline IS NOT NULL
      AND submission_deadline >= ? AND submission_deadline <= ?
  `).get(nowIso, monthFromNow.toISOString()).count;
  const analyzed = db.prepare(`SELECT COUNT(*) AS count FROM tenders WHERE llm_analyzed_at IS NOT NULL`).get().count;
  const bySource = db.prepare(`
    SELECT source_id, COUNT(*) AS count FROM tenders GROUP BY source_id ORDER BY count DESC
  `).all();
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS count FROM tenders GROUP BY status ORDER BY count DESC
  `).all();
  const lastCrawl = db.prepare(`SELECT MAX(started_at) AS last FROM crawl_log`).get().last;

  return {
    totalOpen,
    newToday,
    newSevenDays,
    closingWeek,
    closingMonth,
    analyzed,
    totalTenders: db.prepare(`SELECT COUNT(*) AS count FROM tenders`).get().count,
    bySource,
    byStatus,
    lastCrawl,
  };
}

/**
 * Legt einen Browser-Crawl-Job an. Wirft, wenn bereits ein aktiver
 * Job für die Quelle existiert (Unique-Schutz gegen Doppeljobs).
 */
export function enqueueBrowserJob(sourceId, { mode = 'auto' } = {}) {
  const active = stmts.hasActiveBrowserJob.get({ source_id: sourceId });
  if (active) return null;
  const info = stmts.enqueueBrowserJob.run({
    source_id: sourceId,
    mode,
    requested_at: new Date().toISOString(),
    max_attempts: config.workerMaxAttempts,
  });
  return stmts.getBrowserJobById.get(Number(info.lastInsertRowid));
}

export function hasActiveBrowserJob(sourceId) {
  return Boolean(stmts.hasActiveBrowserJob.get({ source_id: sourceId }));
}

export function getBrowserJobById(id) {
  return stmts.getBrowserJobById.get(id);
}

/**
 * Claimt den ältesten queued/retry-Job atomar für einen Worker.
 * Gibt den Job oder null zurück.
 */
export function claimNextBrowserJob(workerId) {
  const now = new Date().toISOString();
  return stmts.claimNextBrowserJob.get({ now, worker_id: workerId }) || null;
}

export function updateJobProgress(id, { pagesDone, itemsDiscovered, itemsNew, itemsChanged } = {}) {
  stmts.updateJobProgress.run({
    id,
    now: new Date().toISOString(),
    pages_done: pagesDone ?? 0,
    items_discovered: itemsDiscovered ?? 0,
    items_new: itemsNew ?? 0,
    items_changed: itemsChanged ?? 0,
  });
}

export function completeBrowserJob(id, { pagesDone, itemsDiscovered, itemsNew, itemsChanged } = {}) {
  stmts.completeBrowserJob.run({
    id,
    now: new Date().toISOString(),
    pages_done: pagesDone ?? 0,
    items_discovered: itemsDiscovered ?? 0,
    items_new: itemsNew ?? 0,
    items_changed: itemsChanged ?? 0,
  });
}

/**
 * Beendet einen Job mit Status 'failed' oder 'cancelled'.
 */
export function finishBrowserJob(id, status, { pagesDone, itemsDiscovered, itemsNew, itemsChanged, error } = {}) {
  stmts.finishBrowserJob.run({
    id,
    status,
    now: new Date().toISOString(),
    pages_done: pagesDone ?? 0,
    items_discovered: itemsDiscovered ?? 0,
    items_new: itemsNew ?? 0,
    items_changed: itemsChanged ?? 0,
    error_detail: error ? String(error).slice(0, 2000) : null,
  });
}

export function requestCancelJob(id) {
  stmts.requestCancel.run(id);
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - config.workerStaleAfterMs).toISOString();
  stmts.cancelInactiveJob.run({
    id,
    now,
    stale,
    error: 'Abgebrochen (Job war nicht mehr aktiv)',
  });
  return stmts.getBrowserJobById.get(id) || null;
}

/**
 * Setzt Jobs, deren Heartbeat zu alt ist, auf 'retry' zurück
 * (Worker-Crash-/Neustart-Erkennung).
 */
export function recoverStaleJobs(now = new Date().toISOString(), staleMs = 60000) {
  const stale = new Date(Date.now() - staleMs).toISOString();
  const info = stmts.recoverStaleJobs.run({
    now,
    stale,
    error: 'stale (Worker nicht mehr erreichbar)',
    cancel_error: 'Abgebrochen (Worker nicht mehr erreichbar)',
  });
  return info.changes;
}

export function getRecentJobs(limit = 20) {
  return stmts.getRecentJobs.all(limit);
}

// ── Förderprogramme ──────────────────────────────────────────────

/**
 * Baut den Volltext-Suchtext eines Förderprogramms aus allen
 * Kindentitäten (Projektformen, Zielgruppen, Voraussetzungen …) auf.
 */
export function buildFundingSearchText({ title, currentCall, fundingGeber, fundingGegenstand, shortDescription, projectTypes = [], eligibility = [] } = {}) {
  const parts = [title, currentCall, fundingGeber, fundingGegenstand, shortDescription];
  for (const pt of projectTypes) {
    parts.push(pt.name, pt.description, pt.conditions);
  }
  for (const e of eligibility) {
    parts.push(e.text);
  }
  return parts.filter((p) => p).join(' | ');
}

/**
 * Startet einen Förder-Crawl-Log-Eintrag.
 */
export function startFundingCrawlLog(sourceId = null) {
  const now = new Date().toISOString();
  const result = stmts.insertFundingCrawlLog.run(sourceId, now);
  return { id: Number(result.lastInsertRowid), startedAt: now };
}

/**
 * Beendet einen Förder-Crawl-Log-Eintrag.
 */
export function finishFundingCrawlLog(summary) {
  stmts.finishFundingCrawlLog.run({
    id: summary.id,
    finished_at: new Date().toISOString(),
    status: summary.status,
    items_discovered: summary.itemsDiscovered || 0,
    items_new: summary.itemsNew || 0,
    items_changed: summary.itemsChanged || 0,
    documents_loaded: summary.documentsLoaded || 0,
    extraction_errors: summary.extractionErrors || 0,
    needs_review: summary.needsReview || 0,
    error_detail: summary.errorMessage ? String(summary.errorMessage).slice(0, 2000) : null,
  });
}

export function getFundingCrawlHistory(limit = 20) {
  return stmts.getFundingCrawlLogs.all(Math.min(limit, 100));
}

function fundingOverrideValue(overrides, entity, field) {
  const ov = overrides.find((o) => o.entity === entity && o.field === field);
  return ov ? ov.value : undefined;
}

/**
 * Speichert ein Förderprogramm samt Kindentitäten und erkennt Änderungen.
 * Manuelle Overrides gewinnen gegenüber neuen Crawl-Werten.
 * @returns {Promise<{isNew, changed, programId, changes, needsReview}>}
 */
const saveFundingTx = db.transaction(({ program, now }) => {
  const existing = stmts.getFundingBySourceExternal.get(program.sourceId, program.externalId);
  const searchText = buildFundingSearchText({
    title: program.title,
    currentCall: program.currentCall,
    fundingGeber: program.fundingGeber,
    fundingGegenstand: program.fundingGegenstand,
    shortDescription: program.shortDescription,
    projectTypes: program.projectTypes,
    eligibility: program.eligibility,
  });

  const fields = {
    source_id: program.sourceId,
    external_id: program.externalId,
    title: program.title,
    current_call: program.currentCall ?? null,
    short_description: program.shortDescription ?? null,
    funding_gegenstand: program.fundingGegenstand ?? null,
    funding_geber: program.fundingGeber ?? null,
    funding_geber_short: program.fundingGeberShort ?? null,
    search_text: searchText,
    search_text_full: buildFundingSearchTextFull(program),
    publication_date: program.publicationDate ?? null,
    status: program.status || 'unknown',
    review_status: program.reviewStatus || 'unreviewed',
    primary_url: program.primaryUrl ?? null,
    content_hash: program.contentHash,
    extracted_at: program.extractedAt ?? null,
    extraction_model: program.extractionModel ?? null,
    now,
  };

  if (!existing) {
    const result = stmts.insertFunding.run(fields);
    const programId = Number(result.lastInsertRowid);
    insertFundingChildren(programId, program, now);
    saveSourceDocument({
      docKind: 'funding', entityId: programId, canonicalUrl: fields.primary_url,
      documentTitle: fields.title, content: program.sourceText || fields.search_text_full,
    });
    return { isNew: true, changed: true, programId, changes: [{ entity: 'program', field: 'created', oldValue: null, newValue: fields.title }], needsReview: 0 };
  }

  // Änderung erkennen (einfache Kernfelder)
  const changes = [];
  const coreComparisons = [
    ['program', 'title', existing.title, program.title],
    ['program', 'current_call', existing.current_call, program.currentCall],
    ['program', 'funding_geber', existing.funding_geber, program.fundingGeber],
    ['program', 'funding_gegenstand', existing.funding_gegenstand, program.fundingGegenstand],
    ['program', 'status', existing.status, program.status],
  ];
  for (const [entity, field, oldValue, newValue] of coreComparisons) {
    if (String(oldValue ?? '') !== String(newValue ?? '')) {
      changes.push({ entity, field, oldValue, newValue });
    }
  }
  const contentChanged = existing.content_hash !== program.contentHash;
  const changed = changes.length > 0 || contentChanged;

  // Bestehende Overrides laden – sie entscheiden, ob neue Werte übernommen werden
  const overrides = stmts.getFundingOverrides.all(existing.id);

  for (const change of changes) {
    if (change.field === 'status') {
      // Status nie durch Override blockieren (wird zentral berechnet)
      stmts.insertFundingChange.run({ program_id: existing.id, changed_at: now, entity: change.entity, field: change.field, old_value: change.oldValue, new_value: change.newValue, source: 'crawl' });
      continue;
    }
    const override = fundingOverrideValue(overrides, change.entity, change.field);
    if (override !== undefined) {
      // Manueller Wert gewinnt: Quellenänderung nur als Prüfhinweis, nicht überschreiben
      stmts.insertFundingChange.run({ program_id: existing.id, changed_at: now, entity: change.entity, field: change.field, old_value: change.newValue, new_value: override, source: 'conflict' });
    } else {
      stmts.insertFundingChange.run({ program_id: existing.id, changed_at: now, entity: change.entity, field: change.field, old_value: change.oldValue, new_value: change.newValue, source: 'crawl' });
    }
  }

  // Override-angepasste Kernwerte anwenden
  const ovTitle = fundingOverrideValue(overrides, 'program', 'title');
  const ovGeber = fundingOverrideValue(overrides, 'program', 'funding_geber');
  const ovGegenstand = fundingOverrideValue(overrides, 'program', 'funding_gegenstand');
  const ovCall = fundingOverrideValue(overrides, 'program', 'current_call');
  stmts.updateFunding.run({
    ...fields,
    id: existing.id,
    changed: changed ? 1 : 0,
    title: ovTitle ?? fields.title,
    funding_geber: ovGeber ?? fields.funding_geber,
    funding_gegenstand: ovGegenstand ?? fields.funding_gegenstand,
    current_call: ovCall ?? fields.current_call,
  });

  // Kinder ersetzen (Fristen, Projektformen, Links) und Lücken-Only bei LLM-Inhalten
  replaceFundingChildren(existing.id, program, now, overrides);

  if (changed) {
    saveSourceDocument({
      docKind: 'funding', entityId: existing.id, canonicalUrl: fields.primary_url,
      documentTitle: fields.title, content: program.sourceText || fields.search_text_full,
    });
  }

  return { isNew: false, changed, programId: existing.id, changes, needsReview: 0 };
});

function insertFundingChildren(programId, program, now) {
  for (const dl of program.deadlines || []) {
    stmts.insertDeadline.run({ program_id: programId, label: dl.label ?? null, deadline_at: dl.deadlineAt ?? null, timezone: dl.timezone || 'Europe/Berlin', is_ongoing: dl.isOngoing ? 1 : 0, note: dl.note ?? null });
  }
  for (const pt of program.projectTypes || []) {
    stmts.insertProjectType.run({
      program_id: programId,
      name: pt.name,
      description: pt.description ?? null,
      duration_min_months: pt.durationMinMonths ?? null,
      duration_max_months: pt.durationMaxMonths ?? null,
      amount_min_cents: pt.amountMinCents ?? null,
      amount_max_cents: pt.amountMaxCents ?? null,
      currency: pt.currency || 'EUR',
      funding_quote_min: pt.fundingQuoteMin ?? null,
      funding_quote_max: pt.fundingQuoteMax ?? null,
      max_amount_cents: pt.maxAmountCents ?? null,
      conditions: pt.conditions ?? null,
    });
  }
  for (const e of program.eligibility || []) {
    stmts.insertEligibility.run({ program_id: programId, kind: e.kind || 'requirement', text: e.text, sort: e.sort ?? 0 });
  }
  for (const link of program.links || []) {
    stmts.insertLink.run({ program_id: programId, kind: link.kind || 'other', url: link.url, title: link.title ?? null });
  }
  storeFundingEvidence(programId, program.evidence || [], now);
}

/**
 * Ersetzt Kindentitäten. Skalare Kernfelder respektieren Overrides;
 * LLM-Textfelder (funding_gegenstand) werden nur bei Lücken gefüllt.
 */
function replaceFundingChildren(programId, program, now, overrides) {
  stmts.replaceDeadlines.run(programId);
  stmts.replaceProjectTypes.run(programId);
  stmts.replaceEligibility.run(programId);
  stmts.replaceLinks.run(programId);
  insertFundingChildren(programId, program, now);
}

function storeFundingEvidence(programId, evidence, now) {
  stmts.clearEvidence.run(programId);
  for (const ev of evidence) {
    stmts.insertEvidence.run({
      program_id: programId,
      entity: ev.entity || 'program',
      field: ev.field || 'value',
      source_url: ev.sourceUrl ?? null,
      document_title: ev.documentTitle ?? null,
      page: ev.page ?? null,
      quote: ev.quote ?? null,
      method: ev.method || 'parser',
      confidence: ev.confidence ?? null,
      created_at: now,
    });
  }
}

export function saveFundingProgram(program, now = new Date().toISOString()) {
  return saveFundingTx({ program, now });
}

export function getFundingProgramById(id) {
  const row = stmts.getFundingById.get(id);
  if (!row) return null;
  return attachFundingDetails(row);
}

/**
 * Deterministische Existenzprüfung eines Förder-Calls anhand von Quelle + External-ID.
 * Wird beim Crawlen verwendet, um zu entscheiden, ob ein Call neu ist (LLM-Analyse
 * nur für neue Calls) oder bereits vorhanden.
 */
export function fundingProgramExists(sourceId, externalId) {
  return stmts.getFundingBySourceExternal.get(sourceId, externalId) != null;
}

export function getFundingProgramByExternalId(sourceId, externalId) {
  return stmts.getFundingBySourceExternal.get(sourceId, externalId) || null;
}

function attachFundingDetails(row) {
  const doc = getSourceDocument('funding', row.id);
  return {
    ...row,
    source_text: doc?.content ?? row.search_text_full ?? null,
    deadlines: stmts.getFundingDeadlines.all(row.id),
    project_types: stmts.getFundingProjectTypes.all(row.id),
    eligibility: stmts.getFundingEligibility.all(row.id),
    links: stmts.getFundingLinks.all(row.id),
    evidence: stmts.getFundingEvidence.all(row.id),
    overrides: stmts.getFundingOverrides.all(row.id).map((o) => ({
      id: o.id,
      program_id: o.program_id,
      entity: o.entity,
      field: o.field,
      value: o.value ? JSON.parse(o.value) : null,
      is_confirmed: o.is_confirmed,
      created_at: o.created_at,
      updated_at: o.updated_at,
    })),
    changes: stmts.getFundingChanges.all(row.id),
  };
}

export function getFundingStats() {
  const total = db.prepare(`SELECT COUNT(*) AS count FROM funding_programs`).get().count;
  const open = db.prepare(`SELECT COUNT(*) AS count FROM funding_programs WHERE status IN ('open', 'ongoing')`).get().count;
  const needsReview = db.prepare(`SELECT COUNT(*) AS count FROM funding_programs WHERE review_status = 'needs_review'`).get().count;
  const verified = db.prepare(`SELECT COUNT(*) AS count FROM funding_programs WHERE review_status = 'verified'`).get().count;
  const closingSoon = db.prepare(`
    SELECT COUNT(*) AS count FROM funding_programs p
    WHERE EXISTS (
      SELECT 1 FROM funding_deadlines d
      WHERE d.program_id = p.id AND d.is_ongoing = 0
        AND d.deadline_at >= datetime('now') AND d.deadline_at <= datetime('now', '+30 days')
    )
  `).get().count;
  return { total, open, needsReview, verified, closingSoon };
}

/**
 * Listet Förderprogramme mit Filtern, Suche und Paginierung.
 */
export function listFundingPrograms({
  q = null,
  geber = null,
  status = null,
  reviewStatus = null,
  deadlineBefore = null,
  deadlineAfter = null,
  projectType = null,
  sort = 'deadline',
  page = 1,
  limit = 25,
} = {}) {
  const conditions = [];
  const params = {};

  if (q) {
    const fts = buildFundingFtsQuery(q);
    if (fts) {
      conditions.push(`p.id IN (SELECT rowid FROM funding_programs_fts WHERE funding_programs_fts MATCH @fts_query)`);
      params.fts_query = fts;
    }
  }

  if (geber) {
    conditions.push(`(p.funding_geber LIKE @geber OR p.funding_geber_short LIKE @geber)`);
    params.geber = `%${geber}%`;
  }

  if (status?.length) {
    conditions.push(`p.status IN (${status.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(', ')})`);
  }

  if (reviewStatus) {
    conditions.push(`p.review_status = @review_status`);
    params.review_status = reviewStatus;
  }

  if (projectType) {
    conditions.push(`p.id IN (SELECT program_id FROM funding_project_types WHERE name LIKE @project_type)`);
    params.project_type = `%${projectType}%`;
  }

  if (deadlineBefore || deadlineAfter) {
    conditions.push(`p.id IN (
      SELECT d.program_id FROM funding_deadlines d
      WHERE d.is_ongoing = 0
        ${deadlineBefore ? 'AND d.deadline_at <= @deadline_before' : ''}
        ${deadlineAfter ? 'AND d.deadline_at >= @deadline_after' : ''}
    )`);
    if (deadlineBefore) params.deadline_before = deadlineBefore;
    if (deadlineAfter) params.deadline_after = deadlineAfter;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortClauses = {
    deadline: 'next_deadline IS NULL, next_deadline ASC, p.id DESC',
    newest: 'p.publication_date DESC, p.id DESC',
    title: 'p.title ASC, p.id DESC',
  };
  const orderBy = sortClauses[sort] || sortClauses.newest;

  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM funding_programs p ${whereClause}`).get(params);
  const limitInt = Math.max(1, Math.min(Number(limit) || 25, 100));
  const pageInt = Math.max(1, Number(page) || 1);
  const offset = (pageInt - 1) * limitInt;

  const rows = db.prepare(`
    SELECT p.*,
      (SELECT d.deadline_at FROM funding_deadlines d WHERE d.program_id=p.id AND d.is_ongoing=0 AND d.deadline_at >= date('now','localtime') ORDER BY d.deadline_at ASC LIMIT 1) AS next_deadline,  (SELECT d.label FROM funding_deadlines d WHERE d.program_id=p.id AND d.is_ongoing=0 AND d.deadline_at >= date('now','localtime') ORDER BY d.deadline_at ASC LIMIT 1) AS next_deadline_label,
      (SELECT COUNT(*) FROM funding_deadlines d WHERE d.program_id=p.id AND d.is_ongoing=1) AS is_ongoing,
      (SELECT GROUP_CONCAT(pt.name, ', ') FROM funding_project_types pt WHERE pt.program_id=p.id) AS project_type_summary,
      (SELECT MAX(pt.amount_max_cents) FROM funding_project_types pt WHERE pt.program_id=p.id) AS max_amount_cents
    FROM funding_programs p
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ${limitInt} OFFSET ${offset}
  `).all(params);

  // Volltext aus der Listen-API ausblenden (nur für Detailansicht/Suche nötig)
  const programs = rows.map((row) => {
    const { search_text_full, ...rest } = row;
    return rest;
  });

  return {
    total: countRow.count,
    page: pageInt,
    limit: limitInt,
    totalPages: Math.ceil(countRow.count / limitInt),
    programs,
  };
}

/* ── Förder-Chat: Retrieval ────────────────────────────────────── */

export const FTS_STOPWORDS = new Set([
  'die', 'der', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'eines',
  'und', 'oder', 'für', 'für', 'welche', 'welcher', 'welches', 'kann', 'können', 'könnte',
  'ich', 'wir', 'uns', 'mit', 'an', 'auf', 'von', 'zu', 'bei', 'wie', 'was', 'gibt',
  'es', 'ist', 'sind', 'waren', 'wird', 'werden', 'sich', 'nach', 'nicht', 'kein',
  'keine', 'keinen', 'bitte', 'suche', 'suchen', 'geeignet', 'passende', 'passenden',
  'passendes', 'möglich', 'mögliche', 'möglichen', 'unterstützung', 'auskunft', 'zur',
  'zur', 'als', 'auch', 'bis', 'durch', 'aus', 'über', 'einem', 'einer', 'sein', 'ihre',
]);

/**
 * Baut eine sichere FTS5-MATCH-Abfrage aus Freitext.
 * Entfernt Stoppwörter/Fragewörter, quotet und prefix-matcht jedes Token.
 * Gibt '' zurück, wenn nichts Suchbares übrig bleibt.
 */
export function buildFundingFtsQuery(text, { maxTerms = 8, operator = 'AND' } = {}) {
  const tokens = String(text || '')
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/i)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 2 && !FTS_STOPWORDS.has(t))
    .slice(0, maxTerms);
  const unique = [...new Set(tokens)];
  if (!unique.length) return '';
  const join = operator === 'OR' ? ' OR ' : ' AND ';
  return unique.map((term) => `"${term.replace(/"/g, '')}"*`).join(join);
}

/**
 * Sucht Förder-Call-Kandidaten für den Chat per FTS5 + BM25.
 * Liefert kompakte Metadaten; `includeClosed` berücksichtigt nur bei Bedarf.
 */
export function searchFundingChatCandidates({ query = null, status = null, limit = 20, includeClosed = false } = {}) {
  const limitInt = Math.max(1, Math.min(Number(limit) || 20, 50));
  const ftsQuery = query ? buildFundingFtsQuery(query, { operator: 'OR' }) : '';
  const statusList = status == null ? [] : (Array.isArray(status) ? status.map(String) : [String(status)]);
  const statusInClause = (prefix) => (statusList.length ? `${prefix} p.status IN (${statusList.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(', ')})` : '');

  if (ftsQuery) {
    const statusClause = includeClosed
      ? statusInClause('AND')
      : `AND p.status IN ('open','ongoing','unknown')`;
    return db.prepare(`
      SELECT p.id, p.title, p.funding_geber, p.funding_geber_short, p.status, p.review_status,
        p.short_description, p.funding_gegenstand, p.primary_url,
        (SELECT d.deadline_at FROM funding_deadlines d WHERE d.program_id=p.id AND d.is_ongoing=0 AND d.deadline_at >= date('now','localtime') ORDER BY d.deadline_at ASC LIMIT 1) AS next_deadline,
        (SELECT GROUP_CONCAT(pt.name, ', ') FROM funding_project_types pt WHERE pt.program_id=p.id) AS project_type_summary,
        bm25(funding_programs_fts) AS bm25_rank
      FROM funding_programs p
      JOIN funding_programs_fts f ON f.rowid = p.id
      WHERE funding_programs_fts MATCH @fts
        ${statusClause}
      ORDER BY bm25(funding_programs_fts) ASC, p.id DESC
      LIMIT ${limitInt}
    `).all({ fts: ftsQuery });
  }

  // Fallback ohne Suchabfrage: neueste offene Calls
  const statusClause = includeClosed
    ? statusInClause('WHERE')
    : `WHERE p.status IN ('open','ongoing','unknown')`;
  return db.prepare(`
    SELECT p.id, p.title, p.funding_geber, p.funding_geber_short, p.status, p.review_status,
      p.short_description, p.funding_gegenstand, p.primary_url,
      (SELECT d.deadline_at FROM funding_deadlines d WHERE d.program_id=p.id AND d.is_ongoing=0 AND d.deadline_at >= date('now','localtime') ORDER BY d.deadline_at ASC LIMIT 1) AS next_deadline,
      (SELECT GROUP_CONCAT(pt.name, ', ') FROM funding_project_types pt WHERE pt.program_id=p.id) AS project_type_summary,
      0 AS bm25_rank
    FROM funding_programs p
    ${statusClause}
    ORDER BY p.publication_date DESC, p.id DESC
    LIMIT ${limitInt}
  `).all();
}

/**
 * Wählt relevante Chunks für die angegebenen Förder-Calls per FTS5 + BM25 aus.
 * - Nur aktuelle Dokumentversionen
 * - Maximal `chunksPerProgram` Chunks je Programm
 * - Benachbarte, stark überlappende Chunks werden übersprungen (best effort)
 */
export function searchFundingChatChunks({ programIds = [], terms = [], chunksPerProgram = 2 } = {}) {
  const chunkLimit = Math.max(1, Math.min(Number(chunksPerProgram) || 2, 4));
  const lower = terms.map((t) => String(t).toLowerCase()).filter((t) => t.length >= 2);
  const ftsQuery = buildFundingFtsQuery(lower.join(' '), { operator: 'OR', maxTerms: 12 });

  const getChunks = db.prepare(`SELECT * FROM document_chunks WHERE doc_kind='funding' AND entity_id=? AND doc_version=? ORDER BY chunk_index`);
  const ftsSearch = ftsQuery
    ? db.prepare(`
        SELECT dc.*, bm25(funding_chunks_fts) AS bm25_rank
        FROM funding_chunks_fts f
        JOIN document_chunks dc ON dc.chunk_key = f.chunk_key
        WHERE f.entity_id=? AND f.doc_version=? AND funding_chunks_fts MATCH ?
        ORDER BY bm25(funding_chunks_fts) ASC, dc.chunk_index ASC
        LIMIT ?
      `)
    : null;

  const results = [];
  for (const pid of programIds) {
    const doc = getLatestSourceDocument.get('funding', pid);
    if (!doc) continue;

    let ranked;
    if (ftsSearch) {
      ranked = ftsSearch.all(pid, doc.doc_version, ftsQuery, chunkLimit * 2);
    } else {
      // Keine verwertbaren Suchbegriffe: deterministisch die ersten Chunks nehmen.
      ranked = getChunks.all(pid, doc.doc_version).slice(0, chunkLimit * 2);
    }

    // Überlappungs-Dedup: einen Chunk überspringen, wenn er den zuvor
    // gewählten Chunk textlich überlappt (offset-basiert, best effort).
    const picked = [];
    for (const c of ranked) {
      const prev = picked[picked.length - 1];
      const prevEnd = prev ? Number(prev.offset_chars) + String(prev.text || '').length : 0;
      if (prev && Number(c.offset_chars) < prevEnd) continue;
      picked.push(c);
      if (picked.length >= chunkLimit) break;
    }
    results.push(...picked);
  }
  return results.map((c) => ({ ...c, score: c.bm25_rank ?? 0 }));
}

/**
 * Liefert vertrauenswürdige Quellenmetadaten eines Förder-Calls.
 */
export function getFundingChatSource(programId) {
  const p = db.prepare(`SELECT id, title, funding_geber, funding_geber_short, status, review_status, primary_url, short_description FROM funding_programs WHERE id = ?`).get(programId);
  if (!p) return null;
  const doc = getLatestSourceDocument.get('funding', programId);
  return { ...p, source_doc_version: doc?.doc_version ?? null };
}

/**
 * Setzt oder löscht einen manuellen Override für ein Förderfeld.
 */
export function setFundingOverride({ programId, entity, field, value }) {
  const now = new Date().toISOString();
  const existing = stmts.getFundingOverride.get(programId, entity, field);
  const changed = existing == null || existing.value !== value;
  stmts.upsertFundingOverride.run({
    program_id: programId,
    entity,
    field,
    value: value == null ? null : JSON.stringify(value),
    is_confirmed: existing?.is_confirmed ?? 0,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  if (changed) {
    stmts.insertFundingChange.run({
      program_id: programId,
      changed_at: now,
      entity,
      field,
      old_value: existing?.value ?? null,
      new_value: value == null ? null : JSON.stringify(value),
      source: 'manual',
    });
  }
  return getFundingOverridePublic(programId, entity, field);
}

export function getFundingOverridePublic(programId, entity, field) {
  const ov = stmts.getFundingOverride.get(programId, entity, field);
  return ov ? { entity: ov.entity, field: ov.field, value: ov.value ? JSON.parse(ov.value) : null, isConfirmed: Boolean(ov.is_confirmed) } : null;
}

export function deleteFundingOverride({ programId, entity, field }) {
  const existing = stmts.getFundingOverride.get(programId, entity, field);
  if (existing) {
    stmts.deleteFundingOverride.run(programId, entity, field);
    const now = new Date().toISOString();
    stmts.insertFundingChange.run({
      program_id: programId,
      changed_at: now,
      entity,
      field,
      old_value: existing.value ?? null,
      new_value: null,
      source: 'manual',
    });
  }
  return true;
}

export function confirmFundingProgram(programId) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE funding_programs SET review_status = 'verified' WHERE id = ?`).run(programId);
  // Alle bestehenden Overrides bestätigen
  for (const ov of stmts.getFundingOverrides.all(programId)) {
    stmts.upsertFundingOverride.run({
      program_id: programId,
      entity: ov.entity,
      field: ov.field,
      value: ov.value,
      is_confirmed: 1,
      created_at: ov.created_at,
      updated_at: now,
    });
  }
  return getFundingProgramById(programId);
}

// ── RAG-Vorbereitung: Volltext + Chunks ────────────────────────

function normSearchPart(part) {
  return part == null || part === '' ? null : String(part).trim();
}

function safeParseJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Baut den vollständigen durchsuchbaren Text eines Tenders auf.
 */
export function buildTenderSearchText(tender) {
  const parts = [
    tender.title,
    tender.description,
    tender.contractingAuthority,
    tender.cpvLabels ? (Array.isArray(tender.cpvLabels) ? tender.cpvLabels.join(' ') : String(tender.cpvLabels)) : null,
    tender.placeOfPerformance,
    tender.bindingPeriod,
    tender.portalStatus,
    tender.llmSummary,
    tender.llmRequirements ? (Array.isArray(tender.llmRequirements) ? tender.llmRequirements.join(' ') : String(tender.llmRequirements)) : null,
    tender.awardCriteria,
  ];
  for (const section of tender.textSections || []) {
    parts.push(section.text ?? section.content ?? section.rawText);
  }
  for (const fact of tender.facts || []) {
    parts.push(fact.label, fact.valueText ?? fact.value_text ?? fact.value);
  }
  return parts.map(normSearchPart).filter(Boolean).join(' | ');
}

/**
 * Baut den vollständigen durchsuchbaren Text eines Förderprogramms auf,
 * inklusive Kindentitäten (Fristen, Projektformen, Voraussetzungen) und
 * dem vollständigen Originaltext der Bekanntmachung.
 */
export function buildFundingSearchTextFull(program) {
  const parts = [
    program.sourceText,
    program.title,
    program.currentCall,
    program.fundingGeber,
    program.fundingGeberShort,
    program.fundingGegenstand,
    program.shortDescription,
  ];
  for (const d of program.deadlines || []) {
    parts.push(d.label, d.deadlineAt, d.note);
  }
  for (const pt of program.projectTypes || []) {
    parts.push(pt.name, pt.description, pt.conditions);
  }
  for (const e of program.eligibility || []) {
    parts.push(e.text);
  }
  for (const l of program.links || []) {
    parts.push(l.title, l.kind);
  }
  return parts.map(normSearchPart).filter(Boolean).join(' | ');
}

/**
 * Zerlegt Text in überlappende Chunks (~500 Wörter, 50 Überlappung)
 * für die spätere Embedding-Erstellung.
 */
export function chunkText(text, { chunkWords = 500, overlapWords = 50 } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean.split(' ');
  const chunks = [];
  const step = Math.max(1, chunkWords - overlapWords);
  for (let i = 0; i < words.length; i += step) {
    const slice = words.slice(i, i + chunkWords).join(' ');
    if (slice) chunks.push(slice);
  }
  return chunks;
}

const insertDocumentChunk = db.prepare(`
  INSERT INTO document_chunks (doc_kind, entity_id, doc_version, chunk_key, chunk_index, heading, text, token_count, offset_chars, chunker_version, embedding_model_id, created_at)
  VALUES (@doc_kind, @entity_id, @doc_version, @chunk_key, @chunk_index, @heading, @text, @token_count, @offset_chars, @chunker_version, @embedding_model_id, @created_at)
  ON CONFLICT(chunk_key) DO UPDATE SET
    text = excluded.text,
    token_count = excluded.token_count,
    offset_chars = excluded.offset_chars
`);
const clearDocumentChunks = db.prepare(`DELETE FROM document_chunks WHERE doc_kind = ? AND entity_id = ?`);
const insertChunkFts = db.prepare(`
  INSERT INTO funding_chunks_fts(entity_id, chunk_key, doc_version, heading, text)
  VALUES (?, ?, ?, ?, ?)
`);
const clearChunkFts = db.prepare(`DELETE FROM funding_chunks_fts WHERE entity_id = ?`);

/**
 * Erzeugt einen stabilen Chunk-Schlüssel aus Dokumenttyp, ID, Version und Text-Hash.
 */
export function makeChunkKey(docKind, entityId, docVersion, index, text) {
  const h = createHash('sha256').update(String(text).trim().toLowerCase()).digest('hex').slice(0, 12);
  return `${docKind}:${entityId}:v${docVersion}:${index}:${h}`;
}

/**
 * Speichert Text-Chunks für ein Dokument (RAG-Vorbereitung).
 * Stabile chunk_key basierend auf Dokument-ID, Version und Text-Hash.
 * Förder-Chunks werden zusätzlich im FTS5-Index funding_chunks_fts gepflegt.
 */
export function saveDocumentChunks(docKind, entityId, text, { docVersion = 1, heading = null } = {}) {
  clearDocumentChunks.run(docKind, entityId);
  if (docKind === 'funding') clearChunkFts.run(entityId);
  const chunks = chunkText(text);
  const now = new Date().toISOString();
  let offset = 0;
  chunks.forEach((chunk, i) => {
    const tokenCount = chunk.split(/\s+/).length;
    const chunkKey = makeChunkKey(docKind, entityId, docVersion, i, chunk);
    insertDocumentChunk.run({
      doc_kind: docKind,
      entity_id: entityId,
      doc_version: docVersion,
      chunk_key: chunkKey,
      chunk_index: i,
      heading,
      text: chunk,
      token_count: tokenCount,
      offset_chars: offset,
      chunker_version: '1',
      embedding_model_id: null,
      created_at: now,
    });
    if (docKind === 'funding') {
      insertChunkFts.run(entityId, chunkKey, docVersion, heading, chunk);
    }
    offset += chunk.length + 1;
  });
  return chunks.length;
}

/**
 * Baut den FTS5-Index funding_chunks_fts vollständig neu auf (nach Backfill/Start).
 */
export function rebuildFundingChunkFts() {
  db.exec(`DELETE FROM funding_chunks_fts`);
  const rows = db.prepare(`SELECT entity_id, chunk_key, doc_version, heading, text FROM document_chunks WHERE doc_kind = 'funding'`).all();
  const ins = db.prepare(`INSERT INTO funding_chunks_fts(entity_id, chunk_key, doc_version, heading, text) VALUES (?, ?, ?, ?, ?)`);
  for (const r of rows) ins.run(r.entity_id, r.chunk_key, r.doc_version, r.heading, r.text);
  return rows.length;
}

export function getDocumentChunks(docKind, entityId, docVersion = null) {
  if (docVersion != null) {
    return db.prepare(`SELECT * FROM document_chunks WHERE doc_kind = ? AND entity_id = ? AND doc_version = ? ORDER BY chunk_index`).all(docKind, entityId, docVersion);
  }
  return db.prepare(`SELECT * FROM document_chunks WHERE doc_kind = ? AND entity_id = ? ORDER BY chunk_index`).all(docKind, entityId);
}

const insertSourceDocument = db.prepare(`
  INSERT INTO source_documents (doc_kind, entity_id, canonical_url, mime_type, document_title, content, content_hash, content_length, doc_version, fetched_at)
  VALUES (@doc_kind, @entity_id, @canonical_url, @mime_type, @document_title, @content, @content_hash, @content_length, @doc_version, @fetched_at)
`);
const getLatestSourceDocument = db.prepare(`
  SELECT * FROM source_documents WHERE doc_kind = ? AND entity_id = ? ORDER BY doc_version DESC, id DESC LIMIT 1
`);

/**
 * Speichert ein Rohdokument und erzeugt daraus strukturorientierte Chunks.
 * Bei identischem Inhalt-Hash wird die Version nicht erhöht.
 */
export function saveSourceDocument({ docKind, entityId, canonicalUrl, mimeType = 'text/html', documentTitle = null, content, replaceCurrent = false }) {
  const url = canonicalUrl || `${docKind}:${entityId ?? 'unknown'}`;
  const contentHash = createHash('sha256').update(String(content || '')).digest('hex');
  const latest = getLatestSourceDocument.get(docKind, entityId);
  if (replaceCurrent && latest) {
    db.prepare(`DELETE FROM source_documents WHERE doc_kind = ? AND entity_id = ?`).run(docKind, entityId);
    db.prepare(`DELETE FROM document_chunks WHERE doc_kind = ? AND entity_id = ?`).run(docKind, entityId);
  }
  let docVersion;
  if (!replaceCurrent && latest && latest.content_hash === contentHash) {
    return { docVersion: latest.doc_version, changed: false };
  }
  docVersion = replaceCurrent ? 1 : (latest ? latest.doc_version + 1 : 1);
  const fetchedAt = new Date().toISOString();
  insertSourceDocument.run({
    doc_kind: docKind,
    entity_id: entityId,
    canonical_url: url,
    mime_type: mimeType,
    document_title: documentTitle,
    content: content ?? null,
    content_hash: contentHash,
    content_length: String(content || '').length,
    doc_version: docVersion,
    fetched_at: fetchedAt,
  });
  const chunkCount = saveDocumentChunks(docKind, entityId, String(content || ''), { docVersion });
  return { docVersion, changed: true, chunkCount };
}

export function getSourceDocument(docKind, entityId) {
  return getLatestSourceDocument.get(docKind, entityId);
}

/**
 * Registriert oder liest ein Embedding-Modell.
 */
export function getOrCreateEmbeddingModel({ provider, model, dimensions = null, version = '1' }) {
  const existing = db.prepare(`SELECT * FROM embedding_models WHERE provider = ? AND model = ? AND version = ?`).get(provider, model, version);
  if (existing) return existing;
  const info = db.prepare(`INSERT INTO embedding_models (provider, model, dimensions, version, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
    .run(provider, model, dimensions, version, new Date().toISOString());
  return db.prepare(`SELECT * FROM embedding_models WHERE id = ?`).get(Number(info.lastInsertRowid));
}

/**
 * Aktualisiert search_text_full und Chunks nachträglich (für bestehende Daten).
 * Transaktional und ohne N+1 (Kind-Einträge werden gebündelt geladen).
 */
export function backfillSearchText() {
  return db.transaction(() => {
    let updated = 0;

    const tenders = db.prepare(`SELECT * FROM tenders`).all();
    const upTender = db.prepare(`UPDATE tenders SET search_text_full = ? WHERE id = ?`);
    for (const t of tenders) {
      const text = buildTenderSearchText({
        title: t.title,
        description: t.description,
        contractingAuthority: t.contracting_authority,
        cpvLabels: t.cpv_labels ? JSON.parse(t.cpv_labels) : null,
        placeOfPerformance: t.place_of_performance,
        bindingPeriod: t.binding_period,
        portalStatus: t.portal_status,
        llmSummary: t.llm_summary,
        llmRequirements: t.llm_requirements ? JSON.parse(t.llm_requirements) : null,
        awardCriteria: t.award_criteria,
      });
      upTender.run(text, t.id);
      saveSourceDocument({ docKind: 'tender', entityId: t.id, canonicalUrl: t.url, documentTitle: t.title, content: text, replaceCurrent: true });
      updated += 1;
    }

    const programs = db.prepare(`SELECT * FROM funding_programs`).all();
    const upProgram = db.prepare(`UPDATE funding_programs SET search_text_full = ? WHERE id = ?`);
    // Kind-Einträge einmalig gebündelt laden (vermeidet N+1 über getFundingProgramById)
    const byId = (rows) => rows.reduce((m, r) => { (m[r.program_id] = m[r.program_id] || []).push(r); return m; }, {});
    const deadlines = byId(db.prepare(`SELECT * FROM funding_deadlines`).all());
    const projectTypes = byId(db.prepare(`SELECT * FROM funding_project_types`).all());
    const eligibility = byId(db.prepare(`SELECT * FROM funding_eligibility`).all());
    const links = byId(db.prepare(`SELECT * FROM funding_links`).all());

    for (const p of programs) {
      const text = buildFundingSearchTextFull({
        title: p.title,
        currentCall: p.current_call,
        fundingGeber: p.funding_geber,
        fundingGeberShort: p.funding_geber_short,
        fundingGegenstand: p.funding_gegenstand,
        shortDescription: p.short_description,
        deadlines: deadlines[p.id] || [],
        projectTypes: projectTypes[p.id] || [],
        eligibility: eligibility[p.id] || [],
        links: links[p.id] || [],
      });
      upProgram.run(text, p.id);
      saveSourceDocument({ docKind: 'funding', entityId: p.id, canonicalUrl: p.primary_url, documentTitle: p.title, content: text });
      updated += 1;
    }

    rebuildFundingChunkFts();

    return updated;
  })();
}

// ── Crawl-Quellen (verwaltete Quellen für Förderungen & Ausschreibungen) ──

const insertCrawlSource = db.prepare(`
  INSERT INTO crawl_sources (source_key, name, region, url, declared_kind, access, format,
    search_params, list_item_selector, title_selector, link_selector, date_selector,
    detail_text_selector, rate_limit_rpm, state, priority, notes, created_at)
  VALUES (@source_key, @name, @region, @url, @declared_kind, @access, @format,
    @search_params, @list_item_selector, @title_selector, @link_selector, @date_selector,
    @detail_text_selector, @rate_limit_rpm, @state, @priority, @notes, @created_at)
`);

export function listCrawlSources({ declaredKind = null, access = null, state = null } = {}) {
  const conditions = [];
  const params = {};
  if (declaredKind) {
    conditions.push('declared_kind = @declared_kind');
    params.declared_kind = declaredKind;
  }
  if (access) {
    conditions.push('access = @access');
    params.access = access;
  }
  if (state) {
    conditions.push('state = @state');
    params.state = state;
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM crawl_sources ${where} ORDER BY priority, name`).all(params);
}

export function getCrawlSource(id) {
  return db.prepare(`SELECT * FROM crawl_sources WHERE id = ?`).get(id);
}

export function getCrawlSourceByKey(sourceKey) {
  return db.prepare(`SELECT * FROM crawl_sources WHERE source_key = ?`).get(sourceKey);
}

export function addCrawlSource({
  sourceKey,
  name,
  region = 'de',
  url,
  declaredKind = 'funding',
  access = 'http',
  format = 'html_list',
  searchParams = null,
  listItemSelector = null,
  titleSelector = null,
  linkSelector = null,
  dateSelector = null,
  detailTextSelector = null,
  rateLimitRpm = 10,
  state = 'unprobed',
  priority = 5,
  notes = null,
}) {
  const existing = getCrawlSourceByKey(sourceKey);
  if (existing) {
    return updateCrawlSource(existing.id, {
      name, region, url,
      declared_kind: declaredKind,
      access, format,
      search_params: searchParams,
      list_item_selector: listItemSelector,
      title_selector: titleSelector,
      link_selector: linkSelector,
      date_selector: dateSelector,
      detail_text_selector: detailTextSelector,
      rate_limit_rpm: rateLimitRpm,
      notes,
    });
  }
  const info = insertCrawlSource.run({
    source_key: sourceKey,
    name,
    region,
    url,
    declared_kind: declaredKind,
    access,
    format,
    search_params: searchParams ? JSON.stringify(searchParams) : null,
    list_item_selector: listItemSelector,
    title_selector: titleSelector,
    link_selector: linkSelector,
    date_selector: dateSelector,
    detail_text_selector: detailTextSelector,
    rate_limit_rpm: rateLimitRpm,
    state,
    priority,
    notes,
    created_at: new Date().toISOString(),
  });
  return getCrawlSource(Number(info.lastInsertRowid));
}

export function updateCrawlSource(id, patch) {
  const current = getCrawlSource(id);
  if (!current) return null;
  const allowed = ['name', 'region', 'url', 'declared_kind', 'access', 'format', 'search_params',
    'list_item_selector', 'title_selector', 'link_selector', 'date_selector',
    'detail_text_selector', 'rate_limit_rpm', 'state', 'priority', 'notes'];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = key === 'search_params' ? (patch[key] ? JSON.stringify(patch[key]) : null) : patch[key];
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE crawl_sources SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
  return getCrawlSource(id);
}

export function deleteCrawlSource(id) {
  return db.prepare(`DELETE FROM crawl_sources WHERE id = ?`).run(id).changes > 0;
}

/**
 * Stellt eine korrespondierende Zeile in `sources` sicher – erforderlich für
 * die FK von crawl_jobs.source_id bei verwalteten Browser-Quellen.
 */
export function ensureSourceRow({ id, name, region = 'de', type = 'browser', enabled = 0 }) {
  db.prepare(`INSERT OR IGNORE INTO sources (id, name, region, type, enabled, crawl_interval_min)
    VALUES (?, ?, ?, ?, ?, 1440)`).run(id, name, region, type, enabled ? 1 : 0);
  return getSource(id);
}

export function setCrawlSourceState(id, state, probeResult = {}) {
  const sets = ['state = @state'];
  const params = { id, state };
  for (const [key, value] of Object.entries(probeResult)) {
    if (value !== undefined && ['last_http_status', 'last_item_count', 'last_error_type', 'last_error', 'parser_version', 'last_crawl_at', 'last_success_at'].includes(key)) {
      sets.push(`${key} = @${key}`);
      params[key] = value;
    }
  }
  db.prepare(`UPDATE crawl_sources SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getCrawlSource(id);
}

export function recordSourceRun({
  sourceId,
  mode = 'probe',
  documentKind = null,
  httpStatus = null,
  itemsDiscovered = 0,
  itemsImported = 0,
  itemsRejected = 0,
  itemsClassifiedUnknown = 0,
  errorType = null,
  errorDetail = null,
  parserVersion = null,
  durationMs = null,
  startedAt = new Date().toISOString(),
  finishedAt = new Date().toISOString(),
}) {
  const info = db.prepare(`
    INSERT INTO crawl_source_runs (source_id, mode, document_kind, http_status, items_discovered,
      items_imported, items_rejected, items_classified_unknown, error_type, error_detail,
      parser_version, duration_ms, started_at, finished_at)
    VALUES (@source_id, @mode, @document_kind, @http_status, @items_discovered,
      @items_imported, @items_rejected, @items_classified_unknown, @error_type, @error_detail,
      @parser_version, @duration_ms, @started_at, @finished_at)
  `).run({
    source_id: sourceId,
    mode,
    document_kind: documentKind,
    http_status: httpStatus,
    items_discovered: itemsDiscovered,
    items_imported: itemsImported,
    items_rejected: itemsRejected,
    items_classified_unknown: itemsClassifiedUnknown,
    error_type: errorType,
    error_detail: errorDetail ? String(errorDetail).slice(0, 2000) : null,
    parser_version: parserVersion,
    duration_ms: durationMs,
    started_at: startedAt,
    finished_at: finishedAt,
  });
  return Number(info.lastInsertRowid);
}

export function getSourceRuns(sourceId, limit = 10) {
  return db.prepare(`SELECT * FROM crawl_source_runs WHERE source_id = ? ORDER BY id DESC LIMIT ?`).all(sourceId, limit);
}

/**
 * Einmalige Bereinigung des Förderbereichs: löscht alle Förderprogramme
 * samt Kindentitäten, Overrides, Logs, Inbox-/Rohdaten und entfernt alle
 * Förder-/Mixed-Quellen aus crawl_sources. Danach wird ausschließlich
 * Förderinfo als Förderquelle neu angelegt. Tender-Daten und Tender-Quellen
 * bleiben unverändert.
 * @param {{ backup?: boolean, backupPath?: string }} [opts]
 * @returns {Promise<{ deletedPrograms: number, deletedFundingSources: number, backupPath: string|null }>}
 */
export async function cleanupFundingData({ backup = true, backupPath = null } = {}) {
  let madeBackup = null;
  if (backup) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    madeBackup = backupPath || path.join(path.dirname(config.dbPath), `funding-cleanup-backup-${ts}.sqlite`);
    await db.backup(madeBackup);
    console.log(`[db] Sicherung erstellt: ${madeBackup}`);
  }

  const run = db.transaction(() => {
    const fundingSources = db.prepare(`SELECT id, source_key FROM crawl_sources WHERE declared_kind IN ('funding', 'mixed')`).all();

    const deletedPrograms = db.prepare(`DELETE FROM funding_programs`).run().changes;
    db.prepare(`DELETE FROM funding_crawl_log`).run();
    db.prepare(`DELETE FROM source_documents WHERE doc_kind = 'funding'`).run();
    db.prepare(`DELETE FROM document_chunks WHERE doc_kind = 'funding'`).run();

    // Inbox-Einträge und Runs verwaister Förderquellen (FK kaskadiert bereits,
    // hier zusätzlich defensiv bereinigt)
    for (const source of fundingSources) {
      db.prepare(`DELETE FROM discovered_documents WHERE source_id = ?`).run(source.id);
      db.prepare(`DELETE FROM crawl_source_runs WHERE source_id = ?`).run(source.id);
    }
    const deletedFundingSources = db.prepare(`DELETE FROM crawl_sources WHERE declared_kind IN ('funding', 'mixed')`).run().changes;
    for (const source of fundingSources) {
      db.prepare(`DELETE FROM sources WHERE id = ?`).run(source.source_key);
    }

    // Förderinfo als einzige Förderquelle neu anlegen
    addCrawlSource({
      sourceKey: 'foerderinfo',
      name: 'Förderberatung Forschung – Bekanntmachungen Bund',
      region: 'de',
      url: 'https://www.foerderinfo.bund.de/SiteGlobals/Forms/foerderinfo/bekanntmachungen/Bekanntmachungen_Formular.html?cl2Categories_Foerderer=bund',
      declaredKind: 'funding',
      access: 'http',
      format: 'html_list',
      rateLimitRpm: 8,
      priority: 1,
      notes: 'Exklusive Förderquelle; alle Bundes-Bekanntmachungen inkl. Volltext',
    });

    // FTS-Index neu aufbauen (Tabelle ist nach DELETE leer)
    db.exec(`INSERT INTO funding_programs_fts(funding_programs_fts) VALUES('rebuild')`);

    return { deletedPrograms, deletedFundingSources };
  })();

  return { ...run, backupPath: madeBackup };
}

/**
 * Setzt alle Tender-Crawls zurück: löscht sämtliche Ausschreibungen
 * (samt Änderungshistorie und LLM-Log via FK-Kaskade), den Crawl-Verlauf,
 * die Browser-Checkpoints und die Job-Queue – damit ein anschließender
 * Crawl vollständig neu (inkl. Backfill) startet.
 *
 * Die `sources`-Tabelle und Förderdaten bleiben erhalten.
 *
 * Beispiele:
 *   node src/cli-reset-crawls.js
 *   node src/cli-reset-crawls.js --no-backup
 */
export async function cleanupTenderData({ backup = true, backupPath = null, sourceId = null } = {}) {
  let madeBackup = null;
  if (backup) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    madeBackup = backupPath || path.join(path.dirname(config.dbPath), `tender-cleanup-backup-${ts}.sqlite`);
    await db.backup(madeBackup);
    console.log(`[db] Sicherung erstellt: ${madeBackup}`);
  }

  const run = db.transaction(() => {
    if (sourceId) {
      // Nur eine Quelle: Tender dieser Quelle + deren Checkpoint + Jobs
      const deletedTenders = db.prepare(`DELETE FROM tenders WHERE source_id = ?`).run(sourceId).changes;
      db.prepare(`DELETE FROM crawl_checkpoints WHERE source_id = ?`).run(sourceId);
      db.prepare(`DELETE FROM crawl_jobs WHERE source_id = ?`).run(sourceId);
      db.exec(`INSERT INTO tenders_fts(tenders_fts) VALUES('rebuild')`);
      return { deletedTenders };
    }
    // tender_changes + llm_log kaskadieren via FK ON DELETE CASCADE
    const deletedTenders = db.prepare(`DELETE FROM tenders`).run().changes;
    db.prepare(`DELETE FROM crawl_log`).run();
    db.prepare(`DELETE FROM crawl_checkpoints`).run();
    db.prepare(`DELETE FROM crawl_jobs`).run();
    // FTS-Index neu aufbauen (nach DELETE leer)
    db.exec(`INSERT INTO tenders_fts(tenders_fts) VALUES('rebuild')`);
    return { deletedTenders };
  })();

  return { ...run, backupPath: madeBackup };
}

// ── Entdeckte Dokumente (Inbox) ──────────────────────────────

export function addDiscoveredDocument({ sourceId, canonicalUrl, title = null, publicationDate = null, fingerprint = null }) {
  const existing = db.prepare(`SELECT * FROM discovered_documents WHERE canonical_url = ? AND fingerprint = ?`).get(canonicalUrl, fingerprint ?? '');
  if (existing) return existing;
  const info = db.prepare(`
    INSERT INTO discovered_documents (source_id, canonical_url, title, publication_date, fingerprint, status, created_at)
    VALUES (@source_id, @canonical_url, @title, @publication_date, @fingerprint, 'new', @created_at)
  `).run({
    source_id: sourceId,
    canonical_url: canonicalUrl,
    title,
    publication_date: publicationDate,
    fingerprint: fingerprint ?? '',
    created_at: new Date().toISOString(),
  });
  return db.prepare(`SELECT * FROM discovered_documents WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function listDiscoveredDocuments({ classification = null, status = null, limit = 50 } = {}) {
  const conditions = [];
  const params = {};
  if (classification) { conditions.push('classification = @classification'); params.classification = classification; }
  if (status) { conditions.push('status = @status'); params.status = status; }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM discovered_documents ${where} ORDER BY id DESC LIMIT @limit`).all({ ...params, limit });
}

export function getDiscoveredDocument(id) {
  return db.prepare(`SELECT * FROM discovered_documents WHERE id = ?`).get(id);
}

export function classifyDiscoveredDocument(id, { classification, confidence = null, reason = null }) {
  db.prepare(`UPDATE discovered_documents SET classification = ?, classification_confidence = ?, classification_reason = ? WHERE id = ?`)
    .run(classification, confidence, reason ? String(reason).slice(0, 500) : null, id);
  return db.prepare(`SELECT * FROM discovered_documents WHERE id = ?`).get(id);
}

export function linkDiscoveredDocument(id, { fundingId = null, tenderId = null, status = 'processed' }) {
  db.prepare(`UPDATE discovered_documents SET status = ?, target_funding_id = ?, target_tender_id = ? WHERE id = ?`)
    .run(status, fundingId, tenderId, id);
}

// ── Checkpoints ──────────────────────────────────────────────
export function getCheckpoint(sourceId) {
  const cp = stmts.getCheckpoint.get(sourceId);
  return cp || {
    source_id: sourceId,
    backfill_complete: 0,
    oldest_publication_date: null,
    last_page_key: null,
    last_success_at: null,
    known_page_streak: 0,
    updated_at: null,
  };
}

export function updateCheckpoint(sourceId, {
  backfillComplete,
  oldestPublicationDate,
  lastPageKey,
  knownPageStreak,
  lastSuccessAt = new Date().toISOString(),
} = {}) {
  const current = getCheckpoint(sourceId);
  stmts.upsertCheckpoint.run({
    source_id: sourceId,
    backfill_complete: backfillComplete ?? (current.backfill_complete ? 1 : 0),
    oldest_publication_date: oldestPublicationDate ?? current.oldest_publication_date,
    last_page_key: lastPageKey ?? current.last_page_key,
    last_success_at: lastSuccessAt,
    known_page_streak: knownPageStreak ?? current.known_page_streak,
    now: new Date().toISOString(),
  });
}

export default {
  db,
  saveTender,
  persistTenderDetailBundle,
  getTenderById,
  getTenderByExternalId,
  getTenderByPortalProject,
  getTenderBundleById,
  getDiscoveryCache,
  saveDiscoveryCache,
  getTenderChanges,
  getSources,
  getSource,
  updateSourceCrawlTime,
  startCrawlLog,
  finishCrawlLog,
  updateCrawlDetailMetrics,
  updateLlmAnalysis,
  logLlmAnalysis,
  countLlmAnalysesToday,
  getTendersForLlmAnalysis,
  createSavedSearch,
  updateSavedSearch,
  getSavedSearches,
  deleteSavedSearch,
  getTenderUserState,
  setTenderUserState,
  getSearchProfileCounts,
  getCrawlHistory,
  getStats,
  enqueueBrowserJob,
  hasActiveBrowserJob,
  getBrowserJobById,
  claimNextBrowserJob,
  updateJobProgress,
  completeBrowserJob,
  finishBrowserJob,
  requestCancelJob,
  recoverStaleJobs,
  getRecentJobs,
  getCheckpoint,
  updateCheckpoint,
  // Förderprogramme
  buildFundingSearchText,
  startFundingCrawlLog,
  finishFundingCrawlLog,
  getFundingCrawlHistory,
  saveFundingProgram,
  getFundingProgramById,
  fundingProgramExists,
  getFundingProgramByExternalId,
  getFundingStats,
  listFundingPrograms,
  searchFundingChatCandidates,
  searchFundingChatChunks,
  getFundingChatSource,
  setFundingOverride,
  deleteFundingOverride,
  confirmFundingProgram,
  // RAG-Vorbereitung
  buildTenderSearchText,
  buildFundingSearchTextFull,
  chunkText,
  makeChunkKey,
  saveDocumentChunks,
  getDocumentChunks,
  saveSourceDocument,
  getSourceDocument,
  getOrCreateEmbeddingModel,
  rebuildFundingChunkFts,
  backfillSearchText,
  // Crawl-Quellen
  listCrawlSources,
  getCrawlSource,
  getCrawlSourceByKey,
  addCrawlSource,
  updateCrawlSource,
  deleteCrawlSource,
  setCrawlSourceState,
  recordSourceRun,
  getSourceRuns,
  cleanupFundingData,
  cleanupTenderData,
  // Entdeckte Dokumente
  addDiscoveredDocument,
  listDiscoveredDocuments,
  getDiscoveredDocument,
  classifyDiscoveredDocument,
  linkDiscoveredDocument,
  stmts,
};
