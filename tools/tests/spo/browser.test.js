// Browser suite for Supplier & Purchase Orders: drives the real page in Chrome against the pretend backend
// (mock-server.js), so nothing real is touched.
//   Run everything:   node tools/tests/spo/browser.test.js
//   Run one group:    node tools/tests/spo/browser.test.js xss
// Prints PASS/FAIL lines; the last line is ALL PASSED or N FAILED, and the exit code is 1 if anything failed.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startMock } = require('./mock-server');
const L = require('../../../supplier-purchase-order-system/spo-logic.js');

const APP_DIR = path.resolve(__dirname, '..', '..', '..', 'supplier-purchase-order-system');
const TODAY = L.todayISO(), YEAR = TODAY.slice(0, 4);
const ago = n => L.addDays(TODAY, -n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, passes = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || extra === '' ? '' : '   → ' + extra)); cond ? passes++ : fails++; };
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// ───────────── helpers ─────────────
async function open(browser, mock, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, locale: 'en-GB', timezoneId: 'Europe/London' });
  await context.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const problems = [], dialogs = [];
  page.on('pageerror', e => problems.push('page error: ' + e.message));
  page.on('console', m => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) problems.push('blocked by policy: ' + t); });
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.goto(mock.url, { waitUntil: 'load' });
  return { context, page, problems, dialogs };
}
function makeUser(mock, { trialDaysAgo = 1, subscribed = false } = {}) {
  const password = crypto.randomBytes(9).toString('base64url');
  const email = 'user-' + crypto.randomBytes(4).toString('hex') + '@example.test';
  const u = mock.createUser(email, password, {});
  mock.state.trialStart[u.id] = new Date(Date.now() - trialDaysAgo * 864e5).toISOString();
  if (subscribed) mock.insert('bt_subscriptions', { user_id: u.id, product: 'purchase-order-system', status: 'active' });
  return { id: u.id, email, password };
}
async function signIn(page, u, expectApp = true) {
  await page.fill('#login-email', u.email);
  await page.fill('#login-pass', u.password);
  await page.click('#login-btn');
  if (expectApp) { await page.locator('#app-screen').waitFor({ state: 'visible' }); await page.locator('#tiles .tile').first().waitFor(); }
}
const text = async (page, sel) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const visible = (page, sel) => page.locator(sel).isVisible();
const tab = async (page, name) => { await page.click(`[data-tab="${name}"]`); await page.locator(`#view-${name}`).waitFor({ state: 'visible' }); };
// Waits until the pop-up message on screen matches (so a message left over from the step before is never mistaken for it).
async function toastHas(page, re, { error = false, ms = 5000 } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.locator(error ? '#toast.show.error' : '#toast.show').count() && re.test(await text(page, '#toast'))) return true;
    await sleep(60);
  }
  return false;
}
const errorToast = (page, re) => toastHas(page, re, { error: true });
const rows = (mock, table, uid) => mock.state.tables[table].filter(r => r.user_id === uid);
const noSidewaysScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

function seedSupplier(mock, uid, name, extra = {}) {
  return mock.insert('spo_suppliers', Object.assign({ user_id: uid, name, contact: 'Sam', email: 'orders@' + name.toLowerCase().replace(/[^a-z]+/g, '-') + '.example', phone: '01632 960101', payment_terms_days: 30, lead_time_days: 2, account: 'ACC-1' }, extra));
}
// lines: [name, qty, price, received, jobRef, vatRate]
function seedOrder(mock, uid, supplier, n, { status = 'sent', date = ago(3), due = ago(1), lines, legacy = false, goodsIn, notes = null } = {}) {
  const items = lines.map(([name, qty, price, received = 0, jobRef = '', vatRate = legacy ? 0 : 20]) => ({ name, qty, price, qtyReceived: received, jobRef, vatRate }));
  const t = L.orderTotals(items);
  const po = mock.insert('spo_purchase_orders', { user_id: uid, supplier_id: supplier ? supplier.id : null, ref: L.poRef(YEAR, n), order_date: date, due_date: due, status,
    goods_in: goodsIn || L.deliveryState(items), notes, total: t.total, subtotal: legacy ? null : t.subtotal, vat_total: legacy ? null : t.vat, created_at: new Date(Date.now() - (1000 - n) * 1000).toISOString() });
  items.forEach((it, i) => mock.insert('spo_purchase_order_items', { user_id: uid, purchase_order_id: po.id, name: it.name, qty: it.qty, price: it.price, vat_rate: it.vatRate, qty_received: it.qtyReceived, job_ref: it.jobRef || null, position: i }));
  mock.state.tables.spo_counters = mock.state.tables.spo_counters.filter(c => c.user_id !== uid);
  mock.insert('spo_counters', { user_id: uid, next_po_number: n + 1 });
  return po;
}
async function fillLine(page, index, { name, job, qty, price, vat, notes }) {
  const row = page.locator('#po-items .item-row').nth(index);
  if (name !== undefined) { await row.locator('.item-name').fill(name); await row.locator('.item-name').dispatchEvent('change'); }
  if (job !== undefined) await row.locator('.item-job').fill(job);
  if (qty !== undefined) await row.locator('.item-qty').fill(String(qty));
  if (price !== undefined) await row.locator('.item-price').fill(String(price));
  if (vat !== undefined) await row.locator('.item-vat').selectOption(String(vat));
  if (notes !== undefined) await row.locator('.item-notes').fill(notes);
}
async function saveOrder(page, button = '#save-order-btn') { await page.click(button); await page.locator('#order-form').waitFor({ state: 'hidden' }); }
const orderRow = (page, ref) => page.locator(`#orders-list tr:has-text("${ref}")`);

const groups = {};
const group = (name, fn) => { groups[name] = fn; };

