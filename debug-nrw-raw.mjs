import { httpClient } from './src/crawler/http-client.js';
import config from './src/config.js';

const SHOW_TABLE_URL = 'https://www.evergabe.nrw.de/VMPCenter/company/announcements/categoryOverview.do?method=showTable';
const CPVS = ['45000000-7','71220000-6','71400000-0','77300000-3','80000000-4','92000000-1'];

for (const cpv of CPVS) {
  try {
    const res = await httpClient.get(`${SHOW_TABLE_URL}&cpvCode=${cpv}`, { maxRedirects: 5 });
    const html = String(res.data);
    const rows = (html.match(/<tr/gi) || []).length;
    console.log(`${cpv}: ${rows} <tr>-Tags im HTML`);
  } catch (e) {
    console.log(`${cpv}: FEHLER ${e.message}`);
  }
  await new Promise(r => setTimeout(r, config.requestDelayMs));
}
