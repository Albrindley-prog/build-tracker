// A pretend Supabase for Supplier & Purchase Orders, plus a tiny web server for the page.
// Everything lives in memory on this computer (127.0.0.1 only). Nothing real is ever contacted:
// the page's app.js is served with the real Supabase address swapped for this server's address.
//
//   Tests:    const { startMock } = require('./mock-server');  const mock = await startMock();
//   Preview:  node tools/tests/spo/mock-server.js --port 8092 --seed demo
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_DIR = path.join(ROOT, 'supplier-purchase-order-system');
const APP_PATH = '/supplier-purchase-order-system/';
const REAL_SUPABASE = 'https://dkdnlgwflrwdxtrovrrq.supabase.co';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.sql': 'text/plain; charset=utf-8' };
const TABLES = ['spo_suppliers', 'spo_purchase_orders', 'spo_purchase_order_items', 'spo_price_history', 'spo_counters', 'spo_settings', 'spo_returns', 'bt_subscriptions'];
const PK = { spo_counters: 'user_id', spo_settings: 'user_id' };
const MAX_ROWS = 1000;

const uuid = () => crypto.randomUUID();
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const nowIso = () => new Date().toISOString();

function defaults(table, row) {
  const d = {
    spo_suppliers: () => ({ id: uuid(), contact: null, email: null, phone: null, payment_terms_days: 30, account: null, lead_time_days: 0, address: null, created_at: nowIso() }),
    spo_purchase_orders: () => ({ id: uuid(), supplier_id: null, order_date: null, due_date: null, payment_terms_days: 30, status: 'draft', goods_in: 'no', notes: null, total: 0, subtotal: null, vat_total: null, delivered_date: null, created_at: nowIso(), updated_at: nowIso() }),
    spo_purchase_order_items: () => ({ id: uuid(), qty: 0, price: 0, notes: null, job_ref: null, vat_rate: 0, qty_received: 0, position: 0 }),
    spo_price_history: () => ({ id: uuid(), supplier_id: null, recorded_date: nowIso().slice(0, 10), created_at: nowIso() }),
    spo_counters: () => ({ next_po_number: 1 }),
    spo_settings: () => ({ business_name: null, address: null, phone: null, email: null, vat_number: null, default_vat_rate: 20, updated_at: nowIso() }),
    spo_returns: () => ({ id: uuid(), supplier_id: null, purchase_order_id: null, qty: 1, amount: 0, reason: 'other', status: 'to_return', returned_date: null, credit_ref: null, credited_date: null, notes: null, created_at: nowIso() }),
    bt_subscriptions: () => ({ id: uuid() }),
  }[table]();
  return Object.assign(d, row);
}

// The same value rules the real database enforces (migration-2-improvements.sql), in short form.
function breaksRules(table, r) {
  const long = (v, n) => v !== null && v !== undefined && String(v).length > n;
  if (table === 'spo_purchase_order_items') return !(r.qty >= 0 && r.qty <= 1000000 && r.price >= 0 && r.vat_rate >= 0 && r.vat_rate <= 100 && r.qty_received >= 0) || !r.name || long(r.name, 500) || long(r.job_ref, 500) || long(r.notes, 10000);
  if (table === 'spo_purchase_orders') return !['draft', 'sent', 'confirmed', 'delivered', 'invoiced'].includes(r.status) || !['no', 'partial', 'yes'].includes(r.goods_in) || !(r.total >= 0) || long(r.ref, 500) || long(r.notes, 10000);
  if (table === 'spo_suppliers') return !r.name || long(r.name, 500) || !(r.payment_terms_days >= 0) || !(r.lead_time_days >= 0) || long(r.address, 10000);
  if (table === 'spo_returns') return !r.item_name || long(r.item_name, 500) || !(r.qty > 0) || !(r.amount >= 0) || !['to_return', 'returned', 'credited'].includes(r.status) || !['wrong_part', 'damaged', 'not_needed', 'warranty', 'surcharge', 'other'].includes(r.reason);
  if (table === 'spo_settings') return !(r.default_vat_rate >= 0 && r.default_vat_rate <= 100) || long(r.business_name, 500);
  if (table === 'spo_price_history') return !(r.price >= 0) || !r.item_name;
  return false;
}

