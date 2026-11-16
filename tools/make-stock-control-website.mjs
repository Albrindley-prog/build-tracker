#!/usr/bin/env node
// Makes the neutral website Stock Control (stock-control/index.html) from the PD Stevens page (the master,
// stock-control-pd-stevens/index.html): branding out, the Subscribe button and price back in.
//
//   node tools/make-stock-control-website.mjs [version]     e.g.  node tools/make-stock-control-website.mjs 1116a
//
// Every replacement must find its target exactly once, otherwise the build stops. That way a change to the master can
// never make a step quietly do nothing. After building, problems() checks the page and the CLI exits 1 if it finds any.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const BRAND_MARK = '<div class="brand-mark"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="2" height="14" rx=".5"/><rect x="7" y="5" width="1" height="14"/><rect x="10" y="5" width="3" height="14"/><rect x="15" y="5" width="1" height="14"/><rect x="18" y="5" width="3" height="14" rx=".5"/></svg></div>';
const LOGO_SPAN = '<span class="brand-logo" role="img" aria-label="PD Stevens &amp; Sons Ltd"></span>';

function swap(text, from, to, label, expected = 1) {
  const parts = text.split(from);
  if (parts.length - 1 !== expected) throw new Error(`not found (wanted ${expected}, found ${parts.length - 1}): ${label}`);
  return parts.join(to);
}
function swapRe(text, re, to, label, expected = 1) {
  const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const n = (text.match(all) || []).length;
  if (n !== expected) throw new Error(`not found (wanted ${expected}, found ${n}): ${label}`);
  return text.replace(all, to);
}

