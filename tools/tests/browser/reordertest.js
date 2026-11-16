// Reorder levels: setting them, the To order list by supplier, suggested quantities, totals, Excel/print, quick set-up, import.
const { chromium } = require('playwright-core');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
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

// name, sku, qty, cost, location, reorder_level, reorder_qty, supplier
const PARTS = [
  ['Hex Bolt M10 x 50mm', 'HB-1', 170, 0.18, 'Aisle A - Bay 1', 200, 500, 'Fixings Direct'],
  ['Hex Nut M10', 'HN-1', 490, 0.06, 'Aisle A - Bay 1', 100, null, 'Fixings Direct'],
  ['Washer M10 Zinc', 'WS-1', 82, 0.03, 'Aisle A - Bay 2', 100, null, 'Fixings Direct'],
  ['Wood Screw 4 x 40mm (box 200)', 'WSB', 52, 6.49, 'Aisle A - Bay 2', 20, null, 'Fixings Direct'],
  ['Wall Plug Red', 'WP-1', 3, 0.10, 'Aisle A - Bay 3', 10, null, null],
  ['PVC Pipe 110mm x 3m', 'PV-1', 8, 18.75, 'Yard - Rack 2', 8, 4, 'Plumb Supplies'],
  ['Copper Pipe 15mm x 3m', 'CP-1', 11, 14.2, 'Aisle B - Bay 1', null, null, 'Plumb Supplies'],
  ['Cement 25kg', 'CM-1', 4, 6.25, 'Yard - Rack 1', null, null, null],
];

async function boot({ mock = createMock(), viewport = { width: 1280, height: 900 }, browser, plain = false } = {}) {
  const S = mock.state, O = mock.OWNER;
  S.stock.length = 0;
  PARTS.forEach(([name, sku, qty, cost, location, level, rqty, supplier]) => {
    const row = { id: crypto.randomUUID(), owner_id: O, user_id: O, name, sku, qty, cost, location };
    if (!plain) { if (level !== null) row.reorder_level = level; if (rqty !== null) row.reorder_qty = rqty; if (supplier) row.supplier = supplier; }
    S.stock.push(row);
  });
  browser = browser || await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport, locale: 'en-GB', deviceScaleFactor: viewport.width < 600 ? 2 : 1, acceptDownloads: true });
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', mock.handler);
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
  await page.locator('#stockBody tr').first().waitFor(); await sleep(700);
  return { browser, context, page, mock, S, errors, dialogs };
}
const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim());
const byKey = (S, sku) => S.stock.find(s => s.sku === sku);
const row = (page, sku) => page.locator(`#rdBody tr:has-text("${sku}")`);

