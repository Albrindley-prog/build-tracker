// The homepage dashboard for someone who pays for Stock Control: they are not locked out, the Stock Control card has a Manage
// Subscription button, and the Cancel Subscription list offers Stock Control (so a £99 customer can cancel without emailing).
// Run: node tools/tests/browser/homepage-manage.test.js
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { createMock } = require('./mock');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST = 'https://build-tracker.co.uk';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   ' + extra)); if (!cond) fails++; };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

// subscriptions: the products this account has an active bt_subscriptions row for. The pretend table only answers for the
// products the page actually asks about (the page's own `in (...)` list), as the real one does.
async function open(browser, { subscriptions }) {
  const mock = createMock();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB' });
  const portal = [];
  const oldAccount = new Date(Date.now() - 100 * 864e5).toISOString(); // well past the homepage's own 30-day grace period
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (p.endsWith('/auth/v1/user')) return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ id: mock.OWNER, aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', created_at: oldAccount, app_metadata: { provider: 'email' }, user_metadata: {} }) });
    if (p.endsWith('/rest/v1/bt_subscriptions')) {
      const asked = (url.searchParams.get('product') || '').replace(/^in\.\(|\)$/g, '').split(',').map(s => s.replace(/"/g, ''));
      return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(subscriptions.filter(s => asked.includes(s)).map(product => ({ product }))) });
    }
    if (p.endsWith('/functions/v1/create-portal-session')) {
      portal.push({ headers: req.headers(), body: JSON.parse(req.postData() || '{}') });
      return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ url: 'https://billing.stripe.test/portal' }) });
    }
    return mock.handler(route);
  });
  await context.route('https://billing.stripe.test/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe billing portal (test double)</h1>' }));
  await context.route(HOST + '/**', r => {
    let q = decodeURIComponent(new URL(r.request().url()).pathname); if (q.endsWith('/')) q += 'index.html';
    const f = path.join(ROOT, q);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 204 });
    return r.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await page.evaluate(() => showLogin());
  await page.fill('#loginEmail', 'owner@example.com'); await page.fill('#loginPass', 'x');
  await page.click('#loginForm button.mkt-btn');
  await sleep(1500);
  return { context, page, portal, errors };
}
const shown = (page, sel) => page.locator(sel).isVisible();

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let t;

  console.log('\n— paying for Stock Control only —');
  t = await open(browser, { subscriptions: ['stock-control'] });
  check('the dashboard opens (not the "subscribe" lock) for an old account that pays for Stock Control', await shown(t.page, '#dashboard') && !(await shown(t.page, '#dashboardLock')));
  check('the Stock Control card shows Manage Subscription', await shown(t.page, '#ms-btn-stock-control'));
  check('the other cards do not (nothing paid for them)', !(await shown(t.page, '#ms-btn-build-tracker')) && !(await shown(t.page, '#ms-btn-body-shop-pro')));
  await t.page.click('#ms-btn-stock-control', { timeout: 4000 }).catch(() => {});
  await t.page.waitForURL(/billing\.stripe\.test/, { timeout: 6000 }).catch(() => {});
  check('Manage Subscription asks for the billing portal for stock-control and goes there', t.portal.length === 1 && t.portal[0].body.product === 'stock-control' && !t.portal[0].body.flow && /billing\.stripe\.test/.test(t.page.url()), JSON.stringify(t.portal.map(p => p.body)) + ' ' + t.page.url());
  check('…with the signed-in user\'s token', /^Bearer .{20,}/.test((t.portal[0] || { headers: {} }).headers.authorization || ''));
  await t.context.close();

  t = await open(browser, { subscriptions: ['stock-control'] });
  await t.page.click('button:has-text("Cancel Subscription")'); await sleep(800);
  const list = ((await t.page.textContent('#cancel-modal-list')) || '').replace(/\s+/g, ' ');
  check('the Cancel Subscription list offers Stock Control', /Stock Control/.test(list) && (await t.page.locator('#cancel-modal-list button').count()) === 1, list);
  await t.page.click('#cancel-modal-list button', { timeout: 4000 }).catch(() => {});
  await t.page.waitForURL(/billing\.stripe\.test/, { timeout: 6000 }).catch(() => {});
  check('pressing Cancel opens the portal\'s cancellation screen for stock-control', t.portal.length === 1 && t.portal[0].body.product === 'stock-control' && t.portal[0].body.flow === 'cancel', JSON.stringify(t.portal.map(p => p.body)));
  check('no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  console.log('\n— nothing paid, and another tool paid —');
  t = await open(browser, { subscriptions: [] });
  check('an old account that pays for nothing still gets the lock', await shown(t.page, '#dashboardLock') && !(await shown(t.page, '#dashboard')));
  await t.context.close();

  t = await open(browser, { subscriptions: ['build-tracker'] });
  check('paying for another tool does not light up Stock Control\'s Manage button', await shown(t.page, '#ms-btn-build-tracker') && !(await shown(t.page, '#ms-btn-stock-control')));
  await t.context.close();

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
