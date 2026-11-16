// Stock take: counting, review, applying, and the awkward cases (sales during the count, failed updates, whole-number databases).
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

const PARTS = [
  ['Hex Bolt M10 x 50mm', 'HB-1', 170, 0.18, 'Aisle A - Bay 1'],
  ['Hex Nut M10', 'HN-1', 490, 0.06, 'Aisle A - Bay 1'],
  ['Washer M10 Zinc', 'WS-1', 82, 0.03, 'Aisle A - Bay 2'],
  ['Wood Screw 4 x 40mm (box 200)', 'WSB', 52, 6.49, 'Aisle A - Bay 2'],
  ['Wall Plug Red', 'WP-1', 10, 0.10, 'Aisle A - Bay 3'],
  ['PVC Pipe 110mm x 3m', 'PV-1', 8, 18.75, 'Yard - Rack 2'],
  ['Copper Pipe 15mm x 3m', 'CP-1', 11, 14.2, 'Aisle B - Bay 1'],
  ['Cement 25kg', 'CM-1', 29, 6.25, 'Yard - Rack 1'],
  ['No-location part', 'NL-1', 5, 2.0, null],
];

async function boot({ wrap, viewport = { width: 1280, height: 860 }, mock = createMock(), keep } = {}) {
  const S = mock.state, O = mock.OWNER;
  S.stock.length = 0; PARTS.forEach(([name, sku, qty, cost, location]) => S.stock.push({ id: crypto.randomUUID(), owner_id: O, user_id: O, name, sku, qty, cost, location }));
  const browser = keep ? keep.browser : await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport, locale: 'en-GB', deviceScaleFactor: viewport.width < 600 ? 2 : 1 });
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', async route => { if (wrap && await wrap(route, mock)) return; return mock.handler(route); });
  await context.route(HOST + '/**', r => new URL(r.request().url()).pathname.startsWith(PAGE_PATH)
    ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(APP) }) : r.fulfill({ status: 204 }));
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await signIn(page);
  return { browser, context, page, mock, S, errors, dialogs };
}
async function signIn(page) {
  await page.goto(HOST + PAGE_PATH + 'index.html', { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.fill('#loginEmail', 'demo@example.com'); await page.fill('#loginPass', 'x'); await page.click('#loginForm .auth-btn');
  await page.locator('#appScreen').waitFor({ state: 'visible' });
  await page.locator('#stockBody tr').first().waitFor(); await sleep(600);
}
const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim());

async function startTake(page, { place, blind } = {}) {
  await page.click('#stockTakeStartBtn');
  await page.locator('#stockTakeOverlay.open').waitFor();
  if (place) { await page.check('input[name="stMode"][value="place"]'); await page.fill('#stPlace', place); }
  if (blind) await page.check('#stBlindChk');
  await page.click('#stGoBtn');
  await page.locator('#stockTakeScreen').waitFor({ state: 'visible' });
}
async function count(page, sku, qty) {
  await page.fill('#stScanBox', sku); await page.press('#stScanBox', 'Enter');
  await page.locator('#stCountInput').waitFor();
  await page.fill('#stCountInput', String(qty)); await page.press('#stCountInput', 'Enter');
  await page.locator('#stScanMsg:has-text("Saved")').waitFor();
}
async function finish(page) {
  await page.click('button:has-text("Finish stock take…")');
  await page.locator('#stockTakeBody h3:has-text("Finish stock take")').waitFor();
}
const byKey = (S, sku) => S.stock.find(s => s.sku === sku);

(async () => {
  // ═════════════ 1. the main run: one place, not blind ═════════════
  console.log('\n— main run: count Aisle A, plus one part from elsewhere —');
  let t = await boot();
  const { page, S, errors, dialogs } = t;
  check('dashboard shows the Stock take card', await page.locator('#stockTakeCard').isVisible() && /Start a stock take/.test(await text(page, '#stockTakeStartBtn')));
  await page.screenshot({ path: path.join(SHOTS, '18-dashboard-stocktake-card.png') });

  await page.click('#stockTakeStartBtn'); await page.locator('#stockTakeOverlay.open').waitFor();
  check('start dialog: "Start counting" is clear about everything', /Everything — 9 parts/.test(await text(page, '#stockTakeBody')));
  await page.check('input[name="stMode"][value="place"]');
  check('place option: start disabled until a place is typed', await page.locator('#stGoBtn').isDisabled());
  await page.fill('#stPlace', 'Aisle A');
  check('place option: says how many parts match', /5 parts have a location containing “Aisle A”/.test(await text(page, '#stPlaceCount')), await text(page, '#stPlaceCount'));
  check('place option: location suggestions offered', (await page.locator('#stPlaces option').count()) === 6, String(await page.locator('#stPlaces option').count()));
  await page.screenshot({ path: path.join(SHOTS, '19-stocktake-start.png') });
  await page.click('#stGoBtn');
  await page.locator('#stockTakeScreen').waitFor({ state: 'visible' });
  check('counting screen opens, dashboard hidden', !(await page.locator('#appScreen').isVisible()));
  check('progress starts at 0 of 5', (await text(page, '#stProgressTitle')) === '0 of 5 counted', await text(page, '#stProgressTitle'));
  check('"still to count" lists the 5 parts, in walking order (by location)', (await page.locator('#stBody tr').count()) === 5 && (await page.locator('#stBody tr').first().textContent()).includes('Hex Bolt'));
  check('scan box is ready for a scanner', await page.evaluate(() => document.activeElement.id === 'stScanBox'));
  await page.screenshot({ path: path.join(SHOTS, '20-stocktake-empty.png') });

  // scan + count
  await page.fill('#stScanBox', 'hb-1'); await page.press('#stScanBox', 'Enter');   // lower-case, like findBySku allows
  await page.locator('#stCountInput').waitFor();
  check('scanning a part shows it with the system quantity', /Hex Bolt M10 x 50mm/.test(await text(page, '#stCountBody')) && /System says: 170/.test(await text(page, '#stCountBody')), await text(page, '#stCountBody'));
  check('count box is focused, ready to type', await page.evaluate(() => document.activeElement.id === 'stCountInput'));
  await page.screenshot({ path: path.join(SHOTS, '21-stocktake-counting.png') });
  // blank entry is refused
  await page.press('#stCountInput', 'Enter');
  check('blank count is refused with a message', /Type how many you counted/.test(await text(page, '#stScanMsg')) && (await text(page, '#stProgressTitle')) === '0 of 5 counted');
  await page.fill('#stCountInput', '165'); await page.press('#stCountInput', 'Enter');
  await page.locator('#stScanMsg:has-text("Saved")').waitFor();
  check('saved message shows the difference', /counted 165, the system says 170 \(−5\)/.test(await text(page, '#stScanMsg')), await text(page, '#stScanMsg'));
  check('progress moves to 1 of 5', (await text(page, '#stProgressTitle')) === '1 of 5 counted');
  check('scan box refocused for the next scan', await page.evaluate(() => document.activeElement.id === 'stScanBox'));
  check('nothing has changed in the database yet', byKey(S, 'HB-1').qty === 170 && S.logs.length === 0);

  await count(page, 'HN-1', 490);   // matches
  await count(page, 'WS-1', 85);    // over by 3
  await page.fill('#stScanBox', 'NOPE-9'); await page.press('#stScanBox', 'Enter');
  check('unknown code: clear message, nothing selected', /Nothing in stock with the code “NOPE-9”/.test(await text(page, '#stScanMsg')) && (await page.locator('#stCountInput').count()) === 0);
  await count(page, 'PV-1', 9);     // outside Aisle A, over by 1
  check('a part from outside the list can still be counted', /\(\+1 outside this list\)/.test(await text(page, '#stProgressTitle')) && (await text(page, '#stProgressTitle')).startsWith('3 of 5'), await text(page, '#stProgressTitle'));

  await page.click('#stTabCounted');
  check('Counted tab shows 4 parts, newest first', (await page.locator('#stBody tr').count()) === 4 && (await page.locator('#stBody tr').first().textContent()).includes('PVC Pipe'));
  const rowsTxt = await text(page, '#stBody');
  check('Counted tab: matches / short / over badges', rowsTxt.includes('✓ matches') && rowsTxt.includes('−5 short') && rowsTxt.includes('+3 over') && rowsTxt.includes('+1 over'), rowsTxt);
  await page.screenshot({ path: path.join(SHOTS, '22-stocktake-counted.png') });

  // recount, then remove
  await page.locator('#stBody tr:has-text("Hex Bolt") button[title="Count it again"]').click();
  check('recount: previous count is prefilled and flagged', (await page.inputValue('#stCountInput')) === '165' && /Already counted: 165/.test(await text(page, '#stCountBody')));
  await page.fill('#stCountInput', '166'); await page.press('#stCountInput', 'Enter');
  await page.locator('#stScanMsg:has-text("Saved")').waitFor();
  check('recount replaces the earlier count', /−4 short/.test(await text(page, '#stBody')) && !/−5 short/.test(await text(page, '#stBody')));
  await page.fill('#stScanBox', 'WP-1'); await page.press('#stScanBox', 'Enter'); await page.locator('#stCountInput').waitFor();
  await page.fill('#stCountInput', '99'); await page.press('#stCountInput', 'Enter'); await page.locator('#stScanMsg:has-text("Saved")').waitFor();
  await page.locator('#stBody tr:has-text("Wall Plug") button[title="Remove this count"]').click();
  check('removing a count puts the part back in "still to count"', (await text(page, '#stTabTodo')).includes('(2)') && !(await text(page, '#stBody')).includes('Wall Plug'), await text(page, '#stTabTodo'));
  await page.fill('#stSearch', 'pvc'); await sleep(300);
  check('search narrows the list', (await page.locator('#stBody tr').count()) === 1);
  await page.fill('#stSearch', '');
  await page.locator('#stBody tr:has-text("PVC Pipe") button[title="Count it again"]').waitFor();

  // survives a refresh
  await page.reload({ waitUntil: 'load' });   // the session survives a refresh, so it signs straight back in
  await page.locator('#appScreen').waitFor({ state: 'visible' });
  await page.locator('#stockBody tr').first().waitFor(); await sleep(600);
  check('after a refresh the card says a stock take is in progress', /in progress.*whole shop|in progress \(locations containing/.test(await text(page, '#stockTakeBlurb')) && /3 of 5/.test(await text(page, '#stockTakeBlurb')) && (await text(page, '#stockTakeStartBtn')) === 'Continue counting', await text(page, '#stockTakeBlurb'));
  await page.click('#stockTakeStartBtn'); await page.locator('#stockTakeScreen').waitFor({ state: 'visible' });
  check('continuing restores every count', (await text(page, '#stProgressTitle')).startsWith('3 of 5') && (await text(page, '#stTabCounted')).includes('(4)'), await text(page, '#stProgressTitle') + ' / ' + await text(page, '#stTabCounted'));

  // review
  await finish(page);
  const rev = await text(page, '#stockTakeBody');
  check('review: counted 4, matched 1, different 3 (1 short, 2 over)', /Counted: 4 parts/.test(rev) && /Matched the system: 1/.test(rev) && /Different: 3 \(1 short, 2 over\)/.test(rev), rev);
  check('review: values (£0.72 short, £18.84 over, net £18.12)', /−£0\.72 short, £18\.84 over — net £18\.12/.test(rev), rev);
  check('review: says the uncounted parts are left alone', /4 parts in this stock take were not counted|2 parts in this stock take were not counted/.test(rev) && /stay exactly as they are/.test(rev), rev);
  await sleep(500); await page.screenshot({ path: path.join(SHOTS, '23-stocktake-review.png') });
  check('review itself changed nothing', byKey(S, 'HB-1').qty === 170 && S.logs.length === 0);

  await page.click('button:has-text("Update 3 parts")');
  await page.locator('#stockTakeBody h3:has-text("Stock take finished")').waitFor();
  check('applied: short part corrected', byKey(S, 'HB-1').qty === 166);
  check('applied: over parts corrected', byKey(S, 'WS-1').qty === 85 && byKey(S, 'PV-1').qty === 9);
  check('matched and uncounted parts untouched', byKey(S, 'HN-1').qty === 490 && byKey(S, 'WSB').qty === 52 && byKey(S, 'WP-1').qty === 10 && byKey(S, 'CP-1').qty === 11);
  const logs = S.logs.map(l => `${l.action}:${l.item.split(' ')[0]}:${l.qty}`).sort();
  check('Movement Log: COUNT OUT / COUNT IN, only for the 3 corrections', JSON.stringify(logs) === JSON.stringify(['COUNT IN:PVC:1', 'COUNT IN:Washer:3', 'COUNT OUT:Hex:4']), JSON.stringify(logs));
  check('log rows carry owner, user, date', S.logs.every(l => l.owner_id && l.user_id && !isNaN(Date.parse(l.date))));
  await sleep(500); await page.screenshot({ path: path.join(SHOTS, '24-stocktake-finished.png') });
  await page.click('button:has-text("Done")');
  await page.locator('#appScreen').waitFor({ state: 'visible' });
  check('back on the dashboard with the new quantities', (await text(page, '#stockBody')).includes('166'));
  check('card is back to "Start a stock take"', (await text(page, '#stockTakeStartBtn')) === 'Start a stock take');
  check('saved count removed from the browser', await page.evaluate(() => !Object.keys(localStorage).some(k => k.startsWith('pdsc_stocktake'))));
  check('no page errors in the main run', errors.length === 0, errors.join(' | '));
  await t.context.close();

  // ═════════════ 2. blind count ═════════════
  console.log('\n— blind count —');
  t = await boot({ keep: t, mock: createMock() });
  await startTake(t.page, { place: 'Aisle A', blind: true });
  await t.page.fill('#stScanBox', 'HB-1'); await t.page.press('#stScanBox', 'Enter'); await t.page.locator('#stCountInput').waitFor();
  check('blind: the system quantity is hidden while counting', !/System says/.test(await text(t.page, '#stCountBody')));
  await t.page.fill('#stCountInput', '150'); await t.page.press('#stCountInput', 'Enter'); await t.page.locator('#stScanMsg:has-text("Saved")').waitFor();
  check('blind: saved message does not reveal the system quantity', !/system says/i.test(await text(t.page, '#stScanMsg')), await text(t.page, '#stScanMsg'));
  await t.page.click('#stTabCounted');
  check('blind: list hides system quantity and difference', /shown at the end/.test(await text(t.page, '#stBody')) && !/short|over/.test(await text(t.page, '#stBody')));
  await t.page.click('#stTabTodo');
  check('blind: "still to count" has no System column', !(await text(t.page, '#stHead')).includes('System'));
  await t.page.screenshot({ path: path.join(SHOTS, '25-stocktake-blind.png') });
  await finish(t.page);
  check('blind: the review reveals the difference', /Different: 1 \(1 short, 0 over\)/.test(await text(t.page, '#stockTakeBody')) && /−20 short/.test(await text(t.page, '#stockTakeBody')), await text(t.page, '#stockTakeBody'));
  await t.context.close();

  // ═════════════ 3. a sale happens while counting ═════════════
  console.log('\n— a sale during the count —');
  t = await boot({ keep: t, mock: createMock() });
  await startTake(t.page);
  await count(t.page, 'HB-1', 165);                       // system said 170
  byKey(t.S, 'HB-1').qty = 168;                          // 2 sold at the counter meanwhile
  await finish(t.page);
  check('sale during count: review warns that stock has moved', /had stock movements since you counted/.test(await text(t.page, '#stockTakeBody')), await text(t.page, '#stockTakeBody'));
  await t.page.click('button:has-text("Update 1 part")');
  await t.page.locator('#stockTakeBody h3:has-text("Stock take finished")').waitFor();
  check('sale during count: 168 + (165 − 170) = 163, the sale is not wiped out', byKey(t.S, 'HB-1').qty === 163, String(byKey(t.S, 'HB-1').qty));
  check('sale during count: logged as COUNT OUT 5', t.S.logs.length === 1 && t.S.logs[0].action === 'COUNT OUT' && t.S.logs[0].qty === 5, JSON.stringify(t.S.logs));
  await t.context.close();

  // ═════════════ 4. nothing different / nothing counted ═════════════
  console.log('\n— everything matches / nothing counted —');
  t = await boot({ keep: t, mock: createMock() });
  await startTake(t.page, { place: 'Yard' });
  await t.page.click('button:has-text("Finish stock take…")');
  check('finishing with nothing counted is refused kindly', t.dialogs.some(d => /not counted anything/.test(d)));
  await count(t.page, 'PV-1', 8);
  await finish(t.page);
  check('all matched: says so, offers to finish, no update needed', /Everything you counted matched the system/.test(await text(t.page, '#stockTakeBody')) && (await text(t.page, '#stockTakeBody')).includes('Finish stock take'));
  await t.page.click('#stockTakeBody .btn-primary');
  await t.page.locator('#stockTakeBody h3:has-text("Stock take finished")').waitFor();
  check('all matched: "Nothing needed correcting", no logs written', /Nothing needed correcting/.test(await text(t.page, '#stockTakeBody')) && t.S.logs.length === 0);
  await t.context.close();

  // ═════════════ 5. cancel ═════════════
  console.log('\n— cancel —');
  t = await boot({ keep: t, mock: createMock() });
  await startTake(t.page);
  await count(t.page, 'HB-1', 1);
  await t.page.click('button:has-text("Cancel this stock take")');
  await t.page.locator('#appScreen').waitFor({ state: 'visible' });
  check('cancel: back on the dashboard, card reset, counts gone', (await text(t.page, '#stockTakeStartBtn')) === 'Start a stock take' && byKey(t.S, 'HB-1').qty === 170 && t.S.logs.length === 0);
  check('cancel asked first', t.dialogs.some(d => /Cancel this stock take\?/.test(d)));
  await t.context.close();

  // ═════════════ 6. the camera feeds the stock take ═════════════
  console.log('\n— camera —');
  t = await boot({ keep: t, mock: createMock() });
  await startTake(t.page);
  await t.page.evaluate(() => onCameraCode('CP-1'));
  await t.page.locator('#stCountInput').waitFor();
  check('a code from the camera goes to the stock take, not the dashboard', /Copper Pipe/.test(await text(t.page, '#stCountBody')) && !(await t.page.locator('#scanScreen').isVisible()));
  await t.context.close();

  // ═════════════ 7. database that only stores whole numbers ═════════════
  console.log('\n— whole-number database —');
  const wholeOnly = async route => {
    const req = route.request();
    if (req.method() === 'PATCH' && /\/rest\/v1\/stock\b/.test(req.url())) {
      const b = JSON.parse(req.postData() || '{}');
      if ('qty' in b && !Number.isInteger(b.qty)) { await route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: '22P02', message: 'invalid input syntax for type integer: "' + b.qty + '"' }) }); return true; }
    }
    return false;
  };
  t = await boot({ keep: t, mock: createMock(), wrap: wholeOnly });
  await startTake(t.page);
  await count(t.page, 'HB-1', 150.5);
  await finish(t.page);
  await t.page.click('button:has-text("Update 1 part")');
  await t.page.locator('#stockTakeBody h3:has-text("Stock take finished")').waitFor({ timeout: 8000 });
  check('whole-number DB: a part-quantity is rounded rather than failing', byKey(t.S, 'HB-1').qty === 151 && t.errors.length === 0, `${byKey(t.S, 'HB-1').qty} ${t.errors}`);
  await t.context.close();

  // ═════════════ 8. one update fails, then is retried ═════════════
  console.log('\n— a failed update, then a retry —');
  let breakWP = true;
  const flaky = async (route, mock) => {
    const req = route.request();
    if (breakWP && req.method() === 'PATCH' && /\/rest\/v1\/stock\b/.test(req.url())) {
      const id = new URL(req.url()).searchParams.get('id'); const part = mock.state.stock.find(s => 'eq.' + s.id === id);
      if (part && part.sku === 'WS-1') { await route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ message: 'database is having a moment' }) }); return true; }
    }
    return false;
  };
  t = await boot({ keep: t, mock: createMock(), wrap: flaky });
  await startTake(t.page);
  await count(t.page, 'HB-1', 160);   // −10
  await count(t.page, 'WS-1', 90);    // +8  (will fail)
  await finish(t.page);
  await t.page.click('button:has-text("Update 2 parts")');
  await t.page.locator('#stockTakeBody h3:has-text("Some parts could not be updated")').waitFor();
  check('failure: says which part failed and why', /Washer M10 Zinc — database is having a moment/.test(await text(t.page, '#stockTakeBody')), await text(t.page, '#stockTakeBody'));
  check('failure: the good one was applied, the failed one was not', byKey(t.S, 'HB-1').qty === 160 && byKey(t.S, 'WS-1').qty === 82);
  check('failure: only the successful update was logged', t.S.logs.length === 1 && t.S.logs[0].item.startsWith('Hex Bolt'));
  await t.page.click('#stockTakeBody .btn-primary');
  check('failure: the stock take is still open', (await t.page.locator('#stockTakeScreen').isVisible()));
  breakWP = false;
  await finish(t.page);
  check('retry: only the failed part is offered again', /Update 1 part/.test(await text(t.page, '#stockTakeBody')) && /Counted: 2 parts/.test(await text(t.page, '#stockTakeBody')), await text(t.page, '#stockTakeBody'));
  await t.page.click('button:has-text("Update 1 part")');
  await t.page.locator('#stockTakeBody h3:has-text("Stock take finished")').waitFor();
  check('retry: failed part now corrected, the first NOT applied twice', byKey(t.S, 'WS-1').qty === 90 && byKey(t.S, 'HB-1').qty === 160, `${byKey(t.S, 'WS-1').qty} ${byKey(t.S, 'HB-1').qty}`);
  check('retry: log has exactly two entries', t.S.logs.length === 2, JSON.stringify(t.S.logs.map(l => l.action + l.qty)));
  await t.context.close();

  // ═════════════ 9. database refuses the COUNT IN / COUNT OUT wording ═════════════
  console.log('\n— log wording refused by the database —');
  const strictLog = async route => {
    const req = route.request();
    if (req.method() === 'POST' && /\/rest\/v1\/stock_logs\b/.test(req.url())) {
      const rows = [].concat(JSON.parse(req.postData() || '[]'));
      if (rows.some(r => /^COUNT/.test(r.action))) { await route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: '23514', message: 'new row for relation "stock_logs" violates check constraint "stock_logs_action_check"' }) }); return true; }
    }
    return false;
  };
  t = await boot({ keep: t, mock: createMock(), wrap: strictLog });
  await startTake(t.page);
  await count(t.page, 'HB-1', 160);
  await finish(t.page);
  await t.page.click('button:has-text("Update 1 part")');
  await t.page.locator('#stockTakeBody h3:has-text("Stock take finished")').waitFor();
  check('log fallback: plain OUT is written instead, no warning', t.S.logs.length === 1 && t.S.logs[0].action === 'OUT' && t.S.logs[0].qty === 10 && !/could not be written/.test(await text(t.page, '#stockTakeBody')), JSON.stringify(t.S.logs));
  await t.context.close();

  // ═════════════ 10. on a phone ═════════════
  console.log('\n— phone —');
  t = await boot({ keep: t, mock: createMock(), viewport: { width: 390, height: 844 } });
  await t.page.screenshot({ path: path.join(SHOTS, '26-phone-dashboard-card.png'), clip: { x: 0, y: 380, width: 390, height: 464 } }).catch(() => {});
  await startTake(t.page, { place: 'Aisle A' });
  await t.page.fill('#stScanBox', 'HB-1'); await t.page.press('#stScanBox', 'Enter'); await t.page.locator('#stCountInput').waitFor();
  await sleep(500);
  await t.page.screenshot({ path: path.join(SHOTS, '27-phone-stocktake.png') });
  check('phone: no sideways page scroll', await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await t.page.fill('#stCountInput', '168'); await t.page.press('#stCountInput', 'Enter'); await t.page.locator('#stScanMsg:has-text("Saved")').waitFor();
  await finish(t.page); await sleep(300);
  await sleep(500); await t.page.screenshot({ path: path.join(SHOTS, '28-phone-review.png') });
  check('phone: review pop-up has no sideways scroll', await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  check('phone: no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.browser.close();

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
})().catch(e => { console.error(e); process.exit(2); });
