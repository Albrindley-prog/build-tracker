// Demo data for the local preview (node tools/tests/spo/mock-server.js --seed demo).
// Every name, number and address here is made up. The demo sign-in password is random each
// time the preview starts and is only ever filled into the sign-in box on this computer.
const crypto = require('crypto');
const L = require('../../../supplier-purchase-order-system/spo-logic.js');

function seedDemo(mock) {
  const password = crypto.randomBytes(12).toString('base64url');
  const user = mock.createUser('demo@example.test', password, { first_name: 'Demo', last_name: 'Garage' });
  mock.state.demo = { email: user.email, password };
  const uid = user.id, today = L.todayISO(), ago = n => L.addDays(today, -n);
  mock.state.trialStart[uid] = new Date(Date.now() - 6 * 864e5).toISOString();

  mock.insert('spo_settings', { user_id: uid, business_name: 'Demo Garage Ltd', address: 'Unit 4, Example Trading Estate\nAnytown AN1 2BC',
    phone: '01632 960123', email: 'parts@demo-garage.example', vat_number: 'GB 000 0000 00', default_vat_rate: 20 });

  const sup = (name, contact, email, phone, terms, lead, account) =>
    mock.insert('spo_suppliers', { user_id: uid, name, contact, email, phone, payment_terms_days: terms, lead_time_days: lead, account, address: '1 Sample Road\nAnytown AN1 1AA' });
  const northgate = sup('Northgate Motor Factors', 'Sam Carter', 'orders@northgate-factors.example', '01632 960101', 30, 1, 'NG-4471');
  const brake = sup('Brake & Clutch Direct', 'Priya Shah', 'sales@brake-clutch-direct.example', '01632 960102', 30, 2, 'BCD-208');
  const tyres = sup('Tyre Wholesale Co', 'Lee Morgan', 'trade@tyre-wholesale.example', '01632 960103', 60, 3, 'TW-9917');
  const dealer = sup('Main Dealer Parts', 'Parts desk', 'parts@main-dealer.example', '01632 960104', 30, 5, 'MD-55120');

  let n = 0;
  // lines: [name, qty, price, jobRef, qtyReceived]
  function order(supplier, daysAgo, status, due, lines, notes) {
    n++;
    const items = lines.map(([name, qty, price, jobRef, received]) => ({ name, qty, price, vatRate: 20, jobRef: jobRef || '', qtyReceived: received === undefined ? 0 : received }));
    const t = L.orderTotals(items), state = L.deliveryState(items);
    const po = mock.insert('spo_purchase_orders', { user_id: uid, supplier_id: supplier.id, ref: L.poRef(today.slice(0, 4), n), order_date: ago(daysAgo), due_date: due,
      payment_terms_days: supplier.payment_terms_days, status, goods_in: state, notes: notes || null, subtotal: t.subtotal, vat_total: t.vat, total: t.total,
      delivered_date: state === 'yes' ? due : null, created_at: new Date(Date.now() - daysAgo * 864e5).toISOString() });
    items.forEach((it, i) => {
      mock.insert('spo_purchase_order_items', { user_id: uid, purchase_order_id: po.id, name: it.name, qty: it.qty, price: it.price, vat_rate: 20, job_ref: it.jobRef || null, qty_received: it.qtyReceived, position: i });
      mock.insert('spo_price_history', { user_id: uid, supplier_id: supplier.id, item_name: it.name, price: it.price, recorded_date: ago(daysAgo) });
    });
    return po;
  }

  const po1 = order(northgate, 40, 'invoiced', ago(39), [['Brake pads front set', 2, 24.50, 'AB12 CDE', 2], ['Oil filter', 4, 5.40, '', 4]]);
  const po2 = order(tyres, 33, 'delivered', ago(30), [['Tyre 205/55 R16', 4, 58.00, 'YK19 ABC', 4]]);
  order(brake, 20, 'invoiced', ago(18), [['Clutch kit', 1, 189.00, 'Job 1042', 1], ['Brake discs front pair', 1, 62.00, 'Job 1042', 1]]);
  order(brake, 12, 'delivered', ago(10), [['Brake pads front set', 3, 22.10, '', 3]]);
  order(northgate, 9, 'sent', ago(6), [['Timing belt kit', 1, 96.00, 'LM68 XYZ', 1], ['Water pump', 1, 44.00, 'LM68 XYZ', 0], ['Oil filter', 6, 5.90, '', 6]], 'Water pump on back order - chase Sam.');
  const po6 = order(dealer, 4, 'confirmed', L.addDays(today, 1), [['Door mirror glass', 1, 38.50, 'Job 1051', 0], ['Alternator (exchange)', 1, 165.00, 'Job 1049', 0]], 'Old alternator to go back for the surcharge.');
  order(tyres, 2, 'sent', L.addDays(today, 2), [['Tyre 225/45 R17', 2, 71.00, 'Job 1053', 0]]);
  order(northgate, 0, 'draft', L.addDays(today, 1), [['Wiper blades 24"', 5, 7.99, '', 0], ['Engine oil 5W-30 5L', 6, 28.95, '', 0]]);
  mock.insert('spo_counters', { user_id: uid, next_po_number: n + 1 });

  mock.insert('spo_returns', { user_id: uid, supplier_id: northgate.id, purchase_order_id: po1.id, item_name: 'Brake pads front set', qty: 1, amount: 24.50,
    reason: 'wrong_part', status: 'returned', returned_date: ago(34), notes: 'Wrong fitment - driver took it back.', created_at: new Date(Date.now() - 36 * 864e5).toISOString() });
  mock.insert('spo_returns', { user_id: uid, supplier_id: dealer.id, purchase_order_id: po6.id, item_name: 'Alternator (old unit)', qty: 1, amount: 45.00,
    reason: 'surcharge', status: 'to_return', created_at: new Date(Date.now() - 2 * 864e5).toISOString() });
  mock.insert('spo_returns', { user_id: uid, supplier_id: tyres.id, purchase_order_id: po2.id, item_name: 'Tyre 205/55 R16', qty: 1, amount: 58.00,
    reason: 'damaged', status: 'credited', returned_date: ago(29), credit_ref: 'CN-20418', credited_date: ago(20), created_at: new Date(Date.now() - 30 * 864e5).toISOString() });
}

module.exports = { seedDemo };
