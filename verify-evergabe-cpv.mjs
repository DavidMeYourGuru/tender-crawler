import { db } from './src/db.js';
import * as evergabe from './src/portals/evergabe.js';

const row = db.prepare("SELECT url FROM tenders WHERE source_id='evergabe' LIMIT 1").get();
if (!row) { console.log('Kein evergabe-Tender gefunden'); process.exit(1); }
console.log('Teste URL:', row.url);
const detail = await evergabe.fetchDetail(row.url);
console.log('Detail CPV-Codes:', JSON.stringify(detail?.cpvCodes));
console.log('Detail CPV-Labels:', JSON.stringify(detail?.cpvLabels));
console.log('Detail description vorhanden:', !!detail?.description);