/** master: the PD Stevens page text. opts: { priceId, priceGbp: '99.00', approxUsd: '133', version: '1116a' } */
export function buildWebsitePage(master, opts) {
  const { priceId, priceGbp, approxUsd, version } = opts;
  let t = master.replace(/\r\n/g, '\n');

  // ── page title, footer, small texts
  t = swap(t, '<title>Stock Control — PD Stevens &amp; Sons Ltd</title>', '<title>Stock Control — Build Tracker Solutions</title>', 'title');
  t = swap(t, 'Stock Control for PD Stevens &amp; Sons Ltd · by Build Tracker Solutions', 'Stock Control · by Build Tracker Solutions', 'footer');
  t = swap(t, '/* dark blue to light blue, taken from the PD Stevens logo */', '/* dark blue to light blue */', 'gradient comment');
  t = swap(t, "'PD Stevens & Sons Ltd — exported '", "'Stock Control — exported '", 'excel export heading');
  t = swap(t, "'PD Stevens & Sons Ltd — ' + new Date()", "'Stock Control — ' + new Date()", 'order list heading');
  t = swap(t, "company: 'PD Stevens & Sons Ltd'", "company: 'Your company name'", 'receipt heading default');
  t = swap(t, 'placeholder="PD Stevens & Sons Ltd&#10;Address&#10;VAT no."', 'placeholder="Your company name&#10;Address&#10;VAT no."', 'settings placeholder');
  t = swap(t, "'https://build-tracker.co.uk/stock-control-pd-stevens/'", "'https://build-tracker.co.uk/stock-control/'", 'QR fallback address');
  t = swapRe(t, /const APP_VERSION = '[^']*';/, `const APP_VERSION = '${version}';`, 'version stamp');

  // ── logo and its styles out
  t = swapRe(t, /\/\* the PD Stevens logo sits on a white plate[^\n]*\*\/\n\.logo-plate \{[^\n]*\}\n\.logo-plate \.brand-logo \{[^\n]*\}\n/, '', 'sign-in plate styles');
  t = swapRe(t, /\/\* the PD Stevens logo, top-left of the dashboard[^\n]*\*\/\n\.brand-logo \{[^\n]*\}\n/, '', 'logo style');
  t = swapRe(t, /    \.logo-plate \{[^\n]*\}\n    \.logo-plate \.brand-logo \{[^\n]*\}\n/, '', 'phone plate styles');
  t = swap(t, '    .brand-logo { height: 28px; }\n', '', 'phone logo style');
  t = swapRe(t, /    \.topbar-brand \.brand-name \{ display: none; \}[^\n]*\n/, '', 'phone rule hiding the screen name');
  t = swap(t, '.brand-sep { width: 1px; height: 26px; background: var(--border); }\n', '', 'divider style');
  t = swap(t, '    .brand-sub, .brand-sep { display: none; }', '    .brand-sub { display: none; }', 'phone divider rule');

  // ── sign-in panel: the neutral mark and name instead of the logo on its white plate
  t = swap(t, `<div class="logo-plate">${LOGO_SPAN}</div>`, `${BRAND_MARK}\n        <div class="aside-co">Stock Control</div>`, 'sign-in logo plate');

  // ── top bars: the neutral mark and names instead of the logo and divider
  t = swap(t,
    `${LOGO_SPAN}\n            <div class="brand-sep"></div>\n            <div class="brand-sub">Stock Control</div>`,
    `${BRAND_MARK}\n            <div>\n                <div class="brand-name">Stock Control</div>\n                <div class="brand-sub">by Build Tracker Solutions</div>\n            </div>`, 'dashboard top bar');
  t = swapRe(t, new RegExp(`${LOGO_SPAN}\\n            <div class="brand-sep"></div>\\n            <div class="brand-name">([^<]+)</div>`),
    `${BRAND_MARK}\n            <div>\n                <div class="brand-name">$1</div>\n                <div class="brand-sub">Stock Control</div>\n            </div>`, 'screen top bars', 4);
  t = swap(t, `${LOGO_SPAN}\n            <div class="brand-sep"></div>\n            <div>`, `${BRAND_MARK}\n            <div>`, 'stock take top bar');

  // ── billing back in (the PD Stevens page has no price and no Subscribe button)
  t = swap(t,
`// --------------------------
// TRIAL & ACCESS CONFIG
// --------------------------
// 30 days free from sign-up; after that the page only opens for a workspace that has an
// active row in bt_subscriptions (rows are scoped by (user_id, product)). PD Stevens pay by
// arrangement, so there is no price and no online checkout in this copy: a subscription row is
// added by hand when they pay, and set to anything other than 'active' to stop access.
const TRIAL_DAYS = 30;
const SUBSCRIPTIONS_TABLE = 'bt_subscriptions';`,
`// --------------------------
// PAYMENT & TRIAL CONFIG
// --------------------------
const TRIAL_DAYS = 30;
const MONTHLY_PRICE = ${priceGbp};
const CURRENCY = 'gbp';
// Same Supabase project as the other apps, so reusing its bt_trials/bt_subscriptions tables and
// create-checkout-session function. Each app bills separately — rows are scoped by (user_id, product).
const STRIPE_PRICE_ID = '${priceId}';
const SUBSCRIPTIONS_TABLE = 'bt_subscriptions';`, 'billing config');

  t = swap(t, '<div class="trial-note">✅ 30 days free trial</div>', `<div class="trial-note">✅ 30 Days Free Trial — then £${priceGbp} per month</div>`, 'sign-in trial note');

  t = swap(t,
`        <h2>Your free trial has ended</h2>
        <div id="billingMessage"></div>
`,
`        <h2>Subscription Required</h2>
        <div id="billingMessage"></div>
        <button class="auth-btn" id="subscribeBtn">Subscribe £${priceGbp}/month</button>
        <p style="font-size:12px;color:var(--muted);text-align:center;margin-top:4px;">(approx. $${approxUsd} USD)</p>
        <p id="paymentMsg" style="font-size:12px;color:var(--muted);text-align:center;margin-top:8px;"></p>
`, 'billing screen');

  t = swapRe(t, /    const msgEl = document\.getElementById\('billingMessage'\);\n    const contact = [\s\S]*?        : contact;\n\}\n/,
`    const msgEl = document.getElementById('billingMessage');
    const subscribeBtn = document.getElementById('subscribeBtn');

    // Only the workspace owner can actually pay — an invited staff member
    // hitting a lapsed trial/subscription sees the same lock (the whole
    // workspace is paused either way) but with no way to start checkout
    // themselves, and a message pointing at who can.
    if (currentRole !== 'owner') {
        subscribeBtn.style.display = 'none';
        msgEl.innerHTML = \`<p style="color:var(--danger);margin-bottom:16px;">❌ This workspace's free trial has ended.<br>Ask \${escapeHtml(userData?.email || 'the workspace owner')} to subscribe to continue.</p>\`;
        return;
    }
    // Back from Stripe: the payment has been taken, but the confirmation that
    // records it here can take a few seconds (now and then longer). Say so and
    // keep Subscribe out of reach, so nobody pays twice. handlePaymentResult()
    // below keeps checking and opens the app as soon as the payment shows up.
    if (paymentCheck) {
        subscribeBtn.style.display = 'none';
        msgEl.innerHTML = paymentCheck === 'slow'
            ? \`<p style="color:var(--danger);margin-bottom:16px;">Your payment is going through, but we have not had the confirmation yet. Please don't pay again. Wait a minute and refresh this page. If it still doesn't open, email info@build-tracker.co.uk.</p>\`
            : \`<p style="color:var(--accent2);margin-bottom:16px;">✅ Payment received. Opening your account…</p>\`;
        return;
    }
    subscribeBtn.style.display = '';

    if(days > 0) {
        msgEl.innerHTML = \`<p style="color:var(--accent2);margin-bottom:16px;">✅ \${days} days of free trial remaining</p>\`;
    } else {
        msgEl.innerHTML = \`<p style="color:var(--danger);margin-bottom:16px;">❌ Your free trial has ended. Subscribe now to continue.</p>\`;
    }

    subscribeBtn.onclick = startSubscription;
}

// Redirects to a real Stripe Checkout session (created server-side by the
// existing 'create-checkout-session' Edge Function), instead of taking card
// details directly in the browser.
async function startSubscription() {
    const msgEl = document.getElementById('paymentMsg');
    if(msgEl) msgEl.textContent = 'Redirecting to secure checkout…';
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        const res = await fetch(\`\${SB_URL}/functions/v1/create-checkout-session\`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': \`Bearer \${session.access_token}\`
            },
            body: JSON.stringify({
                price_id: STRIPE_PRICE_ID,
                product: PRODUCT_ID,
                user_id: ownerId,
                email: currentUser.email,
                success_url: window.location.origin + window.location.pathname + '?payment=success',
                cancel_url: window.location.origin + window.location.pathname + '?payment=cancel'
            })
        });
        const { url, error } = await res.json();
        if(error || !url) throw new Error(error || 'No checkout URL returned');
        window.location.href = url;
    } catch(err) {
        if(msgEl) msgEl.textContent = 'Could not start checkout: ' + err.message;
    }
}
`, 'showBilling and startSubscription');

  // Coming back from Stripe (?payment=success): wait for the payment to be recorded instead of showing Subscribe again.
  t = swap(t,
`// Checks for ?payment=success/cancel on the URL after redirect back from Stripe.
async function handlePaymentResult() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('payment');
    if(!result) return;
    window.history.replaceState({}, '', window.location.pathname);
    if(result === 'success') {
        // Webhook may take a moment to write the active row; brief delay then re-check.
        setTimeout(() => { checkAccess(); }, 1500);
    }
}
`,
`// 'checking' while we wait for a payment made at Stripe to be recorded, then 'slow' if it takes over a minute.
let paymentCheck = null;

// Checks for ?payment=success/cancel on the URL after redirect back from Stripe.
async function handlePaymentResult() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('payment');
    if(!result) return;
    window.history.replaceState({}, '', window.location.pathname);
    if(result !== 'success' || !currentUser) return;
    // Stripe has taken the payment, but the confirmation that records it can take a few seconds (now and then longer).
    // Until it lands the sign-in check still sees an unpaid account, so keep Subscribe hidden (nobody should pay twice)
    // and check again every 3 seconds for about a minute.
    paymentCheck = 'checking';
    for(let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, i === 0 ? 1500 : 3000));
        try { await checkAccess(); } catch(e) { console.error('Re-check after payment failed:', e.message); }
        if(document.getElementById('billingScreen').style.display === 'none') { paymentCheck = null; return; }
    }
    paymentCheck = 'slow';
    showBilling();
}
`, 'payment return');

  return t;
}