function matches(value, op, raw) {
  const s = value === null || value === undefined ? null : String(value);
  switch (op) {
    case 'eq': return s !== null && s === raw;
    case 'neq': return s !== null && s !== raw;
    case 'is': return raw === 'null' ? s === null : s === raw;
    case 'in': return s !== null && raw.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')).includes(s);
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if (s === null) return false;
      const a = isNaN(Number(s)) || isNaN(Number(raw)) ? [s, raw] : [Number(s), Number(raw)];
      return op === 'gt' ? a[0] > a[1] : op === 'gte' ? a[0] >= a[1] : op === 'lt' ? a[0] < a[1] : a[0] <= a[1];
    }
    default: return true;
  }
}
function filterRows(rows, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    const m = /^(eq|neq|gt|gte|lt|lte|is|in)\.([\s\S]*)$/.exec(v);
    if (m) rows = rows.filter(r => matches(r[k], m[1], m[2]));
  }
  return rows;
}
function orderRows(rows, spec) {
  if (!spec) return rows;
  const keys = spec.split(',').map(p => { const [col, dir] = p.split('.'); return { col, desc: dir === 'desc' }; });
  return rows.slice().sort((a, b) => {
    for (const { col, desc } of keys) {
      const x = a[col], y = b[col];
      if (x === y) continue;
      const c = (x === null || x === undefined) ? 1 : (y === null || y === undefined) ? -1 : (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)));
      return desc ? -c : c;
    }
    return 0;
  });
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size <= 2e6) chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
  });
}

