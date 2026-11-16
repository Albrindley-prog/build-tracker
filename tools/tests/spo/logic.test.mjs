// Unit tests for supplier-purchase-order-system/spo-logic.js (the pure rules).
// Run from the repo root:  node --test tools/tests/spo/logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../../../supplier-purchase-order-system/spo-logic.js');

const TODAY = '2026-11-16';
const line = (o = {}) => ({ id: o.id || 'l1', name: 'Brake pads', jobRef: '', qty: 1, price: 10, vatRate: 20, qtyReceived: 0, notes: '', ...o });
const order = (o = {}) => ({ id: 'o1', supplierId: 's1', ref: 'PO-2026-0001', date: '2026-11-10', dueDate: '2026-11-12', paymentTerms: 30,
  status: 'sent', goodsIn: 'no', notes: '', subtotal: 10, vatTotal: 2, total: 12, deliveredDate: '', items: [line()], ...o });

// ───────────── security: hostile input ─────────────
test('escapeHtml neutralises markup and quotes', () => {
  const out = L.escapeHtml('<img src=x onerror=1>"\'&');
  assert.equal(out, '&lt;img src=x onerror=1&gt;&quot;&#39;&amp;');
  assert.ok(!/[<>"']/.test(out));
  assert.equal(L.escapeHtml(null), '');
  assert.equal(L.escapeHtml(undefined), '');
  assert.equal(L.escapeHtml(0), '0');
  assert.equal(L.escapeHtml('17" tyre'), '17&quot; tyre');
});

test('cleanLine strips control characters and newlines and cuts to length', () => {
  assert.equal(L.cleanLine('  a\u0000b\r\nc\t d  ', 200), 'ab c d');
  assert.equal(L.cleanLine('x'.repeat(500), 200).length, 200);
  assert.equal(L.cleanLine(null, 10), '');
});

test('cleanText keeps line breaks but strips other control characters', () => {
  assert.equal(L.cleanText('line1\r\nline2\u0007', 2000), 'line1\nline2');
  assert.equal(L.cleanText('y'.repeat(3000), 2000).length, 2000);
});

test('num parses, clamps and rounds; junk becomes the minimum', () => {
  assert.equal(L.num('-5'), 0);
  assert.equal(L.num('abc'), 0);
  assert.equal(L.num(''), 0);
  assert.equal(L.num(null), 0);
  assert.equal(L.num('1e99'), 10000000);
  assert.equal(L.num(Infinity), 0);
  assert.equal(L.num('£1,234.567'), 1234.57);
  assert.equal(L.num(1.005), 1.01);
  assert.equal(L.num('2.5', { max: 1000000, dp: 3 }), 2.5);
  assert.equal(L.num('7', { min: 1, max: 5 }), 5);
});

test('telHref keeps only digits and a leading plus', () => {
  assert.equal(L.telHref('01234 567890<script>'), 'tel:01234567890');
  assert.equal(L.telHref('+44 (0)1234 567890'), 'tel:+4401234567890');
  assert.equal(L.telHref('javascript:alert(1)'), '');
  assert.equal(L.telHref(''), '');
});

test('mailtoHref refuses anything that is not a single plain address', () => {
  assert.equal(L.mailtoHref('a@b.co\r\nBcc: x@y.co', 'S', 'B'), '');
  assert.equal(L.mailtoHref('a@b.co?bcc=evil@x.com', 'S', 'B'), '');
  assert.equal(L.mailtoHref('a@b.co, c@d.co', 'S', 'B'), '');
  assert.equal(L.mailtoHref('"><script>', 'S', 'B'), '');
  assert.equal(L.mailtoHref('orders@supplier.co.uk', 'PO & more', 'Line 1\nLine 2'),
    'mailto:orders@supplier.co.uk?subject=PO%20%26%20more&body=Line%201%0D%0ALine%202');
});

test('isValidEmail', () => {
  assert.ok(L.isValidEmail('joe.bloggs+po@supplier.co.uk'));
  assert.ok(!L.isValidEmail('joe@'));
  assert.ok(!L.isValidEmail('joe bloggs@x.co'));
  assert.ok(!L.isValidEmail('a@b.co' + 'm'.repeat(300)));
});

test('validators reject bad values and clean the rest', () => {
  const s = L.validateSupplier({ name: '  <b>Acme</b>\n ', email: 'not-an-email', terms: '9999', leadTime: '-4', phone: 'x'.repeat(100) });
  assert.equal(s.ok, false);
  assert.match(s.errors.join(' '), /email/i);
  const ok = L.validateSupplier({ name: '  <b>Acme</b>\n ', email: '', terms: '9999', leadTime: '-4', phone: 'x'.repeat(100) });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, '<b>Acme</b>');          // stored as typed; escaping happens on output
  assert.equal(ok.value.terms, 365);
  assert.equal(ok.value.leadTime, 0);
  assert.equal(ok.value.phone.length, 60);
  assert.equal(L.validateSupplier({ name: '   ' }).ok, false);

  const o = L.validateOrder({ supplierId: '', date: 'yesterday', status: 'hacked', lines: [] });
  assert.equal(o.ok, false);
  assert.ok(o.errors.length >= 3);

  const good = L.validateOrder({ supplierId: 's1', date: '2026-11-16', dueDate: '', status: 'draft', paymentTerms: 30, notes: 'n',
    lines: [line({ name: ' Pads ', qty: '2', price: '10.50', vatRate: 20 }), line({ name: '', qty: 5 }), line({ name: 'Disc', qty: '0' })] });
  assert.equal(good.ok, false);                          // qty 0 on a named line
  const good2 = L.validateOrder({ supplierId: 's1', date: '2026-11-16', dueDate: '', status: 'draft', paymentTerms: 30, notes: 'n',
    lines: [line({ name: ' Pads ', qty: '2', price: '10.50', vatRate: 17 }), line({ name: '', qty: 5 })] });
  assert.equal(good2.ok, true);
  assert.equal(good2.value.lines.length, 1);             // blank line dropped
  assert.equal(good2.value.lines[0].name, 'Pads');
  assert.equal(good2.value.lines[0].vatRate, 20);        // unknown rate falls back to standard

  const r = L.validateReturn({ supplierId: 's1', itemName: 'Caliper', qty: 1, amount: '-3', reason: 'nope', status: 'weird' });
  assert.equal(r.ok, true);
  assert.equal(r.value.amount, 0);
  assert.equal(r.value.reason, 'other');
  assert.equal(r.value.status, 'to_return');
  assert.equal(L.validateReturn({ supplierId: '', itemName: '' }).ok, false);

  const set = L.validateSettings({ businessName: 'x'.repeat(300), email: 'bad', defaultVatRate: 99 });
  assert.equal(set.ok, false);
  const set2 = L.validateSettings({ businessName: 'x'.repeat(300), email: '', defaultVatRate: 99 });
  assert.equal(set2.value.businessName.length, 200);
  assert.equal(set2.value.defaultVatRate, 20);
});

test('validateOrder will not let a quantity drop below what has been received', () => {
  const v = L.validateOrder({ supplierId: 's1', date: TODAY, status: 'sent', lines: [line({ qty: 2, qtyReceived: 3 })] });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /received/i);
});