(async () => {
  // ═════════════ 1. the dashboard ═════════════
  console.log('\n— dashboard —');
  let t = await boot();
  let { page, S } = t;
  check('three action tiles side by side (Sell, Stock take, Reorder) with the Stillages tile full-width beneath', await page.locator('.action-cards > .card').count() === 4 && await page.locator('#reorderCard').isVisible() && await page.evaluate(() => { const y = id => document.getElementById(id).getBoundingClientRect().top; const w = id => document.getElementById(id).getBoundingClientRect().width; return Math.abs(y('sellCard') - y('stockTakeCard')) < 2 && Math.abs(y('sellCard') - y('reorderCard')) < 2 && y('stillageCard') > y('sellCard') + 50 && w('stillageCard') > w('sellCard') * 2.5; }));
  check('Reorder card says 4 parts are at or below their level', /4 parts are at or below their reorder level/.test(await text(page, '#reorderBlurb')) && (await text(page, '#reorderBtn')) === 'See what to order', await text(page, '#reorderBlurb'));
  check('Low stock tile follows each part\'s own level (5 parts)', (await text(page, '#lowStock')) === '5', await text(page, '#lowStock'));
  check('red quantity badges follow the same rule', (await page.locator('#stockBody .qty-badge.low').count()) === 5, String(await page.locator('#stockBody .qty-badge.low').count()));
  check('tile is now just "Low stock"', /Low stock$/.test(await text(page, '.stat-card.low .stat-label')));
  await page.screenshot({ path: path.join(SHOTS, '50-dashboard-tiles.png') });

  // ═════════════ 2. the To order list ═════════════
  console.log('\n— To order —');
  await page.click('#reorderBtn');
  await page.locator('#reorderScreen').waitFor({ state: 'visible' });
  const groups = await page.locator('#rdBody tr.rd-group').allTextContents();
  check('grouped by supplier, "No supplier set" last', groups.length === 3 && /Fixings Direct/.test(groups[0]) && /Plumb Supplies/.test(groups[1]) && /No supplier set/.test(groups[2]), groups.join(' | '));
  const qtyOf = async sku => row(page, sku).locator('.price-cell').inputValue();
  check('order qty: usual quantity where set (HB-1 500, PV-1 4)', (await qtyOf('HB-1')) === '500' && (await qtyOf('PV-1')) === '4');
  check('order qty: otherwise tops up to twice the level (WS-1 118, WP-1 17)', (await qtyOf('WS-1')) === '118' && (await qtyOf('WP-1')) === '17');
  check('parts above their level are not listed', !(await text(page, '#rdBody')).includes('HN-1') && !(await text(page, '#rdBody')).includes('WSB') && !(await text(page, '#rdBody')).includes('CP-1'));
  check('PV-1 at exactly its level (8 of 8) is listed', (await row(page, 'PV-1').count()) === 1);
  const stats = await text(page, '#rdStats');
  check('stats: 4 parts, 2 suppliers, £170.24', /Parts to order ?4/.test(stats) && /Suppliers ?2/.test(stats) && /£170\.24/.test(stats), stats);
  check('supplier subtotals', /Fixings Direct.*£93\.54/.test(groups[0]) && /Plumb Supplies.*£75\.00/.test(groups[1]) && /No supplier set.*£1\.70/.test(groups[2]), groups.join(' | '));
  await page.screenshot({ path: path.join(SHOTS, '51-reorder-to-order.png') });

  await row(page, 'WS-1').locator('.price-cell').fill('150'); await page.keyboard.press('Tab'); await sleep(200);
  check('changing an order qty updates its cost and the total (£171.20)', /£4\.50/.test(await text(page, '#rdBody tr:has-text("WS-1")')) && /£171\.20/.test(await text(page, '#rdStats')), await text(page, '#rdStats'));
  await row(page, 'WP-1').locator('.price-cell').fill('0'); await page.keyboard.press('Tab'); await sleep(200);
  check('order qty 0 leaves a part off the order (3 parts, £169.50)', /Parts to order ?3/.test(await text(page, '#rdStats')) && /£169\.50/.test(await text(page, '#rdStats')), await text(page, '#rdStats'));
  await row(page, 'WP-1').locator('.price-cell').fill('17'); await page.keyboard.press('Tab'); await sleep(200);
  await page.fill('#rdSearch', 'plumb'); await sleep(300);
  check('search narrows the list (by supplier)', (await page.locator('#rdBody tr:not(.rd-group):not(.rd-total)').count()) === 1 && /PVC Pipe/.test(await text(page, '#rdBody')));
  await page.fill('#rdSearch', '');
  await sleep(300);

  // Excel
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download (Excel)")')]);
  const xf = path.join(__dirname, 'Order_List-test.xlsx'); await dl.saveAs(xf);
  check('download is Order_List.xlsx', dl.suggestedFilename() === 'Order_List.xlsx', dl.suggestedFilename());
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(xf); const W = wb.worksheets[0];
  check('Excel: headings on row 4 and frozen like the stock sheet', ['Supplier', 'Product Code', 'Name of item', 'Location', 'In stock', 'Order qty', 'Unit Cost', 'Est. cost'].every((h, i) => W.getCell(4, i + 1).value === h) && W.views[0].state === 'frozen' && W.views[0].ySplit === 4);
  const xrows = [5, 6, 7, 8].map(r => [W.getCell(r, 1).value, W.getCell(r, 2).value, W.getCell(r, 6).value]);
  check('Excel: rows grouped by supplier, with the edited quantities', JSON.stringify(xrows) === JSON.stringify([['Fixings Direct', 'HB-1', 500], ['Fixings Direct', 'WS-1', 150], ['Plumb Supplies', 'PV-1', 4], ['No supplier set', 'WP-1', 17]]), JSON.stringify(xrows));
  check('Excel: Est. cost is a formula (=Order qty x Unit Cost)', W.getCell('H5').value.formula === 'F5*G5' && W.getCell('H8').value.formula === 'F8*G8');
  check('Excel: total line adds the cost column', W.getCell('A9').value === 'Total' && W.getCell('H9').value.formula === 'SUM(H5:H8)' && near(W.getCell('H9').value.result, 90 + 4.5 + 75 + 1.7), JSON.stringify(W.getCell('H9').value));
  check('Excel: styled like the stock sheet (blue header, blue Order qty)', W.getCell('A4').fill.fgColor.argb === 'FF1F4E78' && W.getCell('F5').font.color.argb === 'FF0000FF');
  // print
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.click('#rdOrderTools button:has-text("Print")'); await sleep(300);
  const doc = await text(page, '#saleDoc');
  check('print: order list with supplier headings, parts and total', /Order list/.test(doc) && /Fixings Direct/.test(doc) && /Plumb Supplies/.test(doc) && /No supplier set/.test(doc) && /Hex Bolt/.test(doc) && /Estimated total£171\.20/.test(doc) && await page.evaluate(() => window.__printed === 1 && document.body.classList.contains('printing-sale')), doc);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  // ═════════════ 3. Set levels ═════════════
  console.log('\n— Set levels —');
  await page.click('#rdTab-levels'); await sleep(200);
  check('Set levels lists every part with editable level, usual qty and supplier', (await page.locator('#rdBody tr').count()) === 8 && (await page.locator('#rdBody tr').first().locator('input').count()) === 3);
  check('stats: 6 parts with a level, 2 without', /Parts with a level ?6/.test(await text(page, '#rdStats')) && /Without a level ?2/.test(await text(page, '#rdStats')), await text(page, '#rdStats'));
  check('supplier suggestions come from existing suppliers', (await page.locator('#rdSuppliers option').count()) === 2);
  await page.screenshot({ path: path.join(SHOTS, '52-reorder-levels.png') });
  await row(page, 'CP-1').locator('input').nth(0).fill('12'); await page.keyboard.press('Tab'); await sleep(300);
  check('typing a level saves it', byKey(S, 'CP-1').reorder_level === 12, String(byKey(S, 'CP-1').reorder_level));
  await row(page, 'WP-1').locator('input').nth(2).fill('Fixings Direct'); await page.keyboard.press('Tab'); await sleep(300);
  check('typing a supplier saves it', byKey(S, 'WP-1').supplier === 'Fixings Direct');
  await row(page, 'PV-1').locator('input').nth(0).fill(''); await page.keyboard.press('Tab'); await sleep(300);
  check('clearing a level removes it', byKey(S, 'PV-1').reorder_level === null);
  await row(page, 'HN-1').locator('input').nth(0).fill('-3'); await page.keyboard.press('Tab'); await sleep(300);
  check('a negative number is refused', t.dialogs.some(d => /Type a number/.test(d)) && byKey(S, 'HN-1').reorder_level === 100);
  await page.click('#rdTab-order'); await sleep(200);
  const g2 = await page.locator('#rdBody tr.rd-group').allTextContents();
  check('To order now: CP-1 added (11 ≤ 12), PV-1 gone, WP-1 under Fixings Direct', (await text(page, '#rdBody')).includes('CP-1') && !(await text(page, '#rdBody')).includes('PV-1') && /Fixings Direct.*3 parts/.test(g2[0]) && g2.length === 2, g2.join(' | '));
  check('suggested quantity for CP-1: 2×12−11 = 13', (await row(page, 'CP-1').locator('.price-cell').inputValue()) === '13');
  check('the dashboard card and Low stock follow', await (async () => { await page.click('button:has-text("Back to dashboard")'); await sleep(200); return /4 parts are at or below/.test(await text(page, "#reorderBlurb")); })(), await text(page, '#reorderBlurb'));
  check('no page errors so far', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ═════════════ 4. quick set-up ═════════════
  console.log('\n— quick set-up —');
  t = await boot({ browser: t.browser }); ({ page, S } = t);
  await page.click('#reorderBtn'); await page.click('#rdTab-levels'); await sleep(200);
  check('quick set-up says how many parts have no level (2)', /\(2 parts shown have none\)/.test(await text(page, '#rdBulk')), await text(page, '#rdBulk'));
  await page.fill('#rdSearch', 'copper'); await sleep(300);
  await page.fill('#rdBulkLevel', '7');
  await page.click('#rdBulk button:has-text("Apply")'); await sleep(500);
  check('quick set-up only touches the parts shown that have no level', byKey(S, 'CP-1').reorder_level === 7 && byKey(S, 'CM-1').reorder_level === undefined && t.dialogs.some(d => /Give 1 part a reorder level of 7/.test(d)), `${byKey(S, 'CP-1').reorder_level} / ${byKey(S, 'CM-1').reorder_level}`);
  await page.fill('#rdSearch', ''); await sleep(300);
  await page.fill('#rdBulkLevel', '5'); await page.click('#rdBulk button:has-text("Apply")'); await sleep(500);
  check('applying to the rest: CM-1 gets 5, parts that had a level are unchanged', byKey(S, 'CM-1').reorder_level === 5 && byKey(S, 'HB-1').reorder_level === 200 && byKey(S, 'CP-1').reorder_level === 7);
  await page.click('#rdBulk button:has-text("Apply")'); await sleep(300);
  check('applying again says every part already has one', t.dialogs.some(d => /already has a reorder level/.test(d)));
  await t.context.close();

  // ═════════════ 5. importing the columns ═════════════
  console.log('\n— import —');
  t = await boot({ browser: t.browser }); ({ page, S } = t);
  const xl = path.join(__dirname, 'reorder-import.xlsx');
  const iw = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(iw, XLSX.utils.aoa_to_sheet([
    ['Product Code', 'Description', 'Qty', 'Unit Cost', 'Reorder Level', 'Order Qty', 'Supplier Name'],
    ['NEW-1', 'Brand new part', 5, 2.5, 10, 25, 'Acme Fixings'],
    ['NEW-2', 'Another new part', 7, 1, '', '', ''],
    ['HB-1', 'Hex Bolt M10 x 50mm', 170, 0.18, 300, '', 'Fixings Direct Ltd'],
    ['HN-1', 'Hex Nut M10', 490, 0.06, '', '', ''],
  ]), 'Sheet1');
  XLSX.writeFile(iw, xl);
  await page.setInputFiles('#excelFile', xl);
  await page.locator('#importOverlay.open').waitFor(); await sleep(500);
  const map = await page.evaluate(() => importState.map);
  check('import: Reorder Level / Order Qty / Supplier Name are matched — Order Qty is NOT taken as the stock quantity, Supplier Name is not the part name', map.qty === 2 && map.name === 1 && map.reorder === 4 && map.orderQty === 5 && map.supplier === 6, JSON.stringify(map));
  await page.screenshot({ path: path.join(SHOTS, '53-import-reorder.png') });
  await page.click('#importBody .btn-primary'); await page.locator('#importBody h3:has-text("Import finished")').waitFor({ timeout: 15000 });
  check('import: new part gets level, usual qty and supplier', byKey(S, 'NEW-1').reorder_level === 10 && byKey(S, 'NEW-1').reorder_qty === 25 && byKey(S, 'NEW-1').supplier === 'Acme Fixings' && byKey(S, 'NEW-1').qty === 5);
  check('import: blanks stay empty on a new part', byKey(S, 'NEW-2').reorder_level === undefined && byKey(S, 'NEW-2').supplier === undefined);
  check('import: existing part updated; blank cells never wipe what is there', byKey(S, 'HB-1').reorder_level === 300 && byKey(S, 'HB-1').supplier === 'Fixings Direct Ltd' && byKey(S, 'HB-1').reorder_qty === 500 && byKey(S, 'HN-1').reorder_level === 100 && byKey(S, 'HN-1').supplier === 'Fixings Direct');
  await t.context.close();

  // ═════════════ 6. database set-up not run ═════════════
  console.log('\n— database set-up not run —');
  t = await boot({ browser: t.browser, mock: createMock({ missingReorder: true }), plain: true }); ({ page, S } = t);
  check('set-up missing: card explains, button off', /migration-reorder\.sql/.test(await text(page, '#reorderBlurb')) && await page.locator('#reorderBtn').isDisabled(), await text(page, '#reorderBlurb'));
  check('set-up missing: Low stock keeps the old rule (5 or fewer → CM-1, WP-1 = 2)', (await text(page, '#lowStock')) === '2', await text(page, '#lowStock'));
  await page.screenshot({ path: path.join(SHOTS, '54-reorder-setup-needed.png'), clip: { x: 0, y: 380, width: 1280, height: 330 } });
  await page.setInputFiles('#excelFile', xl);
  await page.locator('#importOverlay.open').waitFor(); await sleep(400);
  await page.click('#importBody .btn-primary'); await page.locator('#importBody h3:has-text("Import finished")').waitFor({ timeout: 15000 });
  check('set-up missing: importing a sheet with those columns still works (they are quietly left out)', !!byKey(S, 'NEW-1') && !('reorder_level' in byKey(S, 'NEW-1')) && !('supplier' in byKey(S, 'NEW-1')) && t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ═════════════ 7. phone ═════════════
  console.log('\n— phone —');
  t = await boot({ browser: t.browser, viewport: { width: 390, height: 844 } }); ({ page, S } = t);
  await page.screenshot({ path: path.join(SHOTS, '55-phone-dashboard-tiles.png'), clip: { x: 0, y: 380, width: 390, height: 464 } }).catch(() => {});
  await page.click('#reorderBtn'); await page.locator('#reorderScreen').waitFor({ state: 'visible' }); await sleep(400);
  check('phone: To order has no sideways page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(SHOTS, '56-phone-reorder.png') });
  await page.click('#rdTab-levels'); await sleep(300);
  check('phone: Set levels has no sideways page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  check('phone: no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.browser.close();

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
})().catch(e => { console.error(e); process.exit(2); });