// ═════════════ SECURITY ═════════════
group('csp', async browser => {
  const htmlSrc = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
  const logicSrc = fs.readFileSync(path.join(APP_DIR, 'spo-logic.js'), 'utf8');
  const csp = (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(htmlSrc) || [])[1] || '';
  const scriptSrc = (/script-src ([^;]+)/.exec(csp) || [])[1] || '';
  check('csp: page declares a Content-Security-Policy', csp.includes("default-src 'none'"));
  check('csp: inline script is not allowed', scriptSrc !== '' && !scriptSrc.includes('unsafe-inline') && !scriptSrc.includes('unsafe-eval'), scriptSrc);
  check('csp: no inline event handlers in the page', !/<[^>]+\son[a-z]+\s*=/i.test(htmlSrc));
  check('csp: no inline <script> blocks', !/<script(?![^>]*\ssrc=)[^>]*>/i.test(htmlSrc));
  check('csp: Supabase library pinned to an exact version with an integrity hash', /supabase-js@\d+\.\d+\.\d+\/dist\/umd\/supabase\.js" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/.test(htmlSrc));
  check('csp: no eval / new Function / document.write in our code', !/\beval\s*\(|new Function|document\.write/.test(appSrc + logicSrc));
  eq('csp: the page is written to in exactly one guarded place (innerHTML)', (appSrc.match(/\.innerHTML\s*=/g) || []).length, 1);
  eq('csp: ...and one guarded place (insertAdjacentHTML)', (appSrc.match(/insertAdjacentHTML/g) || []).length, 1);
  check('csp: no file upload box left in the page', !/type="file"/.test(htmlSrc));

  const mock = await startMock();
  const { context, page, problems } = await open(browser, mock);
  const u = makeUser(mock);
  await signIn(page, u);
  eq('csp: normal use triggers no policy violations or page errors', problems.join(' | '), '');
  const ran = await page.evaluate(() => {
    const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.appendChild(s);
    const d = document.createElement('div'); d.setAttribute('onclick', 'window.__handler = 1'); document.body.appendChild(d); d.click();
    return { inline: window.__inline, handler: window.__handler };
  });
  check('csp: an injected inline script does not run', ran.inline === undefined);
  check('csp: an injected inline handler does not run', ran.handler === undefined);
  await context.close(); await mock.close();
});

group('auth', async browser => {
  const mock = await startMock();
  const { context, page, problems } = await open(browser, mock);
  const u = makeUser(mock);
  seedSupplier(mock, u.id, 'Secret Supplier Ltd');
  check('auth: app is hidden before sign-in', !(await visible(page, '#app-screen')) && await visible(page, '#auth-screen'));
  check('auth: no data is requested before sign-in', !mock.state.requests.some(r => r.path.startsWith('/rest/v1/spo_')));
  check('auth: nothing from the account is in the page before sign-in', !(await page.content()).includes('Secret Supplier'));

  await page.fill('#login-email', u.email); await page.fill('#login-pass', 'wrong-' + u.password); await page.click('#login-btn');
  await page.locator('#auth-error').waitFor({ state: 'visible' });
  eq('auth: wrong password gives a plain message', await text(page, '#auth-error'), 'Email or password is incorrect.');
  check('auth: wrong password does not open the app', !(await visible(page, '#app-screen')));

  await page.click('#tab-signup');
  await page.fill('#signup-first', 'Test'); await page.fill('#signup-last', 'User');
  const fresh = 'new-' + crypto.randomBytes(4).toString('hex') + '@example.test', pw = crypto.randomBytes(9).toString('base64url');
  await page.fill('#signup-email', fresh); await page.fill('#signup-pass', pw.slice(0, 7)); await page.fill('#signup-conf', pw.slice(0, 7));
  await page.click('#signup-btn');
  check('auth: a 7-character password is refused', /8 characters/.test(await text(page, '#auth-error')));
  check('auth: ...without contacting the server', !mock.state.requests.some(r => r.path === '/auth/v1/signup'));
  await page.fill('#signup-pass', pw); await page.fill('#signup-conf', pw + 'x'); await page.click('#signup-btn');
  check('auth: mismatched passwords are refused', /do not match/i.test(await text(page, '#auth-error')));

  await page.fill('#signup-email', u.email); await page.fill('#signup-pass', pw); await page.fill('#signup-conf', pw); await page.click('#signup-btn');
  await sleep(600);
  const dupMsg = await text(page, '#auth-error');
  check('auth: signing up with an existing email gives a generic message', dupMsg !== '' && !/already registered/i.test(dupMsg), dupMsg);

  await page.fill('#signup-email', fresh); await page.click('#signup-btn');
  await page.locator('#app-screen').waitFor({ state: 'visible' });
  check('auth: a new account goes straight in on its free trial', /30 days/.test(await text(page, '#trial-days')));
  check('auth: a new account sees none of another account\'s data', !(await page.content()).includes('Secret Supplier'));

  await page.click('#logout-btn');
  await page.locator('#auth-screen').waitFor({ state: 'visible' });
  check('auth: logging out hides the app', !(await visible(page, '#app-screen')));
  eq('auth: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

group('billing', async browser => {
  const mock = await startMock();
  const expired = makeUser(mock, { trialDaysAgo: 40 });
  seedSupplier(mock, expired.id, 'Locked Away Ltd');
  let s = await open(browser, mock);
  await signIn(s.page, expired, false);
  await s.page.locator('#billing-screen').waitFor({ state: 'visible' });
  check('billing: trial over and no subscription → billing screen only', !(await visible(s.page, '#app-screen')));
  check('billing: no way back into the app from the locked screen', !(await visible(s.page, '#billing-back-btn')));
  check('billing: the app did not load any data while locked', !mock.state.requests.some(r => r.userId === expired.id && r.path.startsWith('/rest/v1/spo_')));
  check('billing: price shown is £32.00', /£32\.00/.test(await text(s.page, '#billing-screen')));
  await s.page.click('#subscribe-btn');
  await s.page.waitForURL(/payment=cancel|supplier-purchase-order-system\/$/);
  await s.page.locator('#billing-screen').waitFor({ state: 'visible' });
  check('billing: coming back from a cancelled checkout is still locked', !(await visible(s.page, '#app-screen')));
  const sent = mock.state.requests.find(r => r.path === '/functions/v1/create-checkout-session');
  check('billing: checkout is started through the existing server function', !!sent && sent.userId === expired.id);
  await s.context.close();

  const paid = makeUser(mock, { trialDaysAgo: 40, subscribed: true });
  s = await open(browser, mock);
  await signIn(s.page, paid);
  check('billing: an active subscriber gets in after the trial', /Subscribed/.test(await text(s.page, '#trial-days')));
  await s.context.close();

  const trial = makeUser(mock, { trialDaysAgo: 3 });
  s = await open(browser, mock);
  await signIn(s.page, trial);
  await s.page.click('#billing-btn');
  await s.page.locator('#billing-screen').waitFor({ state: 'visible' });
  check('billing: during the trial the billing screen can be closed again', await visible(s.page, '#billing-back-btn'));
  await s.page.click('#billing-back-btn');
  check('billing: ...and returns to the app', await visible(s.page, '#app-screen'));
  eq('billing: no page errors', s.problems.join(' | '), '');
  await s.context.close(); await mock.close();
});

group('xss', async browser => {
  const mock = await startMock();
  const u = makeUser(mock);
  const { context, page, problems } = await open(browser, mock);
  await signIn(page, u);
  const EVIL_SUP = '<img src=x onerror="window.__xss=1">Evil & Sons';
  const EVIL_PART = '17" tyre <script>window.__xss=1</script>';
  const EVIL_JOB = '"><svg onload=window.__xss=1>';

  // typed in through the forms
  await tab(page, 'suppliers'); await page.click('#new-supplier-btn');
  await page.fill('#sup-name', EVIL_SUP); await page.fill('#sup-contact', '<b onmouseover=window.__xss=1>Bob</b>');
  await page.fill('#sup-address', '</textarea><script>window.__xss=1</script>\nLine 2'); await page.fill('#sup-email', 'orders@evil.example');
  await page.click('#save-supplier-btn'); await page.locator('#supplier-form').waitFor({ state: 'hidden' });
  check('xss: hostile supplier name is shown as plain text', (await text(page, '#supplier-list')).includes('<img src=x onerror="window.__xss=1">Evil & Sons'));
  await page.click('#supplier-list [data-action="edit-supplier"]');
  eq('xss: supplier name round-trips through the edit form', await page.inputValue('#sup-name'), EVIL_SUP);
  eq('xss: supplier address round-trips through the edit form', await page.inputValue('#sup-address'), '</textarea><script>window.__xss=1</script>\nLine 2');
  await page.click('[data-action="cancel-supplier"]');

  await page.click('#settings-btn'); await page.fill('#set-name', '<script>window.__xss=1</script>My Garage'); await page.fill('#set-address', '<img src=x onerror=window.__xss=1>');
  await page.click('#save-settings-btn'); await toastHas(page, /saved/i);

  await tab(page, 'orders'); await page.click('#new-order-btn');
  await fillLine(page, 0, { name: EVIL_PART, job: EVIL_JOB, qty: 2, price: 50, notes: '<i onclick=window.__xss=1>note</i>' });
  await page.fill('#po-notes', '<script>window.__xss=1</script> deliver "round the back"');
  await saveOrder(page, '#save-print-btn');
  check('xss: hostile part name saved exactly as typed', rows(mock, 'spo_purchase_order_items', u.id)[0].name === EVIL_PART);
  const printed = await page.innerHTML('#print-area');
  check('xss: printed order shows the text, escaped', printed.includes('17&quot; tyre &lt;script&gt;') || printed.includes('17" tyre &lt;script&gt;'), printed.slice(0, 300));
  eq('xss: printed order contains no script or image elements', await page.locator('#print-area script, #print-area img, #print-area svg, #print-area [onclick], #print-area [onload], #print-area [onerror]').count(), 0);

  await page.fill('#search', 'tyre');
  check('xss: order can be found by its part name', await orderRow(page, L.poRef(YEAR, 1)).count() === 1);
  await page.fill('#search', '');
  await orderRow(page, L.poRef(YEAR, 1)).locator('[data-action="edit-order"]').click();
  eq('xss: part name with a quote mark round-trips through the order form', await page.inputValue('#po-items .item-name'), EVIL_PART);
  eq('xss: job/reg round-trips through the order form', await page.inputValue('#po-items .item-job'), EVIL_JOB);
  await page.click('#cancel-order-btn');

  // arriving in the data by some other route (bypassing the forms), including in fields the page uses for styling
  const sup2 = seedSupplier(mock, u.id, '<svg/onload=window.__xss=1>Direct');
  const po = seedOrder(mock, u.id, sup2, 2, { lines: [['<img src=x onerror=window.__xss=1>', 1, 10, 1, '<script>window.__xss=1</script>']] });
  po.status = '"><img src=x onerror=window.__xss=1>'; po.goods_in = 'x" onmouseover="window.__xss=1'; po.ref = 'PO-<b>bold</b>';
  mock.insert('spo_returns', { user_id: u.id, supplier_id: sup2.id, item_name: '<img src=x onerror=window.__xss=1>', reason: '"><script>window.__xss=1</script>', status: 'x" onclick="window.__xss=1', credit_ref: '<script>window.__xss=1</script>', notes: '<img src=x onerror=window.__xss=1>' });
  mock.insert('spo_price_history', { user_id: u.id, supplier_id: sup2.id, item_name: '<img src=x onerror=window.__xss=1>', price: 5, recorded_date: TODAY });
  await page.reload({ waitUntil: 'load' });
  await page.locator('#tiles .tile').first().waitFor();
  for (const name of ['home', 'orders', 'goodsin', 'returns', 'suppliers', 'prices']) { await tab(page, name); await sleep(150); }
  await tab(page, 'returns'); await page.click('[data-rfilter="all"]'); await sleep(100);
  await tab(page, 'orders'); await page.click('#reorder-btn'); await sleep(150); await page.click('[data-action="close-reorder"]');
  check('xss: hostile order number is shown as plain text', (await text(page, '#orders-list')).includes('PO-<b>bold</b>'));
  eq('xss: no injected elements anywhere in the app', await page.locator('#app-screen img, #app-screen script, #app-screen svg[onload], #app-screen [onerror], #app-screen [onmouseover], #app-screen [onclick], #app-screen b:not([class])').count(), 0);
  check('xss: nothing hostile ever ran', (await page.evaluate(() => window.__xss)) === undefined);
  eq('xss: no page errors or policy violations', problems.join(' | '), '');
  await context.close(); await mock.close();
});

group('account-switch', async browser => {
  const mock = await startMock();
  const a = makeUser(mock), b = makeUser(mock);
  const sup = seedSupplier(mock, a.id, 'Alpha Private Supplies');
  seedOrder(mock, a.id, sup, 1, { lines: [['Alpha secret part', 1, 99, 1, 'AA11 AAA']], notes: 'alpha private note' });
  mock.insert('spo_returns', { user_id: a.id, supplier_id: sup.id, item_name: 'Alpha secret return', amount: 5 });
  mock.insert('spo_settings', { user_id: a.id, business_name: 'Alpha Garage Ltd' });
  const { context, page, problems } = await open(browser, mock);
  await signIn(page, a);
  await tab(page, 'orders');
  await orderRow(page, L.poRef(YEAR, 1)).locator('[data-action="print-order"]').click();
  await orderRow(page, L.poRef(YEAR, 1)).locator('[data-action="edit-order"]').click();
  await page.click('#settings-btn');
  check('account-switch: A sees their own data', (await page.content()).includes('Alpha'));
  await page.click('#logout-btn'); await page.locator('#auth-screen').waitFor({ state: 'visible' });
  const afterLogout = await page.evaluate(() => document.body.innerHTML + [...document.querySelectorAll('input, textarea, select')].map(e => e.value).join('|'));
  check('account-switch: nothing of A is left in the page after logging out', !/alpha/i.test(afterLogout), (afterLogout.match(/.{40}alpha.{40}/i) || [''])[0]);
  await signIn(page, b);
  for (const name of ['orders', 'goodsin', 'returns', 'suppliers', 'prices']) { await tab(page, name); }
  await page.click('#settings-btn');
  const asB = await page.evaluate(() => document.body.innerHTML + [...document.querySelectorAll('input, textarea, select')].map(e => e.value).join('|'));
  check('account-switch: B sees none of A\'s data on any screen', !/alpha/i.test(asB), (asB.match(/.{40}alpha.{40}/i) || [''])[0]);
  check('account-switch: every data request B made was as B', mock.state.requests.filter(r => r.path.startsWith('/rest/v1/spo_')).every(r => r.userId === a.id || r.userId === b.id));
  eq('account-switch: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

group('errors', async browser => {
  const mock = await startMock();
  const u = makeUser(mock);
  const { context, page, problems } = await open(browser, mock);
  await signIn(page, u);
  await tab(page, 'suppliers'); await page.click('#new-supplier-btn'); await page.fill('#sup-name', 'Will Fail Ltd');
  mock.state.failNext = { table: 'spo_suppliers', method: 'POST' };
  await page.click('#save-supplier-btn');
  check('errors: a server failure shows a plain message', await errorToast(page, /couldn't save the supplier/i));
  check('errors: ...with no technical detail', !/db\.internal|10\.0\.0\.7|XX000|connection/i.test(await page.evaluate(() => document.body.innerText)));
  check('errors: the form stays open so nothing typed is lost', await visible(page, '#supplier-form') && (await page.inputValue('#sup-name')) === 'Will Fail Ltd');
  await page.click('#save-supplier-btn'); await page.locator('#supplier-form').waitFor({ state: 'hidden' });
  eq('errors: saving again works', rows(mock, 'spo_suppliers', u.id).length, 1);

  await page.click('#new-supplier-btn'); await page.fill('#sup-name', 'Bad Email Ltd'); await page.fill('#sup-email', 'not-an-email');
  await page.click('#save-supplier-btn');
  check('errors: a bad email address is refused in plain words', await errorToast(page, /email/i));
  eq('errors: ...and nothing is saved', rows(mock, 'spo_suppliers', u.id).length, 1);
  await page.click('[data-action="cancel-supplier"]');

  mock.state.failNext = { table: 'spo_returns', method: 'GET' };
  await page.reload({ waitUntil: 'load' }); await page.locator('#tiles .tile').first().waitFor();
  check('errors: if part of the data cannot be loaded, a banner says so', await visible(page, '#load-banner'));
  await tab(page, 'suppliers');
  check('errors: ...and the rest of the app still works', (await text(page, '#supplier-list')).includes('Will Fail Ltd'));
  eq('errors: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

// ═════════════ FEATURES ═════════════
group('suppliers', async browser => {
  const mock = await startMock();
  const u = makeUser(mock);
  const { context, page, problems, dialogs } = await open(browser, mock);
  await signIn(page, u);
  check('suppliers: a new account sees the getting-started list', await visible(page, '#checklist-card'));
  await tab(page, 'suppliers');
  check('suppliers: empty state invites adding one', /add supplier/i.test(await text(page, '#suppliers-empty')));
  await page.click('#new-supplier-btn');
  await page.click('#save-supplier-btn');
  check('suppliers: company name is required', await errorToast(page, /name/i));
  await page.fill('#sup-name', 'Northgate Factors'); await page.fill('#sup-contact', 'Sam Carter'); await page.fill('#sup-email', 'orders@northgate.example');
  await page.fill('#sup-phone', '01632 960101'); await page.selectOption('#sup-terms', '60'); await page.fill('#sup-account', 'NG-1'); await page.fill('#sup-lead', '3');
  await page.click('#save-supplier-btn'); await page.locator('#supplier-form').waitFor({ state: 'hidden' });
  const saved = rows(mock, 'spo_suppliers', u.id)[0];
  check('suppliers: saved with terms and delivery time', saved.name === 'Northgate Factors' && saved.payment_terms_days === 60 && saved.lead_time_days === 3 && saved.user_id === u.id);
  const listed = await text(page, '#supplier-list');
  check('suppliers: listed with contact, terms and delivery time', /Northgate Factors/.test(listed) && /Sam Carter/.test(listed) && /60 days/.test(listed) && /3 days/.test(listed), listed);
  eq('suppliers: phone is a tap-to-call link', await page.getAttribute('#supplier-list a[href^="tel:"]', 'href'), 'tel:01632960101');
  check('suppliers: email is a mailto link', (await page.getAttribute('#supplier-list a[href^="mailto:"]', 'href')).startsWith('mailto:orders@northgate.example'));

  await page.click('#supplier-list [data-action="edit-supplier"]');
  eq('suppliers: edit form is filled in', await page.inputValue('#sup-name'), 'Northgate Factors');
  await page.fill('#sup-name', 'Northgate Motor Factors'); await page.click('#save-supplier-btn'); await page.locator('#supplier-form').waitFor({ state: 'hidden' });
  check('suppliers: edit updates the same row', rows(mock, 'spo_suppliers', u.id).length === 1 && rows(mock, 'spo_suppliers', u.id)[0].name === 'Northgate Motor Factors');

  seedOrder(mock, u.id, saved, 1, { lines: [['Pads', 1, 100, 0]] });
  await page.reload({ waitUntil: 'load' }); await page.locator('#tiles .tile').first().waitFor(); await tab(page, 'suppliers');
  check('suppliers: shows order count and 12-month spend', /1 open/.test(await text(page, '#supplier-list')) && /£120\.00/.test(await text(page, '#supplier-list')), await text(page, '#supplier-list'));
  await page.click('#supplier-list [data-action="delete-supplier"]');
  await page.locator('#suppliers-empty').waitFor({ state: 'visible' });
  check('suppliers: delete asks first and warns about its orders', dialogs.length === 1 && /1 order/.test(dialogs[0]), dialogs.join('|'));
  eq('suppliers: deleted', rows(mock, 'spo_suppliers', u.id).length, 0);
  await tab(page, 'orders');
  check('suppliers: its order is kept, shown as unknown supplier', /Unknown supplier/.test(await text(page, '#orders-list')));
  eq('suppliers: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

group('orders', async browser => {
  const mock = await startMock();
  const u = makeUser(mock);
  const sup = seedSupplier(mock, u.id, 'Northgate Factors', { payment_terms_days: 60, lead_time_days: 3 });
  seedSupplier(mock, u.id, 'Tyre Co', { payment_terms_days: 30, lead_time_days: 0, email: null });
  const { context, page, problems, dialogs } = await open(browser, mock);
  await signIn(page, u);

  await page.click('#settings-btn');
  await page.fill('#set-name', 'My Garage Ltd'); await page.fill('#set-address', '1 High Street\nAnytown'); await page.fill('#set-vat-number', 'GB 000 0000 00');
  await page.click('#save-settings-btn'); await toastHas(page, /details saved/i);
  eq('orders: business details saved', rows(mock, 'spo_settings', u.id)[0].business_name, 'My Garage Ltd');

  await tab(page, 'orders'); await page.click('#new-order-btn');
  await page.selectOption('#po-supplier', { label: 'Northgate Factors' });
  eq('orders: new order gets the next number', await page.inputValue('#po-ref'), L.poRef(YEAR, 1));
  eq('orders: payment terms come from the supplier', await page.inputValue('#po-payment-terms'), '60');
  eq('orders: expected delivery is order date + the supplier\'s delivery time', await page.inputValue('#po-due-date'), L.addDays(TODAY, 3));
  await page.selectOption('#po-supplier', { label: 'Tyre Co' });
  eq('orders: changing supplier updates the terms', await page.inputValue('#po-payment-terms'), '30');
  await page.selectOption('#po-supplier', { label: 'Northgate Factors' });

  await page.click('#save-order-btn');
  check('orders: an order with no items is refused', await errorToast(page, /item/i));
  eq('orders: new lines start at the usual VAT rate', await page.inputValue('#po-items .item-vat'), '20');
  await fillLine(page, 0, { name: 'Brake pads front', job: 'AB12 CDE', qty: 2, price: 10.50 });
  await page.click('#add-item-btn');
  await fillLine(page, 1, { name: 'Service kit', qty: 1, price: 100, vat: 5, notes: 'blue box' });
  eq('orders: subtotal', await text(page, '#po-subtotal'), '£121.00');
  eq('orders: VAT', await text(page, '#po-vat'), '£9.20');
  eq('orders: total', await text(page, '#po-total'), '£130.20');
  await page.fill('#po-items .item-row:nth-child(1) .item-qty', '0');
  await page.click('#save-order-btn');
  check('orders: a quantity of 0 is refused', await errorToast(page, /quantity/i));
  await page.fill('#po-items .item-row:nth-child(1) .item-qty', '2');
  await page.selectOption('#po-status', 'sent');
  await saveOrder(page);

  const po = rows(mock, 'spo_purchase_orders', u.id)[0], items = rows(mock, 'spo_purchase_order_items', u.id).sort((x, y) => x.position - y.position);
  check('orders: saved with VAT breakdown', po.subtotal === 121 && po.vat_total === 9.2 && po.total === 130.2 && po.status === 'sent' && po.goods_in === 'no', JSON.stringify(po));
  check('orders: lines saved in order with job/reg and VAT rate', items.length === 2 && items[0].job_ref === 'AB12 CDE' && items[0].vat_rate === 20 && items[1].vat_rate === 5 && items[1].position === 1 && items[1].notes === 'blue box', JSON.stringify(items));
  eq('orders: the order number counter moved on', rows(mock, 'spo_counters', u.id)[0].next_po_number, 2);
  eq('orders: each price is logged once', rows(mock, 'spo_price_history', u.id).length, 2);
  const row = await text(page, '#orders-list');
  check('orders: listed with supplier, status and total', /Northgate Factors/.test(row) && /Sent/.test(row) && /£130\.20/.test(row), row);

  // searching and filtering
  for (const [q, n] of [['brake', 1], ['ab12', 1], ['northgate', 1], ['blue box', 1], ['zzz', 0]]) {
    await page.fill('#search', q); await sleep(80);
    eq(`orders: search "${q}"`, await page.locator('#orders-list tr').count(), n);
  }
  await page.fill('#search', '');
  await page.click('[data-filter="draft"]'); eq('orders: Draft chip hides a sent order', await page.locator('#orders-list tr').count(), 0);
  await page.click('[data-filter="sent"]'); eq('orders: Sent chip shows it', await page.locator('#orders-list tr').count(), 1);
  await page.click('[data-filter="all"]');

  // editing: no duplicate price history, same line rows
  const idsBefore = items.map(i => i.id).join(',');
  await orderRow(page, po.ref).locator('[data-action="edit-order"]').click();
  check('orders: the form shows the last price paid', /Last paid £10\.50/.test(await text(page, '#po-items .item-row:nth-child(1) .item-hint')));
  await page.fill('#po-notes', 'Ring before delivery');
  await saveOrder(page);
  eq('orders: re-saving does not log the same prices again', rows(mock, 'spo_price_history', u.id).length, 2);
  eq('orders: lines keep their identity when the order is edited', rows(mock, 'spo_purchase_order_items', u.id).sort((x, y) => x.position - y.position).map(i => i.id).join(','), idsBefore);
  await orderRow(page, po.ref).locator('[data-action="edit-order"]').click();
  await page.fill('#po-items .item-row:nth-child(1) .item-price', '12');
  check('orders: a price rise is pointed out', /more than last time/.test(await text(page, '#po-items .item-row:nth-child(1) .item-hint')));
  await page.locator('#po-items .item-row').nth(1).locator('.item-remove').click();
  await saveOrder(page);
  eq('orders: a changed price is logged', rows(mock, 'spo_price_history', u.id).length, 3);
  eq('orders: a removed line is deleted', rows(mock, 'spo_purchase_order_items', u.id).length, 1);
  eq('orders: totals follow the edit', rows(mock, 'spo_purchase_orders', u.id)[0].total, 28.8);

  // print and email
  await orderRow(page, po.ref).locator('[data-action="print-order"]').click();
  const printed = await text(page, '#print-area');
  check('orders: printed order names both businesses and the totals', /My Garage Ltd/.test(printed) && /1 High Street/.test(printed) && /Northgate Factors/.test(printed) && printed.includes(po.ref) && /£28\.80/.test(printed) && /AB12 CDE/.test(printed) && /GB 000 0000 00/.test(printed), printed);
  eq('orders: the print dialog was opened once', await page.evaluate(() => window.__printed), 1);
  await orderRow(page, po.ref).locator('[data-action="edit-order"]').click();
  await page.click('#save-email-btn'); await page.locator('#order-form').waitFor({ state: 'hidden' });
  const mail = decodeURIComponent(await page.getAttribute('#mail-link', 'href'));
  check('orders: email draft is addressed to the supplier with the order in it', mail.startsWith('mailto:orders@northgate-factors.example?subject=Purchase Order ' + po.ref + ' from My Garage Ltd') && /Brake pads front/.test(mail) && /Total: £28\.80/.test(mail), mail.slice(0, 200));

  // order again
  await orderRow(page, po.ref).locator('[data-action="again-order"]').click();
  eq('orders: "Order again" starts a new order with the next number', await page.inputValue('#po-ref'), L.poRef(YEAR, 2));
  eq('orders: ...as a draft', await page.inputValue('#po-status'), 'draft');
  eq('orders: ...with the same part', await page.inputValue('#po-items .item-name'), 'Brake pads front');
  await saveOrder(page);
  eq('orders: two orders now', rows(mock, 'spo_purchase_orders', u.id).length, 2);

  // a supplier with no email
  await page.click('#new-order-btn'); await page.selectOption('#po-supplier', { label: 'Tyre Co' });
  await fillLine(page, 0, { name: 'Tyre 205/55', qty: 4, price: 60 });
  await page.click('#save-email-btn');
  check('orders: emailing a supplier with no address explains why not', await errorToast(page, /no email/i));
  check('orders: ...but the order itself is still saved', rows(mock, 'spo_purchase_orders', u.id).length === 3);

  // delete
  const n = dialogs.length;
  await page.locator('#order-form').waitFor({ state: 'hidden' });
  await orderRow(page, L.poRef(YEAR, 3)).locator('[data-action="delete-order"]').click();
  await orderRow(page, L.poRef(YEAR, 3)).waitFor({ state: 'detached' });
  check('orders: delete asks first', dialogs.length === n + 1 && dialogs[n].includes(L.poRef(YEAR, 3)));
  check('orders: deleting removes the order and its lines', rows(mock, 'spo_purchase_orders', u.id).length === 2 && !rows(mock, 'spo_purchase_order_items', u.id).some(i => i.name === 'Tyre 205/55'));
  await page.click('#new-order-btn');
  eq('orders: a deleted order\'s number is never reused', await page.inputValue('#po-ref'), L.poRef(YEAR, 4));
  eq('orders: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

group('receiving', async browser => {
  const mock = await startMock();
  const u = makeUser(mock);
  const sup = seedSupplier(mock, u.id, 'Northgate Factors');
  const po = seedOrder(mock, u.id, sup, 1, { status: 'sent', due: ago(2), lines: [['Timing belt kit', 4, 20, 0, 'LM68 XYZ'], ['Water pump', 2, 44, 0], ['Oil filter', 1, 5, 0]] });
  const legacy = seedOrder(mock, u.id, sup, 2, { status: 'sent', due: L.addDays(TODAY, 5), legacy: true, goodsIn: 'partial', lines: [['Old wiper', 4, 5, 0]] });
  seedOrder(mock, u.id, sup, 3, { status: 'delivered', due: ago(20), date: ago(25), legacy: true, goodsIn: 'yes', lines: [['Old bulb', 2, 1.5, 0]] });
  const lineOf = name => mock.state.tables.spo_purchase_order_items.find(i => i.name === name);
  const { context, page, problems, dialogs } = await open(browser, mock);
  await signIn(page, u);

  eq('receiving: Home shows one overdue order', await text(page, '[data-tile="overdue"] .tile-value'), '1');
  eq('receiving: the Goods In tab is flagged', await text(page, '#count-goodsin'), '1');
  await tab(page, 'orders');
  check('receiving: the late order is marked overdue', /Overdue/.test(await text(page, `#orders-list tr:has-text("${po.ref}")`)));
  check('receiving: an order from before the upgrade keeps its "part delivered" mark', /Part delivered/.test(await text(page, `#orders-list tr:has-text("${legacy.ref}")`)));
  check('receiving: an old fully delivered order shows as delivered with its old total', /Delivered/.test(await text(page, `#orders-list tr:has-text("${L.poRef(YEAR, 3)}")`)) && /£3\.00/.test(await text(page, `#orders-list tr:has-text("${L.poRef(YEAR, 3)}")`)));

  await tab(page, 'goodsin');
  eq('receiving: only orders still to arrive are listed', await page.locator('#goodsin-list tr').count(), 2);
  await page.locator(`#goodsin-list tr:has-text("${po.ref}") [data-action="receive-order"]`).click();
  await page.locator('#receive-panel').waitFor({ state: 'visible' });
  eq('receiving: "arrived now" starts as what is outstanding', (await page.locator('.receive-now').evaluateAll(els => els.map(e => e.value))).join(','), '4,2,1');
  await page.locator('.receive-now').nth(0).fill('2'); await page.locator('.receive-now').nth(1).fill('0');
  await page.click('#receive-save-btn'); await page.locator('#receive-panel').waitFor({ state: 'hidden' });
  check('receiving: part delivery recorded per line', lineOf('Timing belt kit').qty_received === 2 && lineOf('Water pump').qty_received === 0 && lineOf('Oil filter').qty_received === 1);
  check('receiving: order becomes part delivered and stays open', po.goods_in === 'partial' && po.status === 'sent' && !po.delivered_date, JSON.stringify(po));
  check('receiving: progress is shown', /3 of 7/.test(await text(page, `#goodsin-list tr:has-text("${po.ref}")`)), await text(page, `#goodsin-list tr:has-text("${po.ref}")`));

  // editing a part-received order keeps what was received
  await tab(page, 'orders');
  await orderRow(page, po.ref).locator('[data-action="edit-order"]').click();
  await page.fill('#po-notes', 'Chased supplier');
  await saveOrder(page);
  check('receiving: editing the order keeps the received quantities', lineOf('Timing belt kit').qty_received === 2 && lineOf('Oil filter').qty_received === 1 && po.goods_in === 'partial' && po.notes === 'Chased supplier');
  await orderRow(page, po.ref).locator('[data-action="edit-order"]').click();
  await page.fill('#po-items .item-row:nth-child(1) .item-qty', '1');
  await page.click('#save-order-btn');
  check('receiving: quantity cannot be cut below what has arrived', await errorToast(page, /already received/i));
  eq('receiving: ...and nothing changed', lineOf('Timing belt kit').qty, 4);
  await page.click('#cancel-order-btn');

  await tab(page, 'goodsin');
  await page.locator(`#goodsin-list tr:has-text("${po.ref}") [data-action="receive-order"]`).click();
  eq('receiving: only what is still to come is asked for', (await page.locator('.receive-now').evaluateAll(els => els.map(e => e.value))).join(','), '2,2');
  await page.locator('.receive-now').nth(0).fill('5');
  await page.click('#receive-save-btn');
  check('receiving: more than is outstanding is refused', await errorToast(page, /is still to come/i));
  eq('receiving: ...and nothing changed', lineOf('Timing belt kit').qty_received, 2);
  await page.locator('.receive-now').nth(0).fill('2');
  await page.click('#receive-save-btn'); await page.locator('#receive-panel').waitFor({ state: 'hidden' });
  check('receiving: when everything is in, the order is marked delivered today', po.goods_in === 'yes' && po.status === 'delivered' && po.delivered_date === TODAY, JSON.stringify(po));
  eq('receiving: a delivered order leaves the Goods In list', await page.locator(`#goodsin-list tr:has-text("${po.ref}")`).count(), 0);
  await tab(page, 'home');
  eq('receiving: Home no longer shows it as overdue', await text(page, '[data-tile="overdue"] .tile-value'), '0');

  // an order from before the upgrade can be received line by line too
  await tab(page, 'goodsin');
  await page.locator(`#goodsin-list tr:has-text("${legacy.ref}") [data-action="receive-order"]`).click();
  await page.locator('.receive-now').nth(0).fill('3');
  await page.click('#receive-save-btn'); await page.locator('#receive-panel').waitFor({ state: 'hidden' });
  check('receiving: an older order can be received the new way', lineOf('Old wiper').qty_received === 3 && legacy.goods_in === 'partial' && legacy.total === 20);

  // start again
  await page.locator(`#goodsin-list tr:has-text("${legacy.ref}") [data-action="receive-order"]`).click();
  const n = dialogs.length;
  await page.click('#receive-reset-btn'); await page.locator('#receive-panel').waitFor({ state: 'hidden' });
  check('receiving: "Start again" asks first, then clears what was received', dialogs.length === n + 1 && lineOf('Old wiper').qty_received === 0 && legacy.goods_in === 'no');
  eq('receiving: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

group('returns', async browser => {
  const mock = await startMock();
  const u = makeUser(mock);
  const sup = seedSupplier(mock, u.id, 'Northgate Factors'), sup2 = seedSupplier(mock, u.id, 'Main Dealer Parts');
  const po = seedOrder(mock, u.id, sup, 1, { status: 'sent', due: L.addDays(TODAY, 1), lines: [['Brake caliper', 2, 80, 1, 'AB12 CDE'], ['Pads', 1, 20, 0]] });
  mock.insert('spo_returns', { user_id: u.id, supplier_id: sup2.id, item_name: 'Alternator (old unit)', qty: 1, amount: 45, reason: 'surcharge', status: 'returned', returned_date: ago(35), created_at: new Date(Date.now() - 36 * 864e5).toISOString() });
  const { context, page, problems, dialogs } = await open(browser, mock);
  await signIn(page, u);

  check('returns: Home shows the credit still to come and what to chase', /£45\.00/.test(await text(page, '[data-tile="credit"]')) && /1 to chase/.test(await text(page, '[data-tile="credit"]')), await text(page, '[data-tile="credit"]'));
  eq('returns: the Returns tab is flagged', await text(page, '#count-returns'), '1');
  check('returns: Home lists it under needs attention', /Alternator \(old unit\)/.test(await text(page, '#attention-list')) && /35 days/.test(await text(page, '#attention-list')), await text(page, '#attention-list'));
  await tab(page, 'returns');
  check('returns: a return sent back 35 days ago is marked Chase', /Chase/.test(await text(page, '#returns-list')));

  // log a return straight from a received line
  await tab(page, 'goodsin');
  await page.locator(`#goodsin-list tr:has-text("${po.ref}") [data-action="receive-order"]`).click();
  eq('returns: only lines that have arrived offer "Return"', await page.locator('#receive-lines [data-action="return-line"]').count(), 1);
  await page.click('#receive-lines [data-action="return-line"]');
  await page.locator('#return-form').waitFor({ state: 'visible' });
  eq('returns: supplier is filled in', await page.locator('#ret-supplier option:checked').textContent(), 'Northgate Factors');
  eq('returns: part is filled in', await page.inputValue('#ret-item'), 'Brake caliper');
  eq('returns: quantity is what has arrived', await page.inputValue('#ret-qty'), '1');
  eq('returns: credit expected is the price paid', await page.inputValue('#ret-amount'), '80');
  eq('returns: linked to the order', await page.locator('#ret-order option:checked').getAttribute('value'), po.id);
  await page.selectOption('#ret-reason', 'wrong_part');
  await page.click('#save-return-btn'); await page.locator('#return-form').waitFor({ state: 'hidden' });
  const ret = () => rows(mock, 'spo_returns', u.id).find(r => r.item_name === 'Brake caliper');
  check('returns: saved as "to send back"', !!ret() && ret().status === 'to_return' && ret().reason === 'wrong_part' && ret().amount === 80 && ret().purchase_order_id === po.id && ret().supplier_id === sup.id, JSON.stringify(ret()));
  check('returns: total owed is shown', /£125\.00/.test(await text(page, '#returns-owed')), await text(page, '#returns-owed'));

  await page.locator('#returns-list tr:has-text("Brake caliper") [data-action="return-sent"]').click();
  await page.locator('#returns-list tr:has-text("Brake caliper") .badge-returned').waitFor();
  check('returns: "Sent back" records today\'s date', ret().status === 'returned' && ret().returned_date === TODAY);
  await page.locator('#returns-list tr:has-text("Brake caliper") [data-action="return-credited"]').click();
  await page.locator('#return-form').waitFor({ state: 'visible' });
  eq('returns: "Credit received" opens the form ready to complete', await page.inputValue('#ret-status'), 'credited');
  await page.fill('#ret-credit-ref', 'CN-20418');
  await page.click('#save-return-btn'); await page.locator('#return-form').waitFor({ state: 'hidden' });
  check('returns: credited with the credit note number and date', ret().status === 'credited' && ret().credit_ref === 'CN-20418' && ret().credited_date === TODAY, JSON.stringify(ret()));
  eq('returns: a credited return leaves the "not yet credited" list', await page.locator('#returns-list tr:has-text("Brake caliper")').count(), 0);
  await page.click('[data-rfilter="credited"]');
  check('returns: ...and is under Credited with its number', /CN-20418/.test(await text(page, '#returns-list')));
  await page.click('[data-rfilter="chase"]');
  eq('returns: Chase filter', await page.locator('#returns-list tr').count(), 1);
  await page.click('[data-rfilter="all"]');
  await page.fill('#search', 'cn-20418'); await sleep(80);
  eq('returns: search by credit note number', await page.locator('#returns-list tr').count(), 1);
  await page.fill('#search', '');

  await page.click('#new-return-btn'); await page.click('#save-return-btn');
  check('returns: a return needs a part name', await errorToast(page, /which part/i));
  await page.click('[data-action="cancel-return"]');

  const n = dialogs.length;
  await page.locator('#returns-list tr:has-text("Alternator") [data-action="delete-return"]').click();
  await page.locator('#returns-list tr:has-text("Alternator")').waitFor({ state: 'detached' });
  check('returns: delete asks first', dialogs.length === n + 1);
  eq('returns: deleted', rows(mock, 'spo_returns', u.id).length, 1);
  eq('returns: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

group('home', async browser => {
  const mock = await startMock();
  const empty = makeUser(mock);
  let s = await open(browser, mock);
  await signIn(s.page, empty);
  check('home: a new account gets a getting-started list of three steps', await visible(s.page, '#checklist-card') && await s.page.locator('#checklist li').count() === 3);
  eq('home: tiles start at zero', await text(s.page, '[data-tile="open"] .tile-value'), '0');
  check('home: nothing needs attention', /nothing/i.test(await text(s.page, '#attention-list')));
  await s.page.click('#checklist [data-action="new-supplier"]');
  check('home: a checklist step opens the right form', await visible(s.page, '#supplier-form'));
  await s.context.close();

  const u = makeUser(mock);
  const a = seedSupplier(mock, u.id, 'Northgate Factors'), b = seedSupplier(mock, u.id, 'Tyre Co');
  seedOrder(mock, u.id, a, 1, { status: 'draft', date: TODAY, due: '', lines: [['Wipers', 5, 8, 0]] });                           // £48 draft
  seedOrder(mock, u.id, a, 2, { status: 'sent', date: ago(5), due: ago(2), lines: [['Belt', 1, 100, 0]] });                        // £120 overdue
  seedOrder(mock, u.id, b, 3, { status: 'confirmed', date: ago(4), due: L.addDays(TODAY, 3), lines: [['Tyre', 4, 50, 2]] });       // £240 partial
  seedOrder(mock, u.id, b, 4, { status: 'delivered', date: ago(8), due: ago(6), lines: [['Tyre B', 2, 50, 2]] });                  // £120 delivered
  mock.insert('spo_settings', { user_id: u.id, business_name: 'My Garage Ltd' });
  mock.insert('spo_returns', { user_id: u.id, supplier_id: a.id, item_name: 'Caliper', amount: 30, status: 'to_return' });
  s = await open(browser, mock);
  await signIn(s.page, u);
  const { page } = s;
  check('home: no getting-started list once set up', !(await visible(page, '#checklist-card')));
  eq('home: open orders', await text(page, '[data-tile="open"] .tile-value'), '3');
  check('home: open order value', /£408\.00/.test(await text(page, '[data-tile="open"]')));
  eq('home: overdue', await text(page, '[data-tile="overdue"] .tile-value'), '1');
  eq('home: awaiting delivery', await text(page, '[data-tile="awaiting"] .tile-value'), '2');
  eq('home: part delivered', await text(page, '[data-tile="partial"] .tile-value'), '1');
  eq('home: credit to come', await text(page, '[data-tile="credit"] .tile-value'), '£30.00');
  const top = await text(page, '#top-suppliers');
  check('home: top suppliers ranked by spend', top.indexOf('Tyre Co') > -1 && top.indexOf('Tyre Co') < top.indexOf('Northgate Factors') && /£360\.00/.test(top) && /£120\.00/.test(top), top);
  check('home: the overdue order is listed under needs attention', new RegExp(L.poRef(YEAR, 2)).test(await text(page, '#attention-list')) && /2 days late/.test(await text(page, '#attention-list')), await text(page, '#attention-list'));

  await page.click('[data-tile="overdue"]');
  check('home: the Overdue tile opens the orders list filtered to overdue', await visible(page, '#view-orders') && (await page.getAttribute('[data-filter="overdue"]', 'class')).includes('active') && await page.locator('#orders-list tr').count() === 1);
  await tab(page, 'home'); await page.click('[data-tile="partial"]');
  eq('home: the Part delivered tile filters too', await page.locator('#orders-list tr').count(), 1);
  await tab(page, 'home'); await page.click('[data-tile="credit"]');
  check('home: the Credit tile opens Returns', await visible(page, '#view-returns') && await page.locator('#returns-list tr').count() === 1);
  await tab(page, 'home'); await page.click('[data-tile="awaiting"]');
  check('home: the Awaiting delivery tile opens Goods In', await visible(page, '#view-goodsin') && await page.locator('#goodsin-list tr').count() === 2);
  await tab(page, 'home');
  await page.locator('#attention-list [data-action="receive-order"]').first().click();
  check('home: "Receive" from needs attention opens that delivery', await visible(page, '#receive-panel') && (await text(page, '#receive-title')).includes(L.poRef(YEAR, 2)));
  eq('home: no page errors', s.problems.join(' | '), '');
  await s.context.close(); await mock.close();
});

group('prices', async browser => {
  const mock = await startMock();
  const u = makeUser(mock);
  const a = seedSupplier(mock, u.id, 'Northgate Factors'), b = seedSupplier(mock, u.id, 'Brake Direct');
  const hist = (sup, name, price, date) => mock.insert('spo_price_history', { user_id: u.id, supplier_id: sup.id, item_name: name, price, recorded_date: date });
  hist(a, 'Oil filter', 5.00, ago(60)); hist(a, 'Oil filter', 5.60, ago(10)); hist(b, 'Oil filter', 4.90, ago(30)); hist(a, 'Brake pads', 24.50, ago(40));
  seedOrder(mock, u.id, a, 1, { status: 'delivered', date: ago(10), due: ago(9), lines: [['Oil filter', 2, 5.60, 2], ['Brake pads', 1, 24.50, 1]] });
  seedOrder(mock, u.id, b, 2, { status: 'delivered', date: ago(30), due: ago(29), lines: [['Oil filter', 2, 4.90, 2]] });
  seedOrder(mock, u.id, b, 3, { status: 'delivered', date: ago(200), due: ago(199), lines: [['Ancient part', 1, 1, 1]] });
  const { context, page, problems } = await open(browser, mock);
  await signIn(page, u);

  await tab(page, 'prices');
  eq('prices: every logged price is listed', await page.locator('#prices-list tr').count(), 4);
  const first = await text(page, '#prices-list tr:nth-child(1)');
  check('prices: newest first, with the rise since last time', /Oil filter/.test(first) && /£5\.60/.test(first) && /▲/.test(first) && /12%/.test(first), first);
  await page.fill('#search', 'brake pads'); await sleep(80);
  eq('prices: search by part', await page.locator('#prices-list tr').count(), 1);
  await page.fill('#search', '');

  await tab(page, 'orders'); await page.click('#new-order-btn'); await page.selectOption('#po-supplier', { label: 'Northgate Factors' });
  await fillLine(page, 0, { name: 'oil filter' });
  eq('prices: typing a known part fills in the last price', await page.inputValue('#po-items .item-price'), '5.6');
  const hint = await text(page, '#po-items .item-hint');
  check('prices: ...and points out a cheaper supplier', /Last paid £5\.60/.test(hint) && /Brake Direct charged £4\.90/.test(hint), hint);
  check('prices: part names are suggested from past orders', await page.locator('#item-names option[value="Oil filter"]').count() === 1);
  await page.click('#cancel-order-btn');

  await page.click('#reorder-btn'); await page.locator('#reorder-panel').waitFor({ state: 'visible' });
  eq('prices: reorder suggestions are grouped by supplier', await page.locator('#reorder-list .reorder-group').count(), 2);
  check('prices: parts older than 3 months are not suggested', !/Ancient part/.test(await text(page, '#reorder-list')));
  const groupB = page.locator('#reorder-list .reorder-group', { hasText: 'Brake Direct' });
  await groupB.locator('[data-action="reorder-create"]').click();
  check('prices: creating with nothing ticked asks you to tick something', await errorToast(page, /tick/i));
  await groupB.locator('.reorder-check').first().check();
  await page.locator('#reorder-list .reorder-group', { hasText: 'Northgate Factors' }).locator('.reorder-check').first().check();
  await groupB.locator('[data-action="reorder-create"]').click();
  await page.locator('#order-form').waitFor({ state: 'visible' });
  eq('prices: the new order is for that group\'s supplier', await page.locator('#po-supplier option:checked').textContent(), 'Brake Direct');
  eq('prices: ...with only that supplier\'s ticked parts', (await page.locator('#po-items .item-name').evaluateAll(els => els.map(e => e.value))).join(','), 'Oil filter');
  eq('prices: ...at the last price', await page.inputValue('#po-items .item-price'), '4.9');
  eq('prices: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

group('big', async browser => {
  const mock = await startMock();
  const u = makeUser(mock);
  for (let i = 0; i < 1050; i++) mock.insert('spo_suppliers', { user_id: u.id, name: 'Supplier ' + String(i).padStart(4, '0') });
  const { context, page, problems } = await open(browser, mock);
  await signIn(page, u);
  await tab(page, 'suppliers');
  eq('big: more than 1000 rows are all loaded (the service sends 1000 at a time)', await page.locator('#supplier-list tr').count(), 1050);
  eq('big: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

group('phone', async browser => {
  const mock = await startMock({ seed: 'demo' });
  const { context, page, problems } = await open(browser, mock, { width: 375, height: 800 });
  check('phone: the demo sign-in is filled in', (await page.inputValue('#login-email')) === mock.state.demo.email);
  check('phone: sign-in screen fits', await noSidewaysScroll(page));
  await page.click('#login-btn'); await page.locator('#tiles .tile').first().waitFor();
  check('phone: Home fits', await noSidewaysScroll(page));
  for (const name of ['orders', 'goodsin', 'returns', 'suppliers', 'prices']) { await tab(page, name); await sleep(120); check(`phone: ${name} list fits`, await noSidewaysScroll(page)); }
  await tab(page, 'orders'); await page.locator('#orders-list [data-action="edit-order"]').first().click(); await sleep(150);
  check('phone: order form fits', await noSidewaysScroll(page));
  await page.click('#cancel-order-btn');
  await tab(page, 'goodsin'); await page.locator('#goodsin-list [data-action="receive-order"]').first().click(); await sleep(150);
  check('phone: receive screen fits', await noSidewaysScroll(page));
  await page.click('[data-action="cancel-receipt"]');
  await tab(page, 'returns'); await page.click('#new-return-btn'); await sleep(150);
  check('phone: return form fits', await noSidewaysScroll(page));
  await page.click('[data-action="cancel-return"]');
  await tab(page, 'suppliers'); await page.click('#new-supplier-btn'); await sleep(150);
  check('phone: supplier form fits', await noSidewaysScroll(page));
  await page.click('[data-action="cancel-supplier"]');
  await page.click('#settings-btn'); await sleep(150);
  check('phone: My business fits', await noSidewaysScroll(page));
  check('phone: buttons are big enough to tap', await page.evaluate(() => [...document.querySelectorAll('#view-settings .btn-primary')].every(b => b.getBoundingClientRect().height >= 40)));
  eq('phone: no page errors', problems.join(' | '), '');
  await context.close(); await mock.close();
});

// ───────────── run ─────────────
(async () => {
  const only = process.argv[2];
  const names = only ? only.split(',') : Object.keys(groups);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const name of names) {
    if (!groups[name]) { console.log('FAIL unknown group ' + name); fails++; continue; }
    try { await groups[name](browser); }
    catch (err) { console.log(`FAIL ${name}: stopped early   → ${String(err && err.message).split('\n')[0]}`); fails++; }
  }
  await browser.close();
  console.log(`\n${passes} passed`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