// ───────────── money and VAT ─────────────
test('lineTotals rounds to pence per line', () => {
  assert.deepEqual(L.lineTotals({ qty: 3, price: 0.33, vatRate: 20 }), { net: 0.99, vat: 0.2, gross: 1.19 });
  assert.deepEqual(L.lineTotals({ qty: 2, price: 10, vatRate: 0 }), { net: 20, vat: 0, gross: 20 });
  assert.deepEqual(L.lineTotals({ qty: 'x', price: null }), { net: 0, vat: 0, gross: 0 });
});

test('orderTotals adds the lines', () => {
  const t = L.orderTotals([{ qty: 3, price: 0.33, vatRate: 20 }, { qty: 1, price: 100, vatRate: 5 }, { qty: 1, price: 10, vatRate: 0 }]);
  assert.deepEqual(t, { subtotal: 110.99, vat: 5.2, total: 116.19 });
});

test('money formats pounds', () => {
  assert.equal(L.money(1234.5), '£1,234.50');
  assert.equal(L.money(0), '£0.00');
  assert.equal(L.money(-3), '-£3.00');
  assert.equal(L.money('junk'), '£0.00');
});

// ───────────── delivery ─────────────
test('deliveryState', () => {
  assert.equal(L.deliveryState([line({ qty: 2, qtyReceived: 0 })]), 'no');
  assert.equal(L.deliveryState([line({ qty: 2, qtyReceived: 1 })]), 'partial');
  assert.equal(L.deliveryState([line({ qty: 2, qtyReceived: 2 }), line({ qty: 1, qtyReceived: 0 })]), 'partial');
  assert.equal(L.deliveryState([line({ qty: 2, qtyReceived: 2 }), line({ qty: 1, qtyReceived: 1 })]), 'yes');
  assert.equal(L.deliveryState([]), 'no');
});

