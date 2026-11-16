// Purchase orders & goods in: raising orders from the To order list, on-order counting, booking deliveries in, cancelling, and the awkward cases.
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
const near = (a, b) => Math.abs(a - b) < 1e-9;
const JSON_HDR = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

// name, sku, qty, cost, location, level, usual qty, supplier
const PARTS = [
  ['Hex Bolt M10 x 50mm', 'HB-1', 170, 0.18, 'Aisle A - Bay 1', 200, 500, 'Fixings Direct'],
  ['Hex Nut M10', 'HN-1', 490, 0.06, 'Aisle A - Bay 1', 100, null, 'Fixings Direct'],
  ['Washer M10 Zinc', 'WS-1', 82, 0.03, 'Aisle A - Bay 2', 100, null, 'Fixings Direct'],
  ['Wall Plug Red', 'WP-1', 3, 0.10, 'Aisle A - Bay 3', 10, null, null],
  ['PVC Pipe 110mm x 3m', 'PV-1', 8, 18.75, 'Yard - Rack 2', 8, 4, 'Plumb Supplies'],
];

async function boot({ mock = createMock(), wrap, viewport = { width: 1280, height: 900 }, browser, seed } = {}) {
  const S = mock.state, O = mock.OWNER;
  S.stock.length = 0;
  PARTS.forEach(([name, sku, qty, cost, location, level, rqty, supplier]) => {
    const row = { id: crypto.randomUUID(), owner_id: O, user_id: O, name, sku, qty, cost, location, reorder_level: level };
    if (rqty !== null) row.reorder_qty = rqty; if (supplier) row.supplier = supplier;
    S.stock.push(row);
  });
  if (seed) seed(S, O);
  browser = browser || await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport, locale: 'en-GB', deviceScaleFactor: viewport.width < 600 ? 2 : 1 });
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', async route => { if (wrap && await wrap(route, mock)) return; return mock.handler(route); });
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
const byKey = (S, sku) => S.stock.find(s => s.sku === sku);
const btn = (page, name) => page.getByRole('button', { name, exact: true });
async function openReorder(page) { await page.click('#reorderBtn'); await page.locator('#reorderScreen').waitFor({ state: 'visible' }); await sleep(300); }
async function createOrders(page) { await page.click('button:has-text("Create purchase orders")'); await page.locator('#poBody h3:has-text("created")').waitFor({ timeout: 8000 }); }
async function openPoTab(page) { await page.click('#rdTab-orders'); await sleep(500); }
async function openPo(page, label) { await page.locator(`#rdBody tr:has-text("${label}")`).click(); await page.locator(`#poBody h3:has-text("${label}")`).waitFor(); await sleep(200); }
const lineOf = (S, sku) => S.poLines.find(l => l.sku === sku);

