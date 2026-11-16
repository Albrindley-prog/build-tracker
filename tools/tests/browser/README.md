# Browser tests for Stock Control

These drive the real pages in Chrome against a pretend (in-memory) Supabase, so nothing real is touched.

Two pages are tested with the same suites:

- `PAGE=website` → `stock-control/index.html` (the neutral page sold on build-tracker.co.uk, generated)
- `PAGE=pd` (default) → `stock-control-pd-stevens/index.html` (the master, PD Stevens' own page)

Regenerate the website page first whenever the master changes:

```
node tools/make-stock-control-website.mjs <version>      # e.g. 1116b  (MMDD + a letter)
node --test tools/tests/make-stock-control-website.test.mjs
```

Run a suite from the repo root (Windows, Git Bash):

```
npm install --prefix tools/tests/browser          # once: playwright-core, exceljs, jsqr, xlsx
export NODE_PATH="$PWD/tools/tests/browser/node_modules"
PAGE=website node tools/tests/browser/selltest.js
PAGE=pd      node tools/tests/browser/selltest.js
```

Each suite prints `PASS`/`FAIL` lines and ends with `ALL PASSED` or `N FAILED` (read the last line; the exit code is not set on failures).
They need Google Chrome installed (Playwright uses the system Chrome).

| Suite | Covers |
|---|---|
| `selltest.js` | selling at the counter, receipts, sales list, void, Sage CSV |
| `stocktest.js` | stock take |
| `potest.js` | purchase orders and goods in |
| `reordertest.js` | reorder levels and the To order list |
| `stilltest.js` | stillages, customer orders, reservations |
| `deletetest.js` | deleting a sale, the logo / brand mark in every top bar |
| `barcodetest.js` | Code 128 / Code 39 barcodes |
| `lowtest.js` | the Low stock list |
| `qrtest.js` | QR codes on the barcode pop-up |
| `billingtest.js` | PD Stevens page only: no price, 30-day lock, contact text |
| `website-billing.test.js` | website page only: £99 price, Subscribe, checkout failures, trial lock, staff, bank-transfer subscribers |

`mock.js` is the pretend Supabase. `page-config.js` picks the page.
Screenshots go to `tools/tests/browser/shots2/` (not committed).
