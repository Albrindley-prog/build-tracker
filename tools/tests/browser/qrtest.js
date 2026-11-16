// Checks the QR code in the barcode pop-up: decodes it like a phone would, then follows the link as a phone would.
const { chromium } = require('playwright-core');
const jsQR = require('jsqr');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createMock } = require('./mock');

const { APP, PAGE_PATH, WEBSITE, COMPANY } = require('./page-config');
const LIVE = 'https://build-tracker.co.uk';
const HOST = process.env.TESTHOST || LIVE;          // set TESTHOST=http://localhost:8091 to view the page from a test address
// what the QR must contain: on the real site its own address, from a test address the real site
const VER = /const APP_VERSION = .([^']+)./.exec(require("fs").readFileSync(APP, "utf8"))[1];
const SCAN_BASE = HOST === LIVE ? `${LIVE}${PAGE_PATH}index.html` : `${LIVE}${PAGE_PATH}`;
const OUT = path.join(__dirname, 'shots2');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   ' + extra)); if (!cond) fails++; };

async function newPage(browser, mock, viewport, login = true, startUrl = HOST + PAGE_PATH + 'index.html') {
  const context = await browser.newContext({ viewport, locale: 'en-GB', deviceScaleFactor: viewport.width < 600 ? 2 : 1 });
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', mock.handler);
  for (const h of new Set([LIVE, HOST])) await context.route(h + '/**', r => {
    const u = new URL(r.request().url());
    return u.pathname.startsWith(PAGE_PATH) ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(APP) }) : r.fulfill({ status: 204 });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(startUrl, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}
const login = async page => {
  await page.fill('#loginEmail', 'demo@example.com'); await page.fill('#loginPass', 'x'); await page.click('#loginForm .auth-btn');
};

// decode the QR image the way a camera would see it: as plain pixels, optionally blurred and shrunk
async function decodeQr(page, { blur = 0, scale = 1 } = {}) {
  const px = await page.evaluate(({ blur, scale }) => {
    const img = document.querySelector('#bcQr img');
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas'); c.width = w + 60; c.height = h + 60;      // white margin around it
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.filter = `blur(${blur}px)`; x.drawImage(img, 30, 30, w, h);
    return { w: c.width, h: c.height, data: Array.from(x.getImageData(0, 0, c.width, c.height).data) };
  }, { blur, scale });
  const res = jsQR(Uint8ClampedArray.from(px.data), px.w, px.h);
  return res ? res.data : null;
}

(async () => {
  const mock = createMock(); const S = mock.state;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  // ── desktop: open the pop-up for the 3rd part
  const d = await newPage(browser, mock, { width: 1280, height: 860 });
  await login(d.page);
  await d.page.locator('#stockBody tr').first().waitFor();
  const row = d.page.locator('#stockBody tr').nth(2);
  const name = (await row.locator('td').first().textContent()).trim();
  const item = S.stock.find(s => s.name === name);
  await row.locator('.btn-icon.bar').click();
  await d.page.locator('#bcQr img').waitFor();
  await sleep(300);
  await d.page.screenshot({ path: path.join(OUT, '12-barcode-and-qr.png') });

  const want = `${SCAN_BASE}?item=${item.id}&v=${VER}`;
  const got = await decodeQr(d.page);
  check('QR decodes to this part\'s link', got === want, `got ${got}`);
  check('QR still decodes when blurred and shrunk (camera-like)', (await decodeQr(d.page, { blur: 1.2, scale: 0.7 })) === want);
  check('barcode still drawn', (await d.page.locator('#bcSvg rect').count()) > 5);
  check('pop-up fits the screen (no scroll needed)', await d.page.evaluate(() => { const b = document.querySelector('#barcodeOverlay .bc-box'); return b.scrollHeight <= b.clientHeight + 1; }));
  check('no page errors (desktop)', d.errors.length === 0, d.errors.join(' | '));

  // switching to another part gives that part's own QR
  await d.page.click('#barcodeOverlay .btn-ghost');
  await d.page.locator('#stockBody tr').nth(3).locator('.btn-icon.bar').click(); await sleep(300);
  const name2 = (await d.page.textContent('#bcItemName')).trim(); const item2 = S.stock.find(s => s.name === name2);
  check('second part has its own, different QR', (await decodeQr(d.page)) === `${SCAN_BASE}?item=${item2.id}&v=${VER}` && item2.id !== item.id);

  // ── phone: follow the link from the QR code while signed out, as a fresh phone browser would
  const p = await newPage(browser, mock, { width: 390, height: 844 }, false, got);
  check('phone opens on the sign-in screen first', await p.page.locator('#authScreen').isVisible());
  await login(p.page);
  await p.page.locator('#scanFound').waitFor({ state: 'visible', timeout: 15000 });
  check('after signing in the phone shows the scanned part', (await p.page.textContent('#scanItemName')).trim() === name, await p.page.textContent('#scanItemName'));
  const before = item.qty;
  await p.page.fill('#scanQty', '2'); await p.page.click('#scanBtnIn'); await p.page.click('button:has-text("Confirm")');
  await sleep(900);
  check('phone can book 2 in from the QR page', S.stock.find(s => s.id === item.id).qty === before + 2, 'qty=' + S.stock.find(s => s.id === item.id).qty);
  await p.page.screenshot({ path: path.join(OUT, '13-phone-after-qr.png') });
  check('no page errors (phone)', p.errors.length === 0, p.errors.join(' | '));

  // ── phone-sized pop-up
  const m = await newPage(browser, mock, { width: 390, height: 844 });
  await login(m.page); await m.page.locator('#stockBody tr').first().waitFor();
  await m.page.locator('#stockBody tr').nth(1).locator('.btn-icon.bar').click(); await sleep(400);
  await m.page.screenshot({ path: path.join(OUT, '14-barcode-and-qr-mobile.png') });
  check('phone: pop-up has no sideways scroll', await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  await browser.close();
})().catch(e => { console.error(e); process.exit(2); });