(async () => {
  // ═════════════ 1. raising orders ═════════════
  console.log('\n— raising purchase orders —');
  let t = await boot();
  let { page, S } = t;
  await openReorder(page);
  check('To order list: 4 parts (HB-1 500, WS-1 118, PV-1 4, WP-1 17)', /Parts to order ?4/.test(await text(page, '#rdStats')));
  check('To order list has an On order column and the Purchase orders tab', /On order/.test(await text(page, '#rdHead')) && await page.locator('#rdTab-orders').isVisible());
  await createOrders(page);
  const dlg = t.dialogs.find(d => /Create 2 purchase orders/.test(d)) || '';
  check('asks first: 2 orders (Fixings Direct, Plumb Supplies) for 3 parts, and warns 1 part has no supplier', /Fixings Direct, Plumb Supplies\) for 3 parts/.test(dlg) && /1 part has no supplier/.test(dlg), dlg);
  check('2 orders created: PO 1 Fixings Direct £93.54, PO 2 Plumb Supplies £75.00', S.pos.length === 2 && S.pos[0].po_no === 1 && S.pos[0].supplier === 'Fixings Direct' && near(S.pos[0].total, 93.54) && S.pos[1].po_no === 2 && S.pos[1].supplier === 'Plumb Supplies' && near(S.pos[1].total, 75), JSON.stringify(S.pos.map(p => [p.po_no, p.supplier, p.total])));
  check('orders start open, with owner and user', S.pos.every(p => p.status === 'open' && p.owner_id && p.user_id && !isNaN(Date.parse(p.created_at))));
  check('3 order lines with ordered qty, nothing received, cost per unit', S.poLines.length === 3 && S.poLines.every(l => l.qty_received === 0 && l.owner_id) && lineOf(S, 'HB-1').qty_ordered === 500 && lineOf(S, 'WS-1').qty_ordered === 118 && lineOf(S, 'PV-1').qty_ordered === 4 && lineOf(S, 'HB-1').unit_cost === 0.18);
  check('a part with no supplier (WP-1) was left off', !lineOf(S, 'WP-1'));
  check('confirmation lists both orders', /PO-0001/.test(await text(page, '#poBody')) && /PO-0002/.test(await text(page, '#poBody')) && /2 purchase orders created/.test(await text(page, '#poBody')));
  await page.screenshot({ path: path.join(SHOTS, '60-po-created.png') });
  await btn(page, 'Done').click();
  check('stock is untouched by raising orders', byKey(S, 'HB-1').qty === 170 && S.logs.length === 0);
  check('To order list now only has the part with no supplier (the rest are on order)', /Parts to order ?1/.test(await text(page, '#rdStats')) && (await text(page, '#rdBody')).includes('WP-1') && !(await text(page, '#rdBody')).includes('HB-1'), await text(page, '#rdStats'));
  await openPoTab(page);
  check('Purchase orders tab lists the 2 open orders, newest first, 0 arrived', (await page.locator('#rdBody tr').count()) === 2 && (await page.locator('#rdBody tr').first().textContent()).includes('PO-0002') && /0 of 618/.test(await text(page, '#rdBody')) && /0 of 4/.test(await text(page, '#rdBody')), await text(page, '#rdBody'));
  check('stats: 2 orders, 622 units still to arrive, £168.54', /Orders shown ?2/.test(await text(page, '#rdStats')) && /622/.test(await text(page, '#rdStats')) && /£168\.54/.test(await text(page, '#rdStats')), await text(page, '#rdStats'));
  await page.screenshot({ path: path.join(SHOTS, '61-po-list.png') });
  await page.fill('#rdSearch', 'plumb'); await sleep(300);
  check('search filters orders by supplier', (await page.locator('#rdBody tr').count()) === 1 && /PO-0002/.test(await text(page, '#rdBody')));
  await page.fill('#rdSearch', ''); await sleep(300);
  await page.click('button:has-text("Back to dashboard")'); await sleep(300);
  check('dashboard Reorder tile mentions the orders on the way', /2 orders on the way/.test(await text(page, '#reorderBlurb')), await text(page, '#reorderBlurb'));

  // ═════════════ 2. booking deliveries in ═════════════
  console.log('\n— booking deliveries in —');
  await openReorder(page); await openPoTab(page); await openPo(page, 'PO-0001');
  check('order pop-up shows lines, ordered, arrived, still due', /Hex Bolt M10 x 50mm/.test(await text(page, '#poBody')) && /Washer M10 Zinc/.test(await text(page, '#poBody')) && /Waiting/.test(await text(page, '#poBody')));
  check('a waiting order with nothing in can be cancelled', await btn(page, 'Cancel this order…').isVisible());
  await page.screenshot({ path: path.join(SHOTS, '62-po-detail.png') });
  const hbId = S.poLines.find(l => l.sku === 'HB-1').id;
  await page.fill('#poIn-' + hbId, '300'); await btn(page, 'Book in').click(); await sleep(900);
  check('part delivery: HB-1 stock 170 → 470, line shows 300 arrived', byKey(S, 'HB-1').qty === 470 && lineOf(S, 'HB-1').qty_received === 300, `${byKey(S, 'HB-1').qty} ${lineOf(S, 'HB-1').qty_received}`);
  check('order becomes "part delivered"', S.pos[0].status === 'partial' && /Part delivered/.test(await text(page, '#poBody')));
  check('Movement Log: GOODS IN 300', S.logs.length === 1 && S.logs[0].action === 'GOODS IN' && S.logs[0].qty === 300 && S.logs[0].item === 'Hex Bolt M10 x 50mm', JSON.stringify(S.logs));
  check('still due shown (200); a part-delivered order cannot be cancelled, only closed short', /200/.test(await text(page, '#poRow-' + hbId)) && (await page.getByRole('button', { name: 'Cancel this order…' }).count()) === 0 && await btn(page, 'Nothing more is coming…').isVisible());
  await btn(page, 'Everything still due has arrived').click();
  check('"Everything still due has arrived" fills the amounts', (await page.inputValue('#poIn-' + hbId)) === '200' && (await page.inputValue('#poIn-' + lineOf(S, 'WS-1').id)) === '118');
  await btn(page, 'Book in').click(); await sleep(1000);
  check('rest delivered: HB-1 670, WS-1 82 + 118 = 200', byKey(S, 'HB-1').qty === 670 && byKey(S, 'WS-1').qty === 200, `${byKey(S, 'HB-1').qty} ${byKey(S, 'WS-1').qty}`);
  check('order complete, with a received date', S.pos[0].status === 'received' && !!S.pos[0].received_at && /Complete/.test(await text(page, '#poBody')));
  check('complete order has no receiving inputs left', (await page.locator('#poBody input.price-cell').count()) === 0);
  await btn(page, 'Close').click();
  await page.click('#rdBulk button:has-text("Complete")'); await sleep(600);
  check('Complete filter shows it, with everything arrived', /PO-0001/.test(await text(page, '#rdBody')) && /618 of 618/.test(await text(page, '#rdBody')), await text(page, '#rdBody'));
  await page.click('#rdBulk button:has-text("On order")'); await sleep(500);
  check('On order filter now only has PO-0002', (await page.locator('#rdBody tr').count()) === 1 && /PO-0002/.test(await text(page, '#rdBody')));
  await openPo(page, 'PO-0002');
  await page.fill('#poIn-' + lineOf(S, 'PV-1').id, '5'); await btn(page, 'Book in').click(); await sleep(900);
  check('over-delivery asks first, then books the full 5 (PV-1 8 → 13)', t.dialogs.some(d => /more than was still due/.test(d)) && byKey(S, 'PV-1').qty === 13 && S.pos[1].status === 'received');
  await btn(page, 'Close').click();
  await page.click('button:has-text("Back to dashboard")'); await sleep(300);
  check('nothing left on order: the tile stops mentioning orders', !/on the way/.test(await text(page, '#reorderBlurb')), await text(page, '#reorderBlurb'));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ═════════════ 3. on order counts towards stock ═════════════
  console.log('\n— on order counts towards stock —');
  t = await boot({ browser: t.browser }); ({ page, S } = t);
  await openReorder(page);
  await page.locator('#rdBody tr:has-text("WS-1") .price-cell').fill('10'); await page.keyboard.press('Tab'); await sleep(200);
  await createOrders(page); await btn(page, 'Done').click();
  const ws = page.locator('#rdBody tr:has-text("WS-1")');
  check('a small order (10) is not enough: WS-1 stays on the list (82 + 10 = 92 ≤ 100)', (await ws.count()) === 1);
  check('...showing the 10 on order', /\b10\b/.test(await ws.locator('td').nth(4).textContent()), await ws.locator('td').nth(4).textContent());
  check('...and suggests topping up from 92: 2×100 − 92 = 108', (await ws.locator('.price-cell').inputValue()) === '108', await ws.locator('.price-cell').inputValue());
  await t.context.close();

  // ═════════════ 4. scanning in the order pop-up ═════════════
  console.log('\n— scanning to book in —');
  t = await boot({ browser: t.browser }); ({ page, S } = t);
  await openReorder(page); await createOrders(page); await btn(page, 'Done').click();
  await openPoTab(page); await openPo(page, 'PO-0001');
  await page.fill('#poScan', 'ws-1'); await page.press('#poScan', 'Enter');
  check('scanning a part on the order jumps to its line, ready to type', await page.evaluate(id => document.activeElement.id === 'poIn-' + id, lineOf(S, 'WS-1').id) && /Washer M10 Zinc — still due 118/.test(await text(page, '#poScanMsg')), await text(page, '#poScanMsg'));
  await page.fill('#poScan', 'HN-1'); await page.press('#poScan', 'Enter');
  check('a part that is not on this order says so', /Hex Nut M10 is not on this order/.test(await text(page, '#poScanMsg')), await text(page, '#poScanMsg'));
  await page.fill('#poScan', 'ZZZ'); await page.press('#poScan', 'Enter');
  check('an unknown code says so', /Nothing in stock with the code “ZZZ”/.test(await text(page, '#poScanMsg')));
  await page.evaluate(() => onCameraCode('HB-1')); await sleep(200);
  check('a code from the camera goes to the order pop-up', await page.evaluate(id => document.activeElement.id === 'poIn-' + id, lineOf(S, 'HB-1').id), await text(page, '#poScanMsg'));
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await btn(page, 'Print').click(); await sleep(300);
  const doc = await text(page, '#saleDoc');
  check('print: purchase order with number, supplier, lines, total and the PO number to quote', /Purchase order PO-0001/.test(doc) && /To Fixings Direct/.test(doc) && /Hex Bolt/.test(doc) && /Washer/.test(doc) && /Total£93\.54/.test(doc) && /quote PO-0001/.test(doc) && await page.evaluate(() => window.__printed === 1 && document.body.classList.contains('printing-sale')), doc);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await t.context.close();

  // ═════════════ 5. cancelling / closing short ═════════════
  console.log('\n— cancelling and closing short —');
  t = await boot({ browser: t.browser }); ({ page, S } = t);
  await openReorder(page); await createOrders(page); await btn(page, 'Done').click();
  await openPoTab(page); await openPo(page, 'PO-0002');
  await btn(page, 'Cancel this order…').click(); await sleep(800);
  check('cancelled: status cancelled, record kept, stock untouched', S.pos[1].status === 'cancelled' && S.pos.length === 2 && S.poLines.length === 3 && byKey(S, 'PV-1').qty === 8 && /Cancelled/.test(await text(page, '#poBody')));
  check('a cancelled order has no booking-in and no cancel button', (await page.locator('#poBody input.price-cell').count()) === 0 && (await page.getByRole('button', { name: 'Cancel this order…' }).count()) === 0);
  await btn(page, 'Close').click();
  await page.click('#rdTab-order'); await sleep(300);
  check('its part (PV-1) is back on the To order list', (await text(page, '#rdBody')).includes('PV-1'));
  await openPoTab(page); await page.click('#rdBulk button:has-text("Cancelled")'); await sleep(500);
  check('Cancelled filter shows PO-0002', /PO-0002/.test(await text(page, '#rdBody')));
  await page.click('#rdBulk button:has-text("On order")'); await sleep(400);
  await openPo(page, 'PO-0001');
  await page.fill('#poIn-' + lineOf(S, 'HB-1').id, '100'); await btn(page, 'Book in').click(); await sleep(900);
  await btn(page, 'Nothing more is coming…').click(); await sleep(900);
  check('closed short: complete, note added, stock stays at what arrived (270)', S.pos[0].status === 'received' && /Closed short/.test(S.pos[0].notes) && byKey(S, 'HB-1').qty === 270, `${S.pos[0].status} ${S.pos[0].notes} ${byKey(S, 'HB-1').qty}`);
  await btn(page, 'Close').click();
  await page.click('#rdTab-order'); await sleep(300);
  check('closing short stops counting the missing 400 as on order — HB-1 (270 ≤ 200? no) stays off, WS-1 back on the list', (await text(page, '#rdBody')).includes('WS-1') && !(await text(page, '#rdBody')).includes('HB-1'), await text(page, '#rdBody'));
  await t.context.close();

  // ═════════════ 6. two people booking the same delivery ═════════════
  console.log('\n— someone else books in first —');
  t = await boot({ browser: t.browser }); ({ page, S } = t);
  await openReorder(page); await createOrders(page); await btn(page, 'Done').click();
  await openPoTab(page); await openPo(page, 'PO-0001');
  lineOf(S, 'HB-1').qty_received = 100;           // meanwhile, at another till
  byKey(S, 'HB-1').qty = 270;
  await page.fill('#poIn-' + lineOf(S, 'HB-1').id, '300'); await btn(page, 'Book in').click(); await sleep(1000);
  check('conflict: warned that someone else booked it in, nothing added twice', t.dialogs.some(d => /someone else booked this in/.test(d)) && lineOf(S, 'HB-1').qty_received === 100 && byKey(S, 'HB-1').qty === 270 && S.logs.length === 0, `${lineOf(S, 'HB-1').qty_received} ${byKey(S, 'HB-1').qty} ${t.dialogs.join(' | ')}`);
  check('conflict: the pop-up reloads with the real figures (100 arrived)', /100/.test(await text(page, '#poRow-' + lineOf(S, 'HB-1').id)));
  await t.context.close();

  // ═════════════ 7. order number collision ═════════════
  console.log('\n— order number collision —');
  let stale = true;
  const collide = async route => { const r = route.request(); if (stale && r.method() === 'GET' && /\/rest\/v1\/sc_purchase_orders\b/.test(r.url()) && new URL(r.url()).searchParams.get('select') === 'po_no') { stale = false; await route.fulfill({ status: 200, headers: JSON_HDR, body: '[]' }); return true; } return false; };
  t = await boot({ browser: t.browser, wrap: collide, seed: (S, O) => S.pos.push({ id: crypto.randomUUID(), owner_id: O, user_id: O, po_no: 1, supplier: 'Old Supplier', status: 'received', total: 5, created_at: new Date(Date.now() - 86400e3).toISOString() }) }); ({ page, S } = t);
  await openReorder(page); await createOrders(page);
  check('collision: new orders take the next free numbers (2 and 3), no error', S.pos.length === 3 && S.pos[1].po_no === 2 && S.pos[2].po_no === 3 && t.errors.length === 0, JSON.stringify(S.pos.map(p => p.po_no)));
  await t.context.close();

  // ═════════════ 8. saving the lines fails ═════════════
  console.log('\n— saving the order fails —');
  const breakLines = async route => { const r = route.request(); if (r.method() === 'POST' && /\/rest\/v1\/sc_po_lines\b/.test(r.url())) { await route.fulfill({ status: 500, headers: JSON_HDR, body: JSON.stringify({ message: 'lines table exploded' }) }); return true; } return false; };
  t = await boot({ browser: t.browser, wrap: breakLines }); ({ page, S } = t);
  await openReorder(page);
  await page.click('button:has-text("Create purchase orders")'); await sleep(1200);
  check('lines fail: told clearly, and the half-made order is cancelled', t.dialogs.some(d => /Not every order could be created/.test(d) && /lines table exploded/.test(d)) && S.pos.length >= 1 && S.pos.every(p => p.status === 'cancelled' && /NOT COMPLETED/.test(p.notes)), JSON.stringify(S.pos.map(p => [p.status, p.notes])));
  check('lines fail: nothing counts as on order, parts still on the list', /Parts to order ?4/.test(await text(page, '#rdStats')), await text(page, '#rdStats'));
  await t.context.close();

  // ═════════════ 9. log wording refused ═════════════
  const strictLog = async route => { const r = route.request(); if (r.method() === 'POST' && /\/rest\/v1\/stock_logs\b/.test(r.url()) && [].concat(JSON.parse(r.postData() || '[]')).some(x => x.action === 'GOODS IN')) { await route.fulfill({ status: 400, headers: JSON_HDR, body: JSON.stringify({ code: '23514', message: 'violates check constraint "stock_logs_action_check"' }) }); return true; } return false; };
  t = await boot({ browser: t.browser, wrap: strictLog }); ({ page, S } = t);
  await openReorder(page); await createOrders(page); await btn(page, 'Done').click();
  await openPoTab(page); await openPo(page, 'PO-0002');
  await page.fill('#poIn-' + lineOf(S, 'PV-1').id, '4'); await btn(page, 'Book in').click(); await sleep(900);
  check('log fallback: plain IN written when GOODS IN is refused, no warning', S.logs.length === 1 && S.logs[0].action === 'IN' && !t.dialogs.some(d => /did not go through/.test(d)), JSON.stringify(S.logs));
  await t.context.close();

  // ═════════════ 10. set-up not run ═════════════
  console.log('\n— database set-up not run —');
  t = await boot({ browser: t.browser, mock: createMock({ missingPo: true }) }); ({ page, S } = t);
  await openReorder(page);
  check('set-up missing: To order list still works as before', /Parts to order ?4/.test(await text(page, '#rdStats')) && !/on the way/.test(await text(page, '#reorderBlurb')));
  await page.click('button:has-text("Create purchase orders")'); await sleep(300);
  check('set-up missing: Create purchase orders says what to run', t.dialogs.some(d => /migration-purchase-orders\.sql/.test(d)) && S.pos.length === 0);
  await openPoTab(page);
  check('set-up missing: the Purchase orders tab explains', /migration-purchase-orders\.sql/.test(await text(page, '#rdBody')), await text(page, '#rdBody'));
  await page.screenshot({ path: path.join(SHOTS, '63-po-setup-needed.png') });
  check('set-up missing: no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ═════════════ 11. phone ═════════════
  console.log('\n— phone —');
  t = await boot({ browser: t.browser, viewport: { width: 390, height: 844 } }); ({ page, S } = t);
  await openReorder(page); await createOrders(page); await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, '64-phone-po-created.png') });
  await btn(page, 'Done').click();
  await openPoTab(page); await sleep(300);
  check('phone: orders list has no sideways page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(SHOTS, '65-phone-po-list.png') });
  await openPo(page, 'PO-0001'); await sleep(300);
  check('phone: order pop-up has no sideways page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(SHOTS, '66-phone-po-detail.png') });
  check('phone: no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.browser.close();

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
})().catch(e => { console.error(e); process.exit(2); });
