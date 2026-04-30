import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`PAGE_ERROR: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`CONSOLE_ERROR: ${m.text()}`); });

await page.goto('http://localhost:5174', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const result = await page.evaluate(() => {
  const w = window;
  const game = w.__game ?? w.game ?? null;
  const sculptor = game?.energySculptor ?? game?.sculptor ?? null;
  return {
    hasGame: !!game,
    hasSculptor: !!sculptor,
    keys: game ? Object.keys(game).slice(0, 30) : null,
    winKeys: Object.keys(w).filter(k => /game|sculpt|energy|jam/i.test(k)),
  };
});
console.log(JSON.stringify(result, null, 2));
console.log('Errors:', errors.length);
errors.forEach(e => console.log(e));
await browser.close();