test('receivedSummary', () => {
  assert.deepEqual(L.receivedSummary([line({ qty: 4, qtyReceived: 1 }), line({ qty: 2, qtyReceived: 2 })]),
    { ordered: 6, received: 3, outstanding: 3, lineCount: 2, linesDone: 1 });
});

test('applyReceipt adds what arrived and works out the new state', () => {
  const lines = [line({ id: 'a', qty: 4, qtyReceived: 1 }), line({ id: 'b', qty: 2, qtyReceived: 0 })];
  const r = L.applyReceipt(lines, { a: '2', b: '' });
  assert.equal(r.ok, true);
  assert.equal(r.anyArrived, true);
  assert.equal(r.lines[0].qtyReceived, 3);
  assert.equal(r.lines[1].qtyReceived, 0);
  assert.equal(r.state, 'partial');
  assert.equal(lines[0].qtyReceived, 1);                 // input not mutated
  assert.equal(L.applyReceipt(lines, { a: 3, b: 2 }).state, 'yes');
});

test('applyReceipt rejects negatives, junk and more than is outstanding', () => {
  const lines = [line({ id: 'a', qty: 4, qtyReceived: 1 })];
  assert.equal(L.applyReceipt(lines, { a: '-1' }).ok, false);
  assert.equal(L.applyReceipt(lines, { a: 'lots' }).ok, false);
  assert.equal(L.applyReceipt(lines, { a: '4' }).ok, false);
  assert.equal(L.applyReceipt(lines, { a: '0' }).anyArrived, false);
});

test('isOpen and isOverdue', () => {
  assert.equal(L.isOverdue(order({ dueDate: '2026-11-12' }), TODAY), true);
  assert.equal(L.isOverdue(order({ dueDate: TODAY }), TODAY), false);
  assert.equal(L.isOverdue(order({ dueDate: '' }), TODAY), false);
  assert.equal(L.isOverdue(order({ status: 'delivered' }), TODAY), false);
  assert.equal(L.isOverdue(order({ goodsIn: 'yes' }), TODAY), false);
  assert.equal(L.isOverdue(order({ status: 'draft' }), TODAY), false);
  assert.equal(L.isOpen(order({ status: 'invoiced' })), false);
  assert.equal(L.isOpen(order({ status: 'draft' })), true);
});

