import { getWithRedirects } from './src/crawler/http-client.js';
import * as cheerio from 'cheerio';

const url = 'https://www.evergabe-online.de/tenderdetails.html?id=884991';
const res = await getWithRedirects(url);
const $ = cheerio.load(res.data);
const text = $('body').text();
// Zeige alle Vorkommen von "CPV" mit Kontext
const idxs = [];
let i = text.toLowerCase().indexOf('cpv');
while (i !== -1) {
  idxs.push(text.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' '));
  i = text.toLowerCase().indexOf('cpv', i + 1);
}
console.log('CPV-Vorkommen:', idxs.length);
for (const s of idxs.slice(0, 10)) console.log('  …', s, '…');
console.log('--- first 600 chars of body text ---');
console.log(text.replace(/\s+/g, ' ').slice(0, 600));
