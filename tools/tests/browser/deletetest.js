// Delete a sale from the Sales screen (owner only, puts the parts back first, needs the database step), and the logo in every top bar.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createMock } = require('./mock');

const { APP, PAGE_PATH, WEBSITE, COMPANY } = require('./page-config');
const HOST = 'https://build-tracker.co.uk';
const SHOTS = path.join(__dirname, 'shots2'); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   ' + extra)); if (!cond) fails++; };
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

const PARTS = [
  ['Hex Bolt M10 x 50mm', 'HB-1', 170, 0.18, 'Aisle A - Bay 1', 0.40],
  ['Hex Nut M10', 'HN-1', 490, 0.06, 'Aisle A - Bay 1', 0.15],
];
async function boot({ mock = createMock(), viewport = { width: 1280, height: 900 }, browser, staff = false } = {}) {
  const S = mock.state, O = mock.OWNER;
  S.stock.length = 0;
  PARTS.forEach(([name, sku, qty, cost, location, sell]) => S.stock.push({ id: crypto.randomUUID(), owner_id: O, user_id: O, name, sku, qty, cost, location, sell_price: sell, reorder_level: 5 }));
  const context = await browser.newContext({ viewport, locale: 'en-GB', deviceScaleFactor: viewport.width < 600 ? 2 : 1 });
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', async route => {
    if (staff && new URL(route.request().url()).pathname.endsWith('/rest/v1/sc_team_members')) return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify([{ role: 'staff' }]) });
    return mock.handler(route);
  });
  await context.route(HOST + '/**', r => new URL(r.request().url()).pathname.startsWith(PAGE_PATH)
    ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(APP) }) : r.fulfill({ status: 204 }));
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.goto(HOST + PAGE_PATH + 'index.html', { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.fill('#loginEmail', 'demo@example.com'); await page.fill('#loginPass', 'x'); await page.click('#loginForm .auth-btn');
  await page.locator('#appScreen').waitFor({ state: 'visible' });
  await page.locator('#stockBody tr').first().waitFor(); await sleep(800);
  return { context, page, mock, S, errors, dialogs };
}
const part = (S, sku) => S.stock.find(s => s.sku === sku);
const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim());
async function makeSale(t, qty) {
  const { page } = t;
  await page.click('#sellStartBtn'); await page.locator('#sellScreen').waitFor({ state: 'visible' });
  await page.fill('#sellScan', 'HB-1'); await page.press('#sellScan', 'Enter');
  const q = page.locator('#sellBasket .qty-ctl input'); await q.fill(String(qty)); await q.press('Tab');
  await page.click('#sellCompleteBtn');
  await page.locator('#sellBody h3:has-text("complete")').waitFor(); await sleep(400);
  await page.click('#sellBody button:has-text("New sale")');
  await page.click('button:visible:has-text("← Back to dashboard")'); await sleep(300);
}
async function openSales(page) { await page.click('#salesListBtn'); await page.locator('#salesScreen').waitFor({ state: 'visible' }); await sleep(500); }
const lastDialog = t => t.dialogs[t.dialogs.length - 1] || '';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  // ── the logo in every top bar
  console.log('\n— the logo in every corner —');
  let t = await boot({ browser }); let { page, S } = t;
  const logoOk = async (screenId) => WEBSITE ? page.evaluate(id => { const el = document.querySelector('#' + id + ' .topbar .brand-mark'); const r = el && el.getBoundingClientRect(); return r && r.width > 20 && !document.querySelector('#' + id + ' .brand-logo') ? 'ok' : 'missing'; }, screenId) : page.evaluate(id => { const el = document.querySelector('#' + id + ' .brand-logo'); if (!el) return 'missing'; const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 100 && r.height > 20 && /data:image\/png/.test(cs.backgroundImage) ? 'ok' : 'bad ' + r.width + 'x' + r.height; }, screenId);
  check('dashboard top bar has the logo', (await logoOk('appScreen')) === 'ok');
  await page.click('#salesListBtn'); await page.locator('#salesScreen').waitFor({ state: 'visible' });
  check('Sales screen top bar has the logo (not the barcode icon)', (await logoOk('salesScreen')) === 'ok' && (WEBSITE || (await page.locator('#salesScreen .brand-mark').count()) === 0) && /Sales/.test(await text(page, '#salesScreen .brand-name')));
  await page.screenshot({ path: path.join(SHOTS, 'del-01-sales-empty.png'), clip: { x: 0, y: 0, width: 1280, height: 330 } });
  await page.click('button:visible:has-text("← Back to dashboard")');
  await page.click('#sellStartBtn'); await page.locator('#sellScreen').waitFor({ state: 'visible' });
  check('Sell screen has the logo', (await logoOk('sellScreen')) === 'ok');
  await page.click('button:visible:has-text("← Back to dashboard")');
  await page.click('#reorderBtn'); await page.locator('#reorderScreen').waitFor({ state: 'visible' });
  check('Reorder screen has the logo', (await logoOk('reorderScreen')) === 'ok');
  await page.click('button:visible:has-text("← Back to dashboard")');
  await page.click('#ordersBtn').catch(() => {});
  if (await page.locator('#ordersScreen').isVisible()) { check('Customer orders screen has the logo', (await logoOk('ordersScreen')) === 'ok'); await page.click('button:visible:has-text("← Back to dashboard")'); }
  else check('Customer orders screen has the logo (screen shows only once the stillage step is run — checked in markup)', (await page.locator(WEBSITE ? '#ordersScreen .topbar .brand-mark' : '#ordersScreen .brand-logo').count()) === 1);
  await page.click('#stockTakeStartBtn'); await page.locator('#stockTakeOverlay.open').waitFor(); await page.click('#stGoBtn'); await page.locator('#stockTakeScreen').waitFor({ state: 'visible' });
  check('Stock take screen has the logo', (await logoOk('stockTakeScreen')) === 'ok');
  await page.click('#stockTakeScreen button:has-text("Back")').catch(() => {});
  await t.context.close();

  // ── deleting a completed sale
  console.log('\n— deleting a completed sale —');
  t = await boot({ browser }); ({ page, S } = t);
  await makeSale(t, 3);
  check('a sale of 3 was made: stock 170 → 167', part(S, 'HB-1').qty === 167 && S.sales.length === 1);
  await openSales(page);
  check('the owner sees a delete button on the sale\'s row', (await page.locator('#salesBody tr .btn-icon.del').count()) === 1);
  await page.screenshot({ path: path.join(SHOTS, 'del-02-sales-row.png'), clip: { x: 0, y: 0, width: 1280, height: 520 } });
  // say no first
  page.removeAllListeners('dialog'); const noMsgs = []; page.once('dialog', d => { noMsgs.push(d.message()); d.dismiss(); });
  await page.click('#salesBody tr .btn-icon.del'); await sleep(600);
  check('pressing Cancel on the question changes nothing', /Delete sale 1 completely/.test(noMsgs[0] || '') && S.sales.length === 1 && S.sales[0].status === 'completed' && part(S, 'HB-1').qty === 167, noMsgs[0]);
  page.on('dialog', d => { t.dialogs.push(d.message()); d.accept(); });
  await page.click('#salesBody tr .btn-icon.del'); await sleep(1200);
  check('the question explains: parts go back, gone from Sales and Sage, use Void to keep a record', /parts go back into stock/.test(lastDialog(t)) && /Sage export/.test(lastDialog(t)) && /Void/.test(lastDialog(t)), lastDialog(t));
  check('deleted: the sale and its lines are gone from the database', S.sales.length === 0 && S.saleLines.length === 0);
  check('the parts went back: stock 167 → 170', part(S, 'HB-1').qty === 170, String(part(S, 'HB-1').qty));
  check('the Movement Log shows the parts coming back (VOID)', S.logs.some(l => l.action === 'VOID' && l.qty === 3));
  check('the Sales list no longer shows it', /No sales in this period/.test(await text(page, '#salesBody')), await text(page, '#salesBody'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));

  // ── deleting a voided sale
  console.log('\n— deleting a voided sale —');
  await page.click('button:visible:has-text("← Back to dashboard")'); await sleep(300);
  await makeSale(t, 2);
  await openSales(page);
  await page.click('#salesBody tr:has-text("Cash sale")'); await page.locator('#sellBody h3:has-text("Sale")').waitFor();
  check('the sale pop-up has Void and Delete buttons for the owner', (await page.locator('#sellBody button:has-text("Void this sale")').count()) === 1 && (await page.locator('#sellBody button:has-text("Delete…")').count()) === 1);
  await page.click('#sellBody button:has-text("Void this sale")'); await sleep(1200);
  check('voided: parts back (170) and the sale is kept as Voided', part(S, 'HB-1').qty === 170 && S.sales.length === 1 && S.sales[0].status === 'voided');
  await page.click('#salesBody tr:has-text("Voided")'); await page.locator('#sellBody h3:has-text("voided")').waitFor();
  check('a voided sale\'s pop-up has no Void button but still has Delete', (await page.locator('#sellBody button:has-text("Void this sale")').count()) === 0 && (await page.locator('#sellBody button:has-text("Delete…")').count()) === 1);
  const before = part(S, 'HB-1').qty;
  await page.click('#sellBody button:has-text("Delete…")'); await sleep(1200);
  check('deleting a voided sale says stock is not touched', /Delete voided sale/.test(lastDialog(t)) && /Stock isn't touched/.test(lastDialog(t)), lastDialog(t));
  check('the voided sale is gone and stock stayed put', S.sales.length === 0 && S.saleLines.length === 0 && part(S, 'HB-1').qty === before);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── staff cannot delete
  console.log('\n— staff —');
  t = await boot({ browser, staff: true }); ({ page, S } = t);
  await makeSale(t, 1);
  await openSales(page);
  check('a staff login sees no delete button in the list', (await page.locator('#salesBody tr').count()) === 1 && (await page.locator('#salesBody .btn-icon.del').count()) === 0);
  await page.click('#salesBody tr'); await page.locator('#sellBody h3:has-text("Sale")').waitFor();
  check('…and none in the sale pop-up (Void is still there)', (await page.locator('#sellBody button:has-text("Delete…")').count()) === 0 && (await page.locator('#sellBody button:has-text("Void this sale")').count()) === 1);
  await t.context.close();

  // ── the database step has not been run
  console.log('\n— database step not run —');
  t = await boot({ browser, mock: createMock({ noSaleDelete: true }) }); ({ page, S } = t);
  await makeSale(t, 2);
  await openSales(page);
  await page.click('#salesBody .btn-icon.del'); await sleep(1000);
  check('it says to run migration-sales-delete.sql', /migration-sales-delete\.sql/.test(lastDialog(t)), lastDialog(t));
  check('and nothing was changed: still completed, stock still 168', S.sales.length === 1 && S.sales[0].status === 'completed' && part(S, 'HB-1').qty === 168, `${S.sales.length} ${S.sales[0] && S.sales[0].status} ${part(S, 'HB-1').qty}`);
  await t.context.close();

  // ── phone: every top bar fits
  console.log('\n— phone —');
  t = await boot({ browser, viewport: { width: 390, height: 844 } }); ({ page, S } = t);
  const overflow = async name => { const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); check('phone: ' + name + ' has no sideways scroll', w <= 1, 'overflow ' + w); };
  await makeSale(t, 1);
  await openSales(page); await overflow('Sales'); await page.screenshot({ path: path.join(SHOTS, 'del-03-phone-sales.png'), clip: { x: 0, y: 0, width: 390, height: 640 } });
  await page.click('button:visible:has-text("← Back to dashboard")');
  await page.click('#sellStartBtn'); await page.locator('#sellScreen').waitFor({ state: 'visible' }); await overflow('Sell'); await page.screenshot({ path: path.join(SHOTS, 'del-04-phone-sell.png'), clip: { x: 0, y: 0, width: 390, height: 400 } });
  const bar = await page.evaluate(() => { const b = document.querySelector('#sellScreen .topbar'); const r = [...b.children].map(c => c.getBoundingClientRect()); return { right: Math.max(...r.map(x => x.right)), vw: innerWidth, wrapped: b.scrollWidth > b.clientWidth + 1 }; });
  check('phone: Sell top bar (logo + two buttons) fits on one row', !bar.wrapped && bar.right <= bar.vw, JSON.stringify(bar));
  await page.click('button:visible:has-text("← Back to dashboard")');
  await page.click('#reorderBtn'); await page.locator('#reorderScreen').waitFor({ state: 'visible' }); await overflow('Reorder');
  check('phone: no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
})().catch(e => { console.error(e); process.exit(2); });
