// The homepage after the Stock Control price change: no sideways scroll at phone and desktop width, the new price and the tailored
// offer are visible, and choosing Stock Control in the sign-up list takes you to its page instead of the shared £32 payment link.
// Run: node tools/tests/browser/homepage-layout.test.js     (screenshots go to tools/tests/browser/shots2/)
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { createMock } = require('./mock');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SHOTS = path.join(__dirname, 'shots2'); fs.mkdirSync(SHOTS, { recursive: true });
const HOST = 'https://build-tracker.co.uk';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   ' + extra)); if (!cond) fails++; };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

async function open(browser, viewport) {
  const mock = createMock();
  const context = await browser.newContext({ viewport, locale: 'en-GB', deviceScaleFactor: viewport.width < 600 ? 2 : 1 });
  const popups = [];
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', r => mock.handler(r));
  await context.route(HOST + '/**', r => {
    let p = decodeURIComponent(new URL(r.request().url()).pathname); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 204 });
    return r.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  await context.route('https://buy.stripe.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'payment link' }));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  context.on('page', p => popups.push(p.url()));
  page.on('dialog', d => d.accept());
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready); await sleep(600);
  return { context, page, errors, popups };
}
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    console.log(`\n— ${name} —`);
    const t = await open(browser, vp), { page } = t;
    check(`${name}: no sideways scroll`, (await overflow(page)) <= 1, 'overflow ' + (await overflow(page)));
    const card = page.locator('a.tool-link[href="stock-control/index.html"]').first();
    await card.scrollIntoViewIfNeeded();
    check(`${name}: the Stock Control card shows the tailored offer`, /From £300 a month/.test(await card.textContent()) && await card.getByText('From £300 a month').isVisible());
    await page.screenshot({ path: path.join(SHOTS, `home-${name}-card.png`) });
    const note = page.locator('#pricing p.price-note', { hasText: 'Stock Control is £99 a month' });
    await note.scrollIntoViewIfNeeded(); await sleep(300);
    check(`${name}: the pricing section says Stock Control is £99 a month and links email and phone`, await note.isVisible() && (await note.locator('a[href^="mailto:"]').count()) === 1 && (await note.locator('a[href^="tel:"]').count()) === 1);
    check(`${name}: the pricing note fits inside the screen`, await note.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth + 1; }));
    await page.screenshot({ path: path.join(SHOTS, `home-${name}-pricing.png`) });
    check(`${name}: no page errors`, t.errors.length === 0, t.errors.join(' | '));
    await t.context.close();
  }

  console.log('\n— choosing Stock Control in the sign-up list —');
  {
    const t = await open(browser, { width: 1280, height: 900 }), { page } = t;
    const option = page.locator('.option-item', { hasText: 'Inventory & suppliers' });
    check('the list line reads £99/month (approx. $133)', /£99\/month/.test(await option.textContent()) && /approx\. \$133/.test(await option.textContent()), await option.textContent());
    await page.evaluate(() => { document.querySelectorAll('.popup').forEach(p => p.style.display = ''); });
    await Promise.all([page.waitForURL(/\/stock-control\/index\.html/, { timeout: 8000 }), option.evaluate(el => el.click())]);
    check('it opens the Stock Control page, not the £32 payment link', /\/stock-control\/index\.html/.test(page.url()) && !t.popups.some(u => /buy\.stripe\.com/.test(u)), page.url() + ' ' + t.popups.join(','));
    await t.context.close();
  }

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
