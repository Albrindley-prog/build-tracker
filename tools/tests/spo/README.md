# Tests for Supplier & Purchase Orders

Everything here runs on this computer only. Nothing real is ever contacted: the browser tests and the
preview use a pretend Supabase (`mock-server.js`, listening on 127.0.0.1), and the database tests use a
real Postgres engine running in memory (PGlite).

Run from the repo root (Windows, Git Bash):

```
npm install --prefix tools/tests/spo        # once: playwright-core, @electric-sql/pglite (exact versions)
node --test tools/tests/spo/logic.test.mjs      # the rules: money, VAT, delivery, validation, text safety
node --test tools/tests/spo/migration.test.mjs  # the SQL: upgrade safety, row-level security, value rules
node tools/tests/spo/browser.test.js            # the real page in Chrome (needs Google Chrome installed)
node tools/tests/spo/browser.test.js xss        # ...or just one group
```

The browser suite prints `PASS`/`FAIL` lines and ends with `ALL PASSED` or `N FAILED`.

| Browser group | Covers |
|---|---|
| `csp` | no inline script, pinned library with integrity hash, one guarded place that writes to the page |
| `auth` | app hidden until signed in, plain error messages, password length, sign-up |
| `billing` | trial over → locked; subscriber gets in; price shown; checkout goes through the server function |
| `xss` | hostile text in every field is shown as text, never run — typed in or arriving in the data |
| `account-switch` | nothing of one account is left on screen for the next person to sign in |
| `errors` | server failures show a plain message with no technical detail; nothing typed is lost |
| `suppliers` | add, edit, delete, links, order count and spend |
| `orders` | VAT totals, job/reg, search, filters, price history, print, email, order again, delete |
| `receiving` | line-by-line receiving, back orders, overdue, orders from before the upgrade |
| `returns` | log from a received line, sent back, credited, chase flag |
| `home` | tiles, needs attention, top suppliers, getting-started list |
| `prices` | price changes, cheaper-elsewhere hint, reorder suggestions per supplier |
| `big` | more than 1000 rows still load |
| `phone` | no sideways scrolling at phone width |

## Preview with made-up data

```
node tools/tests/spo/mock-server.js --port 8092 --seed demo
```

Open http://127.0.0.1:8092/supplier-purchase-order-system/ — the sign-in box is filled in with a demo
account (its password is random each time and never leaves this computer). Click **Sign in**.
Anything you change is forgotten when the preview stops.
