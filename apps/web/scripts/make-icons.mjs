// Renders public/icon.svg to the PNG sizes that iOS and installers need.
//
//   node scripts/make-icons.mjs
//
// Uses the system Chrome through Playwright, so no image tools are required.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const chrome = process.env.CHROME_PATH ?? '/usr/local/bin/chrome';
const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');

const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    const png = await page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), png);
    console.log(`wrote icon-${size}.png (${png.length} bytes)`);
    await page.close();
  }
} finally {
  await browser.close();
}
