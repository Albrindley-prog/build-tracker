// Low stock tile: click it to see which parts are low (most urgent first), click a part to find it, jump to Reorder.
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

// name, sku, qty, level (null = none)
const PARTS = [
  ['Hex Bolt M10 x 50mm', 'HB-1', 3, 10],
  ['Hex Nut M10', 'HN-1', 50, 20],
  ['Washer M10 Zinc', 'WS-1', 5, null],
  ['PVC Pipe 110mm x 3m', 'PV-1', 12, 10],
  ['Copper Pipe 15mm x 3m', 'CP-1', 40, null],
];
async function boot(browser, { viewport = { width: 1280, height: 900 }, allFine = false, noReorder = false } = {}) {
  const mock = createMock({ missingReorder: noReorder }), S = mock.state, O = mock.OWNER;
  S.stock.length = 0;
  PARTS.forEach(([name, sku, qty, level]) => { const row = { id: crypto.randomUUID(), owner_id: O, user_id: O, name, sku, qty: allFine ? qty + 500 : qty, cost: 1, location: 'Aisle 1', sell_price: 2 }; if (!noReorder && level !== null) row.reorder_level = level; S.stock.push(row); });
  if (!allFine) {
    const pv = S.stock.find(s => s.sku === 'PV-1'), hb = S.stock.find(s => s.sku === 'HB-1');
    // PV-1: 12 in stock but 5 reserved for a customer, so only 7 are free (≤ level 10) → low
    const ord = { id: crypto.randomUUID(), owner_id: O, user_id: O, order_no: 1, customer: 'Smith', reference: null, status: 'open', created_at: new Date().toISOString() };
    S.orders.push(ord); S.orderLines.push({ id: crypto.randomUUID(), order_id: ord.id, owner_id: O, stock_id: pv.id, sku: 'PV-1', name: pv.name, qty: 5 });
    // HB-1 has 20 on order from a supplier
    const po = { id: crypto.randomUUID(), owner_id: O, user_id: O, po_no: 1, supplier: 'Fixings Direct', status: 'open', notes: null, total: 20, created_at: new Date().toISOString() };
    S.pos.push(po); S.poLines.push({ id: crypto.randomUUID(), po_id: po.id, owner_id: O, stock_id: hb.id, sku: 'HB-1', name: hb.name, qty_ordered: 20, qty_received: 0, unit_cost: 1 });
  }
  const ctx = await browser.newContext({ viewport, locale: 'en-GB', deviceScaleFactor: viewport.width < 600 ? 2 : 1 });
  await ctx.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', r => mock.handler(r));
  await ctx.route(HOST + '/**', r => new URL(r.request().url()).pathname.startsWith(PAGE_PATH) ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(APP) }) : r.fulfill({ status: 204 }));
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(HOST + PAGE_PATH + 'index.html', { waitUntil: 'load' });
  await page.fill('#loginEmail', 'demo@example.com'); await page.fill('#loginPass', 'x'); await page.click('#loginForm .auth-btn');
  await page.locator('#stockBody tr').first().waitFor(); await sleep(1200);
  return { ctx, page, S, errors };
}
const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim());

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let t = await boot(browser); let { page } = t;

  console.log('\n— the tile —');
  check('the tile says 3 are low and invites a click', (await text(page, '#lowStock')) === '3' && /Click to see which/.test(await text(page, '#lowStockCard')), await text(page, '#lowStockCard'));
  check('it is a button you can reach with the keyboard', (await page.getAttribute('#lowStockCard', 'role')) === 'button' && (await page.getAttribute('#lowStockCard', 'tabindex')) === '0');
  check('the cursor becomes a hand over it', (await page.evaluate(() => getComputedStyle(document.getElementById('lowStockCard')).cursor)) === 'pointer');

  console.log('\n— the list —');
  await page.click('#lowStockCard'); await page.locator('#lowOverlay.open').waitFor(); await sleep(200);
  const rows = await page.locator('#lowBody tbody tr').allTextContents();
  const clean = rows.map(r => r.replace(/\s+/g, ' ').trim());
  check('heading says 3 parts', /Low stock — 3 parts/.test(await text(page, '#lowBody h3')), await text(page, '#lowBody h3'));
  check('exactly the three low parts are listed, nothing else', rows.length === 3 && !clean.some(r => /Hex Nut|Copper/.test(r)), clean.join(' | '));
  check('most urgent first: Hex Bolt (3 vs level 10), PVC Pipe (7 free vs 10), Washer (5 vs standard 5)', /Hex Bolt/.test(clean[0]) && /PVC Pipe/.test(clean[1]) && /Washer/.test(clean[2]), clean.join(' | '));
  check('Hex Bolt shows 3 in stock, level 10, 20 on order', /3 10 20/.test(clean[0].replace(/HB-1 · Aisle 1/, '').replace(/Hex Bolt M10 x 50mm/, '').trim()) || (/\b3\b/.test(clean[0]) && /\b10\b/.test(clean[0]) && /\b20\b/.test(clean[0])), clean[0]);
  check('PVC Pipe shows 12 in stock with "5 reserved" (that is why it is low)', /12/.test(clean[1]) && /5 reserved/.test(clean[1]), clean[1]);
  check('Washer, which has no level, says 5 (standard)', /5 \(standard\)/.test(clean[2]), clean[2]);
  check('the note explains the rule and mentions reserved stock', /reorder level/.test(await text(page, '#lowBody')) && /reserved for customer orders does not count/.test(await text(page, '#lowBody')));
  await page.screenshot({ path: path.join(SHOTS, 'low-01-list.png') });

  console.log('\n— clicking a part —');
  await page.click('#lowBody tbody tr:has-text("PVC Pipe")'); await sleep(500);
  check('the pop-up closes and the stock list is filtered to that part', await page.locator('#lowOverlay.open').count() === 0 && (await page.inputValue('#stockSearch')) === 'PV-1' && (await page.locator('#stockBody tr').count()) === 1 && /PVC Pipe/.test(await text(page, '#stockBody')), await text(page, '#stockBody'));
  await page.fill('#stockSearch', ''); await page.evaluate(() => onStockSearch(''));

  console.log('\n— from the keyboard and onwards to Reorder —');
  await page.focus('#lowStockCard'); await page.keyboard.press('Enter'); await page.locator('#lowOverlay.open').waitFor();
  check('Enter on the focused tile opens it too', true);
  await page.click('#lowBody button:has-text("See what to order")');
  await page.locator('#reorderScreen').waitFor({ state: 'visible' });
  check('"See what to order" closes the list and opens the Reorder screen', await page.locator('#lowOverlay.open').count() === 0 && await page.locator('#reorderScreen').isVisible());
  check('the Reorder screen\'s own red tile is not made clickable', (await page.evaluate(() => getComputedStyle(document.querySelector('#rdStats .stat-card.low')).cursor)) !== 'pointer');
  await page.click('button:visible:has-text("← Back to dashboard")');
  await page.click('#lowStockCard'); await page.locator('#lowOverlay.open').waitFor(); await page.click('#lowBody button:has-text("Close")');
  check('Close just closes it', await page.locator('#lowOverlay.open').count() === 0);
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();

  console.log('\n— when nothing is low —');
  t = await boot(browser, { allFine: true }); page = t.page;
  check('the tile shows 0', (await text(page, '#lowStock')) === '0');
  await page.click('#lowStockCard'); await page.locator('#lowOverlay.open').waitFor();
  check('it says nothing is low, no table and no Reorder button', /Nothing is low/.test(await text(page, '#lowBody')) && (await page.locator('#lowBody table').count()) === 0 && (await page.locator('#lowBody button:has-text("See what to order")').count()) === 0, await text(page, '#lowBody'));
  await t.ctx.close();

  console.log('\n— reorder set-up not run (levels unavailable) —');
  t = await boot(browser, { noReorder: true }); page = t.page;
  await page.click('#lowStockCard'); await page.locator('#lowOverlay.open').waitFor();
  check('still lists parts with 5 or fewer (the old rule), and no Reorder button', (await page.locator('#lowBody tbody tr').count()) === 2 && (await page.locator('#lowBody button:has-text("See what to order")').count()) === 0, await text(page, '#lowBody'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();

  console.log('\n— phone —');
  t = await boot(browser, { viewport: { width: 390, height: 844 } }); page = t.page;
  await page.click('#lowStockCard'); await page.locator('#lowOverlay.open').waitFor(); await sleep(300);
  const w = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const tableOverflow = await page.evaluate(() => { const s = document.querySelector('#lowBody .table-scroll'); return s.scrollWidth - s.clientWidth; });
  check('phone: no sideways page scroll', w <= 1, 'overflow ' + w);
  check('phone: the list fits inside the pop-up without sideways scrolling', tableOverflow <= 1, 'table overflow ' + tableOverflow);
  await page.screenshot({ path: path.join(SHOTS, 'low-02-phone.png') });
  check('phone: no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
})().catch(e => { console.error(e); process.exit(2); });
