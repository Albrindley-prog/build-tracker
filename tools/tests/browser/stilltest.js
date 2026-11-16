// Stillages & customer orders: setting up stillages, placing parts, setting parts aside for an order, selling around
// the reservation, selling an order, cancelling, stillage counts coming down with stock, goods in, backup/restore,
// the set-up-missing case, and the phone layout.
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

// name, sku, qty, cost, location, level, supplier, sell price
const PARTS = [
  ['Hex Bolt M10 x 50mm', 'HB-1', 170, 0.18, 'Aisle A - Bay 1', 200, 'Fixings Direct', 0.40],
  ['Hex Nut M10', 'HN-1', 490, 0.06, 'Aisle A - Bay 1', 100, 'Fixings Direct', 0.15],
  ['Washer M10 Zinc', 'WS-1', 82, 0.03, 'Aisle A - Bay 2', 50, 'Fixings Direct', 0.08],
  ['Wall Plug Red', 'WP-1', 3, 0.10, 'Aisle A - Bay 3', 2, null, 0.25],
  ['PVC Pipe 110mm x 3m', 'PV-1', 8, 18.75, 'Yard - Rack 2', 2, 'Plumb Supplies', 30],
];

async function boot({ mock = createMock(), viewport = { width: 1280, height: 900 }, browser, seed } = {}) {
  const S = mock.state, O = mock.OWNER;
  S.stock.length = 0;
  PARTS.forEach(([name, sku, qty, cost, location, level, supplier, sell]) => {
    const row = { id: crypto.randomUUID(), owner_id: O, user_id: O, name, sku, qty, cost, location, reorder_level: level, sell_price: sell };
    if (supplier) row.supplier = supplier;
    S.stock.push(row);
  });
  if (seed) seed(S, O);
  browser = browser || await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport, locale: 'en-GB', deviceScaleFactor: viewport.width < 600 ? 2 : 1, acceptDownloads: true });
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', route => mock.handler(route));
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
  return { browser, context, page, mock, S, errors, dialogs };
}
const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim());
const part = (S, sku) => S.stock.find(s => s.sku === sku);
const rowOf = (page, sku) => page.locator('#stockBody tr', { hasText: sku });
const stillageRows = (S, sku) => S.stillageStock.filter(r => r.stock_id === part(S, sku).id).map(r => ({ name: S.stillages.find(s => s.id === r.stillage_id).name, qty: Number(r.qty) })).sort((a, b) => b.qty - a.qty);
const stillageId = (S, name) => S.stillages.find(s => s.name === name).id;
const lastDialog = t => t.dialogs[t.dialogs.length - 1] || '';
async function placeIn(t, sku, map) { // map: { 'Cage A': 100, ... }
  await rowOf(t.page, sku).locator('.stl-cell').click();
  await t.page.locator('#slBody h3:has-text("Where is")').waitFor();
  for (const [name, qty] of Object.entries(map)) await t.page.fill('#slIn-' + stillageId(t.S, name), String(qty));
  await t.page.click('#slPartSave');
  await t.page.waitForFunction(() => !document.getElementById('slOverlay').classList.contains('open'));
  await sleep(300);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const t = await boot({ browser, seed: (S, O) => {
    S.pos.push({ id: crypto.randomUUID(), owner_id: O, user_id: O, po_no: 1, supplier: 'Fixings Direct', status: 'open', notes: null, total: 1.6, created_at: new Date().toISOString() });
  } });
  const { page, S } = t;
  const po = S.pos[0];
  S.poLines.push({ id: crypto.randomUUID(), po_id: po.id, owner_id: S.pos[0].owner_id, stock_id: part(S, 'WS-1').id, sku: 'WS-1', name: 'Washer M10 Zinc', qty_ordered: 20, qty_received: 0, unit_cost: 0.08 });

  // ── 1. setting up the stillages
  console.log('\n— setting up the stillages —');
  check('dashboard card invites you to set up stillages', /Set up your stillages/.test(await text(page, '#stillageBlurb')), await text(page, '#stillageBlurb'));
  check('its button says "Set up stillages"', (await text(page, '#stillagesBtn')) === 'Set up stillages');
  check('no Stillages column in the stock list yet', !(await page.locator('#thStillages').isVisible()));
  await page.click('#stillagesBtn'); await page.locator('#slOverlay.open').waitFor();
  check('it asks how many stillages you have, with 6 pre-selected', /How many stillages do you have/.test(await text(page, '#slBody')) && (await page.inputValue('#slHowMany')) === '6');
  await page.click('button:has-text("Create them")');
  await page.locator('#slBody input[value="Stillage 6"]').waitFor();
  check('six stillages were created, in order', S.stillages.length === 6 && S.stillages.map(s => s.name).join() === 'Stillage 1,Stillage 2,Stillage 3,Stillage 4,Stillage 5,Stillage 6' && S.stillages.every(s => s.active), S.stillages.map(s => s.name).join());
  const first = page.locator('#slBody table input').first();
  await first.fill('Cage A'); await first.press('Tab'); await sleep(500);
  check('a stillage can be renamed', S.stillages[0].name === 'Cage A' && (await page.locator('#slBody input[value="Cage A"]').count()) === 1);
  const second = page.locator('#slBody table input').nth(1);
  await second.fill('cage a'); await second.press('Tab'); await sleep(400);
  check('a duplicate name is refused, nothing changed', /already a stillage called/.test(lastDialog(t)) && S.stillages[1].name === 'Stillage 2', lastDialog(t));
  await page.fill('#slNewName', 'Stillage 7'); await page.click('button:has-text("Add it")'); await sleep(500);
  check('another stillage can be added', S.stillages.length === 7 && S.stillages[6].name === 'Stillage 7' && S.stillages[6].sort_order === 7);
  await page.screenshot({ path: path.join(SHOTS, 'st-01-manage.png') });
  await page.click('#slBody .btn-primary:has-text("Done")');
  check('card now counts the stillages', /^7 stillages\./.test(await text(page, '#stillageBlurb')), await text(page, '#stillageBlurb'));
  check('the Stillages column has appeared, every part says Allocate', (await page.locator('#thStillages').isVisible()) && (await page.locator('#stockBody .stl-add').count()) === 5);

  // ── 2. placing parts in stillages
  console.log('\n— placing parts in stillages —');
  await rowOf(page, 'HB-1').locator('.stl-cell').click();
  await page.locator('#slBody h3:has-text("Where is")').waitFor();
  check('the pop-up names the part and its stock', /Where is Hex Bolt/.test(await text(page, '#slBody')) && /170/.test(await text(page, '#slBody h3 + p')), await text(page, '#slBody'));
  await page.fill('#slIn-' + stillageId(S, 'Cage A'), '100');
  await page.fill('#slIn-' + stillageId(S, 'Stillage 2'), '50');
  check('summary adds it up: 150 placed, 20 not placed', /In stillages: 150 · not placed in a stillage: 20 · in stock: 170/.test(await text(page, '#slPartSum')), await text(page, '#slPartSum'));
  await page.fill('#slIn-' + stillageId(S, 'Stillage 3'), '30');
  check('too many (180 of 170) is refused and Save is off', /30 more than the 170|10 more than the 170/.test(await text(page, '#slPartSum')) && await page.locator('#slPartSave').isDisabled(), await text(page, '#slPartSum'));
  await page.fill('#slIn-' + stillageId(S, 'Stillage 3'), '');
  await page.click('#slBody tr:has-text("Stillage 3") button:has-text("All the rest")');
  check('"All the rest" fills in the 20 left', (await page.inputValue('#slIn-' + stillageId(S, 'Stillage 3'))) === '20');
  await page.fill('#slIn-' + stillageId(S, 'Stillage 3'), '');
  await page.click('#slPartSave');
  await page.waitForFunction(() => !document.getElementById('slOverlay').classList.contains('open'));
  await sleep(300);
  check('saved: Cage A 100 and Stillage 2 50', JSON.stringify(stillageRows(S, 'HB-1')) === JSON.stringify([{ name: 'Cage A', qty: 100 }, { name: 'Stillage 2', qty: 50 }]), JSON.stringify(stillageRows(S, 'HB-1')));
  const cell = await text(page, '#stockBody tr:has-text("HB-1") .stl-cell');
  check('the stock list shows the chips and the 20 not placed', /Cage A · 100/.test(cell) && /Stillage 2 · 50/.test(cell) && /20 not placed/.test(cell), cell);
  check('part quantity itself did not change', part(S, 'HB-1').qty === 170);

  await placeIn(t, 'HN-1', { 'Stillage 4': 490 });
  await placeIn(t, 'WP-1', { 'Cage A': 3 });
  await page.fill('#stockSearch', 'Stillage 4'); await sleep(400);
  check('searching a stillage name finds the parts in it', (await page.locator('#stockBody tr').count()) === 1 && /HN-1/.test(await text(page, '#stockBody')), await text(page, '#stockBody'));
  await page.fill('#stockSearch', '');
  await sleep(300);

  // hiding and showing
  await page.click('#stillagesBtn'); await page.locator('#slOverlay.open').waitFor();
  check('manage list says what is in each stillage', /1 part · 490 in all/.test(await text(page, '#slBody tr:has(input[value="Stillage 4"])')), await text(page, '#slBody tr:has(input[value="Stillage 4"])'));
  await page.click('#slBody tr:has(input[value="Stillage 7"]) button:has-text("Hide")'); await sleep(500);
  check('an empty stillage hides without asking', !S.stillages.find(s => s.name === 'Stillage 7').active);
  await page.click('#slBody tr:has(input[value="Stillage 4"]) button:has-text("Hide")'); await sleep(600);
  check('hiding one with parts asks first, then sends them back to "not placed"', /Hide Stillage 4/.test(lastDialog(t)) && !S.stillages.find(s => s.name === 'Stillage 4').active && stillageRows(S, 'HN-1').length === 0 && part(S, 'HN-1').qty === 490, lastDialog(t));
  await page.click('#slBody tr:has(input[value="Stillage 4"]) button:has-text("Show again")'); await sleep(500);
  check('a hidden stillage can be shown again', S.stillages.find(s => s.name === 'Stillage 4').active);
  await page.click('#slBody .btn-primary:has-text("Done")');
  await placeIn(t, 'HN-1', { 'Stillage 4': 490 });

  // ── 3. customer orders
  console.log('\n— customer orders —');
  const lowBefore = Number(await text(page, '#lowStock'));
  await page.click('#ordersBtn'); await page.locator('#ordersScreen').waitFor({ state: 'visible' }); await sleep(400);
  check('the orders screen starts empty, with a hint', /No customer orders are open/.test(await text(page, '#coListBody')), await text(page, '#coListBody'));
  await page.click('button:has-text("New order")'); await page.locator('#coCust').waitFor();
  check('Save is off until there is a customer and a part', await page.locator('#coSaveBtn').isDisabled());
  await page.fill('#coCust', 'Smith Plumbing'); await page.fill('#coRef', 'PO 7731');
  await page.fill('#coScan', 'HB-1'); await page.press('#coScan', 'Enter');
  await page.locator('#coLines input[type=number]').fill('120'); await page.press('#coLines input[type=number]', 'Tab');
  check('line shows qty 120 and the stock note', (await page.inputValue('#coLines input[type=number]')) === '120' && /170 in stock/.test(await text(page, '#coLines')), await text(page, '#coLines'));
  await page.fill('#coScan', 'WP-1'); await page.press('#coScan', 'Enter');
  const wp = page.locator('#coLines tr', { hasText: 'WP-1' }).locator('input[type=number]');
  await wp.fill('5'); await wp.press('Tab');
  check('asking for more than is free is refused with the reason', await page.locator('#coSaveBtn').isDisabled() && /Wall Plug Red: only 3 free/.test(await text(page, '#coProblem')), await text(page, '#coProblem'));
  await wp.fill('2'); await wp.press('Tab');
  check('lowered to 2: the button is ready and says what it does', !(await page.locator('#coSaveBtn').isDisabled()) && (await text(page, '#coSaveBtn')) === 'Set 2 parts aside', await text(page, '#coSaveBtn'));
  await page.screenshot({ path: path.join(SHOTS, 'st-02-order-editor.png') });
  await page.click('#coSaveBtn');
  await page.locator('#orderBody h3:has-text("ORD-0001")').waitFor(); await sleep(300);
  const o1 = S.orders[0];
  check('order ORD-0001 saved as open with its two lines', S.orders.length === 1 && o1.order_no === 1 && o1.status === 'open' && o1.customer === 'Smith Plumbing' && o1.reference === 'PO 7731' && S.orderLines.length === 2, JSON.stringify(o1));
  const detail = await text(page, '#orderBody');
  check('the order shows each part with where it is (stillage chips)', /Cage A · 100/.test(detail) && /Stillage 2 · 50/.test(detail) && /Cage A · 3/.test(detail) && /set aside for this customer/.test(detail), detail);
  await page.screenshot({ path: path.join(SHOTS, 'st-03-order-detail.png') });
  await page.click('#orderBody button:has-text("Close")');
  check('it appears in the list as Open with 2 parts · 122', /ORD-0001/.test(await text(page, '#coListBody')) && /2 parts · 122/.test(await text(page, '#coListBody')) && /Open/.test(await text(page, '#coListBody')), await text(page, '#coListBody'));

  // a second customer wants more than is free
  await page.click('button:has-text("New order")'); await page.locator('#coCust').waitFor();
  await page.fill('#coCust', 'Jones Builders');
  await page.fill('#coScan', 'HB-1'); await page.press('#coScan', 'Enter');
  const hb = page.locator('#coLines input[type=number]');
  await hb.fill('60'); await hb.press('Tab');
  check('only 50 of the 170 Hex Bolts are free after Smith\'s 120', await page.locator('#coSaveBtn').isDisabled() && /only 50 free/.test(await text(page, '#coProblem')) && /120 set aside for other orders/.test(await text(page, '#coLines')), await text(page, '#coProblem') + ' | ' + await text(page, '#coLines'));
  await page.fill('#coScan', 'HB-1'); await page.press('#coScan', 'Enter'); // adds one more, line is now 61 — still refused
  await hb.fill('0'); await hb.press('Tab');
  await page.click('#coLines button.del');
  await page.fill('#coScan', 'HN-1'); await page.press('#coScan', 'Enter');
  const hn = page.locator('#coLines input[type=number]'); await hn.fill('450'); await hn.press('Tab');
  await page.click('#coSaveBtn');
  await page.locator('#orderBody h3:has-text("ORD-0002")').waitFor(); await sleep(300);
  check('Jones Builders\' order (450 nuts) saved as ORD-0002', S.orders.length === 2 && S.orders[1].order_no === 2 && S.orders[1].customer === 'Jones Builders');
  await page.click('#orderBody button:has-text("Close")');
  await page.click('button:visible:has-text("← Back to dashboard")'); await sleep(400);
  check('dashboard card counts 2 open orders and 572 units set aside', /2 open customer orders holding 572 units/.test(await text(page, '#stillageBlurb')), await text(page, '#stillageBlurb'));
  check('stock list shows 120 reserved on the bolts', /120 reserved/.test(await text(page, '#stockBody tr:has-text("HB-1")')), await text(page, '#stockBody tr:has-text("HB-1")'));
  check('Low stock counts free stock: the nuts (40 free ≤ 100) and plugs (1 free ≤ 2) join the bolts', Number(await text(page, '#lowStock')) === lowBefore + 2 && (await rowOf(page, 'HN-1').locator('.qty-badge.low').count()) === 1, `${lowBefore} -> ${await text(page, '#lowStock')}`);
  await page.screenshot({ path: path.join(SHOTS, 'st-00-dashboard.png'), fullPage: true });
  check('on-hand quantities are unchanged by reserving', part(S, 'HB-1').qty === 170 && part(S, 'HN-1').qty === 490);
  await page.click('#reorderBtn'); await page.locator('#reorderScreen').waitFor({ state: 'visible' }); await sleep(400);
  check('Hex Nut is on the To order list, showing 40 free', /Hex Nut M10/.test(await text(page, '#rdBody')) && /40 free/.test(await text(page, '#rdBody')), await text(page, '#rdBody'));
  await page.click('button:visible:has-text("← Back to dashboard")'); await sleep(300);

  // ── 4. selling around a reservation
  console.log('\n— selling around a reservation —');
  await page.click('#sellStartBtn'); await page.locator('#sellScreen').waitFor({ state: 'visible' });
  await page.fill('#sellScan', 'HB-1'); await page.press('#sellScan', 'Enter');
  const sq = page.locator('#sellBasket .qty-ctl input'); await sq.fill('100'); await sq.press('Tab');
  check('selling 100 of 170 when 120 are set aside is blocked, saying why', await page.locator('#sellCompleteBtn').isDisabled() && /only 50 free — 120 set aside for customer orders/.test(await text(page, '#sellProblem')), await text(page, '#sellProblem'));
  check('the basket line warns in red too', /Only 50 free/.test(await text(page, '#sellBasket')), await text(page, '#sellBasket'));
  await sq.fill('40'); await sq.press('Tab');
  check('40 is fine, and the Take from box starts on the biggest stillage (Cage A)', !(await page.locator('#sellCompleteBtn').isDisabled()) && (await page.locator('#sellBasket select.stl-from').inputValue()) === stillageId(S, 'Cage A'));
  await page.selectOption('#sellBasket select.stl-from', stillageId(S, 'Stillage 2'));
  await page.screenshot({ path: path.join(SHOTS, 'st-04-sell-takefrom.png') });
  await page.click('#sellCompleteBtn');
  await page.locator('#sellBody h3:has-text("Sale 1 complete")').waitFor(); await sleep(400);
  check('sale 1 taken: stock 170 → 130', part(S, 'HB-1').qty === 130);
  check('and it came out of Stillage 2 as chosen (50 → 10), Cage A untouched', JSON.stringify(stillageRows(S, 'HB-1')) === JSON.stringify([{ name: 'Cage A', qty: 100 }, { name: 'Stillage 2', qty: 10 }]), JSON.stringify(stillageRows(S, 'HB-1')));
  await page.click('#sellBody button:has-text("New sale")');

  // ── 5. selling the order itself
  console.log('\n— selling an order —');
  await page.click('button:visible:has-text("← Back to dashboard")'); await sleep(300);
  await page.click('#ordersBtn'); await page.locator('#ordersScreen').waitFor({ state: 'visible' }); await sleep(400);
  await page.click('#coListBody tr:has-text("ORD-0001")');
  await page.locator('#orderBody h3:has-text("ORD-0001")').waitFor();
  await page.click('#orderBody button:has-text("Sell this order")');
  await page.locator('#sellScreen').waitFor({ state: 'visible' }); await sleep(300);
  const sum = await text(page, '#sellSummary');
  check('the sell screen is filled from the order: customer, reference, banner', /ORD-0001/.test(sum) && (await page.inputValue('#sellSummary input[placeholder="e.g. Smith Plumbing"]')) === 'Smith Plumbing' && (await page.evaluate(() => sale.reference)) === 'PO 7731' && (await page.locator('#sellBasket tr', { hasText: 'HB-1' }).count()) === 1, sum);
  check('the order\'s own set-aside parts count as free to it (120 of 130)', !(await page.locator('#sellCompleteBtn').isDisabled()) && (await text(page, '#sellProblem')) === '', await text(page, '#sellProblem'));
  await page.screenshot({ path: path.join(SHOTS, 'st-05-sell-order.png') });
  await page.click('#sellCompleteBtn');
  await page.locator('#sellBody h3:has-text("Sale 2 complete")').waitFor(); await sleep(500);
  check('stock came down: bolts 130 → 10, plugs 3 → 1', part(S, 'HB-1').qty === 10 && part(S, 'WP-1').qty === 1, `${part(S, 'HB-1').qty} ${part(S, 'WP-1').qty}`);
  check('the order is marked sold on sale 2', S.orders[0].status === 'fulfilled' && S.orders[0].sale_no === 2 && !!S.orders[0].closed_at, JSON.stringify(S.orders[0]));
  check('bolts: Cage A (100) taken first, then the rest trimmed from Stillage 2 → 10 left there', JSON.stringify(stillageRows(S, 'HB-1')) === JSON.stringify([{ name: 'Stillage 2', qty: 10 }]), JSON.stringify(stillageRows(S, 'HB-1')));
  check('plugs: the last 2 of 3 came out of Cage A, 1 left', JSON.stringify(stillageRows(S, 'WP-1')) === JSON.stringify([{ name: 'Cage A', qty: 1 }]), JSON.stringify(stillageRows(S, 'WP-1')));
  check('Movement Log has the SALE lines', S.logs.filter(l => l.action === 'SALE').length === 3, JSON.stringify(S.logs.map(l => l.action)));
  await page.click('#sellBody button:has-text("New sale")');
  await page.click('button:visible:has-text("← Back to dashboard")'); await sleep(400);
  check('only Jones\'s order is still holding stock', /1 open customer order holding 450 units/.test(await text(page, '#stillageBlurb')), await text(page, '#stillageBlurb'));
  check('the bolts no longer say reserved', !/reserved/.test(await text(page, '#stockBody tr:has-text("HB-1")')));

  // ── 6. cancelling an order releases the stock
  console.log('\n— cancelling —');
  await page.click('#ordersBtn'); await page.locator('#ordersScreen').waitFor({ state: 'visible' }); await sleep(400);
  await page.click('#coListBody tr:has-text("ORD-0002")');
  await page.locator('#orderBody h3:has-text("ORD-0002")').waitFor();
  await page.click('#orderBody button:has-text("Cancel this order")');
  await page.locator('#orderBody span:has-text("Cancelled")').waitFor(); await sleep(300);
  check('ORD-0002 is cancelled and kept (not deleted), with a closed date', S.orders[1].status === 'cancelled' && !!S.orders[1].closed_at && S.orderLines.filter(l => l.order_id === S.orders[1].id).length === 1);
  await page.click('#orderBody button:has-text("Close")');
  await page.click('button:visible:has-text("← Back to dashboard")'); await sleep(400);
  check('the nuts are free again: no longer flagged low', (await rowOf(page, 'HN-1').locator('.qty-badge.low').count()) === 0 && !/reserved/.test(await text(page, '#stockBody tr:has-text("HN-1")')), await text(page, '#stockBody tr:has-text("HN-1")'));
  check('card says no orders are open', /No customer orders are open/.test(await text(page, '#stillageBlurb')), await text(page, '#stillageBlurb'));

  // ── 7. stillage counts come down when stock goes down
  console.log('\n— stillage counts follow the stock —');
  await rowOf(page, 'WP-1').locator('.btn-icon.minus').click(); await sleep(600);
  check('taking the last plug out manually empties its stillage row', part(S, 'WP-1').qty === 0 && stillageRows(S, 'WP-1').length === 0, JSON.stringify(stillageRows(S, 'WP-1')));
  check('and the row shows Allocate again', /Allocate/.test(await text(page, '#stockBody tr:has-text("WP-1") .stl-cell')));

  // stock take: count 400 nuts where 490 are in Stillage 4
  await page.click('#stockTakeStartBtn'); await page.locator('#stockTakeOverlay.open').waitFor();
  await page.click('#stGoBtn'); await page.locator('#stockTakeScreen').waitFor({ state: 'visible' });
  await page.fill('#stScanBox', 'HN-1'); await page.press('#stScanBox', 'Enter');
  await page.locator('#stCountInput').waitFor(); await page.fill('#stCountInput', '400'); await page.press('#stCountInput', 'Enter');
  await page.locator('#stScanMsg:has-text("Saved")').waitFor();
  await page.click('button:has-text("Finish stock take…")');
  await page.locator('#stockTakeBody h3:has-text("Finish stock take")').waitFor();
  await page.click('#stockTakeBody button:has-text("Update 1 part")');
  await page.locator('#stockTakeBody h3:has-text("Stock take finished")').waitFor(); await sleep(400);
  check('a stock take that finds 400 sets the nuts to 400', part(S, 'HN-1').qty === 400);
  check('…and Stillage 4 comes down to 400 with it', JSON.stringify(stillageRows(S, 'HN-1')) === JSON.stringify([{ name: 'Stillage 4', qty: 400 }]), JSON.stringify(stillageRows(S, 'HN-1')));
  await page.click('#stockTakeBody button:has-text("Done")'); await sleep(500);

  // ── 8. goods in straight into a stillage
  console.log('\n— goods in —');
  await page.click('#reorderBtn'); await page.locator('#reorderScreen').waitFor({ state: 'visible' }); await sleep(300);
  await page.click('#rdTab-orders'); await sleep(500);
  await page.locator('#rdBody tr:has-text("PO-0001")').click();
  await page.locator('#poBody h3:has-text("PO-0001")').waitFor();
  check('the order pop-up offers "Put what arrives into" with the stillages', (await page.locator('#poDest option').count()) === 7 && /Put what arrives into/.test(await text(page, '#poBody')), String(await page.locator('#poDest option').count()));
  await page.selectOption('#poDest', stillageId(S, 'Stillage 3'));
  await page.click('button:has-text("Everything still due has arrived")');
  await page.click('#poBookBtn'); await sleep(900);
  check('delivery booked in: washers 82 → 102', part(S, 'WS-1').qty === 102, String(part(S, 'WS-1').qty));
  check('and the 20 went into Stillage 3', JSON.stringify(stillageRows(S, 'WS-1')) === JSON.stringify([{ name: 'Stillage 3', qty: 20 }]), JSON.stringify(stillageRows(S, 'WS-1')));
  await page.click('#poBody button:has-text("Close")');
  await page.click('button:visible:has-text("← Back to dashboard")'); await sleep(300);

  // ── 9. backup, clear all, restore
  console.log('\n— backup and restore —');
  const dl = page.waitForEvent('download');
  await page.click('button:has-text("Export Backup")');
  const file = path.join(SHOTS, 'st-backup.json'); await (await dl).saveAs(file);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('the backup file carries the stillages and where parts are', Array.isArray(backup.stillages) && backup.stillages.length === 7 && Array.isArray(backup.stillage_stock) && backup.stillage_stock.length === S.stillageStock.length && backup.stillage_stock.length >= 3, JSON.stringify(Object.keys(backup)));
  const nBefore = S.stillageStock.length;
  await page.click('button:has-text("Clear all data…")'); await page.locator('#clearWord').waitFor();
  await page.uncheck('#clearBackup'); await page.fill('#clearWord', 'DELETE'); await page.click('#clearGo');
  await page.locator('#clearBody h3:has-text("All data cleared")').waitFor(); await sleep(300);
  check('Clear all data empties the stock and the stillage counts', S.stock.length === 0 && S.stillageStock.length === 0);
  check('the stillages themselves are kept', S.stillages.length === 7);
  await page.click('#clearBody button:has-text("Done")');
  await page.setInputFiles('#importFile', file);
  await page.waitForFunction(() => document.querySelectorAll('#stockBody .stl-cell').length >= 5, null, { timeout: 8000 }).catch(() => {});
  await sleep(800);
  check('Import Backup puts the parts back', S.stock.length === 5, String(S.stock.length));
  check('…and every stillage count with them', S.stillageStock.length === nBefore, `${S.stillageStock.length} vs ${nBefore}`);
  check('…shown in the list again', /Stillage 2 · 10/.test(await text(page, '#stockBody tr:has-text("HB-1")')), await text(page, '#stockBody tr:has-text("HB-1")'));

  check('no page errors in the main run', t.errors.length === 0, t.errors.join(' | '));

  // ── 10. phone layout
  console.log('\n— phone —');
  const ph = await boot({ browser, viewport: { width: 390, height: 844 }, seed: (S2, O) => {
  ['Stillage 1', 'Stillage 2', 'Stillage 3'].forEach((n, i) => S2.stillages.push({ id: crypto.randomUUID(), owner_id: O, name: n, sort_order: i + 1, active: true }));
  S2.stillageStock.push({ id: crypto.randomUUID(), owner_id: O, stillage_id: S2.stillages[0].id, stock_id: part(S2, 'HB-1').id, qty: 120 }, { id: crypto.randomUUID(), owner_id: O, stillage_id: S2.stillages[1].id, stock_id: part(S2, 'HB-1').id, qty: 30 });
  const ord = { id: crypto.randomUUID(), owner_id: O, user_id: O, order_no: 1, customer: 'Smith Plumbing', reference: 'PO 7731', status: 'open', created_at: new Date().toISOString() };
  S2.orders.push(ord);
  S2.orderLines.push({ id: crypto.randomUUID(), order_id: ord.id, owner_id: O, stock_id: part(S2, 'HB-1').id, sku: 'HB-1', name: 'Hex Bolt M10 x 50mm', qty: 100 }, { id: crypto.randomUUID(), owner_id: O, order_id: ord.id, stock_id: part(S2, 'HN-1').id, sku: 'HN-1', name: 'Hex Nut M10', qty: 100 });
  } });
  await sleep(300);
  const overflow = async name => { const w = await ph.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); check('phone: ' + name + ' has no sideways page scroll', w <= 1, 'overflow ' + w); };
  await overflow('dashboard');
  await ph.page.locator('#stillageCard').scrollIntoViewIfNeeded(); await ph.page.screenshot({ path: path.join(SHOTS, 'st-06-phone-card.png') });
  await ph.page.click('#ordersBtn'); await ph.page.locator('#ordersScreen').waitFor({ state: 'visible' }); await sleep(400);
  await overflow('orders list'); await ph.page.screenshot({ path: path.join(SHOTS, 'st-07-phone-orders.png') });
  await ph.page.click('#coListBody tr:has-text("ORD-0001")'); await ph.page.locator('#orderBody h3:has-text("ORD-0001")').waitFor(); await sleep(300);
  await overflow('order pop-up'); await ph.page.screenshot({ path: path.join(SHOTS, 'st-08-phone-order.png') });
  await ph.page.click('#orderBody button:has-text("Change it")'); await ph.page.locator('#coCust').waitFor(); await sleep(300);
  await overflow('order editor'); await ph.page.screenshot({ path: path.join(SHOTS, 'st-09-phone-editor.png') });
  await ph.page.click('#orderBody button:has-text("Cancel")'); await sleep(200);
  await ph.page.click('button:visible:has-text("← Back to dashboard")');
  await ph.page.click('#sellStartBtn'); await ph.page.fill('#sellScan', 'HB-1'); await ph.page.press('#sellScan', 'Enter'); await sleep(300);
  await overflow('sell screen with the Take from box'); await ph.page.screenshot({ path: path.join(SHOTS, 'st-10-phone-sell.png') });
  check('phone: no page errors', ph.errors.length === 0, ph.errors.join(' | '));
  await ph.context.close();

  // ── 11. the database step has not been run
  console.log('\n— set-up missing —');
  const miss = await boot({ browser, mock: createMock({ missingStillages: true }) });
  check('missing set-up: the card explains what to run, buttons off', /migration-stillages-orders\.sql/.test(await text(miss.page, '#stillageBlurb')) && await miss.page.locator('#ordersBtn').isDisabled() && await miss.page.locator('#stillagesBtn').isDisabled(), await text(miss.page, '#stillageBlurb'));
  check('missing set-up: no Stillages column, list otherwise normal', !(await miss.page.locator('#thStillages').isVisible()) && (await miss.page.locator('#stockBody tr').count()) === 5);
  await miss.page.click('#sellStartBtn'); await miss.page.fill('#sellScan', 'HB-1'); await miss.page.press('#sellScan', 'Enter');
  await miss.page.click('#sellCompleteBtn'); await miss.page.locator('#sellBody h3:has-text("complete")').waitFor(); await sleep(300);
  check('missing set-up: a normal sale still works', part(miss.S, 'HB-1').qty === 169 && miss.S.sales.length === 1, String(part(miss.S, 'HB-1').qty));
  check('missing set-up: no page errors', miss.errors.length === 0, miss.errors.join(' | '));
  await miss.context.close();

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
})().catch(e => { console.error(e); process.exit(2); });
