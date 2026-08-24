import { chromium } from 'playwright';
import path from 'node:path';
import config from './src/config.js';

const profileDir = path.join(config.browserProfileDir, 'evergabe');
const url = 'https://www.evergabe-online.de/tenderdetails.html?id=884991';
const context = await chromium.launchPersistentContext(profileDir, {
  headless: true, locale: 'de-DE', userAgent: config.userAgent,
});
try {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(config.browserPageWaitMs);
  const r = await page.evaluate(() => {
    const full = document.body.textContent || '';
    const i = full.indexOf('CPV');
    const around = full.slice(i - 5, i + 250).replace(/\s+/g, ' ');
    // Suche nach Elementen, die "73000000" enthalten
    const els = [...document.querySelectorAll('*')].filter(el => el.children.length === 0 && /73000000/.test(el.textContent));
    return {
      around,
      textContentHasCpv: i >= 0,
      leafWithCode: els.slice(0, 3).map(e => e.textContent.replace(/\s+/g,' ').trim()),
      iframeCount: document.querySelectorAll('iframe').length,
    };
  });
  console.log(JSON.stringify(r, null, 2));
} finally {
  await context.close().catch(() => {});
}