async function startMock({ port = 0, seed = 'empty', demo = false } = {}) {
  const state = {
    users: [], tokens: {}, refresh: {}, trialStart: {}, requests: [], failNext: null,
    tables: Object.fromEntries(TABLES.map(t => [t, []])),
    demo: null,     // { email, password } when started with the demo seed
  };
  let origin = '';

  const issueSession = user => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: exp - 3600, exp, session_id: uuid() })}.${crypto.randomBytes(16).toString('base64url')}`;
    const refresh = crypto.randomBytes(16).toString('base64url');
    state.tokens[access] = user.id; state.refresh[refresh] = user.id;
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: refresh, user: publicUser(user) };
  };
  const publicUser = u => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.created_at, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.meta || {}, identities: [], created_at: u.created_at, updated_at: u.created_at });
  const createUser = (email, password, meta) => { const u = { id: uuid(), email: String(email).toLowerCase(), password: String(password), meta: meta || {}, created_at: nowIso() }; state.users.push(u); return u; };
  const userFromReq = req => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); const id = m && state.tokens[m[1]]; return id ? state.users.find(u => u.id === id) : null; };

  function cascadeDelete(table, row) {
    if (table === 'spo_purchase_orders') {
      state.tables.spo_purchase_order_items = state.tables.spo_purchase_order_items.filter(i => i.purchase_order_id !== row.id);
      state.tables.spo_returns.forEach(r => { if (r.purchase_order_id === row.id) r.purchase_order_id = null; });
    }
    if (table === 'spo_suppliers') {
      ['spo_purchase_orders', 'spo_price_history', 'spo_returns'].forEach(t => state.tables[t].forEach(r => { if (r.supplier_id === row.id) r.supplier_id = null; }));
    }
  }

  async function handle(req, res) {
    const u = new URL(req.url, origin);
    const p = u.pathname, method = req.method;
    const send = (status, body, headers) => {
      const isBuf = Buffer.isBuffer(body), isStr = typeof body === 'string';
      const h = Object.assign({ 'cache-control': 'no-store' }, headers || {});
      if (body !== undefined && !isBuf && !isStr) { h['content-type'] = 'application/json; charset=utf-8'; body = JSON.stringify(body); }
      res.writeHead(status, h); res.end(body === undefined ? undefined : body);
    };
    const prefer = req.headers.prefer || '';
    const wantObject = (req.headers.accept || '').includes('vnd.pgrst.object');
    const wantRows = prefer.includes('return=representation');
    const rls = table => send(403, { code: '42501', details: null, hint: null, message: `new row violates row-level security policy for table "${table}"` });

    // ── the page itself ──
    if (method === 'GET' && (p === '/' || p === APP_PATH.slice(0, -1))) return send(302, undefined, { location: APP_PATH });
    if (method === 'GET' && p === '/__demo/demo.js') {
      if (!state.demo) return send(404, 'not found');
      return send(200, demoScript(state.demo), { 'content-type': TYPES['.js'] });
    }
    if (method === 'GET' && p.startsWith(APP_PATH)) {
      const rel = decodeURIComponent(p.slice(APP_PATH.length)) || 'index.html';
      const file = path.resolve(APP_DIR, rel);
      if (!file.startsWith(APP_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'not found');
      let body = fs.readFileSync(file, 'utf8');
      if (rel === 'app.js') {
        if (!body.includes(REAL_SUPABASE)) return send(500, 'app.js does not contain the expected Supabase address');
        body = body.split(REAL_SUPABASE).join(origin);
      }
      if (rel === 'index.html' && state.demo) body = body.replace('</body>', '<script src="/__demo/demo.js" defer></script>\n</body>');
      return send(200, body, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    }

    // ── pretend Supabase ──
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readBody(req) : {};
    const user = userFromReq(req);
    state.requests.push({ method, path: p, query: u.search, userId: user ? user.id : null });

    if (p === '/auth/v1/signup' && method === 'POST') {
      const email = String(body.email || '').toLowerCase();
      if (!email || String(body.password || '').length < 6) return send(422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
      if (state.users.some(x => x.email === email)) return send(422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      return send(200, issueSession(createUser(email, body.password, body.data)));
    }
    if (p === '/auth/v1/token' && method === 'POST') {
      const grant = u.searchParams.get('grant_type');
      if (grant === 'password') {
        const found = state.users.find(x => x.email === String(body.email || '').toLowerCase() && x.password === String(body.password || ''));
        return found ? send(200, issueSession(found)) : send(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      if (grant === 'refresh_token') {
        const id = state.refresh[body.refresh_token], found = id && state.users.find(x => x.id === id);
        return found ? send(200, issueSession(found)) : send(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      }
      return send(400, { code: 400, msg: 'unsupported grant' });
    }
    if (p === '/auth/v1/logout' && method === 'POST') {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (m) delete state.tokens[m[1]];
      return send(204);
    }
    if (p === '/auth/v1/user' && method === 'GET') return user ? send(200, publicUser(user)) : send(401, { code: 401, msg: 'invalid JWT' });

    if (p === '/rest/v1/rpc/start_trial_if_missing' && method === 'POST') {
      if (!user) return send(401, { code: '42501', message: 'not signed in' });
      if (!state.trialStart[user.id]) state.trialStart[user.id] = nowIso();
      return send(200, [{ trial_start: state.trialStart[user.id] }]);
    }
    if (p === '/functions/v1/create-checkout-session' && method === 'POST') {
      return send(200, { url: origin + APP_PATH + '?payment=cancel' });       // never leaves this computer
    }

    const tm = /^\/rest\/v1\/([a-z_]+)$/.exec(p);
    if (tm && TABLES.includes(tm[1])) {
      const table = tm[1], pk = PK[table] || 'id';
      if (state.failNext && state.failNext.table === table && state.failNext.method === method) {
        state.failNext = null;
        return send(500, { code: 'XX000', message: 'internal error: connection to server at "db.internal" (10.0.0.7) failed' });
      }
      const mine = () => (user ? state.tables[table].filter(r => r.user_id === user.id) : []);

      if (method === 'GET') {
        let rows = orderRows(filterRows(mine(), u.searchParams), u.searchParams.get('order'));
        // like the real service, never more than 1000 rows in one reply
        const off = Number(u.searchParams.get('offset') || 0), lim = Math.min(Number(u.searchParams.get('limit') || MAX_ROWS), MAX_ROWS);
        rows = rows.slice(off, off + lim);
        if (wantObject) return rows.length === 1 ? send(200, rows[0]) : send(406, { code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
        return send(200, rows);
      }
      if (method === 'POST') {
        const merge = prefer.includes('resolution=merge-duplicates');
        const incoming = [].concat(body), out = [];
        // check everything first so a rejected request changes nothing (like one database statement)
        for (const raw of incoming) {
          if (!user || raw.user_id !== user.id) return rls(table);
          const existing = state.tables[table].find(r => r[pk] !== undefined && r[pk] === raw[pk]);
          if (existing && (!merge || existing.user_id !== user.id)) return existing.user_id !== user.id ? rls(table) : send(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
          const candidate = existing ? Object.assign({}, existing, raw) : defaults(table, raw);
          if (breaksRules(table, candidate)) return send(400, { code: '23514', message: `${table} violates the value rules` });
          if (table === 'spo_purchase_order_items' && !state.tables.spo_purchase_orders.some(o => o.id === candidate.purchase_order_id)) return send(409, { code: '23503', message: 'insert or update on table violates foreign key constraint' });
          out.push({ existing, candidate });
        }
        const saved = out.map(({ existing, candidate }) => { if (existing) { Object.assign(existing, candidate); return existing; } state.tables[table].push(candidate); return candidate; });
        if (!wantRows) return send(201);
        return wantObject ? send(201, saved[0]) : send(201, saved);
      }
      if (method === 'PATCH') {
        if (!user) return send(wantRows ? 200 : 204, wantRows ? [] : undefined);
        if (body.user_id !== undefined && body.user_id !== user.id) return rls(table);
        const rows = filterRows(mine(), u.searchParams);
        for (const r of rows) if (breaksRules(table, Object.assign({}, r, body)) && !breaksRules(table, r)) return send(400, { code: '23514', message: `${table} violates the value rules` });
        rows.forEach(r => Object.assign(r, body));
        if (!wantRows) return send(204);
        return wantObject ? (rows.length === 1 ? send(200, rows[0]) : send(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })) : send(200, rows);
      }
      if (method === 'DELETE') {
        const rows = filterRows(mine(), u.searchParams);
        state.tables[table] = state.tables[table].filter(r => !rows.includes(r));
        rows.forEach(r => cascadeDelete(table, r));
        return wantRows ? send(200, rows) : send(204);
      }
    }
    return send(404, { message: 'not found: ' + method + ' ' + p });
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(err => { res.writeHead(500); res.end(String(err && err.message)); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });   // this computer only
  origin = 'http://127.0.0.1:' + server.address().port;

  const api = {
    url: origin + APP_PATH, origin, state, createUser, issueSession,
    insert(table, row) { const r = defaults(table, row); state.tables[table].push(r); return r; },
    close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
  };
  if (seed === 'demo') require('./seed-demo').seedDemo(api);
  return api;
}

function demoScript(demo) {
  return `(function () {
  var bar = document.createElement('div');
  bar.textContent = 'DEMO — pretend data on this computer only. Nothing here is real, and nothing you change is kept.';
  bar.style.cssText = 'background:#f59e0b;color:#111;font:600 13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;margin:0 auto 14px;max-width:1200px;text-align:center';
  document.body.insertBefore(bar, document.body.firstChild);
  var e = document.getElementById('login-email'), p = document.getElementById('login-pass');
  if (e && p) { e.value = ${JSON.stringify(demo.email)}; p.value = ${JSON.stringify(demo.password)}; }
})();`;
}

module.exports = { startMock, APP_PATH };

if (require.main === module) {
  const arg = name => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : undefined; };
  startMock({ port: Number(arg('port') || 8092), seed: arg('seed') || 'demo' }).then(m => {
    console.log('Supplier & Purchase Orders preview (pretend data): ' + m.url);
    console.log('Listening on 127.0.0.1 only. Press Ctrl+C to stop.');
  }).catch(err => { console.error('Could not start: ' + err.message); process.exit(1); });
}
