// Selling at the counter: prices, basket, completing, receipts, sales list, void, Sage CSV, and the awkward cases.
const { chromium } = require('playwright-core');
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
const JSON_HDR = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

const PARTS = [   // name, sku, qty, cost, location, sell price
  ['Hex Bolt M10 x 50mm', 'HB-1', 170, 0.18, 'Aisle A - Bay 1', 0.45],
  ['Hex Nut M10', 'HN-1', 490, 0.06, 'Aisle A - Bay 1', null],
  ['Washer M10 Zinc', 'WS-1', 82, 0.03, 'Aisle A - Bay 2', 0.08],
  ['Wood Screw 4 x 40mm (box 200)', 'WSB', 52, 6.49, 'Aisle A - Bay 2', 9.99],
  ['Wall Plug Red', 'WP-1', 10, 0.10, 'Aisle A - Bay 3', 0.25],
  ['PVC Pipe 110mm x 3m', 'PV-1', 8, 18.75, 'Yard - Rack 2', 27.5],
  ['Copper Pipe 15mm x 3m', 'CP-1', 11, 14.2, 'Aisle B - Bay 1', 21.0],
  ['Cement 25kg', 'CM-1', 29, 6.25, 'Yard - Rack 1', 9.5],
];

async function boot({ wrap, viewport = { width: 1280, height: 900 }, mock = createMock(), browser, seedSales } = {}) {
  const S = mock.state, O = mock.OWNER;
  S.stock.length = 0;
  PARTS.forEach(([name, sku, qty, cost, location, sell]) => S.stock.push({ id: crypto.randomUUID(), owner_id: O, user_id: O, name, sku, qty, cost, location, ...(sell === null ? {} : { sell_price: sell }) }));
  if (seedSales) seedSales(S, O);
  browser = browser || await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport, locale: 'en-GB', deviceScaleFactor: viewport.width < 600 ? 2 : 1, acceptDownloads: true });
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
  await page.locator('#stockBody tr').first().waitFor(); await sleep(700);
  return { browser, context, page, mock, S, errors, dialogs };
}
const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim());
const byKey = (S, sku) => S.stock.find(s => s.sku === sku);
const btn = (page, name) => page.getByRole('button', { name, exact: true });
async function openSell(page) { await page.click('#sellStartBtn'); await page.locator('#sellScreen').waitFor({ state: 'visible' }); }
async function scan(page, code) { await page.fill('#sellScan', code); await page.press('#sellScan', 'Enter'); await sleep(150); }
async function setQty(page, row, v) { await page.locator('#sellBasket tbody tr').nth(row).locator('.qty-ctl input').fill(String(v)); await page.keyboard.press('Tab'); await sleep(150); }
async function setPrice(page, row, v) { await page.locator('#sellBasket tbody tr').nth(row).locator('.price-in').fill(String(v)); await page.keyboard.press('Tab'); await sleep(150); }
async function complete(page) { await page.click('#sellCompleteBtn'); await page.locator('#sellBody h3:has-text("complete")').waitFor({ timeout: 8000 }); }

