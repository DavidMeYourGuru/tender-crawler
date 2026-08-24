import { chromium } from 'playwright';
import path from 'node:path';
import config from './src/config.js';

const profileDir = path.join(config.browserProfileDir, 'evergabe');
const url = 'https://www.evergabe-online.de/tenderdetails.html?id=884991';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  locale: 'de-DE',
  userAgent: config.userAgent,
});
try {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const idx = text.toLowerCase().indexOf('cpv');
    return {
      title: document.title,
      hasLogin: /Anmeldung|ELSTER|Benutzername/i.test(text),
      cpvContext: idx >= 0 ? text.slice(Math.max(0, idx - 60), idx + 120).replace(/\s+/g, ' ') : null,
      bodySnippet: text.replace(/\s+/g, ' ').slice(0, 300),
    };
  });
  console.log(JSON.stringify(info, null, 2));
} finally {
  await context.close().catch(() => {});
}
