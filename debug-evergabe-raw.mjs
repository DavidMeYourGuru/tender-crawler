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
    const text = document.body.innerText || '';
    const i = text.indexOf('CPV');
    return {
      before: JSON.stringify(text.slice(i - 10, i + 200)),
      hasLogin: /ANMELDEN|Benutzername/i.test(text),
    };
  });
  console.log(JSON.stringify(r, null, 2));
} finally {
  await context.close().catch(() => {});
}
