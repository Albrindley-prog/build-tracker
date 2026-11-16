// The homepage must say Stock Control is £99 a month and must not sell it through the shared £32 Payment Link.
// Run: node --test tools/tests/homepage-prices.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const lines = html.split('\n');
const lineWith = s => lines.find(l => l.includes(s)) || '';

test('the sign-up list says Stock Control is £99/month (approx. $133) and no longer £32', () => {
  const line = lineWith('<strong>Stock Control</strong><small>');
  assert.match(line, /Inventory & suppliers — £99\/month <span class="usd">\(approx\. \$133\)<\/span>/);
  assert.doesNotMatch(line, /£32/);
});

test('the Stock Control card has the tailored offer as plain text (the card is itself a link, so no links inside it)', () => {
  const start = html.indexOf('<a class="mkt-card tool-link" href="stock-control/index.html">');
  assert.ok(start > 0, 'Stock Control card not found');
  const card = html.slice(start, html.indexOf('</a>', start));
  assert.match(card, /From £300 a month/);
  assert.match(card, /info@build-tracker\.co\.uk/);
  assert.match(card, /07931 095631/);
  assert.doesNotMatch(card.replace(/^<a [^>]*>/, ''), /<a /, 'a link inside a link is not valid');
});

test('the pricing section carries the tailored offer with email and phone links', () => {
  const p = html.slice(html.indexOf('id="pricing"'));
  assert.match(p, /Stock Control is £99 a month/);
  assert.match(p, /From £300 a month/);
  assert.match(p, /href="mailto:info@build-tracker\.co\.uk"/);
  assert.match(p, /href="tel:07931095631"/);
});

test('no sentence still says all the main tools are £32', () => {
  assert.doesNotMatch(html, /Our main tools are £32 a month with a 30‑day free trial;/);
  assert.doesNotMatch(html, /Choose the tools you need — £32\/month each<\/li>/);
  assert.doesNotMatch(html, /Pay only £32\/month per tool <span[^>]*>\(approx\. \$43 USD\)<\/span> if you want to continue\./);
  assert.match(lineWith('"description": "Tools from £3.99 per month.'), /Stock Control £99/);
  assert.match(lineWith('Choose the tools you need'), /Stock Control is £99\/month/);
  assert.match(lineWith('Pay only £32/month per tool'), /Stock Control is £99\/month/);
  assert.match(lineWith('After that, £32 per month'), /Stock Control is £99/);
});

// the function is read out of the page and run with stand-ins for the things it touches
function loadSelectSoftware() {
  const m = html.match(/function selectSoftware\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'selectSoftware not found as a multi-line function');
  const calls = { closed: 0, alerts: [], paid: [], went: [] };
  const fn = new Function('closeSelection', 'alert', 'startPayment', 'location', `${m[0]}; return selectSoftware;`)(
    () => { calls.closed++; }, msg => calls.alerts.push(msg), name => calls.paid.push(name), { set href(v) { calls.went.push(v); } });
  return { fn, calls };
}

test('choosing Stock Control goes to its own page: no £32 alert, no Payment Link', () => {
  const { fn, calls } = loadSelectSoftware();
  fn('Stock Control');
  assert.deepEqual(calls.went, ['stock-control/index.html']);
  assert.deepEqual(calls.paid, []);
  assert.deepEqual(calls.alerts, []);
  assert.equal(calls.closed, 1);
});

test('choosing any other tool still goes to payment at £32 as before', () => {
  const { fn, calls } = loadSelectSoftware();
  fn('Quote Builder');
  assert.deepEqual(calls.paid, ['Quote Builder']);
  assert.match(calls.alerts[0], /£32\.00 per month/);
  assert.deepEqual(calls.went, []);
});

test('the shared Payment Link is still only opened from startPayment', () => {
  const uses = html.match(/buy\.stripe\.com\/[A-Za-z0-9]+/g) || [];
  assert.equal(uses.length, 1, 'expected the one Payment Link used by startPayment');
  assert.match(html, /async function startPayment[\s\S]*?buy\.stripe\.com/);
});

test('a paying Stock Control customer can manage and cancel from the dashboard, like every other paid tool', () => {
  const managed = html.match(/const MANAGED_PRODUCTS = \[([^\]]*)\];/);
  assert.ok(managed, 'MANAGED_PRODUCTS not found');
  assert.match(managed[1], /'stock-control'/, "'stock-control' must be in MANAGED_PRODUCTS (Manage button, Cancel list and the dashboard lock all read it)");
  assert.match(html, /'stock-control': 'Stock Control'/, 'the Cancel list needs a readable name for Stock Control');
  // the dashboard card (the second one: the first is the sales card higher up the page)
  const at = html.indexOf('<h3>Stock Control</h3>', html.indexOf('Your Dashboard</h2>'));
  assert.ok(at > 0, 'dashboard Stock Control card not found');
  const card = html.slice(at, html.indexOf('</div>', at));
  assert.match(card, /id="ms-btn-stock-control" class="mkt-btn mkt-btn-manage hidden" onclick="openBillingPortal\('stock-control'\)">Manage Subscription<\/button>/);
  assert.match(card, /<a href="stock-control\/index\.html" class="mkt-btn mkt-btn-blue">Open<\/a>/, 'Open stays');
});
