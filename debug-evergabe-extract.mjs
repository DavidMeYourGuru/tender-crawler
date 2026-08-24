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
    const cpvCodes = []; const cpvLabels = [];
    const re = /CPV-Codes?\s*(?:Hauptteil\s*\([^)]*\))?\s*:\s*([^\n(]+?)\s*\((\d{8}(?:-\d)?)\)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const label = m[1].replace(/\s+/g, ' ').trim();
      const code = m[2];
      if (code) cpvCodes.push(code);
      if (label) cpvLabels.push(label);
    }
    return { cpvCodes, cpvLabels, snippet: text.replace(/\s+/g,' ').slice(0, 400) };
  });
  console.log('RESULT:', JSON.stringify(r, null, 2));
} finally {
  await context.close().catch(() => {});
}