test('dates', () => {
  assert.equal(L.addDays('2026-11-16', 7), '2026-11-23');
  assert.equal(L.addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(L.daysBetween('2026-10-17', '2026-11-16'), 30);
  assert.equal(L.expectedDate('2026-11-16', 3), '2026-11-19');
  assert.equal(L.expectedDate('2026-11-16', 0), '');
  assert.equal(L.expectedDate('', 3), '');
  assert.equal(L.isISODate('2026-11-16'), true);
  assert.equal(L.isISODate('2026-13-40'), false);
  assert.equal(L.isISODate('16/11/2026'), false);
  assert.equal(L.todayISO(new Date(2026, 10, 16, 23, 30)), '2026-11-16');
  assert.equal(L.formatDate('2026-11-16'), '16 Nov 2026');
  assert.equal(L.formatDate(''), '—');
  assert.equal(L.poRef(2026, 7), 'PO-2026-0007');
});

// ───────────── search and filters ─────────────
test('filterOrders by chip and by part / job text', () => {
  const orders = [
    order({ id: 'a', ref: 'PO-2026-0001', status: 'draft', dueDate: '' }),
    order({ id: 'b', ref: 'PO-2026-0002', status: 'sent', dueDate: '2026-11-01', items: [line({ name: 'Front discs', jobRef: 'AB12 CDE' })] }),
    order({ id: 'c', ref: 'PO-2026-0003', status: 'confirmed', goodsIn: 'partial', dueDate: '2026-12-01', supplierId: 's2' }),
    order({ id: 'd', ref: 'PO-2026-0004', status: 'delivered', goodsIn: 'yes' }),
    order({ id: 'e', ref: 'PO-2026-0005', status: 'invoiced', goodsIn: 'yes' }),
  ];
  const names = { s1: 'Northgate Factors', s2: 'Tyre Co' };
  const f = (filter, q = '') => L.filterOrders(orders, { filter, q, supplierName: id => names[id] || '', today: TODAY }).map(o => o.id).join('');
  assert.equal(f('all'), 'abcde');
  assert.equal(f('open'), 'abc');
  assert.equal(f('overdue'), 'b');
  assert.equal(f('draft'), 'a');
  assert.equal(f('partial'), 'c');
  assert.equal(f('awaiting'), 'bc');
  assert.equal(f('delivered'), 'd');
  assert.equal(f('invoiced'), 'e');
  assert.equal(f('all', 'discs'), 'b');
  assert.equal(f('all', 'ab12'), 'b');
  assert.equal(f('all', 'tyre'), 'c');
  assert.equal(f('all', '0004'), 'd');
  assert.equal(f('all', 'front northgate'), 'b');
  assert.equal(f('all', 'zzz'), '');
});

// ───────────── home screen numbers ─────────────
test('dashboardStats', () => {
  const orders = [
    order({ id: 'a', status: 'draft', total: 50, date: '2026-11-02', dueDate: '' }),
    order({ id: 'b', status: 'sent', total: 120, date: '2026-11-03', dueDate: '2026-11-05' }),
    order({ id: 'c', status: 'confirmed', goodsIn: 'partial', total: 80, date: '2026-10-20', dueDate: '2026-12-01' }),
    order({ id: 'd', status: 'delivered', goodsIn: 'yes', total: 200, date: '2026-10-05' }),
  ];
  const returns = [
    { id: 'r1', status: 'to_return', amount: 15, createdAt: '2026-11-15T10:00:00Z' },
    { id: 'r2', status: 'returned', amount: 40, returnedDate: '2026-10-01' },
    { id: 'r3', status: 'credited', amount: 99, returnedDate: '2026-09-01' },
  ];
  const s = L.dashboardStats({ orders, returns, today: TODAY });
  assert.equal(s.openCount, 3);
  assert.equal(s.openValue, 250);
  assert.equal(s.overdueCount, 1);
  assert.equal(s.awaitingCount, 2);
  assert.equal(s.partialCount, 1);
  assert.equal(s.creditCount, 2);
  assert.equal(s.creditValue, 55);
  assert.equal(s.chaseCount, 1);
  assert.equal(s.spendThisMonth, 120);                   // drafts are not spend
  assert.equal(s.spendLastMonth, 280);
});

test('topSuppliers ranks by spend in the window', () => {
  const orders = [
    order({ supplierId: 's1', total: 100, date: '2026-11-01' }),
    order({ supplierId: 's2', total: 300, date: '2026-10-01' }),
    order({ supplierId: 's1', total: 50, date: '2026-09-10' }),
    order({ supplierId: 's1', total: 999, date: '2026-01-01' }),          // too old
    order({ supplierId: 's2', total: 999, date: '2026-11-01', status: 'draft' }),
  ];
  assert.deepEqual(L.topSuppliers(orders, TODAY), [{ supplierId: 's2', spend: 300, count: 1 }, { supplierId: 's1', spend: 150, count: 2 }]);
});

test('attentionItems lists overdue orders and returns to chase, worst first', () => {
  const orders = [order({ id: 'b', dueDate: '2026-11-05' }), order({ id: 'c', dueDate: '2026-11-14' }), order({ id: 'ok', dueDate: '2026-12-01' })];
  const returns = [{ id: 'r2', status: 'returned', amount: 40, returnedDate: '2026-10-01' }, { id: 'r9', status: 'returned', amount: 1, returnedDate: '2026-11-10' }];
  const items = L.attentionItems({ orders, returns, today: TODAY });
  assert.deepEqual(items.map(i => i.kind + ':' + i.id + ':' + i.days), ['overdue:b:11', 'overdue:c:2', 'chase:r2:46']);
});

// ───────────── price history ─────────────
const HIST = [
  { supplierId: 's1', name: 'Oil filter', price: 5.0, date: '2026-09-01' },
  { supplierId: 's1', name: 'oil FILTER', price: 5.6, date: '2026-10-01' },
  { supplierId: 's2', name: 'Oil filter', price: 4.9, date: '2026-08-01' },
  { supplierId: 's3', name: 'Oil filter', price: 6.5, date: '2026-10-10' },
];

test('lastPrice is the most recent for that supplier, ignoring case', () => {
  assert.equal(L.lastPrice(HIST, 's1', 'OIL filter '), 5.6);
  assert.equal(L.lastPrice(HIST, 's2', 'Oil filter'), 4.9);
  assert.equal(L.lastPrice(HIST, 's1', 'Air filter'), null);
});

test('cheaperElsewhere finds a lower latest price at another supplier', () => {
  assert.deepEqual(L.cheaperElsewhere(HIST, 's1', 'Oil filter', 5.6), { supplierId: 's2', price: 4.9 });
  assert.equal(L.cheaperElsewhere(HIST, 's2', 'Oil filter', 4.9), null);
  assert.equal(L.cheaperElsewhere(HIST, 's1', 'Air filter', 3), null);
  assert.equal(L.cheaperElsewhere(HIST, 's1', 'Oil filter', 0), null);
});

test('priceChange', () => {
  assert.deepEqual(L.priceChange(5, 5.6), { diff: 0.6, pct: 12 });
  assert.deepEqual(L.priceChange(10, 9), { diff: -1, pct: -10 });
  assert.equal(L.priceChange(5, 5), null);
  assert.equal(L.priceChange(null, 5), null);
  assert.equal(L.priceChange(0, 5), null);
});

test('priceRowsToLog only logs new or changed prices, once per part', () => {
  const rows = L.priceRowsToLog(HIST, 's1', [
    line({ name: 'Oil filter', price: 5.6 }),            // unchanged → skipped
    line({ name: 'Air filter', price: 8 }),              // new
    line({ name: 'air filter', price: 8 }),              // duplicate on the same order
    line({ name: 'Wiper', price: 0 }),                   // no price → skipped
    line({ name: 'Brake pads', price: 21 }),
  ], TODAY);
  assert.deepEqual(rows, [
    { supplierId: 's1', name: 'Air filter', price: 8, date: TODAY },
    { supplierId: 's1', name: 'Brake pads', price: 21, date: TODAY },
  ]);
});

test('historyWithChange is newest first with the change from the previous price', () => {
  const rows = L.historyWithChange(HIST);
  assert.equal(rows[0].date, '2026-10-10');
  const oct = rows.find(r => r.date === '2026-10-01');
  assert.deepEqual(oct.change, { diff: 0.6, pct: 12 });
  assert.equal(rows.find(r => r.date === '2026-09-01').change, null);
});

test('reorderGroups groups recent parts by supplier with the latest price', () => {
  const orders = [
    order({ supplierId: 's1', date: '2026-11-01', items: [line({ name: 'Pads', price: 20 }), line({ name: 'Discs', price: 40 })] }),
    order({ supplierId: 's1', date: '2026-10-01', items: [line({ name: 'pads', price: 18 })] }),
    order({ supplierId: 's2', date: '2026-10-15', items: [line({ name: 'Tyre 205/55', price: 60, vatRate: 20 })] }),
    order({ supplierId: 's2', date: '2026-05-01', items: [line({ name: 'Old thing', price: 1 })] }),
    order({ supplierId: null, date: '2026-11-01', items: [line({ name: 'Orphan' })] }),
  ];
  const g = L.reorderGroups(orders, TODAY);
  assert.equal(g.length, 2);
  assert.deepEqual(g.find(x => x.supplierId === 's1').items.map(i => i.name + '@' + i.lastPrice), ['Discs@40', 'Pads@20']);
  assert.deepEqual(g.find(x => x.supplierId === 's2').items.map(i => i.name), ['Tyre 205/55']);
});

// ───────────── returns ─────────────
test('returnFlag: chase 30 days after it went back, nudge after a week unsent', () => {
  assert.equal(L.returnFlag({ status: 'returned', returnedDate: '2026-10-17' }, TODAY), 'chase');
  assert.equal(L.returnFlag({ status: 'returned', returnedDate: '2026-10-18' }, TODAY), null);
  assert.equal(L.returnFlag({ status: 'to_return', createdAt: '2026-11-01T09:00:00Z' }, TODAY), 'send');
  assert.equal(L.returnFlag({ status: 'to_return', createdAt: '2026-11-14T09:00:00Z' }, TODAY), null);
  assert.equal(L.returnFlag({ status: 'credited', returnedDate: '2026-01-01' }, TODAY), null);
});

test('filterReturns', () => {
  const returns = [
    { id: 'a', supplierId: 's1', itemName: 'Caliper', status: 'to_return', createdAt: '2026-11-15T00:00:00Z', creditRef: '', notes: '' },
    { id: 'b', supplierId: 's2', itemName: 'Alternator', status: 'returned', returnedDate: '2026-10-01', creditRef: '', notes: 'surcharge unit' },
    { id: 'c', supplierId: 's1', itemName: 'Wiper', status: 'credited', returnedDate: '2026-09-01', creditRef: 'CN-88', notes: '' },
  ];
  const f = (filter, q = '') => L.filterReturns(returns, { filter, q, supplierName: id => ({ s1: 'Northgate', s2: 'Tyre Co' }[id]), today: TODAY }).map(r => r.id).join('');
  assert.equal(f('all'), 'abc');
  assert.equal(f('open'), 'ab');
  assert.equal(f('to_return'), 'a');
  assert.equal(f('returned'), 'b');
  assert.equal(f('credited'), 'c');
  assert.equal(f('chase'), 'b');
  assert.equal(f('all', 'cn-88'), 'c');
  assert.equal(f('all', 'tyre'), 'b');
});

// ───────────── rows from the database, including pre-upgrade rows ─────────────
test('orderFromRow copes with rows saved before the upgrade', () => {
  const o = L.orderFromRow(
    { id: 'o1', supplier_id: 's1', ref: 'PO-2026-0001', order_date: '2026-08-01', due_date: null, payment_terms_days: 30, status: 'sent', goods_in: 'partial', notes: null, total: '45.50' },
    [{ id: 'i2', name: 'B', qty: '1', price: '5.50', notes: null }, { id: 'i1', name: 'A', qty: '2', price: '20.00', notes: 'x', position: 0 }]);
  assert.equal(o.total, 45.5);
  assert.equal(o.subtotal, 45.5);
  assert.equal(o.vatTotal, 0);
  assert.equal(o.goodsIn, 'partial');
  assert.equal(o.dueDate, '');
  assert.equal(o.items.length, 2);
  assert.deepEqual(o.items[0], { id: 'i2', name: 'B', jobRef: '', qty: 1, price: 5.5, vatRate: 0, qtyReceived: 0, notes: '', position: 0 });
});

test('orderFromRow sorts lines by position and reads the new columns', () => {
  const o = L.orderFromRow(
    { id: 'o1', supplier_id: 's1', ref: 'R', order_date: '2026-11-01', due_date: '2026-11-03', payment_terms_days: 0, status: 'delivered', goods_in: 'yes', notes: 'n', subtotal: '10.00', vat_total: '2.00', total: '12.00', delivered_date: '2026-11-03' },
    [{ id: 'i2', name: 'B', qty: 1, price: 5, position: 1, vat_rate: '20', qty_received: '1', job_ref: 'AB12 CDE' }, { id: 'i1', name: 'A', qty: 1, price: 5, position: 0, vat_rate: 20, qty_received: 1 }]);
  assert.deepEqual(o.items.map(i => i.name), ['A', 'B']);
  assert.equal(o.items[1].jobRef, 'AB12 CDE');
  assert.equal(o.items[1].qtyReceived, 1);
  assert.equal(o.vatTotal, 2);
  assert.equal(o.deliveredDate, '2026-11-03');
});

test('orderEmail builds a plain-text order and shortens very long orders', () => {
  const po = order({ items: Array.from({ length: 40 }, (_, i) => line({ name: 'Part ' + i, qty: 1, price: 1 })) });
  const e = L.orderEmail(po, { name: 'Northgate', contact: 'Sam' }, { businessName: 'My Garage Ltd' });
  assert.equal(e.subject, 'Purchase Order PO-2026-0001 from My Garage Ltd');
  assert.match(e.body, /Dear Sam/);
  assert.match(e.body, /Part 0/);
  assert.match(e.body, /and 15 more/);
  assert.ok(!/Part 39/.test(e.body));
  assert.match(e.body, /My Garage Ltd/);
});

test('supplierStats counts open orders and 12-month spend per supplier', () => {
  const orders = [
    order({ supplierId: 's1', total: 100, date: '2026-11-01', status: 'sent' }),
    order({ supplierId: 's1', total: 50, date: '2025-06-01', status: 'invoiced', goodsIn: 'yes' }),
    order({ supplierId: 's1', total: 70, date: '2026-10-01', status: 'draft' }),
  ];
  assert.deepEqual(L.supplierStats(orders, TODAY).s1, { orderCount: 3, openCount: 2, spend12m: 100 });
});
