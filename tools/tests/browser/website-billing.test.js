// The website Stock Control page: the 30-day trial and its lock, the Subscribe button and the checkout call, failures,
// staff, bank-transfer subscribers, no PD Stevens text, and the phone layout. Run: PAGE=website node tools/tests/browser/website-billing.test.js
const { chromium } = require('playwright-core');
const fs = require('fs');
const { createMock } = require('./mock');
const { APP, PAGE_PATH, WEBSITE } = require('./page-config');
if (!WEBSITE) { console.log('SKIP: this test is for the website page (PAGE=website); the PD Stevens page has no Subscribe button.'); console.log('ALL PASSED (skipped)'); process.exit(0); }

const HOST = 'https://build-tracker.co.uk';
const PRICE_ID = 'price_1UcKi1ICF2fQjVNyOo6gFX1f';
const FN = '/functions/v1/create-checkout-session';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '   ' + extra)); if (!cond) fails++; };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };

// daysAgo: when they signed up; subscription: an active bt_subscriptions row; role; checkout: how the function answers
async function run(browser, { daysAgo, subscription = false, role = 'owner', checkout = { status: 200, body: { url: 'https://checkout.stripe.test/pay' } }, viewport = { width: 1280, height: 860 }, login = true }) {
  const mock = createMock();
  const state = { subscription }; // the test can flip this while the page is open (the payment being recorded)
  const context = await browser.newContext({ viewport, locale: 'en-GB' });
  const signup = new Date(Date.now() - daysAgo * 864e5).toISOString();
  const calls = [];
  await context.route('https://dkdnlgwflrwdxtrovrrq.supabase.co/**', async route => {
    const req = route.request(), p = new URL(req.url()).pathname, obj = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
    if (p.endsWith(FN)) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      calls.push({ headers: req.headers(), body: JSON.parse(req.postData() || '{}') });
      if (checkout === 'abort') return route.abort('failed');
      return route.fulfill({ status: checkout.status, headers: CORS, body: JSON.stringify(checkout.body) });
    }
    if (p.endsWith('/rest/v1/users')) { const row = { id: mock.OWNER, email: 'owner@example.com', signup_date: signup }; return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(obj ? row : [row]) }); }
    if (p.endsWith('/rest/v1/bt_subscriptions')) {
      if (state.subscription) return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(obj ? { status: 'active' } : [{ status: 'active' }]) });
      return route.fulfill({ status: 406, headers: CORS, body: JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows' }) });
    }
    if (p.endsWith('/rest/v1/sc_team_members') && role === 'staff') return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify([{ role: 'staff' }]) });
    return mock.handler(route);
  });
  await context.route('https://checkout.stripe.test/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stripe checkout (test double)</h1>' }));
  await context.route(HOST + '/**', r => new URL(r.request().url()).pathname.startsWith(PAGE_PATH)
    ? r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(APP) }) : r.fulfill({ status: 204 }));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(HOST + PAGE_PATH + 'index.html', { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const overflowSignIn = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const signInText = (await page.textContent('#authScreen')).replace(/\s+/g, ' ');
  if (login) {
    await page.fill('#loginEmail', 'owner@example.com'); await page.fill('#loginPass', 'x'); await page.click('#loginForm .auth-btn');
    await sleep(1800);
  }
  return { context, page, errors, calls, signInText, overflowSignIn, state };
}
const visible = (page, id) => page.locator(id).isVisible();
const text = async (page, sel) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let t;

  console.log('\n— sign-in screen and the trial —');
  t = await run(browser, { daysAgo: 5 });
  check('sign-in screen says 30 Days Free Trial — then £99.00 per month', /30 Days Free Trial — then £99\.00 per month/.test(t.signInText), t.signInText);
  check('day 5: the app opens, badge says days of trial left', await visible(t.page, '#appScreen') && /days trial left/.test(await text(t.page, '#trialBadge')), await text(t.page, '#trialBadge'));
  const dash = await t.page.evaluate(() => document.body.innerText);
  check('no visible text mentions PD Stevens (sign-in, dashboard)', !/PD Stevens/i.test(t.signInText) && !/PD Stevens/i.test(dash));
  check('the live page has no PD Stevens logo or text anywhere in its markup', !(await t.page.evaluate(() => /PD Stevens|pd-stevens/i.test(document.documentElement.outerHTML))));
  check('no page errors (in trial)', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();

  t = await run(browser, { daysAgo: 29 });
  check('day 29: still opens', await visible(t.page, '#appScreen'));
  await t.context.close();

  console.log('\n— trial over, nothing paid —');
  t = await run(browser, { daysAgo: 30 });
  await t.page.locator('#billingScreen').waitFor({ state: 'visible', timeout: 4000 }).catch(() => {}); // if it never locks, the check below records that
  check('day 30: locked (billing screen, no dashboard)', !(await visible(t.page, '#appScreen')));
  const bill = await text(t.page, '#billingScreen');
  check('locked owner sees the trial has ended, Subscribe £99.00/month and the dollar guide', /free trial has ended/.test(bill) && /Subscribe £99\.00\/month/.test(bill) && /\(approx\. \$133 USD\)/.test(bill), bill);
  check('no PD Stevens on the billing screen', !/PD Stevens/i.test(bill));
  await t.page.click('#subscribeBtn');
  await t.page.waitForURL(/checkout\.stripe\.test/, { timeout: 8000 });
  const c = t.calls[0] || {};
  check('Subscribe posts once to create-checkout-session with the new price and the stock-control product', t.calls.length === 1 && c.body.price_id === PRICE_ID && c.body.product === 'stock-control', JSON.stringify(c.body));
  check('the checkout request carries the signed-in user\'s token and no card details', /^Bearer .{20,}/.test(c.headers.authorization || '') && !/card|number|cvc/i.test(JSON.stringify(c.body)));
  check('the success and cancel addresses come back to the Stock Control page', /\/stock-control\/.*payment=success/.test(c.body.success_url) && /payment=cancel/.test(c.body.cancel_url), JSON.stringify([c.body.success_url, c.body.cancel_url]));
  check('then the browser goes to the address the function returned', /checkout\.stripe\.test\/pay/.test(t.page.url()), t.page.url());
  await t.context.close();

  console.log('\n— back from Stripe before the payment has been recorded —');
  {
    t = await run(browser, { daysAgo: 40 });
    await t.page.locator('#billingScreen').waitFor({ state: 'visible' });
    await t.page.clock.install();
    await t.page.goto(HOST + PAGE_PATH + 'index.html?payment=success', { waitUntil: 'load' });
    await t.page.clock.runFor(4000); await sleep(700);
    const waiting = await text(t.page, '#billingScreen');
    check('back from Stripe, not recorded yet: says the payment was received and Subscribe is hidden (no second payment)', /Payment received/.test(waiting) && !(await visible(t.page, '#subscribeBtn')) && await visible(t.page, '#billingScreen'), waiting);
    check('the ?payment=success part is removed from the address', !/payment=/.test(t.page.url()), t.page.url());
    t.state.subscription = true; // the webhook has now written the active row
    await t.page.clock.runFor(4000); await sleep(900);
    check('as soon as the payment is recorded the app opens by itself and says Subscribed', await visible(t.page, '#appScreen') && !(await visible(t.page, '#billingScreen')) && /Subscribed/.test(await text(t.page, '#trialBadge')), await text(t.page, '#trialBadge'));
    check('no checkout request was made on the return trip, and no page errors', t.calls.length === 0 && t.errors.length === 0, t.errors.join(' | '));
    await t.context.close();

    t = await run(browser, { daysAgo: 40 });
    await t.page.locator('#billingScreen').waitFor({ state: 'visible' });
    await t.page.clock.install();
    await t.page.goto(HOST + PAGE_PATH + 'index.html?payment=success', { waitUntil: 'load' });
    for (let i = 0; i < 25; i++) { await t.page.clock.runFor(3000); await sleep(120); } // 75 seconds and the payment is never recorded
    const slow = await text(t.page, '#billingScreen');
    check('still nothing after a minute: tells them not to pay again, and Subscribe stays hidden', /don.t pay again/i.test(slow) && /info@build-tracker\.co\.uk/.test(slow) && !(await visible(t.page, '#subscribeBtn')), slow);
    await t.context.close();

    t = await run(browser, { daysAgo: 40 });
    await t.page.locator('#billingScreen').waitFor({ state: 'visible' });
    await t.page.goto(HOST + PAGE_PATH + 'index.html?payment=cancel', { waitUntil: 'load' }); await sleep(2500);
    check('back from Stripe without paying (cancel): Subscribe is there as before', await visible(t.page, '#subscribeBtn') && !/Payment received/.test(await text(t.page, '#billingScreen')) && !/payment=/.test(t.page.url()), await text(t.page, '#billingScreen'));
    await t.context.close();
  }

  console.log('\n— checkout failing —');
  t = await run(browser, { daysAgo: 40, checkout: { status: 400, body: { error: "That price isn't available for this product." } } });
  await t.page.locator('#billingScreen').waitFor({ state: 'visible' });
  await t.page.click('#subscribeBtn'); await sleep(900);
  check('a 400 from the function shows the reason and stays on the billing screen', (await text(t.page, '#paymentMsg')) === "Could not start checkout: That price isn't available for this product." && await visible(t.page, '#billingScreen'), await text(t.page, '#paymentMsg'));
  check('Subscribe is still usable: a second press makes a second request', await t.page.locator('#subscribeBtn').isEnabled() && (await t.page.click('#subscribeBtn'), await sleep(900), t.calls.length === 2), String(t.calls.length));
  await t.context.close();

  t = await run(browser, { daysAgo: 40, checkout: { status: 200, body: {} } });
  await t.page.locator('#billingScreen').waitFor({ state: 'visible' });
  await t.page.click('#subscribeBtn'); await sleep(900);
  check('a reply with no checkout address gives a readable message', /^Could not start checkout: No checkout URL returned/.test(await text(t.page, '#paymentMsg')), await text(t.page, '#paymentMsg'));
  await t.context.close();

  t = await run(browser, { daysAgo: 40, checkout: 'abort' });
  await t.page.locator('#billingScreen').waitFor({ state: 'visible' });
  await t.page.click('#subscribeBtn'); await sleep(900);
  check('a network failure gives a readable message and the page carries on', /^Could not start checkout: /.test(await text(t.page, '#paymentMsg')) && await visible(t.page, '#billingScreen') && t.errors.length === 0, await text(t.page, '#paymentMsg') + ' | ' + t.errors.join(' | '));
  await t.context.close();

  console.log('\n— paid up, and staff —');
  t = await run(browser, { daysAgo: 40, subscription: true });
  check('day 40 with an active bt_subscriptions row (bank-transfer style): the app opens', await visible(t.page, '#appScreen'));
  check('…and the badge says Subscribed', /Subscribed/.test(await text(t.page, '#trialBadge')), await text(t.page, '#trialBadge'));
  await t.context.close();

  t = await run(browser, { daysAgo: 40, role: 'staff' });
  await t.page.locator('#billingScreen').waitFor({ state: 'visible' });
  const staff = await text(t.page, '#billingScreen');
  check('a staff member on a locked workspace is told to ask the owner and gets no Subscribe button', /free trial has ended/.test(staff) && /Ask .* to subscribe/.test(staff) && !(await visible(t.page, '#subscribeBtn')), staff);
  await t.context.close();

  console.log('\n— phone —');
  t = await run(browser, { daysAgo: 5, viewport: { width: 390, height: 844 } });
  check('phone: sign-in screen has no sideways scroll', t.overflowSignIn <= 1, 'overflow ' + t.overflowSignIn);
  check('phone: dashboard has no sideways scroll', (await overflow(t.page)) <= 1, 'overflow ' + (await overflow(t.page)));
  check('phone: no page errors', t.errors.length === 0, t.errors.join(' | '));
  await t.context.close();
  t = await run(browser, { daysAgo: 40, viewport: { width: 390, height: 844 } });
  await t.page.locator('#billingScreen').waitFor({ state: 'visible' });
  check('phone: billing screen has no sideways scroll and Subscribe is visible', (await overflow(t.page)) <= 1 && await visible(t.page, '#subscribeBtn'), 'overflow ' + (await overflow(t.page)));
  await t.context.close();

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
