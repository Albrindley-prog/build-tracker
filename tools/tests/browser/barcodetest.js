// Barcode type: standard Code 128 or Code 39 (* at each end); the barcode is decoded back from its picture to prove it reads;
// a gun that sends the stars still finds the part; labels follow the choice.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createMock } = require('./mock');
const { APP, PAGE_PATH, WEBSITE, COMPANY } = require('./page-config'); const HOST = 'https://build-tracker.co.uk';
const SHOTS = path.join(__dirname, 'shots2');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   ' + extra)); if (!cond) fails++; };
const PARTS = [['Hex Bolt M10', 'HB-1', 170, 0.18], ['Brake Pad Set', 'ab-2', 12, 24.5], ['Widget & Co', 'AB&CO', 3, 1], ['Rubber Seal', '13.25', 40, 0.9]];

async function boot(browser, viewport = { width: 1280, height: 900 }) {
  const mock = createMock(), S = mock.state, O = mock.OWNER;
  S.stock.length = 0; PARTS.forEach(([name, sku, qty, cost]) => S.stock.push({ id: crypto.randomUUID(), owner_id: O, user_id: O, name, sku, qty, cost, location: 'Aisle 1', sell_price: 1, reorder_level: 2 }));
  const ctx = await browser.newContext({ viewport, locale: 'en-GB' });
  await ctx.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', r => mock.handler(r));
  await ctx.route(HOST + '/**', r => new URL(r.request().url()).pathname.startsWith(PAGE_PATH) ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(APP) }) : r.fulfill({ status: 204 }));
  const page = await ctx.newPage(); const errors = [], dialogs = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.goto(HOST + PAGE_PATH + 'index.html', { waitUntil: 'load' });
  await page.fill('#loginEmail', 'demo@example.com'); await page.fill('#loginPass', 'x'); await page.click('#loginForm .auth-btn');
  await page.locator('#stockBody tr').first().waitFor(); await sleep(900);
  return { ctx, page, S, errors, dialogs };
}
// draw the barcode picture, then read it back with the same decoder the camera uses
const decode = (page, svgSel, format) => page.evaluate(async ([sel, fmt]) => {
  const svg = document.querySelector(sel);
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); await img.decode();
  const c = document.createElement('canvas'), k = 2; c.width = img.naturalWidth * k; c.height = img.naturalHeight * k;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  let host = document.getElementById('tmpReader'); if (!host) { host = document.createElement('div'); host.id = 'tmpReader'; host.style.display = 'none'; document.body.appendChild(host); }
  const f = Html5QrcodeSupportedFormats;
  const reader = new Html5Qrcode('tmpReader', { verbose: false, formatsToSupport: [f[fmt]] });
  try { return await reader.scanFile(new File([blob], 'b.png', { type: 'image/png' }), false); } catch (e) { return 'ERR ' + ((e && e.message) || e); }
}, [svgSel, format]);
const svgText = (page, sel) => page.evaluate(s => [...document.querySelector(s).querySelectorAll('text')].map(t => t.textContent).join(' '), sel);
const open = async (page, sku) => { await page.locator('#stockBody tr', { hasText: sku }).first().locator('.btn-icon.bar').click(); await page.locator('#barcodeOverlay.open').waitFor(); await sleep(250); };
const closeModal = page => page.click('#barcodeOverlay button:has-text("Close")');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let t = await boot(browser); let { page } = t;

  console.log('\n— standard barcode (as before) —');
  await open(page, 'HB-1');
  check('default is the standard barcode, with no stars', (await page.inputValue('#bcType')) === 'code128' && (await svgText(page, '#bcSvg')).trim() === 'HB-1', await svgText(page, '#bcSvg'));
  check('it decodes back to HB-1 as Code 128', (await decode(page, '#bcSvg', 'CODE_128')) === 'HB-1');

  console.log('\n— Code 39 with a * at each end —');
  await page.selectOption('#bcType', 'code39'); await sleep(300);
  check('switching redraws it with the stars printed under the bars: *HB-1*', (await svgText(page, '#bcSvg')).trim() === '*HB-1*', await svgText(page, '#bcSvg'));
  check('it decodes back to HB-1 as Code 39 (the decoder strips the start/stop stars)', (await decode(page, '#bcSvg', 'CODE_39')) === 'HB-1');
  check('and it is NOT readable as Code 128 any more (so it really is a different barcode)', (await decode(page, '#bcSvg', 'CODE_128')) !== 'HB-1');
  check('the choice is remembered in this browser', (await page.evaluate(() => localStorage.getItem('pdsc_barcodetype_v1'))) === 'code39');
  check('the Labels box beside Print labels follows', (await page.inputValue('#bcTypeLabels')) === 'code39');
  await page.screenshot({ path: path.join(SHOTS, 'bc-01-code39-modal.png') });
  await closeModal(page);

  await open(page, 'ab-2');
  check('a lower-case code is capitalised for Code 39: *AB-2*, and still reads', (await svgText(page, '#bcSvg')).trim() === '*AB-2*' && (await decode(page, '#bcSvg', 'CODE_39')) === 'AB-2', await svgText(page, '#bcSvg'));
  await closeModal(page);
  await open(page, '13.25');
  check('a code with a dot works: *13.25*', (await svgText(page, '#bcSvg')).trim() === '*13.25*' && (await decode(page, '#bcSvg', 'CODE_39')) === '13.25');
  check('no warning for those', await page.locator('#bcNote').isHidden());
  await closeModal(page);
  await open(page, 'AB&CO');
  check('a code with "&" cannot be Code 39: standard barcode shown instead, with a note', (await svgText(page, '#bcSvg')).trim() === 'AB&CO' && await page.locator('#bcNote').isVisible() && (await decode(page, '#bcSvg', 'CODE_128')) === 'AB&CO', await svgText(page, '#bcSvg'));
  await closeModal(page);

  console.log('\n— scanning a gun that sends the stars —');
  await page.fill('#scanBox', '*HB-1*'); await page.press('#scanBox', 'Enter');
  await page.locator('#scanScreen').waitFor({ state: 'visible' });
  check('scanning *HB-1* finds Hex Bolt M10', /Hex Bolt M10/.test(await page.textContent('#scanScreen')), (await page.textContent('#scanScreen')).slice(0, 120));
  await page.evaluate(() => { document.getElementById('scanScreen').style.display = 'none'; document.getElementById('appScreen').style.display = 'block'; });
  const found = await page.evaluate(() => ({ plain: !!findBySku('HB-1'), stars: !!findBySku('*HB-1*'), starsLower: !!findBySku('*ab-2*'), lone: !!findBySku('**'), none: !!findBySku('*NOPE*') }));
  check('lookup: plain, starred and lower-case starred codes find their part; "**" and unknown starred codes find nothing', found.plain && found.stars && found.starsLower && !found.lone && !found.none, JSON.stringify(found));

  console.log('\n— labels —');
  await page.evaluate(() => { window.__sheet = null; window.print = () => { window.__sheet = document.getElementById('labelSheet').innerHTML; }; });
  await page.click('button:has-text("Print labels")'); await sleep(500);
  const sheet = await page.evaluate(() => window.__sheet || '');
  check('the label sheet uses Code 39: *HB-1* *AB-2* *13.25* under the bars', /\*HB-1\*/.test(sheet) && /\*AB-2\*/.test(sheet) && /\*13\.25\*/.test(sheet));
  check('it says one label (AB&CO) has a standard barcode instead', /1 label has a standard barcode/.test(t.dialogs[t.dialogs.length - 1] || ''), t.dialogs[t.dialogs.length - 1]);
  await page.selectOption('#bcTypeLabels', 'code128'); await sleep(200);
  await page.click('button:has-text("Print labels")'); await sleep(500);
  const sheet2 = await page.evaluate(() => window.__sheet || '');
  check('switch back to standard: labels have no stars', !/\*HB-1\*/.test(sheet2) && /HB-1/.test(sheet2));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();

  console.log('\n— phone —');
  t = await boot(browser, { width: 390, height: 844 }); page = t.page;
  const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone: the new box beside Print labels causes no sideways scroll', w <= 1, 'overflow ' + w);
  await page.locator('#bcTypeLabels').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'bc-02-phone-tools.png') });
  await open(page, 'HB-1'); await page.selectOption('#bcType', 'code39'); await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'bc-03-phone-modal.png') });
  const w2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone: the barcode pop-up fits', w2 <= 1, 'overflow ' + w2);
  check('phone: no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
})().catch(e => { console.error(e); process.exit(2); });
