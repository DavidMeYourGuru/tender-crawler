import pkg from '/home/tender-crawler/node_modules/playwright/index.js';
const { chromium } = pkg;
const b = await chromium.launch({ headless: true });
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('https://www.zim.de/ZIM/Redaktion/DE/Artikel/international-aktuelle-ausschreibungen.html', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1500);

const found = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('a').forEach((a) => {
    const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const href = a.getAttribute('href') || '';
    if (/deutsch.?franz|franz.?deutsch/i.test(t) || /Deutsch-Franz/i.test(href) || /ausschreib/i.test(t)) {
      out.push({ t: t.slice(0, 90), href: href.slice(0, 200) });
    }
  });
  return out;
});
console.log('Treffer:', found.length);
found.slice(0, 25).forEach((f) => console.log('  ', JSON.stringify(f)));

console.log('--- Überschriften ---');
const heads = await page.evaluate(() => Array.from(document.querySelectorAll('h2,h3,h4')).map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
heads.slice(0, 25).forEach((h) => console.log('  ', h.slice(0, 90)));
await b.close();