/** A list of things wrong with a website page; empty means it is clean. */
export function problems(page) {
  const out = [];
  if (/PD Stevens/i.test(page)) out.push('mentions PD Stevens');
  if (/stevens/i.test(page)) out.push('mentions a Stevens name');
  if (/pd-stevens/i.test(page)) out.push('contains a pd-stevens address');
  if (/logo-plate|\.brand-logo/.test(page)) out.push('still has the logo styles');
  // the small drawn barcode pictures are data:image/svg+xml and are expected; any other embedded picture could be a logo
  if (/data:image\/(?!svg\+xml)/i.test(page)) out.push('contains embedded picture data (a logo?)');
  if (/<img\b/i.test(page)) out.push('contains an <img> picture');
  if (!/create-checkout-session/.test(page)) out.push('the checkout call is missing');
  if (!/const STRIPE_PRICE_ID = 'price_[A-Za-z0-9]+';/.test(page)) out.push('the Stripe price id is missing');
  if (!/const PRODUCT_ID = 'stock-control';/.test(page)) out.push("the product id is not 'stock-control'");
  if (!/Subscribe £\d+\.\d\d\/month/.test(page)) out.push('the Subscribe price text is missing');
  if (/£32|32\.00/.test(page)) out.push('still shows the old £32 price');
  return out;
}

// ── command line
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const masterPath = path.join(root, 'stock-control-pd-stevens', 'index.html');
  const outPath = path.join(root, 'stock-control', 'index.html');
  const version = process.argv[2] || '1116a';
  const page = buildWebsitePage(readFileSync(masterPath, 'utf8'), { priceId: 'price_1UcKi1ICF2fQjVNyOo6gFX1f', priceGbp: '99.00', approxUsd: '133', version });
  const bad = problems(page);
  if (bad.length) { console.error('NOT written. Problems:\n - ' + bad.join('\n - ')); process.exit(1); }
  writeFileSync(outPath, page);
  console.log(`wrote ${path.relative(root, outPath)} (${page.length} characters, version ${version})`);
}
