// In-memory stand-in for the Supabase project, for testing/recording the app safely.
const crypto = require('crypto');

const OWNER = '7d3f0c1e-5a2b-4c8e-9d41-0a6b8e2f3c10';
const EMAIL = 'demo@example.com';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

function createMock({ missingLocation = false, missingSell = false, missingSales = false, missingReorder = false, missingPo = false, missingStillages = false, noSaleDelete = false } = {}) {
  const now = Date.now(), DAY = 864e5;
  const iso = ms => new Date(ms).toISOString();
  const id = () => crypto.randomUUID();
  const item = (name, sku, qty, cost, location = null) => ({ id: id(), owner_id: OWNER, user_id: OWNER, name, sku, qty, cost, ...(missingLocation ? {} : { location }) });
  const state = {
    stock: [
      item('Brake Pads – Front (Set)', 'BRK-F-014', 12, 24.50, 'Aisle 2, Shelf C'),
      item('Engine Oil 5W-30 (5L)', 'OIL-5W30-5L', 18, 28.95, 'Yard store'),
      item('Oil Filter', 'OFL-0231', 3, 5.40),
      item('Wiper Blade 24"', 'WPR-24', 4, 7.99, 'Aisle 1, Shelf A'),
    ],
    logs: [],
    invites: [],
    requests: [],
    sales: [],
    saleLines: [],
    pos: [],
    poLines: [],
    stillages: [],
    stillageStock: [],
    orders: [],
    orderLines: [],
  };
  const jwt = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: OWNER, email: EMAIL, role: 'authenticated', aud: 'authenticated', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 36000 })}.demo`;
  const user = () => ({ id: OWNER, aud: 'authenticated', role: 'authenticated', email: EMAIL, email_confirmed_at: iso(now - 9 * DAY), app_metadata: { provider: 'email' }, user_metadata: {}, created_at: iso(now - 9 * DAY) });

  async function handler(route) {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, m = req.method();
    state.requests.push({ m, p, q: url.search });
    const json = (body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const empty = (status = 204) => route.fulfill({ status, headers: CORS });
    const wantObj = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
    const eq = k => { const v = url.searchParams.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };
    const page = arr => {
      const off = Number(url.searchParams.get('offset') || 0), lim = url.searchParams.get('limit');
      return arr.slice(off, lim ? off + Number(lim) : undefined);
    };
    const rows = arr => wantObj ? (arr[0] ? json(arr[0]) : json({ message: 'no rows', code: 'PGRST116' }, 406)) : json(arr);
    const body = () => { try { return req.postDataJSON(); } catch { return {}; } };

    if (m === 'OPTIONS') return empty();
    if (p.endsWith('/auth/v1/token')) return json({ access_token: jwt(), token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(now / 1000) + 36000, refresh_token: 'demo-refresh', user: user() });
    if (p.endsWith('/auth/v1/logout')) return empty();
    if (p.endsWith('/auth/v1/user')) return json(user());
    if (p.endsWith('/rpc/sc_resolve_owner')) return json(OWNER);
    if (p.endsWith('/rpc/sc_create_invite')) { state.invites.push({ id: id(), invited_email: body().p_email, status: 'pending' }); return json({ ok: true, token: 'a94f2c71d0e8' }); }
    if (p.endsWith('/rest/v1/users')) return rows([{ id: OWNER, email: EMAIL, signup_date: iso(now - 8 * DAY) }]);
    if (p.endsWith('/rest/v1/sc_team_members')) return rows(url.searchParams.get('select') === 'role' ? [{ role: 'owner' }] : [{ user_id: OWNER, role: 'owner' }]);
    if (p.endsWith('/rest/v1/sc_team_invites')) return rows(state.invites);
    if (p.endsWith('/rest/v1/stock')) {
      if (m === 'GET') {
        if (missingLocation && (url.searchParams.get('select') || '').includes('location')) return json({ code: '42703', message: 'column stock.location does not exist' }, 400);
        if (missingReorder && /reorder_level|reorder_qty|supplier/.test(url.searchParams.get('select') || '')) return json({ code: '42703', message: 'column stock.reorder_level does not exist' }, 400);
        if (missingSell && (url.searchParams.get('select') || '').includes('sell_price')) return json({ code: '42703', message: 'column stock.sell_price does not exist' }, 400);
        let list = state.stock.slice().sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
        if (eq('id')) list = list.filter(s => s.id === eq('id'));
        const inIds = url.searchParams.get('id');
        if (inIds && inIds.startsWith('in.(')) { const set = new Set(inIds.slice(4, -1).split(',')); list = list.filter(s => set.has(s.id)); }
        return rows(page(list));
      }
      if (m === 'POST') {
        const merge = (req.headers()['prefer'] || '').includes('merge-duplicates');
        for (const r of [].concat(body())) {
          if (missingReorder && ('reorder_level' in r || 'reorder_qty' in r || 'supplier' in r)) return json({ code: 'PGRST204', message: "Could not find the 'reorder_level' column of 'stock' in the schema cache" }, 400);
          if (missingSell && 'sell_price' in r) return json({ code: 'PGRST204', message: "Could not find the 'sell_price' column of 'stock' in the schema cache" }, 400);
          if (missingLocation && 'location' in r) return json({ code: 'PGRST204', message: "Could not find the 'location' column of 'stock' in the schema cache" }, 400);
          const at = state.stock.findIndex(s => s.id === r.id);
          if (at >= 0) { if (merge) state.stock[at] = { ...state.stock[at], ...r }; else return json({ code: '23505', message: 'duplicate key' }, 409); }
          else state.stock.push(r);
        }
        return empty(201);
      }
      if (m === 'PATCH') {
        const b = body();
        if (missingReorder && ('reorder_level' in b || 'reorder_qty' in b || 'supplier' in b)) return json({ code: 'PGRST204', message: "Could not find the 'reorder_level' column of 'stock' in the schema cache" }, 400);
        const idq = url.searchParams.get('id');
        if (idq && idq.startsWith('in.(')) { const set = new Set(idq.slice(4, -1).split(',')); state.stock.filter(s => set.has(s.id)).forEach(s => Object.assign(s, b)); return empty(); }
        const s = state.stock.find(s => s.id === eq('id')); if (s) Object.assign(s, b); return empty();
      }
      if (m === 'DELETE') {
        if (eq('id')) state.stock = state.stock.filter(s => s.id !== eq('id'));
        else if (eq('owner_id')) state.stock = state.stock.filter(s => s.owner_id !== eq('owner_id'));
        const have = new Set(state.stock.map(s => s.id));
        state.stillageStock = state.stillageStock.filter(r => have.has(r.stock_id));
        return empty();
      }
    }
    if (p.endsWith('/rest/v1/stock_logs')) {
      if (m === 'GET') {
        let list = state.logs.slice().sort((a, b) => b.date.localeCompare(a.date));
        if (eq('item')) list = list.filter(l => l.item === eq('item'));
        return json(page(list));
      }
      if (m === 'POST') { [].concat(body()).forEach(r => state.logs.push(r)); return empty(201); }
      return empty();
    }
    if (p.endsWith('/rest/v1/sc_sales')) {
      if (missingSales) return json({ code: 'PGRST205', message: "Could not find the table 'public.sc_sales' in the schema cache" }, 404);
      const wantRep = (req.headers()['prefer'] || '').includes('return=representation');
      if (m === 'GET') {
        let list = state.sales.slice();
        if (eq('status')) list = list.filter(s => s.status === eq('status'));
        const gte = url.searchParams.get('sold_at'); if (gte && gte.startsWith('gte.')) list = list.filter(s => s.sold_at >= gte.slice(4));
        list.sort((a, b) => b.sale_no - a.sale_no);
        const lim = url.searchParams.get('limit'); if (lim) list = list.slice(0, Number(lim));
        return json(list);
      }
      if (m === 'POST') {
        const r = body();
        if (state.sales.some(s => s.owner_id === r.owner_id && s.sale_no === r.sale_no)) return json({ code: '23505', message: 'duplicate key value violates unique constraint "sc_sales_owner_no_idx"' }, 409);
        state.sales.push(r); return empty(201);
      }
      if (m === 'PATCH') {
        const targets = state.sales.filter(s => s.id === eq('id') && (!eq('status') || s.status === eq('status')));
        targets.forEach(s => Object.assign(s, body()));
        return wantRep ? json(targets.map(s => ({ id: s.id }))) : empty();
      }
      if (m === 'DELETE') {
        if (noSaleDelete) return json({ code: '42501', message: 'permission denied for table sc_sales' }, 403);
        const gone = state.sales.filter(s => s.id === eq('id') && (!eq('status') || s.status === eq('status')));
        state.sales = state.sales.filter(s => !gone.includes(s));
        state.saleLines = state.saleLines.filter(l => !gone.some(s => s.id === l.sale_id));
        return wantRep ? json(gone.map(s => ({ id: s.id }))) : empty();
      }
    }
    if (p.endsWith('/rest/v1/sc_sale_lines')) {
      if (missingSales) return json({ code: 'PGRST205', message: "Could not find the table 'public.sc_sale_lines' in the schema cache" }, 404);
      if (m === 'GET') return json(state.saleLines.filter(l => l.sale_id === eq('sale_id')).sort((a, b) => (a.name < b.name ? -1 : 1)));
      if (m === 'POST') { [].concat(body()).forEach(r => state.saleLines.push(r)); return empty(201); }
    }
    if (p.endsWith('/rest/v1/sc_purchase_orders') || p.endsWith('/rest/v1/sc_po_lines')) {
      const isHead = p.endsWith('/rest/v1/sc_purchase_orders');
      if (missingPo) return json({ code: 'PGRST205', message: "Could not find the table 'public." + (isHead ? 'sc_purchase_orders' : 'sc_po_lines') + "' in the schema cache" }, 404);
      const table = isHead ? state.pos : state.poLines;
      const wantRep = (req.headers()['prefer'] || '').includes('return=representation');
      const filt = list => {
        for (const [k, v] of url.searchParams.entries()) {
          if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
          if (v.startsWith('eq.')) { const x = v.slice(3); list = list.filter(r => String(r[k]) === x); }
          else if (v.startsWith('in.(')) { const set = new Set(v.slice(4, -1).split(',')); list = list.filter(r => set.has(String(r[k]))); }
        }
        return list;
      };
      if (m === 'GET') {
        let list = filt(table.slice());
        const ord = url.searchParams.get('order');
        if (ord) { const [col, dir] = ord.split('.'); list.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
        const lim = url.searchParams.get('limit'); if (lim) list = list.slice(0, Number(lim));
        return json(list);
      }
      if (m === 'POST') {
        const rows = [].concat(body());
        if (isHead && rows.some(r => table.some(s => s.owner_id === r.owner_id && s.po_no === r.po_no))) return json({ code: '23505', message: 'duplicate key value violates unique constraint "sc_po_owner_no_idx"' }, 409);
        rows.forEach(r => table.push(r)); return empty(201);
      }
      if (m === 'PATCH') {
        const targets = filt(table.slice());
        targets.forEach(r => Object.assign(r, body()));
        return wantRep ? json(targets.map(r => ({ id: r.id }))) : empty();
      }
    }
    const SL_TABLES = { sc_stillages: 'stillages', sc_stillage_stock: 'stillageStock', sc_orders: 'orders', sc_order_lines: 'orderLines' };
    const slName = Object.keys(SL_TABLES).find(n => p.endsWith('/rest/v1/' + n));
    if (slName) {
      if (missingStillages) return json({ code: 'PGRST205', message: "Could not find the table 'public." + slName + "' in the schema cache" }, 404);
      const table = state[SL_TABLES[slName]];
      const UNIQUE = { sc_stillages: ['owner_id', 'name'], sc_stillage_stock: ['stillage_id', 'stock_id'], sc_orders: ['owner_id', 'order_no'] }[slName];
      const wantRep = (req.headers()['prefer'] || '').includes('return=representation');
      const filt = list => {
        for (const [k, v] of url.searchParams.entries()) {
          if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
          if (v.startsWith('eq.')) { const x = v.slice(3); list = list.filter(r => String(r[k]) === x); }
          else if (v.startsWith('in.(')) { const set = new Set(v.slice(4, -1).split(',')); list = list.filter(r => set.has(String(r[k]))); }
        }
        return list;
      };
      if (m === 'GET') {
        let list = filt(table.slice());
        if (slName === 'sc_stillage_stock') { const have = new Set(state.stock.map(s => s.id)); list = list.filter(r => have.has(r.stock_id)); }
        const ord = url.searchParams.get('order');
        if (ord) {
          const keys = ord.split(',').map(x => x.split('.'));
          list.sort((a, b) => { for (const [col, dir] of keys) { const c = a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0; if (c) return c * (dir === 'desc' ? -1 : 1); } return 0; });
        }
        const off = Number(url.searchParams.get('offset') || 0), lim = url.searchParams.get('limit');
        return json(list.slice(off, lim ? off + Number(lim) : undefined));
      }
      if (m === 'POST') {
        const upsert = (req.headers()['prefer'] || '').includes('merge-duplicates');
        const conflict = (url.searchParams.get('on_conflict') || 'id').split(',');
        for (const r of [].concat(body())) {
          const same = row => conflict.every(c => String(row[c]) === String(r[c]));
          if (upsert) { const at = table.findIndex(same); if (at >= 0) { table[at] = { ...table[at], ...r }; continue; } }
          if (table.some(x => x.id && x.id === r.id)) return json({ code: '23505', message: 'duplicate key value violates unique constraint "pkey"' }, 409);
          if (UNIQUE && table.some(x => UNIQUE.every(c => String(x[c]) === String(r[c])))) return json({ code: '23505', message: 'duplicate key value violates unique constraint "' + slName + '_idx"' }, 409);
          table.push({ id: crypto.randomUUID(), ...r });
        }
        return empty(201);
      }
      if (m === 'PATCH') {
        const targets = filt(table.slice());
        targets.forEach(r => Object.assign(r, body()));
        return wantRep ? json(targets.map(r => ({ id: r.id }))) : empty();
      }
      if (m === 'DELETE') {
        const gone = new Set(filt(table.slice()));
        for (let i = table.length - 1; i >= 0; i--) if (gone.has(table[i])) table.splice(i, 1);
        return empty();
      }
    }
    console.log('unmocked', m, p);
    return json([]);
  }
  return { state, handler, OWNER, EMAIL };
}

module.exports = { createMock };
