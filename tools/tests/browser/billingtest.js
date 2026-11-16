// The PD Stevens copy must show no price anywhere, and the 30-day lock must still work.
const { chromium } = require('playwright-core');
const fs = require('fs');
const { createMock } = require('./mock');

const { APP, PAGE_PATH, WEBSITE, COMPANY } = require('./page-config');
if (WEBSITE) { console.log('SKIP: the PD Stevens billing test (no price on that page). See website-billing.test.js for this page.'); console.log('ALL PASSED (skipped)'); process.exit(0); }
const HOST = 'https://build-tracker.co.uk';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   ' + extra)); if (!cond) fails++; };
const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

async function run({ daysAgo, subscription, role = 'owner' }) {
  const mock = createMock();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-GB' });
  const signup = new Date(Date.now() - daysAgo * 864e5).toISOString();
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', async route => {
    const req = route.request(), p = new URL(req.url()).pathname, obj = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
    if (p.endsWith('/rest/v1/users')) { const row = { id: mock.OWNER, email: 'owner@example.com', signup_date: signup }; return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(obj ? row : [row]) }); }
    if (p.endsWith('/rest/v1/bt_subscriptions')) {
      if (subscription) return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(obj ? { status: 'active' } : [{ status: 'active' }]) });
      return route.fulfill({ status: 406, headers: CORS, body: JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows' }) });
    }
    if (p.endsWith('/rest/v1/sc_team_members') && role === 'staff') return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify([{ role: 'staff' }]) });
    return mock.handler(route);
  });
  await context.route(HOST + '/**', r => new URL(r.request().url()).pathname.startsWith(PAGE_PATH)
    ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(APP) }) : r.fulfill({ status: 204 }));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(HOST + PAGE_PATH + 'index.html', { waitUntil: 'load' });
  const signInText = (await page.textContent('#authScreen')).replace(/\s+/g, ' ');
  await page.fill('#loginEmail', 'owner@example.com'); await page.fill('#loginPass', 'x'); await page.click('#loginForm .auth-btn');
  await sleep(1800);
  return { browser, context, page, errors, signInText };
}

(async () => {
  // ── sign-in screen
  let t = await run({ daysAgo: 5, subscription: false });
  check('sign-in screen says "30 days free trial" and shows no price', /30 days free trial/.test(t.signInText) && !/£|\$|per month|32/.test(t.signInText), t.signInText);
  check('in the trial (day 5): the app opens', await t.page.locator('#appScreen').isVisible());
  const pageText = (await t.page.content());
  check('the page source has no price or checkout in it', !/£32|32\.00|\$43|create-checkout-session|price_1T/.test(pageText));
  check('no page errors (in trial)', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── trial over, nothing paid: locked
  t = await run({ daysAgo: 40, subscription: false, role: 'owner' }); const { page } = t;
  await page.locator('#billingScreen').waitFor({ state: 'visible' });
  const owner = (await page.textContent('#billingScreen')).replace(/\s+/g, ' ');
  check('trial over, not paid: the app is locked (billing screen, no dashboard)', !(await page.locator('#appScreen').isVisible()));
  check('locked screen says the trial has ended and how to get in touch', /Your free trial has ended/.test(owner) && /info@build-tracker\.co\.uk/.test(owner) && /07931 095631/.test(owner), owner);
  check('locked screen has no price and no Subscribe button', !/£|\$|per month|Subscribe/.test(owner) && (await page.locator('#subscribeBtn').count()) === 0, owner);
  await page.screenshot({ path: 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-OneDrive-build-tracker2026-Stock-Control/18c8a9c5-2598-43f1-bc90-45139fd54341/scratchpad/shots2/70-trial-ended.png' });
  await page.click('#billingScreen .btn-ghost');
  await page.locator('#authScreen').waitFor({ state: 'visible' });
  check('Sign Out on the locked screen works', await page.locator('#authScreen').isVisible());
  check('no page errors (locked)', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  // ── trial over, but they have paid (a subscription row added by hand): in
  t = await run({ daysAgo: 40, subscription: true });
  check('trial over but an active subscription row exists: the app opens', await t.page.locator('#appScreen').isVisible());
  check('...and the badge says Subscribed', /Subscribed/.test(await t.page.textContent('#trialBadge')), await t.page.textContent('#trialBadge'));
  await t.context.close();

  // ── an invited staff member on a locked workspace
  t = await run({ daysAgo: 40, subscription: false, role: 'staff' });
  await t.page.locator('#billingScreen').waitFor({ state: 'visible' });
  const staff = (await t.page.textContent('#billingScreen')).replace(/\s+/g, ' ');
  check('locked workspace, staff member: told to ask the owner, no price', /free trial has ended/.test(staff) && /get in touch with Build Tracker Solutions/.test(staff) && !/£|\$|Subscribe/.test(staff), staff);
  await t.browser.close();

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
})().catch(e => { console.error(e); process.exit(2); });
