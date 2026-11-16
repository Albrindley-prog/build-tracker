// Supplier & Purchase Orders — the rules (no screen code, no network).
// Loaded by index.html as window.SPOLogic and by the Node tests via require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SPOLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── fixed values ──────────────────────────────────────────────
  const VAT_RATES = [20, 5, 0];
  const STATUSES = ['draft', 'sent', 'confirmed', 'delivered', 'invoiced'];
  const STATUS_LABELS = { draft: 'Draft', sent: 'Sent', confirmed: 'Confirmed', delivered: 'Delivered', invoiced: 'Invoiced' };
  const GOODS_IN_LABELS = { no: 'Not delivered', partial: 'Part delivered', yes: 'Delivered' };
  const RETURN_STATUSES = ['to_return', 'returned', 'credited'];
  const RETURN_STATUS_LABELS = { to_return: 'To send back', returned: 'Sent back', credited: 'Credited' };
  const RETURN_REASONS = [
    { id: 'wrong_part', label: 'Wrong part' },
    { id: 'damaged', label: 'Damaged' },
    { id: 'not_needed', label: 'Not needed' },
    { id: 'warranty', label: 'Faulty (warranty)' },
    { id: 'surcharge', label: 'Surcharge / old unit' },
    { id: 'other', label: 'Other' },
  ];
  const LIMITS = { name: 200, short: 120, ref: 60, long: 2000, vatNumber: 30, maxQty: 1000000, maxPrice: 10000000, maxDays: 365 };
  const CHASE_DAYS = 30;        // a return sent back this long ago with no credit gets a "Chase" flag
  const SEND_NUDGE_DAYS = 7;    // a return logged this long ago but not sent back gets a nudge
  const REORDER_MONTHS = 3;
  const TOP_SUPPLIER_DAYS = 90;
  const EMAIL_MAX_LINES = 25;
  const dict = () => Object.create(null);   // a plain lookup table with no inherited keys
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── text safety ───────────────────────────────────────────────
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
  }
  // html`<td>${value}</td>` — every ${value} is escaped unless it is itself the result of html``.
  // The screens only ever put html`` results into the page, so text from the database (or typed
  // by a user) can never become markup. A plain object cannot pretend to be trusted: the check
  // is "was it made by this class", which data loaded as JSON can never be.
  class SafeHtml {
    constructor(s) { this.s = s; }
    toString() { return this.s; }
  }
  function htmlPart(v) {
    if (v instanceof SafeHtml) return v.s;
    if (Array.isArray(v)) return v.map(htmlPart).join('');
    if (v === false) return '';
    return escapeHtml(v);
  }
  function html(strings) {
    let out = strings[0];
    for (let i = 1; i < arguments.length; i++) out += htmlPart(arguments[i]) + strings[i];
    return new SafeHtml(out);
  }
  const isSafeHtml = v => v instanceof SafeHtml;

  // One-line text: control characters removed, any whitespace run becomes one space.
  function cleanLine(value, max) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || LIMITS.short);
  }
  // Multi-line text: keeps line breaks, removes other control characters.
  function cleanText(value, max) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, max || LIMITS.long);
  }

  // ── numbers and money ─────────────────────────────────────────
  function roundTo(n, dp) {
    const s = String(n);
    if (s.indexOf('e') === -1) return Number(Math.round(Number(s + 'e' + dp)) + 'e-' + dp);
    const f = Math.pow(10, dp);
    return Math.round(n * f) / f;
  }
  const round2 = n => roundTo(n, 2);
  // Parse a number from user input, clamp it to [min, max] and round. Junk becomes min.
  function num(value, opts) {
    const o = opts || {};
    const min = o.min === undefined ? 0 : o.min;
    const max = o.max === undefined ? LIMITS.maxPrice : o.max;
    const dp = o.dp === undefined ? 2 : o.dp;
    let n = typeof value === 'number' ? value : parseFloat(String(value === null || value === undefined ? '' : value).replace(/[£,\s]/g, ''));
    if (!Number.isFinite(n)) return min;
    if (n < min) n = min;
    if (n > max) n = max;
    return roundTo(n, dp);
  }
  const qtyOf = v => num(v, { max: LIMITS.maxQty, dp: 3 });
  function money(n) {
    let v = Number(n);
    if (!Number.isFinite(v)) v = 0;
    const abs = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '-£' : '£') + abs;
  }
  function lineTotals(line) {
    const l = line || {};
    const net = round2(qtyOf(l.qty) * num(l.price));
    const vat = round2(net * num(l.vatRate, { max: 100 }) / 100);
    return { net, vat, gross: round2(net + vat) };
  }
  function orderTotals(lines) {
    let subtotal = 0, vat = 0;
    (lines || []).forEach(l => { const t = lineTotals(l); subtotal += t.net; vat += t.vat; });
    subtotal = round2(subtotal); vat = round2(vat);
    return { subtotal, vat, total: round2(subtotal + vat) };
  }

  // ── dates (all plain YYYY-MM-DD strings) ──────────────────────
  function isISODate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  const pad2 = n => String(n).padStart(2, '0');
  function todayISO(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  const toUTC = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fromUTC = ms => { const d = new Date(ms); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); };
  function addDays(iso, n) { return isISODate(iso) ? fromUTC(toUTC(iso) + Math.round(n) * 86400000) : ''; }
  function addMonths(iso, n) {
    if (!isISODate(iso)) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return first.getUTCFullYear() + '-' + pad2(first.getUTCMonth() + 1) + '-' + pad2(Math.min(d, last));
  }
  function daysBetween(fromIso, toIso) {
    if (!isISODate(fromIso) || !isISODate(toIso)) return 0;
    return Math.round((toUTC(toIso) - toUTC(fromIso)) / 86400000);
  }
  function expectedDate(orderDate, leadDays) {
    const n = num(leadDays, { max: LIMITS.maxDays, dp: 0 });
    return n > 0 && isISODate(orderDate) ? addDays(orderDate, n) : '';
  }
  function formatDate(iso) {
    if (!isISODate(iso)) return '—';
    const [y, m, d] = iso.split('-').map(Number);
    return d + ' ' + MONTHS[m - 1] + ' ' + y;
  }
  const dateOnly = v => (typeof v === 'string' ? v.slice(0, 10) : '');
  function poRef(year, n) { return 'PO-' + year + '-' + String(n).padStart(4, '0'); }

  // ── delivery ──────────────────────────────────────────────────
  function receivedSummary(lines) {
    let ordered = 0, received = 0, lineCount = 0, linesDone = 0;
    (lines || []).forEach(l => {
      const q = qtyOf(l.qty), r = Math.min(qtyOf(l.qtyReceived), q);
      if (q <= 0) return;
      ordered += q; received += r; lineCount++;
      if (r >= q) linesDone++;
    });
    ordered = roundTo(ordered, 3); received = roundTo(received, 3);
    return { ordered, received, outstanding: roundTo(ordered - received, 3), lineCount, linesDone };
  }
  function deliveryState(lines) {
    const s = receivedSummary(lines);
    if (!s.lineCount || s.received <= 0) return 'no';
    return s.linesDone === s.lineCount ? 'yes' : 'partial';
  }
  // arrivedById: { [lineId]: quantity that has just arrived }. Never mutates `lines`.
  function applyReceipt(lines, arrivedById) {
    const errors = [];
    let anyArrived = false;
    const next = (lines || []).map(l => {
      const raw = arrivedById ? arrivedById[l.id] : undefined;
      if (raw === undefined || raw === null || String(raw).trim() === '') return Object.assign({}, l);
      const a = Number(String(raw).replace(/,/g, ''));
      const outstanding = roundTo(qtyOf(l.qty) - qtyOf(l.qtyReceived), 3);
      if (!Number.isFinite(a) || a < 0) { errors.push({ id: l.id, message: 'Enter a number, 0 or more, for "' + l.name + '".' }); return Object.assign({}, l); }
      if (a > outstanding + 1e-9) { errors.push({ id: l.id, message: 'Only ' + outstanding + ' of "' + l.name + '" is still to come.' }); return Object.assign({}, l); }
      if (a > 0) anyArrived = true;
      return Object.assign({}, l, { qtyReceived: roundTo(qtyOf(l.qtyReceived) + a, 3) });
    });
    return { ok: errors.length === 0, errors, lines: next, state: deliveryState(next), anyArrived };
  }
  function isOpen(po) { return !!po && po.status !== 'delivered' && po.status !== 'invoiced' && po.goodsIn !== 'yes'; }
  function isOverdue(po, today) { return isOpen(po) && po.status !== 'draft' && isISODate(po.dueDate) && po.dueDate < today; }
  const isAwaiting = po => isOpen(po) && (po.status === 'sent' || po.status === 'confirmed');

  // ── search and filters ────────────────────────────────────────
  function matchesText(haystack, q) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hay = haystack.toLowerCase();
    return terms.every(t => hay.indexOf(t) !== -1);
  }
  function orderSearchText(po, supplierName) {
    const parts = [po.ref, supplierName || '', po.notes || ''];
    (po.items || []).forEach(i => parts.push(i.name || '', i.jobRef || '', i.notes || ''));
    return parts.join(' \n ');
  }
  function filterOrders(orders, opts) {
    const o = opts || {};
    const filter = o.filter || 'all', today = o.today || todayISO();
    const nameOf = o.supplierName || (() => '');
    return (orders || []).filter(po => {
      if (filter === 'open' && !isOpen(po)) return false;
      if (filter === 'overdue' && !isOverdue(po, today)) return false;
      if (filter === 'partial' && !(isOpen(po) && po.goodsIn === 'partial')) return false;
      if (filter === 'awaiting' && !isAwaiting(po)) return false;
      if (STATUSES.indexOf(filter) !== -1 && po.status !== filter) return false;
      return !o.q || matchesText(orderSearchText(po, nameOf(po.supplierId)), o.q);
    });
  }
  function filterReturns(returns, opts) {
    const o = opts || {};
    const filter = o.filter || 'all', today = o.today || todayISO();
    const nameOf = o.supplierName || (() => '');
    return (returns || []).filter(r => {
      if (filter === 'open' && r.status === 'credited') return false;
      if (filter === 'chase' && returnFlag(r, today) !== 'chase') return false;
      if (RETURN_STATUSES.indexOf(filter) !== -1 && r.status !== filter) return false;
      return !o.q || matchesText([r.itemName, nameOf(r.supplierId) || '', r.creditRef || '', r.notes || ''].join(' \n '), o.q);
    });
  }

  // ── returns ───────────────────────────────────────────────────
  function returnFlag(ret, today) {
    if (!ret) return null;
    if (ret.status === 'returned' && isISODate(ret.returnedDate) && daysBetween(ret.returnedDate, today) >= CHASE_DAYS) return 'chase';
    if (ret.status === 'to_return' && isISODate(dateOnly(ret.createdAt)) && daysBetween(dateOnly(ret.createdAt), today) >= SEND_NUDGE_DAYS) return 'send';
    return null;
  }

  // ── home screen numbers ───────────────────────────────────────
  function dashboardStats(data) {
    const orders = data.orders || [], returns = data.returns || [], today = data.today || todayISO();
    const thisMonth = today.slice(0, 7), lastMonth = addMonths(today.slice(0, 8) + '01', -1).slice(0, 7);
    const s = { openCount: 0, openValue: 0, overdueCount: 0, awaitingCount: 0, partialCount: 0, draftCount: 0,
      creditCount: 0, creditValue: 0, chaseCount: 0, spendThisMonth: 0, spendLastMonth: 0 };
    orders.forEach(po => {
      if (isOpen(po)) { s.openCount++; s.openValue += num(po.total); }
      if (isOverdue(po, today)) s.overdueCount++;
      if (isAwaiting(po)) s.awaitingCount++;
      if (isOpen(po) && po.goodsIn === 'partial') s.partialCount++;
      if (po.status === 'draft') { s.draftCount++; return; }
      const month = (po.date || '').slice(0, 7);
      if (month === thisMonth) s.spendThisMonth += num(po.total);
      if (month === lastMonth) s.spendLastMonth += num(po.total);
    });
    returns.forEach(r => {
      if (r.status !== 'credited') { s.creditCount++; s.creditValue += num(r.amount); }
      if (returnFlag(r, today) === 'chase') s.chaseCount++;
    });
    ['openValue', 'creditValue', 'spendThisMonth', 'spendLastMonth'].forEach(k => { s[k] = round2(s[k]); });
    return s;
  }
  function topSuppliers(orders, today, days, limit) {
    const since = addDays(today, -(days || TOP_SUPPLIER_DAYS));
    const by = dict();
    (orders || []).forEach(po => {
      if (po.status === 'draft' || !po.supplierId || !(po.date >= since)) return;
      const e = by[po.supplierId] || (by[po.supplierId] = { supplierId: po.supplierId, spend: 0, count: 0 });
      e.spend += num(po.total); e.count++;
    });
    return Object.keys(by).map(k => { by[k].spend = round2(by[k].spend); return by[k]; })
      .sort((a, b) => b.spend - a.spend).slice(0, limit || 5);
  }
  function supplierStats(orders, today) {
    const since = addDays(today, -365), by = dict();
    (orders || []).forEach(po => {
      if (!po.supplierId) return;
      const e = by[po.supplierId] || (by[po.supplierId] = { orderCount: 0, openCount: 0, spend12m: 0 });
      e.orderCount++;
      if (isOpen(po)) e.openCount++;
      if (po.status !== 'draft' && po.date >= since) e.spend12m = round2(e.spend12m + num(po.total));
    });
    return by;
  }
  function attentionItems(data) {
    const today = data.today || todayISO(), out = [];
    (data.orders || []).filter(po => isOverdue(po, today))
      .map(po => ({ kind: 'overdue', id: po.id, days: daysBetween(po.dueDate, today) }))
      .sort((a, b) => b.days - a.days).forEach(i => out.push(i));
    const flagged = (data.returns || []).map(r => ({ r, flag: returnFlag(r, today) })).filter(x => x.flag);
    flagged.filter(x => x.flag === 'chase').map(x => ({ kind: 'chase', id: x.r.id, days: daysBetween(x.r.returnedDate, today) }))
      .sort((a, b) => b.days - a.days).forEach(i => out.push(i));
    flagged.filter(x => x.flag === 'send').map(x => ({ kind: 'send', id: x.r.id, days: daysBetween(dateOnly(x.r.createdAt), today) }))
      .sort((a, b) => b.days - a.days).forEach(i => out.push(i));
    return out;
  }

  // ── price history ─────────────────────────────────────────────
  const key = s => String(s || '').trim().toLowerCase();
  function latestFor(history, supplierId, name) {
    const k = key(name);
    let best = null;
    (history || []).forEach(h => {
      if (h.supplierId !== supplierId || key(h.name) !== k) return;
      if (!best || (h.date || '') >= (best.date || '')) best = h;
    });
    return best;
  }
  function lastPrice(history, supplierId, name) {
    const h = latestFor(history, supplierId, name);
    return h ? num(h.price) : null;
  }
  function cheaperElsewhere(history, supplierId, name, price) {
    const ref = num(price);
    if (ref <= 0 || !key(name)) return null;
    const k = key(name), others = dict();
    (history || []).forEach(h => { if (h.supplierId && h.supplierId !== supplierId && key(h.name) === k) others[h.supplierId] = true; });
    let best = null;
    Object.keys(others).forEach(sid => {
      const p = lastPrice(history, sid, name);
      if (p !== null && p > 0 && p < ref - 0.005 && (!best || p < best.price)) best = { supplierId: sid, price: p };
    });
    return best;
  }
  function priceChange(prev, next) {
    if (prev === null || prev === undefined) return null;
    const p = num(prev), n = num(next);
    if (p <= 0) return null;
    const diff = round2(n - p);
    if (diff === 0) return null;
    return { diff, pct: Math.round(diff / p * 1000) / 10 };
  }
  function priceRowsToLog(history, supplierId, lines, date) {
    const seen = dict(), rows = [];
    (lines || []).forEach(l => {
      const k = key(l.name), price = num(l.price);
      if (!k || price <= 0 || seen[k]) return;
      seen[k] = true;
      if (lastPrice(history, supplierId, l.name) === price) return;
      rows.push({ supplierId, name: cleanLine(l.name, LIMITS.name), price, date });
    });
    return rows;
  }
  function historyWithChange(history) {
    const last = dict();
    const asc = (history || []).map((h, i) => ({ h, i })).sort((a, b) => (a.h.date || '').localeCompare(b.h.date || '') || a.i - b.i);
    const out = asc.map(x => {
      const k = x.h.supplierId + '|' + key(x.h.name);
      const row = Object.assign({}, x.h, { change: k in last ? priceChange(last[k], x.h.price) : null });
      last[k] = x.h.price;
      return row;
    });
    return out.reverse();
  }
  function reorderGroups(orders, today, months) {
    const since = addMonths(today, -(months || REORDER_MONTHS));
    const groups = dict(), order = [];
    (orders || []).forEach(po => {
      if (!po.supplierId || !(po.date >= since)) return;
      if (!groups[po.supplierId]) { groups[po.supplierId] = dict(); order.push(po.supplierId); }
      (po.items || []).forEach(i => {
        const k = key(i.name);
        if (!k) return;
        const cur = groups[po.supplierId][k];
        if (!cur || po.date > cur.lastDate) groups[po.supplierId][k] = { name: i.name, lastPrice: num(i.price), lastDate: po.date, vatRate: num(i.vatRate, { max: 100 }) };
      });
    });
    return order.map(sid => ({ supplierId: sid, items: Object.keys(groups[sid]).map(k => groups[sid][k]).sort((a, b) => a.name.localeCompare(b.name)) }))
      .filter(g => g.items.length);
  }

  // ── links built from data ─────────────────────────────────────
  function isValidEmail(s) {
    return typeof s === 'string' && s.length <= 200 && /^[^\s@<>"',;:\\?&=]+@[^\s@<>"',;:\\?&=]+\.[^\s@<>"',;:\\?&=]+$/.test(s);
  }
  function telHref(phone) {
    const s = String(phone || '').trim();
    const digits = s.replace(/\D/g, '');
    if (digits.length < 5 || digits.length > 20) return '';
    return 'tel:' + (s.charAt(0) === '+' ? '+' : '') + digits;
  }
  function mailtoHref(email, subject, body) {
    if (!isValidEmail(email)) return '';
    const crlf = String(body || '').replace(/\r\n?|\n/g, '\r\n');
    return 'mailto:' + encodeURIComponent(email).replace(/%40/g, '@') + '?subject=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(crlf);
  }
  function orderEmail(po, supplier, settings) {
    const biz = settings && settings.businessName ? settings.businessName : '';
    const items = po.items || [];
    const shown = items.slice(0, EMAIL_MAX_LINES).map(i => {
      const t = lineTotals(i);
      return '- ' + i.name + (i.jobRef ? ' [' + i.jobRef + ']' : '') + ' x ' + qtyOf(i.qty) + ' @ ' + money(i.price) + ' = ' + money(t.net) + (i.notes ? ' (' + i.notes + ')' : '');
    });
    if (items.length > EMAIL_MAX_LINES) shown.push('... and ' + (items.length - EMAIL_MAX_LINES) + ' more lines (see the printed order).');
    const t = orderTotals(items);
    const lines = [
      'Dear ' + ((supplier && supplier.contact) || (supplier && supplier.name) || 'Sir/Madam') + ',', '',
      'Please supply the following.', '',
      'Order number: ' + po.ref,
      'Order date: ' + formatDate(po.date),
      'Delivery wanted by: ' + (isISODate(po.dueDate) ? formatDate(po.dueDate) : 'to be confirmed'),
    ];
    if (supplier && supplier.account) lines.push('Our account number: ' + supplier.account);
    lines.push('', 'Items (prices ex VAT):');
    shown.forEach(l => lines.push(l));
    lines.push('', 'Subtotal: ' + money(t.subtotal), 'VAT: ' + money(t.vat), 'Total: ' + money(t.total));
    if (po.notes) lines.push('', 'Notes: ' + po.notes);
    lines.push('', 'Please confirm you have this order and when it will arrive.', '', 'Kind regards', biz);
    return { subject: 'Purchase Order ' + po.ref + (biz ? ' from ' + biz : ''), body: lines.join('\n').trim() };
  }

  // ── validation (always cleans; errors are plain-English sentences) ──
  const intDays = v => num(v, { max: LIMITS.maxDays, dp: 0 });
  const isoOrBlank = v => (isISODate(v) ? v : '');
  function validateSupplier(d) {
    const s = d || {}, errors = [];
    const value = {
      name: cleanLine(s.name, LIMITS.name), contact: cleanLine(s.contact, LIMITS.short), email: cleanLine(s.email, 200),
      phone: cleanLine(s.phone, LIMITS.ref), terms: intDays(s.terms), account: cleanLine(s.account, LIMITS.ref),
      leadTime: intDays(s.leadTime), address: cleanText(s.address, LIMITS.long),
    };
    if (!value.name) errors.push('Company name is needed.');
    if (value.email && !isValidEmail(value.email)) errors.push('That email address does not look right.');
    return { ok: !errors.length, errors, value };
  }
  function validateSettings(d) {
    const s = d || {}, errors = [];
    const rate = num(s.defaultVatRate, { max: 100 });
    const value = {
      businessName: cleanLine(s.businessName, LIMITS.name), address: cleanText(s.address, LIMITS.long), phone: cleanLine(s.phone, LIMITS.ref),
      email: cleanLine(s.email, 200), vatNumber: cleanLine(s.vatNumber, LIMITS.vatNumber),
      defaultVatRate: VAT_RATES.indexOf(rate) !== -1 ? rate : 20,
    };
    if (value.email && !isValidEmail(value.email)) errors.push('That email address does not look right.');
    return { ok: !errors.length, errors, value };
  }
  function validateOrder(d) {
    const o = d || {}, errors = [];
    const lines = [];
    (o.lines || []).forEach((l, idx) => {
      const name = cleanLine(l.name, LIMITS.name);
      if (!name) return;
      const rate = num(l.vatRate, { max: 100 });
      const line = {
        id: l.id || null, name, jobRef: cleanLine(l.jobRef, LIMITS.ref), qty: qtyOf(l.qty), price: num(l.price),
        vatRate: VAT_RATES.indexOf(rate) !== -1 ? rate : 20, qtyReceived: qtyOf(l.qtyReceived), notes: cleanLine(l.notes, LIMITS.name), position: idx,
      };
      if (line.qty <= 0) errors.push('"' + name + '" needs a quantity above 0.');
      else if (line.qtyReceived > line.qty) errors.push('"' + name + '": ' + line.qtyReceived + ' already received, so the quantity cannot be less than that.');
      lines.push(line);
    });
    lines.forEach((l, i) => { l.position = i; });
    if (!o.supplierId) errors.push('Choose a supplier.');
    if (!isISODate(o.date)) errors.push('Choose the order date.');
    if (!lines.length) errors.push('Add at least one item.');
    const value = {
      supplierId: o.supplierId || '', date: isoOrBlank(o.date), dueDate: isoOrBlank(o.dueDate),
      status: STATUSES.indexOf(o.status) !== -1 ? o.status : 'draft', paymentTerms: intDays(o.paymentTerms),
      notes: cleanText(o.notes, LIMITS.long), lines,
    };
    return { ok: !errors.length, errors, value };
  }
  function validateReturn(d) {
    const r = d || {}, errors = [];
    const value = {
      supplierId: r.supplierId || '', orderId: r.orderId || null, itemName: cleanLine(r.itemName, LIMITS.name),
      qty: qtyOf(r.qty), amount: num(r.amount),
      reason: RETURN_REASONS.some(x => x.id === r.reason) ? r.reason : 'other',
      status: RETURN_STATUSES.indexOf(r.status) !== -1 ? r.status : 'to_return',
      returnedDate: isoOrBlank(r.returnedDate), creditRef: cleanLine(r.creditRef, LIMITS.ref),
      creditedDate: isoOrBlank(r.creditedDate), notes: cleanText(r.notes, LIMITS.long),
    };
    if (!value.supplierId) errors.push('Choose a supplier.');
    if (!value.itemName) errors.push('Say which part is going back.');
    if (value.qty <= 0) errors.push('Quantity must be above 0.');
    return { ok: !errors.length, errors, value };
  }

  // ── rows from the database → the shapes the screens use ───────
  const txt = v => (v === null || v === undefined ? '' : String(v));
  function itemFromRow(r) {
    return { id: r.id, name: txt(r.name), jobRef: txt(r.job_ref), qty: Number(r.qty) || 0, price: Number(r.price) || 0,
      vatRate: Number(r.vat_rate) || 0, qtyReceived: Number(r.qty_received) || 0, notes: txt(r.notes), position: Number(r.position) || 0 };
  }
  function orderFromRow(p, itemRows) {
    const total = Number(p.total) || 0;
    const items = (itemRows || []).map(itemFromRow).map((it, i) => ({ it, i })).sort((a, b) => a.it.position - b.it.position || a.i - b.i).map(x => x.it);
    // An order marked fully delivered the old way (one dropdown for the whole order) has, by definition, had every line arrive.
    if (p.goods_in === 'yes') items.forEach(it => { if (it.qtyReceived < it.qty) it.qtyReceived = it.qty; });
    return {
      id: p.id, supplierId: p.supplier_id || null, ref: txt(p.ref), date: txt(p.order_date), dueDate: txt(p.due_date),
      paymentTerms: Number(p.payment_terms_days === null || p.payment_terms_days === undefined ? 30 : p.payment_terms_days),
      status: STATUSES.indexOf(p.status) !== -1 ? p.status : 'draft', goodsIn: ['no', 'partial', 'yes'].indexOf(p.goods_in) !== -1 ? p.goods_in : 'no',
      notes: txt(p.notes), subtotal: p.subtotal === null || p.subtotal === undefined ? total : Number(p.subtotal) || 0,
      vatTotal: Number(p.vat_total) || 0, total, deliveredDate: txt(p.delivered_date), items,
    };
  }
  function supplierFromRow(s) {
    return { id: s.id, name: txt(s.name), contact: txt(s.contact), email: txt(s.email), phone: txt(s.phone),
      terms: Number(s.payment_terms_days === null || s.payment_terms_days === undefined ? 30 : s.payment_terms_days), account: txt(s.account),
      leadTime: Number(s.lead_time_days) || 0, address: txt(s.address) };
  }
  function returnFromRow(r) {
    return { id: r.id, supplierId: r.supplier_id || null, orderId: r.purchase_order_id || null, itemName: txt(r.item_name), qty: Number(r.qty) || 0,
      amount: Number(r.amount) || 0, reason: RETURN_REASONS.some(x => x.id === r.reason) ? r.reason : 'other',
      status: RETURN_STATUSES.indexOf(r.status) !== -1 ? r.status : 'to_return', returnedDate: txt(r.returned_date), creditRef: txt(r.credit_ref),
      creditedDate: txt(r.credited_date), notes: txt(r.notes), createdAt: txt(r.created_at) };
  }
  function settingsFromRow(r) {
    const s = r || {};
    const rate = Number(s.default_vat_rate);
    return { businessName: txt(s.business_name), address: txt(s.address), phone: txt(s.phone), email: txt(s.email), vatNumber: txt(s.vat_number),
      defaultVatRate: VAT_RATES.indexOf(rate) !== -1 ? rate : 20 };
  }
  function priceFromRow(r) { return { supplierId: r.supplier_id || null, name: txt(r.item_name), price: Number(r.price) || 0, date: txt(r.recorded_date) }; }

  return {
    VAT_RATES, STATUSES, STATUS_LABELS, GOODS_IN_LABELS, RETURN_STATUSES, RETURN_STATUS_LABELS, RETURN_REASONS, LIMITS, CHASE_DAYS,
    escapeHtml, html, isSafeHtml, cleanLine, cleanText, num, money, lineTotals, orderTotals,
    isISODate, todayISO, addDays, addMonths, daysBetween, expectedDate, formatDate, poRef,
    receivedSummary, deliveryState, applyReceipt, isOpen, isOverdue,
    filterOrders, filterReturns, returnFlag,
    dashboardStats, topSuppliers, supplierStats, attentionItems,
    lastPrice, cheaperElsewhere, priceChange, priceRowsToLog, historyWithChange, reorderGroups,
    isValidEmail, telHref, mailtoHref, orderEmail,
    validateSupplier, validateSettings, validateOrder, validateReturn,
    itemFromRow, orderFromRow, supplierFromRow, returnFromRow, settingsFromRow, priceFromRow,
  };
});
