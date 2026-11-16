// Tests for tools/make-stock-control-website.mjs: the script that turns the PD Stevens Stock Control page (the master)
// into the neutral page sold on the website. Run: node --test tools/tests/make-stock-control-website.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildWebsitePage, problems } from '../make-stock-control-website.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const master = readFileSync(path.join(here, '..', '..', 'stock-control-pd-stevens', 'index.html'), 'utf8');
const OPTS = { priceId: 'price_1UcKi1ICF2fQjVNyOo6gFX1f', priceGbp: '99.00', approxUsd: '133', version: '1116a' };
const page = buildWebsitePage(master, OPTS);

test('no PD Stevens text, address or logo is left in the website page', () => {
  assert.deepEqual(problems(page), []);
  assert.doesNotMatch(page, /PD Stevens/i);
  assert.doesNotMatch(page, /pd-stevens/i);
  assert.doesNotMatch(page, /logo-plate/);
  assert.doesNotMatch(page, /\.brand-logo/);
  assert.doesNotMatch(page, /data:image\/png/);
});

test('problems() flags branding, a missing checkout call, a missing price and the old £32', () => {
  assert.ok(problems(page + '\nPD Stevens').length > 0, 'branding not flagged');
  assert.ok(problems(page.replaceAll('create-checkout-session', 'x')).length > 0, 'missing checkout call not flagged');
  assert.ok(problems(page.replace('Subscribe £99.00/month', 'Subscribe')).length > 0, 'missing price not flagged');
  assert.ok(problems(page + '\n£32.00').length > 0, 'old price not flagged');
  assert.ok(problems(page + '\ndata:image/png;base64,AAAA').length > 0, 'image data not flagged');
  assert.ok(problems(page.replace("const PRODUCT_ID = 'stock-control';", "const PRODUCT_ID = 'other';")).length > 0, 'wrong product id not flagged');
});

test('the Subscribe button is wired to the checkout function with the new price and the stock-control product', () => {
  assert.match(page, /const STRIPE_PRICE_ID = 'price_1UcKi1ICF2fQjVNyOo6gFX1f';/);
  assert.match(page, /const PRODUCT_ID = 'stock-control';/);
  assert.match(page, /\/functions\/v1\/create-checkout-session/);
  assert.match(page, /price_id: STRIPE_PRICE_ID/);
  assert.match(page, /product: PRODUCT_ID/);
  assert.match(page, /id="subscribeBtn"/);
  assert.match(page, /subscribeBtn\.onclick = startSubscription;/);
  assert.match(page, /Could not start checkout: /);
});

test('the price text says £99.00 a month, the dollar guide, and no £32 anywhere', () => {
  assert.ok(page.includes('✅ 30 Days Free Trial — then £99.00 per month'));
  assert.ok(page.includes('Subscribe £99.00/month'));
  assert.ok(page.includes('(approx. $133 USD)'));
  assert.ok(page.includes('const MONTHLY_PRICE = 99.00;'));
  assert.doesNotMatch(page, /£32|32\.00/);
});

test('the receipt heading default is neutral and the QR fallback points at /stock-control/', () => {
  assert.ok(page.includes("company: 'Your company name'"));
  assert.ok(page.includes("'https://build-tracker.co.uk/stock-control/'"));
  assert.doesNotMatch(page, /build-tracker\.co\.uk\/stock-control-pd-stevens/);
});

test('the neutral look: title, footer, name line and a brand mark in every top bar and on the sign-in panel', () => {
  assert.ok(page.includes('<title>Stock Control — Build Tracker Solutions</title>'));
  assert.ok(page.includes('Stock Control · by Build Tracker Solutions'));
  assert.equal((page.match(/<div class="brand-mark">/g) || []).length, 7, 'sign-in panel + 6 top bars = 7 brand marks');
  assert.doesNotMatch(page, /class="brand-sep"/);
});

test('only the intended lines differ from the master', () => {
  const a = master.replace(/\r\n/g, '\n').split('\n'), b = page.split('\n');
  const sa = new Set(a), sb = new Set(b);
  const changed = a.filter(l => !sb.has(l)).length + b.filter(l => !sa.has(l)).length;
  assert.ok(changed > 20, `suspiciously few changes (${changed}): was anything replaced?`);
  assert.ok(changed < 200, `too many changed lines (${changed}): a replacement ran away`);
});

test('generation is repeatable', () => {
  assert.equal(buildWebsitePage(master, OPTS), page);
});

test('the version stamp is the one passed in', () => {
  assert.match(page, /const APP_VERSION = '1116a';/);
  assert.match(buildWebsitePage(master, { ...OPTS, version: '1116b' }), /const APP_VERSION = '1116b';/);
});

test('a master that has changed shape makes the build fail loudly instead of skipping a step', () => {
  assert.throws(() => buildWebsitePage('<html><title>x</title></html>', OPTS), /not found/);
  assert.throws(() => buildWebsitePage(master.replace('const TRIAL_DAYS = 30;', 'const TRIAL_DAYS = 31;'), OPTS), /not found/);
  assert.throws(() => buildWebsitePage(master.replace('<div class="brand-name">Sales</div>', '<div class="brand-title">Sales</div>'), OPTS), /not found/);
});

test('problems() also catches any name spelt with "stevens", any picture other than a small drawn one, and any <img> tag', () => {
  assert.ok(problems(page + '\nSTEVENS').length > 0, 'stevens (any case) not flagged');
  assert.ok(problems(page + '\n<p>Stevens Bodyworks</p>').length > 0, 'a different spelling not flagged');
  assert.ok(problems(page + '\n<img src="x.png">').length > 0, '<img> not flagged');
  assert.ok(problems(page + '\n<IMG src="x.png">').length > 0, '<IMG> not flagged');
  assert.ok(problems(page + '\nurl(data:image/jpeg;base64,AAAA)').length > 0, 'jpeg data not flagged');
  assert.ok(problems(page + '\nurl(data:image/webp;base64,AAAA)').length > 0, 'webp data not flagged');
  assert.ok(problems(page + '\nurl(data:image/gif;base64,AAAA)').length > 0, 'gif data not flagged');
  assert.deepEqual(problems(page), [], 'the real page must still be clean (it keeps its small drawn barcode pictures)');
});

test('the page saved in the repo is exactly what the script builds today (nobody edited it by hand, and it is not behind the master)', () => {
  const saved = readFileSync(path.join(here, '..', '..', 'stock-control', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const version = saved.match(/const APP_VERSION = '([^']*)';/)?.[1];
  assert.ok(version, 'no version stamp in the saved page');
  const fresh = buildWebsitePage(master, { ...OPTS, version }).replace(/\r\n/g, '\n');
  assert.equal(saved === fresh, true, 'stock-control/index.html is out of date: run  node tools/make-stock-control-website.mjs ' + version);
});