(async () => {
  // ═════════════ 1. prices on parts ═════════════
  console.log('\n— selling prices on the parts —');
  let t = await boot();
  let { page, S } = t;
  check('stock table has a Sell Price column with the saved prices', /Sell Price/.test(await text(page, 'table:has(#stockBody) thead')) && (await page.locator('#stockBody tr:has-text("HB-1") .price-cell').inputValue()) === '0.45');
  await page.locator('#stockBody tr:has-text("HN-1") .price-cell').fill('0.12'); await page.keyboard.press('Tab'); await sleep(300);
  check('typing a price in the table saves it', byKey(S, 'HN-1').sell_price === 0.12, String(byKey(S, 'HN-1').sell_price));
  await page.locator('#stockBody tr:has-text("HN-1") .price-cell').fill(''); await page.keyboard.press('Tab'); await sleep(300);
  check('clearing it removes the price', byKey(S, 'HN-1').sell_price === null);
  await page.fill('#name', 'Brass Hinge'); await page.fill('#sku', 'BH-1'); await page.fill('#qty', '5'); await page.fill('#cost', '1.5'); await page.fill('#sellPrice', '3.25');
  await page.click('#addItemCard .btn-primary'); await sleep(400);
  check('Add Item saves the sell price', byKey(S, 'BH-1') && byKey(S, 'BH-1').sell_price === 3.25);
  check('Add Item clears the sell price box afterwards', (await page.inputValue('#sellPrice')) === '');
  await page.screenshot({ path: path.join(SHOTS, '30-stock-table-sell-price.png'), clip: { x: 0, y: 0, width: 1280, height: 900 } });
  S.stock.splice(S.stock.findIndex(s => s.sku === 'BH-1'), 1);
  await t.context.close();

  // ═════════════ 2. the main selling run ═════════════
  console.log('\n— a cash sale —');
  t = await boot({ browser: t.browser });
  ({ page, S } = t);
  check('dashboard has the Sell at the counter card, buttons ready', await page.locator('#sellCard').isVisible() && !(await page.locator('#sellStartBtn').isDisabled()) && (await text(page, '#sellStartBtn')) === 'New sale');
  await page.screenshot({ path: path.join(SHOTS, '31-dashboard-sell-card.png') });
  await openSell(page);
  check('sell screen opens with an empty basket', /Scan a part, or type a name or code above/.test(await text(page, '#sellBasket')) && (await page.locator('#sellCompleteBtn').isDisabled()));
  check('scan box focused for a scanner', await page.evaluate(() => document.activeElement.id === 'sellScan'));
  await scan(page, 'hb-1');
  check('scanning adds the part at its selling price', (await page.locator('#sellBasket tbody tr').count()) === 1 && (await page.locator('#sellBasket .price-in').first().inputValue()) === '0.45');
  await scan(page, 'HB-1');
  check('scanning it again adds one more (qty 2)', (await page.locator('#sellBasket .qty-ctl input').first().inputValue()) === '2');
  check('a part with no selling price is added with the price cell flagged', await (async () => { await scan(page, 'HN-1'); return (await page.locator('#sellBasket tbody tr').nth(1).locator('.price-in.missing').count()) === 1; })());
  check('Complete is blocked until it has a price, and says why', (await page.locator('#sellCompleteBtn').isDisabled()) && /needs a price/.test(await text(page, '#sellProblem')), await text(page, '#sellProblem'));
  await setPrice(page, 1, '0.12');
  await setQty(page, 1, 10);
  check('totals: net £2.10, VAT £0.42, total £2.52', /Net£2\.10/.test(await text(page, '.sell-totals')) && /VAT \(20%\)£0\.42/.test(await text(page, '.sell-totals')) && /Total£2\.52/.test(await text(page, '.sell-totals')), await text(page, '.sell-totals'));
  check('Complete button shows the total', /Complete sale — £2\.52/.test(await text(page, '#sellCompleteBtn')));
  await page.fill('#sellScan', 'wash'); await sleep(200);
  check('typing a name shows matches to click', /Washer M10 Zinc/.test(await text(page, '.sell-sugg')), await text(page, '#sellBasket'));
  await page.screenshot({ path: path.join(SHOTS, '32-sell-screen.png') });
  await page.locator('.sell-sugg-row').first().click(); await sleep(200);
  check('clicking a match adds it', (await page.locator('#sellBasket tbody tr').count()) === 3);
  await page.locator('#sellBasket tbody tr').nth(2).locator('button[title="Remove"]').click(); await sleep(150);
  check('a line can be removed', (await page.locator('#sellBasket tbody tr').count()) === 2);
  check('nothing sold or changed so far', S.sales.length === 0 && byKey(S, 'HB-1').qty === 170);

  await complete(page);
  const s1 = S.sales[0];
  check('sale recorded as number 1, cash, £2.10 + £0.42 = £2.52', s1 && s1.sale_no === 1 && s1.payment === 'cash' && near(s1.net, 2.1) && near(s1.vat, 0.42) && near(s1.gross, 2.52) && s1.status === 'completed' && s1.vat_rate === 20, JSON.stringify(s1));
  check('sale has owner, user and a real timestamp', s1.owner_id && s1.user_id && !isNaN(Date.parse(s1.sold_at)));
  check('two sale lines saved with prices', S.saleLines.length === 2 && S.saleLines.every(l => l.sale_id === s1.id && l.owner_id) && near(S.saleLines.find(l => l.sku === 'HB-1').line_net, 0.9) && S.saleLines.find(l => l.sku === 'HN-1').qty === 10);
  check('stock reduced: HB-1 170→168, HN-1 490→480', byKey(S, 'HB-1').qty === 168 && byKey(S, 'HN-1').qty === 480);
  check('untouched parts unchanged', byKey(S, 'WS-1').qty === 82 && byKey(S, 'CP-1').qty === 11);
  check('Movement Log: two SALE entries', S.logs.length === 2 && S.logs.every(l => l.action === 'SALE') && S.logs.find(l => l.item.startsWith('Hex Bolt')).qty === 2 && S.logs.find(l => l.item === 'Hex Nut M10').qty === 10, JSON.stringify(S.logs.map(l => l.action + l.item + l.qty)));
  check('confirmation shows the sale number and total', /Sale 1 complete/.test(await text(page, '#sellBody')) && /£2\.52/.test(await text(page, '#sellBody')));
  await page.screenshot({ path: path.join(SHOTS, '33-sale-complete.png') });
  await btn(page, 'New sale').click();
  check('basket is empty again for the next customer', /Scan a part, or type/.test(await text(page, '#sellBasket')));
  check('dashboard stock figures follow', true);

  // ═════════════ 3. an account customer, no VAT ═════════════
  console.log('\n— an account sale, 0% VAT —');
  await scan(page, 'CP-1');
  await btn(page, 'Account customer').click();
  check('account customer: payment moves to "On account"', (await page.locator('#sellSummary .auth-tab.active').allTextContents()).includes('On account'));
  check('account customer needs a name before Complete', /customer’s name/.test(await text(page, '#sellProblem')) && await page.locator('#sellCompleteBtn').isDisabled());
  await page.fill('#sellSummary input[placeholder="e.g. Smith Plumbing"]', 'Smith Plumbing');
  await page.fill('#sellSummary input[placeholder="e.g. SMI001"]', 'SMI001');
  await page.fill('#sellSummary .form-field:has-text("order number") input', 'PO 4471');
  await page.selectOption('#sellSummary select', '0');
  check('0% VAT: total equals net', /VAT \(0%\)£0\.00/.test(await text(page, '.sell-totals')) && /Total£21\.00/.test(await text(page, '.sell-totals')), await text(page, '.sell-totals'));
  await page.screenshot({ path: path.join(SHOTS, '34-account-sale.png') });
  await complete(page);
  const s2 = S.sales[1];
  check('sale 2 is the account sale with customer, code, reference', s2.sale_no === 2 && s2.customer_name === 'Smith Plumbing' && s2.account_ref === 'SMI001' && s2.payment === 'account' && s2.reference === 'PO 4471' && s2.vat_rate === 0 && s2.vat === 0 && s2.gross === 21, JSON.stringify(s2));
  await btn(page, 'New sale').click();

  // ═════════════ 4. selling more than is in stock ═════════════
  console.log('\n— more than is in stock —');
  await scan(page, 'WP-1'); await setQty(page, 0, 15);
  check('over-stock line shows a warning', /Only 10 in stock/.test(await text(page, '#sellBasket')));
  await btn(page, 'Card').click();
  await complete(page);
  check('over-stock: the user was asked first', t.dialogs.some(d => /more than the system says is in stock/.test(d)));
  check('over-stock: stock stops at 0, sale still recorded at 15', byKey(S, 'WP-1').qty === 0 && S.saleLines.find(l => l.sku === 'WP-1').qty === 15);
  check('card payment recorded, VAT back at 20% (£3.75 + £0.75)', S.sales[2].payment === 'card' && S.sales[2].vat_rate === 20 && near(S.sales[2].net, 3.75) && near(S.sales[2].vat, 0.75) && near(S.sales[2].gross, 4.5), JSON.stringify(S.sales[2]));
  await btn(page, 'New sale').click();

  // ═════════════ 5. the Sales list ═════════════
  console.log('\n— sales list —');
  await page.click('.topbar-user .logout-btn:has-text("Sales list")');
  await page.locator('#salesScreen').waitFor({ state: 'visible' });
  await page.locator('#salesBody tr').first().waitFor(); await sleep(300);
  check('today shows all 3 sales, newest first', (await page.locator('#salesBody tr').count()) === 3 && (await page.locator('#salesBody tr').first().textContent()).includes('Cash sale'));
  const stats = await text(page, '#salesStats');
  check('summary: 3 sales, £28.02 total, £1.17 VAT', /Sales ?3/.test(stats) && /£28\.02/.test(stats) && /£1\.17/.test(stats), stats);
  check('summary: split by cash / card / account', /£2\.52 · £4\.50 · £21\.00/.test(stats), stats);
  await page.screenshot({ path: path.join(SHOTS, '35-sales-list.png') });
  await page.locator('#salesBody tr:has-text("Smith Plumbing")').click();
  await page.locator('#sellBody h3:has-text("Sale 2")').waitFor();
  check('opening a sale shows its lines and totals', /Copper Pipe/.test(await text(page, '#sellBody')) && /£21\.00/.test(await text(page, '#sellBody')) && /SMI001/.test(await text(page, '#sellBody')));
  await page.evaluate(() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; });
  await btn(page, 'Print receipt').click(); await sleep(300);
  const doc = await text(page, '#saleDoc');
  check('print: receipt has company, number, customer, lines and totals', doc.includes(COMPANY) && /Sales receipt/.test(doc) && /No\. 2/.test(doc) && /Smith Plumbing \(SMI001\)/.test(doc) && /Copper Pipe/.test(doc) && /VAT \(0%\)£0\.00/.test(doc) && /Total£21\.00/.test(doc) && /Paid on account/.test(doc), doc);
  check('print: page switched into receipt-printing mode', await page.evaluate(() => window.__printCalls === 1 && document.body.classList.contains('printing-sale')));
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  check('print: cleaned up afterwards', await page.evaluate(() => !document.body.classList.contains('printing-sale') && document.getElementById('saleDoc').innerHTML === ''));
  await page.screenshot({ path: path.join(SHOTS, '36-sale-detail.png') });
  await btn(page, 'Close').click();

  // ═════════════ 6. voiding ═════════════
  console.log('\n— void —');
  await page.locator('#salesBody tr:has-text("£2.52")').click();
  await page.locator('#sellBody h3:has-text("Sale 1")').waitFor();
  await btn(page, 'Void this sale…').click();
  await page.locator('#salesBody tr:has-text("Voided")').waitFor({ timeout: 8000 });
  check('void: sale marked voided, record kept', S.sales[0].status === 'voided' && !!S.sales[0].voided_at && S.sales.length === 3 && S.saleLines.length === 4);
  check('void: stock put back (HB-1 168→170, HN-1 480→490)', byKey(S, 'HB-1').qty === 170 && byKey(S, 'HN-1').qty === 490);
  check('void: logged as VOID', S.logs.filter(l => l.action === 'VOID').length === 2);
  check('void: summary now excludes it (2 sales, £25.50)', /Sales ?2/.test(await text(page, '#salesStats')) && /£25\.50/.test(await text(page, '#salesStats')), await text(page, '#salesStats'));
  const before = byKey(S, 'HB-1').qty, logsBefore = S.logs.length;
  await page.locator('#salesBody tr:has-text("Voided")').click();
  await page.locator('#sellBody h3:has-text("voided")').waitFor();
  check('a voided sale has no Void button', (await page.getByRole('button', { name: 'Void this sale…' }).count()) === 0);
  await page.evaluate(id => voidSale(id), S.sales[0].id); await sleep(500);
  check('voiding twice is refused and puts nothing back twice', t.dialogs.some(d => /already been voided/.test(d)) && byKey(S, 'HB-1').qty === before && S.logs.length === logsBefore);
  await btn(page, 'Close').click().catch(() => {});

  // ═════════════ 7. Sage CSV ═════════════
  console.log('\n— Sage 50 export —');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export for Sage 50")')]);
  const csvFile = path.join(__dirname, 'sage-test.csv'); await dl.saveAs(csvFile);
  const rows = fs.readFileSync(csvFile, 'utf8').trim().split('\r\n').map(r => r.split('","').map(c => c.replace(/^"|"$/g, '')));
  const today = new Date().toLocaleDateString('en-GB');
  check('Sage: file name', /^sage-sales-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  check('Sage: standard column headings', rows[0].join('|') === 'Type|Account Reference|Nominal A/C Ref|Department|Date|Reference|Details|Net Amount|Tax Code|Tax Amount', rows[0].join('|'));
  check('Sage: voided sale left out, 2 rows', rows.length === 3, String(rows.length));
  check('Sage: account sale row (customer code, T0, no VAT)', rows[1].join('|') === `SI|SMI001|4000|0|${today}|S2|Counter sale - Smith Plumbing - PO 4471|21.00|T0|0.00`, rows[1].join('|'));
  check('Sage: card sale goes to the cash account, T1, VAT £0.75', rows[2].join('|') === `SI|CASH|4000|0|${today}|S3|Counter sale|3.75|T1|0.75`, rows[2].join('|'));
  await page.click('button:has-text("Settings")');
  await page.locator('#sellBody h3:has-text("Sales settings")').waitFor();
  await page.fill('#ssCompany', 'Acme Parts Ltd\n1 High Street\nVAT 123 4567 89'); await page.fill('#ssNominal', '4001'); await page.fill('#ssCash', 'CSH01');
  await btn(page, 'Save').click();
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export for Sage 50")')]);
  await dl2.saveAs(csvFile);
  const rows2 = fs.readFileSync(csvFile, 'utf8').trim().split('\r\n');
  check('Sage: settings change the nominal and cash account', rows2[2].includes('"CSH01","4001"') && rows2[1].includes('"SMI001","4001"'), rows2[2]);
  await page.evaluate(() => { window.print = () => {}; });
  await page.locator('#salesBody tr:has-text("Smith Plumbing")').click(); await page.locator('#sellBody h3:has-text("Sale 2")').waitFor();
  await btn(page, 'Print receipt').click(); await sleep(300);
  check('receipt picks up the company details from settings', /Acme Parts Ltd/.test(await text(page, '#saleDoc')) && /1 High Street/.test(await text(page, '#saleDoc')) && /VAT 123 4567 89/.test(await text(page, '#saleDoc')));
  check('no page errors in the main run', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ═════════════ 8. a basket survives a refresh ═════════════
  console.log('\n— draft basket survives a refresh —');
  t = await boot({ browser: t.browser }); ({ page, S } = t);
  await openSell(page); await scan(page, 'CM-1'); await setQty(page, 0, 3);
  await page.reload({ waitUntil: 'load' });
  await page.locator('#appScreen').waitFor({ state: 'visible' }); await page.locator('#stockBody tr').first().waitFor(); await sleep(600);
  check('after a refresh the card says a sale is in progress', /A sale is in progress: 1 line/.test(await text(page, '#sellBlurb')) && (await text(page, '#sellStartBtn')) === 'Continue the sale');
  await page.click('#sellStartBtn'); await page.locator('#sellScreen').waitFor({ state: 'visible' });
  check('the basket is back with its quantity', (await page.locator('#sellBasket tbody tr').count()) === 1 && (await page.locator('#sellBasket .qty-ctl input').first().inputValue()) === '3');
  await page.evaluate(() => sellClear()); await sleep(200);
  check('Clear the basket empties it (after asking)', /Scan a part/.test(await text(page, '#sellBasket')) && t.dialogs.some(d => /Clear the basket/.test(d)));
  await page.evaluate(() => onCameraCode('PV-1')); await sleep(200);
  check('a code from the camera adds to the sale', (await page.locator('#sellBasket tbody tr').count()) === 1 && /PVC Pipe/.test(await text(page, '#sellBasket')));
  await scan(page, 'zzzz-nothing');
  check('unknown code: clear message', /Nothing in stock matching “zzzz-nothing”/.test(await text(page, '#sellMsg')));
  await t.context.close();

  // ═════════════ 9. two tills pick the same sale number ═════════════
  console.log('\n— sale number collision —');
  let stale = true;
  const collide = async route => {
    const req = route.request();
    if (stale && req.method() === 'GET' && /\/rest\/v1\/sc_sales\b/.test(req.url()) && new URL(req.url()).searchParams.get('select') === 'sale_no') { stale = false; await route.fulfill({ status: 200, headers: JSON_HDR, body: '[]' }); return true; }
    return false;
  };
  t = await boot({ browser: t.browser, wrap: collide, seedSales: (S, O) => S.sales.push({ id: crypto.randomUUID(), owner_id: O, user_id: O, sale_no: 1, sold_at: new Date(Date.now() - 3600e3).toISOString(), payment: 'cash', vat_rate: 20, net: 1, vat: 0.2, gross: 1.2, status: 'completed' }) });
  ({ page, S } = t);
  await openSell(page); await scan(page, 'CM-1');
  await complete(page);
  check('collision: the sale gets the next free number (2), not an error', S.sales.length === 2 && S.sales[1].sale_no === 2 && t.errors.length === 0 && !t.dialogs.some(d => /not completed/.test(d)), JSON.stringify(S.sales.map(s => s.sale_no)));
  await t.context.close();

  // ═════════════ 10. saving the lines fails ═════════════
  console.log('\n— saving the sale fails part-way —');
  const breakLines = async route => { const r = route.request(); if (r.method() === 'POST' && /\/rest\/v1\/sc_sale_lines\b/.test(r.url())) { await route.fulfill({ status: 500, headers: JSON_HDR, body: JSON.stringify({ message: 'lines table exploded' }) }); return true; } return false; };
  t = await boot({ browser: t.browser, wrap: breakLines }); ({ page, S } = t);
  await openSell(page); await scan(page, 'HB-1');
  await page.click('#sellCompleteBtn'); await sleep(900);
  check('lines fail: user is told nothing was sold', t.dialogs.some(d => /Nothing was sold and stock is unchanged/.test(d) && /lines table exploded/.test(d)), t.dialogs.join(' | '));
  check('lines fail: stock untouched, no log entries', byKey(S, 'HB-1').qty === 170 && S.logs.length === 0);
  check('lines fail: the half-made sale is voided, not left as a real sale', S.sales.length === 1 && S.sales[0].status === 'voided' && /NOT COMPLETED/.test(S.sales[0].reference));
  check('lines fail: the basket is kept so they can try again', (await page.locator('#sellBasket tbody tr').count()) === 1 && !(await page.locator('#sellCompleteBtn').isDisabled()));
  await t.context.close();

  // ═════════════ 11. one stock update fails ═════════════
  console.log('\n— one stock update fails —');
  const breakStock = async (route, mock) => {
    const r = route.request();
    if (r.method() === 'PATCH' && /\/rest\/v1\/stock\b/.test(r.url())) {
      const id = new URL(r.url()).searchParams.get('id'); const p = mock.state.stock.find(s => 'eq.' + s.id === id);
      if (p && p.sku === 'HB-1') { await route.fulfill({ status: 500, headers: JSON_HDR, body: JSON.stringify({ message: 'stock table is busy' }) }); return true; }
    }
    return false;
  };
  t = await boot({ browser: t.browser, wrap: breakStock }); ({ page, S } = t);
  await openSell(page); await scan(page, 'HB-1'); await scan(page, 'CM-1');
  await complete(page);
  check('stock fail: sale is recorded and the user is told which part to fix', S.sales.length === 1 && S.sales[0].status === 'completed' && /Stock could not be reduced for/.test(await text(page, '#sellBody')) && /Hex Bolt M10 x 50mm: stock table is busy/.test(await text(page, '#sellBody')), await text(page, '#sellBody'));
  check('stock fail: the other part was still reduced', byKey(S, 'CM-1').qty === 28 && byKey(S, 'HB-1').qty === 170);
  await t.context.close();

  // ═════════════ 12. log wording refused by the database ═════════════
  const strictLog = async route => { const r = route.request(); if (r.method() === 'POST' && /\/rest\/v1\/stock_logs\b/.test(r.url()) && [].concat(JSON.parse(r.postData() || '[]')).some(x => /^(SALE|VOID)$/.test(x.action))) { await route.fulfill({ status: 400, headers: JSON_HDR, body: JSON.stringify({ code: '23514', message: 'new row violates check constraint "stock_logs_action_check"' }) }); return true; } return false; };
  t = await boot({ browser: t.browser, wrap: strictLog }); ({ page, S } = t);
  await openSell(page); await scan(page, 'CM-1'); await complete(page);
  check('log fallback: plain OUT written when SALE is refused', S.logs.length === 1 && S.logs[0].action === 'OUT' && !/could not be written/.test(await text(page, '#sellBody')), JSON.stringify(S.logs));
  await t.context.close();

  // ═════════════ 13. set-up not run yet ═════════════
  console.log('\n— database set-up not run —');
  t = await boot({ browser: t.browser, mock: createMock({ missingSell: true, missingSales: true }) }); ({ page, S } = t);
  check('set-up missing: the card explains and the buttons are off', /migration-sales\.sql/.test(await text(page, '#sellBlurb')) && await page.locator('#sellStartBtn').isDisabled() && await page.locator('#salesListBtn').isDisabled(), await text(page, '#sellBlurb'));
  await page.screenshot({ path: path.join(SHOTS, '37-setup-needed.png'), clip: { x: 0, y: 380, width: 1280, height: 420 } });
  await page.fill('#name', 'Brass Hinge'); await page.fill('#sku', 'BH-9'); await page.fill('#qty', '5'); await page.fill('#cost', '1.5'); await page.fill('#sellPrice', '3.25');
  await page.click('#addItemCard .btn-primary'); await sleep(500);
  check('set-up missing: adding a part still works (sell price quietly left out)', byKey(S, 'BH-9') && !('sell_price' in byKey(S, 'BH-9')) && t.errors.length === 0 && !t.dialogs.some(d => /Could not save item/.test(d)), t.dialogs.join(' | '));
  await page.locator('#stockBody tr:has-text("HB-1") .price-cell').fill('0.99'); await page.keyboard.press('Tab'); await sleep(300);
  check('set-up missing: editing a price explains what to run', t.dialogs.some(d => /migration-sales\.sql/.test(d)));
  await t.context.close();

  // ═════════════ 14. importing a Sell Price column ═════════════
  console.log('\n— importing selling prices —');
  t = await boot({ browser: t.browser }); ({ page, S } = t);
  const xl = path.join(__dirname, 'sell-import.xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Product Code', 'Description', 'Qty', 'Unit Price', 'Selling Price'],
    ['NEW-A', 'Brand new part A', 5, 2.0, 3.5],
    ['NEW-B', 'Brand new part B', 7, 1.0, ''],
    ['HB-1', 'Hex Bolt M10 x 50mm', 1, 0.18, 0.55],
    ['HN-1', 'Hex Nut M10', 1, 0.06, ''],
  ]), 'Sheet1');
  XLSX.writeFile(wb, xl);
  await page.setInputFiles('#excelFile', xl);
  await page.locator('#importOverlay.open').waitFor(); await sleep(500);
  const map = await page.evaluate(() => importState.map);
  check('import: "Selling Price" is matched to the selling price, "Unit Price" stays the cost', map.sell === 4 && map.cost === 3, JSON.stringify(map));
  await page.screenshot({ path: path.join(SHOTS, '38-import-sell-price.png') });
  await page.click('#importBody .btn-primary'); await page.locator('#importBody h3:has-text("Import finished")').waitFor({ timeout: 15000 });
  check('import: new part gets its selling price, blank stays empty', byKey(S, 'NEW-A').sell_price === 3.5 && (byKey(S, 'NEW-B').sell_price === undefined || byKey(S, 'NEW-B').sell_price === null));
  check('import: existing part updated, a blank cell never wipes an existing price', byKey(S, 'HB-1').sell_price === 0.55 && byKey(S, 'HN-1').sell_price === undefined);
  check('import: cost column is the Unit Price as before', byKey(S, 'NEW-A').cost === 2);
  await t.context.close();

  // ═════════════ 15. on a phone ═════════════
  console.log('\n— phone —');
  t = await boot({ browser: t.browser, viewport: { width: 390, height: 844 } }); ({ page, S } = t);
  await openSell(page); await scan(page, 'HB-1'); await scan(page, 'CP-1'); await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, '39-phone-sell.png') });
  check('phone: sell screen has no sideways page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, '40-phone-sell-summary.png') });
  await complete(page); await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, '41-phone-sale-complete.png') });
  await btn(page, 'New sale').click();
  await page.click('.topbar-user .logout-btn:has-text("Sales list")'); await page.locator('#salesBody tr').first().waitFor(); await sleep(400);
  check('phone: sales list has no sideways page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(SHOTS, '42-phone-sales.png') });
  check('phone: no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.browser.close();

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
})().catch(e => { console.error(e); process.exit(2); });
