import { db } from './src/db.js';

const bySource = db.prepare(`
  SELECT source_id, COUNT(*) AS n,
         SUM(CASE WHEN cpv_codes IS NOT NULL THEN 1 ELSE 0 END) AS with_cpv
  FROM tenders GROUP BY source_id ORDER BY n DESC
`).all();
const total = db.prepare('SELECT COUNT(*) c FROM tenders').get().c;
const jobs = db.prepare("SELECT id, source_id, status, pages_done, items_new, items_changed FROM crawl_jobs ORDER BY id DESC LIMIT 8").all();
const logs = db.prepare("SELECT id, source_id, status, items_new, items_changed, errors FROM crawl_log ORDER BY id DESC LIMIT 8").all();

console.log('TOTAL tenders:', total);
console.log('BY SOURCE:');
for (const r of bySource) console.log(`  ${r.source_id}: ${r.n} (CPV: ${r.with_cpv})`);
console.log('JOBS:'); for (const j of jobs) console.log('  ', JSON.stringify(j));
console.log('LOGS:'); for (const l of logs) console.log('  ', JSON.stringify(l));
