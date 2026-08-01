/**
 * Kanonischer Quellenkatalog für Förderungen und Ausschreibungen.
 *
 * Jeder Eintrag wird beim Start in `crawl_sources` registriert (idempotent
 * über source_key). `declared_kind`: 'funding' | 'tender' | 'mixed'.
 * `access`: 'http' | 'browser'. `format`: 'html_list' | 'html_search' |
 * 'single_page' | 'rss' | 'json_api'.
 *
 * Förderbereich: Exklusiv Förderinfo (foerderinfo.bund.de) als einzige
 * Förderquelle. Alle sonstigen Förder-/Mixed-Quellen wurden entfernt.
 * Verbleibend sind ausschließlich Tender-Quellen für die Vergabe-Discovery.
 */

export const SOURCE_CATALOG = [
  // ── Zentrale Förderportale ──────────────────────────────────
  { sourceKey: 'foerderinfo', name: 'Förderberatung Forschung – Bekanntmachungen Bund', region: 'de', url: 'https://www.foerderinfo.bund.de/SiteGlobals/Forms/foerderinfo/bekanntmachungen/Bekanntmachungen_Formular.html?cl2Categories_Foerderer=bund', declaredKind: 'funding', access: 'http', format: 'html_list', priority: 1, notes: 'Exklusive Förderquelle; alle Bundes-Bekanntmachungen inkl. Volltext' },

  // ── Ausschreibungen (Vergabe-Discovery) ────────────────────
  { sourceKey: 'zim-ausschreibungen', name: 'ZIM – aktuelle internationale Ausschreibungen', region: 'de', url: 'https://www.zim.de/ZIM/Redaktion/DE/Artikel/international-aktuelle-ausschreibungen.html', declaredKind: 'tender', access: 'http', format: 'html_list', priority: 2 },
  { sourceKey: 'bbsr-ausschreibungen', name: 'BBSR – aktuelle Ausschreibungen', region: 'de', url: 'https://www.bbsr.bund.de/BBSR/DE/forschung/ausschreibungen/_node.html', declaredKind: 'tender', access: 'http', format: 'html_list', priority: 3 },
  { sourceKey: 'bayfor-ausschreibungen', name: 'BayFOR – aktuelle Ausschreibungen', region: 'bayern', url: 'https://www.bayfor.org/de/aktuelles/ausschreibungen.html', declaredKind: 'tender', access: 'http', format: 'html_list', priority: 3 },
];

export const SOURCE_STATE_LABELS = {
  unprobed: 'Ungeprüft',
  active: 'Aktiv',
  blocked: 'Blockiert',
  needs_config: 'Konfig nötig',
  disabled: 'Deaktiviert',
};
