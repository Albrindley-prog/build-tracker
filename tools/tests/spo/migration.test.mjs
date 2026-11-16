// Runs the two SQL files against a real Postgres engine (PGlite, in memory) and checks:
//   - the upgrade is safe on top of existing data and safe to run twice
//   - one customer can never read or change another customer's rows (row-level security)
//   - the database itself rejects bad values
// Run from the repo root:  node --test tools/tests/spo/migration.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', '..', '..', 'supplier-purchase-order-system');
const SQL1 = fs.readFileSync(path.join(appDir, 'migration.sql'), 'utf8');
const SQL2 = fs.readFileSync(path.join(appDir, 'migration-2-improvements.sql'), 'utf8');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUP_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const PO_DONE = 'aaaaaaaa-0000-4000-8000-000000000010';
const PO_PART = 'aaaaaaaa-0000-4000-8000-000000000011';
const PO_NEW = 'aaaaaaaa-0000-4000-8000-000000000012';
const ALL_TABLES = ['spo_suppliers', 'spo_purchase_orders', 'spo_purchase_order_items', 'spo_price_history', 'spo_counters', 'spo_settings', 'spo_returns'];

let db;

// Act as a signed-in customer (or as a visitor who is not signed in when userId is null).
async function as(userId, fn) {
  await db.exec(`set role ${userId ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${userId || ''}', false);`);
  try { return await fn(); }
  finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

before(async () => {
  db = new PGlite();
  // The parts of Supabase the SQL relies on: auth.users, auth.uid(), the two API roles, and its default table grants.
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create role authenticated nologin;
    create role anon nologin;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to authenticated, anon;
    alter default privileges in schema public grant all on tables to authenticated, anon;
    insert into auth.users (id) values ('${A}'), ('${B}');
  `);
  await db.exec(SQL1);
  // Data as the currently published app would have saved it (old columns only).
  await db.exec(`
    insert into spo_suppliers (id, user_id, name, payment_terms_days, lead_time_days) values ('${SUP_A}', '${A}', 'Northgate Factors', 30, 2);
    insert into spo_purchase_orders (id, user_id, supplier_id, ref, order_date, status, goods_in, notes, total) values
      ('${PO_DONE}', '${A}', '${SUP_A}', 'PO-2026-0001', '2026-08-01', 'delivered', 'yes',     'old note', 45.50),
      ('${PO_PART}', '${A}', '${SUP_A}', 'PO-2026-0002', '2026-08-05', 'sent',      'partial', null,       20.00),
      ('${PO_NEW}',  '${A}', '${SUP_A}', 'PO-2026-0003', '2026-08-09', 'draft',     'no',      null,       -5.00);
    insert into spo_purchase_order_items (purchase_order_id, user_id, name, qty, price) values
      ('${PO_DONE}', '${A}', 'Brake pads', 2, 20.00), ('${PO_DONE}', '${A}', 'Oil filter', 1, 5.50),
      ('${PO_PART}', '${A}', 'Wiper', 4, 5.00),
      ('${PO_NEW}',  '${A}', 'Legacy oddity', -1, 5.00);
    insert into spo_price_history (user_id, supplier_id, item_name, price, recorded_date) values ('${A}', '${SUP_A}', 'Brake pads', 20.00, '2026-08-01');
    insert into spo_counters (user_id, next_po_number) values ('${A}', 4);
  `);
  await db.exec(SQL2);
  await db.exec(SQL2);            // running it a second time must be harmless
  // Rows in the two new tables for customer A.
  await db.exec(`
    insert into spo_settings (user_id, business_name) values ('${A}', 'A Garage Ltd');
    insert into spo_returns (user_id, supplier_id, purchase_order_id, item_name, qty, amount) values ('${A}', '${SUP_A}', '${PO_DONE}', 'Brake pads', 1, 20.00);
  `);
});

// ───────────── upgrade safety ─────────────
test('existing rows survive the upgrade unchanged', async () => {
  assert.equal(await count(`select count(*) n from spo_purchase_orders where user_id = $1`, [A]), 3);
  assert.equal(await count(`select count(*) n from spo_purchase_order_items where user_id = $1`, [A]), 4);
  const po = (await db.query(`select total, subtotal, vat_total, notes, status, goods_in from spo_purchase_orders where id = $1`, [PO_DONE])).rows[0];
  assert.equal(Number(po.total), 45.5);
  assert.equal(po.subtotal, null);
  assert.equal(po.vat_total, null);
  assert.equal(po.notes, 'old note');
  assert.equal(po.status, 'delivered');
  assert.equal(po.goods_in, 'yes');
  assert.equal(await count(`select next_po_number n from spo_counters where user_id = $1`, [A]), 4);
});

test('old lines get VAT 0 so their totals do not change', async () => {
  assert.equal(await count(`select count(*) n from spo_purchase_order_items where vat_rate <> 0`), 0);
});

test('lines of orders already marked fully delivered are back-filled as received; others are not', async () => {
  const done = (await db.query(`select qty, qty_received from spo_purchase_order_items where purchase_order_id = $1 order by name`, [PO_DONE])).rows;
  assert.deepEqual(done.map(r => [Number(r.qty), Number(r.qty_received)]), [[2, 2], [1, 1]]);
  const part = (await db.query(`select qty_received from spo_purchase_order_items where purchase_order_id = $1`, [PO_PART])).rows;
  assert.equal(Number(part[0].qty_received), 0);
});

test('the currently published page can still save after the upgrade (old column lists)', async () => {
  await as(A, async () => {
    const po = (await db.query(
      `insert into spo_purchase_orders (user_id, supplier_id, ref, order_date, payment_terms_days, due_date, status, goods_in, notes, total)
       values ($1, $2, 'PO-2026-0004', '2026-11-16', 30, null, 'draft', 'no', '', 12.00) returning id`, [A, SUP_A])).rows[0];
    await db.query(`insert into spo_purchase_order_items (purchase_order_id, user_id, name, qty, price, notes) values ($1, $2, 'Bulb', 0, 1.20, '')`, [po.id, A]);
    await db.query(`insert into spo_price_history (user_id, supplier_id, item_name, price, recorded_date) values ($1, $2, 'Bulb', 1.20, '2026-11-16')`, [A, SUP_A]);
    await db.query(`update spo_purchase_orders set goods_in = 'yes', status = 'delivered' where id = $1`, [po.id]);
    await db.query(`insert into spo_suppliers (user_id, name, contact, email, phone, payment_terms_days, account, lead_time_days, address) values ($1, 'Old Page Ltd', '', '', '', 90, '', 7, '')`, [A]);
    await db.query(`delete from spo_purchase_orders where id = $1`, [po.id]);
  });
});

test('a pre-existing odd row does not block the upgrade and can still be edited as before', async () => {
  assert.equal(await count(`select count(*) n from spo_purchase_order_items where qty < 0`), 1);
  assert.equal(await count(`select count(*) n from spo_purchase_orders where total < 0`), 1);
  await as(A, async () => {
    // the old page's "Goods In" dropdown and edit both still work on the odd order, without fixing it first
    await db.query(`update spo_purchase_orders set goods_in = 'partial' where id = $1`, [PO_NEW]);
    await db.query(`update spo_purchase_order_items set notes = 'still editable' where purchase_order_id = $1 and qty < 0`, [PO_NEW]);
  });
  assert.equal(await count(`select count(*) n from spo_purchase_orders where id = '${PO_NEW}' and goods_in = 'partial' and total < 0`), 1);
});

test('a row that is inside the rules cannot be changed to be outside them', async () => {
  await as(A, async () => {
    await assert.rejects(db.query(`update spo_purchase_order_items set qty = -3 where purchase_order_id = $1`, [PO_PART]), /violates/);
    await assert.rejects(db.query(`update spo_purchase_orders set status = 'hacked' where id = $1`, [PO_PART]), /violates/);
    await assert.rejects(db.query(`update spo_suppliers set name = '' where id = $1`, [SUP_A]), /violates/);
    await assert.rejects(db.query(`update spo_price_history set price = -1 where user_id = $1`, [A]), /violates/);
  });
  assert.equal(await count(`select qty n from spo_purchase_order_items where purchase_order_id = $1`, [PO_PART]), 4);
});

test('new columns and tables have sensible defaults', async () => {
  await as(A, async () => {
    const it = (await db.query(`insert into spo_purchase_order_items (purchase_order_id, user_id, name) values ($1, $2, 'Default check') returning job_ref, vat_rate, qty_received, position`, [PO_NEW, A])).rows[0];
    assert.equal(it.job_ref, null);
    assert.equal(Number(it.vat_rate), 0);
    assert.equal(Number(it.qty_received), 0);
    assert.equal(it.position, 0);
    const r = (await db.query(`insert into spo_returns (user_id, item_name) values ($1, 'Caliper') returning status, reason, qty, amount, id`, [A])).rows[0];
    assert.equal(r.status, 'to_return');
    assert.equal(r.reason, 'other');
    assert.equal(Number(r.qty), 1);
    assert.equal(Number(r.amount), 0);
    await db.query(`delete from spo_returns where id = $1`, [r.id]);
  });
  assert.equal(await count(`select default_vat_rate n from spo_settings where user_id = $1`, [A]), 20);
});

// ───────────── row-level security: one customer cannot touch another's data ─────────────
const INTRUDER_ROW = {
  spo_suppliers: `insert into spo_suppliers (user_id, name) values ('${A}', 'Intruder')`,
  spo_purchase_orders: `insert into spo_purchase_orders (user_id, ref) values ('${A}', 'PO-X')`,
  spo_purchase_order_items: `insert into spo_purchase_order_items (user_id, purchase_order_id, name) values ('${A}', '${PO_NEW}', 'Intruder')`,
  spo_price_history: `insert into spo_price_history (user_id, item_name, price) values ('${A}', 'Intruder', 1)`,
  spo_counters: `insert into spo_counters (user_id, next_po_number) values ('${A}', 99)`,
  spo_settings: `insert into spo_settings (user_id, business_name) values ('${A}', 'Intruder')`,
  spo_returns: `insert into spo_returns (user_id, item_name) values ('${A}', 'Intruder')`,
};

for (const table of ALL_TABLES) {
  test(`RLS ${table}: another signed-in customer cannot read, add, change or delete`, async () => {
    const before = await count(`select count(*) n from ${table} where user_id = '${A}'`);
    assert.ok(before > 0, 'customer A has rows to protect');
    await as(B, async () => {
      assert.equal(await count(`select count(*) n from ${table}`), 0, 'B can see no rows at all');
      await assert.rejects(db.exec(INTRUDER_ROW[table]), /row-level security|duplicate key/);
      assert.equal((await db.query(`update ${table} set user_id = user_id where user_id = '${A}'`)).affectedRows, 0);
      assert.equal((await db.query(`delete from ${table} where user_id = '${A}'`)).affectedRows, 0);
    });
    assert.equal(await count(`select count(*) n from ${table} where user_id = '${A}'`), before, 'A still has every row');
  });

  test(`RLS ${table}: a visitor who is not signed in gets nothing`, async () => {
    await as(null, async () => {
      assert.equal(await count(`select count(*) n from ${table}`), 0);
      await assert.rejects(db.exec(INTRUDER_ROW[table]), /row-level security|permission denied/);
    });
  });
}

test('RLS: a customer cannot move their own row into someone else\'s account', async () => {
  await db.exec(`insert into spo_suppliers (user_id, name) values ('${B}', 'B Supplier')`);
  await as(B, async () => {
    await assert.rejects(db.exec(`update spo_suppliers set user_id = '${A}' where user_id = '${B}'`), /row-level security/);
  });
});

test('RLS: the owner can use their own rows normally', async () => {
  await as(A, async () => {
    for (const table of ALL_TABLES) assert.ok(await count(`select count(*) n from ${table}`) > 0, table);
    await db.query(`update spo_settings set business_name = 'A Garage (updated)' where user_id = $1`, [A]);
  });
  assert.equal((await db.query(`select business_name from spo_settings where user_id = $1`, [A])).rows[0].business_name, 'A Garage (updated)');
});

// ───────────── the database rejects bad values ─────────────
const BAD = [
  ['negative quantity', `insert into spo_purchase_order_items (user_id, purchase_order_id, name, qty) values ('${A}', '${PO_NEW}', 'x', -1)`],
  ['negative price', `insert into spo_purchase_order_items (user_id, purchase_order_id, name, price) values ('${A}', '${PO_NEW}', 'x', -0.01)`],
  ['VAT rate 500', `insert into spo_purchase_order_items (user_id, purchase_order_id, name, vat_rate) values ('${A}', '${PO_NEW}', 'x', 500)`],
  ['negative received', `insert into spo_purchase_order_items (user_id, purchase_order_id, name, qty_received) values ('${A}', '${PO_NEW}', 'x', -2)`],
  ['over-long part name', `insert into spo_purchase_order_items (user_id, purchase_order_id, name) values ('${A}', '${PO_NEW}', repeat('x', 501))`],
  ['unknown order status', `insert into spo_purchase_orders (user_id, ref, status) values ('${A}', 'PO-B', 'hacked')`],
  ['unknown delivery state', `insert into spo_purchase_orders (user_id, ref, goods_in) values ('${A}', 'PO-B', 'maybe')`],
  ['over-long order notes', `insert into spo_purchase_orders (user_id, ref, notes) values ('${A}', 'PO-B', repeat('x', 10001))`],
  ['empty supplier name', `insert into spo_suppliers (user_id, name) values ('${A}', '')`],
  ['over-long supplier name', `insert into spo_suppliers (user_id, name) values ('${A}', repeat('x', 501))`],
  ['negative lead time', `insert into spo_suppliers (user_id, name, lead_time_days) values ('${A}', 'x', -3)`],
  ['negative logged price', `insert into spo_price_history (user_id, item_name, price) values ('${A}', 'x', -1)`],
  ['unknown return status', `insert into spo_returns (user_id, item_name, status) values ('${A}', 'x', 'lost')`],
  ['unknown return reason', `insert into spo_returns (user_id, item_name, reason) values ('${A}', 'x', 'because')`],
  ['zero return quantity', `insert into spo_returns (user_id, item_name, qty) values ('${A}', 'x', 0)`],
  ['negative credit', `insert into spo_returns (user_id, item_name, amount) values ('${A}', 'x', -5)`],
  ['settings VAT rate 500', `update spo_settings set default_vat_rate = 500 where user_id = '${A}'`],
  ['PO counter below 1', `update spo_counters set next_po_number = 0 where user_id = '${A}'`],
];
for (const [name, sql] of BAD) {
  test(`constraint: ${name} is rejected`, async () => {
    await as(A, async () => { await assert.rejects(db.exec(sql), /check constraint|violates/); });
  });
}

// ───────────── deleting ─────────────
test('deleting an order removes its lines and keeps the return (unlinked)', async () => {
  await as(A, async () => { await db.query(`delete from spo_purchase_orders where id = $1`, [PO_DONE]); });
  assert.equal(await count(`select count(*) n from spo_purchase_order_items where purchase_order_id = $1`, [PO_DONE]), 0);
  const ret = (await db.query(`select purchase_order_id, supplier_id from spo_returns where user_id = $1`, [A])).rows[0];
  assert.equal(ret.purchase_order_id, null);
  assert.equal(ret.supplier_id, SUP_A);
});

test('deleting a supplier keeps its returns and orders (unlinked)', async () => {
  await as(A, async () => { await db.query(`delete from spo_suppliers where id = $1`, [SUP_A]); });
  assert.equal(await count(`select count(*) n from spo_returns where user_id = $1 and supplier_id is null`, [A]), 1);
  assert.ok(await count(`select count(*) n from spo_purchase_orders where user_id = $1 and supplier_id is null`, [A]) >= 2);
});

test('deleting the account removes everything it owned', async () => {
  await db.query(`delete from auth.users where id = $1`, [A]);
  for (const table of ALL_TABLES) assert.equal(await count(`select count(*) n from ${table} where user_id = '${A}'`), 0, table);
});
