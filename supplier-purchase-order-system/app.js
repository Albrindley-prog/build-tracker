// Supplier & Purchase Orders — the screens and the conversations with the database.
// The rules (money, VAT, delivery, validation, text safety) live in spo-logic.js.
//
// Text safety: every piece of the page that contains data is built with html`...`, which escapes
// each value, and is put on the page only by setHTML / appendHTML below. Nothing else writes markup.
(function () {
  'use strict';

  const L = window.SPOLogic;
  const html = L.html;

  // ════════════════════════════════════════════════════════════════
  // CONFIG
  // ════════════════════════════════════════════════════════════════
  const SUPABASE_URL = 'https://dkdnlgwflrwdxtrovrrq.supabase.co';
  // This "anon" key is designed to be public. What protects each customer's data is row-level
  // security in the database (every row is locked to its owner), not keeping this key secret.
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrZG5sZ3dmbHJ3ZHh0cm92cnJxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MjM4NjUsImV4cCI6MjA5NTk5OTg2NX0.vf3uAq8uInMBMEw6fU-qng2kg_BjunGNgFhGoA_V4Gk';
  const TRIAL_DAYS = 30;
  // Same Supabase project as the other Build Tracker apps: the shared bt_trials / bt_subscriptions
  // tables and the create-checkout-session function are reused. Each app bills separately.
  const STRIPE_PRICE_ID = 'price_1TgOwNICF2fQjVNyZi4seWgw';
  const SUBSCRIPTIONS_TABLE = 'bt_subscriptions';
  const PRODUCT_ID = 'purchase-order-system';
  const PAGE_SIZE = 1000;          // the service sends at most this many rows per request

  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
  });

  // ════════════════════════════════════════════════════════════════
  // STATE AND SMALL HELPERS
  // ════════════════════════════════════════════════════════════════
  const freshState = () => ({
    user: null, trialStart: null, subscribed: false, loadProblem: false,
    suppliers: [], orders: [], history: [], returns: [], settings: L.settingsFromRow(null), nextPONumber: 1,
    tab: 'home', orderFilter: 'all', returnFilter: 'open',
    editOrderId: null, editSupplierId: null, editReturnId: null, receiveOrderId: null,
  });
  let state = freshState();

  const $ = id => document.getElementById(id);
  const show = (el, on) => el.classList.toggle('hidden', !on);
  const today = () => L.todayISO();
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const termsLabel = n => (Number(n) === 0 ? 'Due on receipt' : Number(n) + ' days');
  const supplierById = id => state.suppliers.find(s => s.id === id) || null;
  const supplierName = id => { const s = supplierById(id); return s ? s.name : 'Unknown supplier'; };
  const orderById = id => state.orders.find(o => o.id === id) || null;
  const returnById = id => state.returns.find(r => r.id === id) || null;
  const reasonLabel = id => (L.RETURN_REASONS.find(r => r.id === id) || { label: 'Other' }).label;

  // The only two places that put markup on the page. Both refuse anything not built by html``.
  function setHTML(el, safe) {
    if (!L.isSafeHtml(safe)) throw new Error('setHTML needs the result of html``');
    el.innerHTML = safe.toString();
  }
  function appendHTML(el, safe) {
    if (!L.isSafeHtml(safe)) throw new Error('appendHTML needs the result of html``');
    el.insertAdjacentHTML('beforeend', safe.toString());
  }

  let toastTimer = null;
  function toast(message, type) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', type === 'error');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' ? 4500 : 2500);
  }
  // People see a plain message; the detail goes to the browser console for support.
  function fail(what, error) {
    console.error('Could not ' + what + ':', error && error.code ? error.code : '', error && error.message ? error.message : error);
    toast("Couldn't " + what + '. Please try again.', 'error');
  }
  async function busy(button, work) {
    if (button && button.disabled) return;
    if (button) button.disabled = true;
    try { await work(); } catch (err) { fail('finish that', err); } finally { if (button) button.disabled = false; }
  }
  function setSelect(select, value, label) {
    const v = String(value);
    if (!Array.from(select.options).some(o => o.value === v)) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label || v;
      select.appendChild(o);
    }
    select.value = v;
  }
  function fillSupplierSelect(select, selectedId) {
    setHTML(select, html`${!supplierById(selectedId) && selectedId !== undefined ? html`<option value="">— choose a supplier —</option>` : ''}${state.suppliers.map(s => html`<option value="${s.id}">${s.name}</option>`)}`);
    select.value = supplierById(selectedId) ? selectedId : (selectedId === undefined && state.suppliers[0] ? state.suppliers[0].id : '');
  }

  // ════════════════════════════════════════════════════════════════
  // SIGN IN, TRIAL AND SUBSCRIPTION
  // ════════════════════════════════════════════════════════════════
  function authMessage(kind, message) {
    const err = $('auth-error'), ok = $('auth-success');
    err.textContent = kind === 'error' ? message : ''; show(err, kind === 'error');
    ok.textContent = kind === 'ok' ? message : ''; show(ok, kind === 'ok');
  }
  function switchAuthTab(name) {
    $('tab-login').classList.toggle('active', name === 'login');
    $('tab-signup').classList.toggle('active', name === 'signup');
    show($('form-login'), name === 'login');
    show($('form-signup'), name === 'signup');
    authMessage();
  }

  async function doLogin() {
    const email = $('login-email').value.trim().toLowerCase(), password = $('login-pass').value;
    if (!email || !password) return authMessage('error', 'Please enter your email and password.');
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error || !data || !data.user) {
      console.error('Sign-in failed:', error && error.message);
      return authMessage('error', error && error.status && error.status < 500 ? 'Email or password is incorrect.' : "Couldn't sign in just now. Please try again.");
    }
    $('login-pass').value = '';
    state.user = data.user;
    if (await checkAccess()) await launchApp();
  }

  async function doSignup() {
    const first = L.cleanLine($('signup-first').value, 80), last = L.cleanLine($('signup-last').value, 80);
    const email = $('signup-email').value.trim().toLowerCase(), password = $('signup-pass').value, confirm = $('signup-conf').value;
    if (!first || !last) return authMessage('error', 'Please enter your first and last name.');
    if (!L.isValidEmail(email)) return authMessage('error', 'Please enter a valid email address.');
    if (password.length < 8) return authMessage('error', 'Password must be at least 8 characters.');
    if (password !== confirm) return authMessage('error', 'Passwords do not match.');
    const { data, error } = await db.auth.signUp({ email, password, options: { data: { first_name: first, last_name: last } } });
    if (error || !data || !data.user) {
      console.error('Sign-up failed:', error && error.message);
      return authMessage('error', "Couldn't create the account. If you already have one, sign in instead.");
    }
    // "Confirm email" is off for this project, so a new account is signed in straight away.
    authMessage('ok', 'Account created! Signing you in…');
    $('signup-pass').value = ''; $('signup-conf').value = '';
    state.user = data.user;
    if (await checkAccess()) await launchApp();
  }

  async function doLogout() {
    try { await db.auth.signOut(); } catch (err) { console.error('Sign-out failed:', err && err.message); }
    backToSignIn();
  }
  // Wipes everything belonging to the signed-in account from the page, so the next person to
  // sign in on this browser cannot see any of it.
  function backToSignIn() {
    state = freshState();
    ['po-items', 'item-names', 'receive-lines', 'reorder-list', 'print-area', 'po-supplier', 'ret-supplier', 'ret-order'].forEach(id => { $(id).textContent = ''; });
    ['receive-title', 'order-form-title', 'return-form-title', 'supplier-form-title', 'po-due-hint', 'billing-msg', 'trial-days'].forEach(id => { $(id).textContent = ''; });
    document.querySelectorAll('#app-screen input, #app-screen textarea, #auth-screen input').forEach(el => { el.value = ''; });
    $('mail-link').setAttribute('href', '#');
    closePanels();
    // redraw every screen from the now-empty state, not just the one that was showing
    VIEWS.forEach(view => { state.tab = view; renderAll(); });
    state.tab = 'home';
    show($('load-banner'), false);
    show($('app-screen'), false); show($('billing-screen'), false); show($('auth-screen'), true);
    switchAuthTab('login');
  }

  // trial_start lives in the shared bt_trials table, set once by a database function, so it
  // cannot be reset from the browser.
  async function ensureTrialStarted() {
    const { data, error } = await db.rpc('start_trial_if_missing', { p_product: PRODUCT_ID });
    if (error) { console.error('start_trial_if_missing failed:', error.message); state.trialStart = null; return; }
    state.trialStart = data && data[0] && data[0].trial_start ? data[0].trial_start : null;
  }
  function trialEnd() { const end = new Date(state.trialStart); end.setDate(end.getDate() + TRIAL_DAYS); return end; }
  const trialActive = () => !!state.trialStart && new Date() < trialEnd();
  const trialDaysLeft = () => (state.trialStart ? Math.max(0, Math.ceil((trialEnd() - new Date()) / 86400000)) : 0);
  async function hasActiveSubscription() {
    const { data, error } = await db.from(SUBSCRIPTIONS_TABLE).select('status').eq('user_id', state.user.id).eq('product', PRODUCT_ID).eq('status', 'active').maybeSingle();
    if (error) { console.error('Subscription check failed:', error.message); return false; }
    return !!data;
  }
  // Runs after sign-in and on every page load. True = may use the app; false = billing screen is showing.
  async function checkAccess() {
    if (!state.user) return false;
    await ensureTrialStarted();
    if (trialActive()) return true;
    state.subscribed = await hasActiveSubscription();
    if (state.subscribed) return true;
    showBilling(true);
    return false;
  }
  function showBilling(locked) {
    show($('auth-screen'), false); show($('app-screen'), false);
    const banner = $('billing-trial');
    show(banner, trialActive());
    banner.textContent = trialActive() ? plural(trialDaysLeft(), 'day') + ' of free trial remaining' : '';
    setHTML($('billing-text'), trialActive()
      ? html`Subscribe for <strong>£32.00 / month</strong> to keep using it when your free trial ends.`
      : state.subscribed ? html`You are subscribed at <strong>£32.00 / month</strong>. Thank you.`
        : html`Your free trial has ended. Subscribe now for <strong>£32.00 / month</strong> to continue.`);
    show($('subscribe-btn'), !state.subscribed);
    show($('billing-back-btn'), !locked);
    $('billing-msg').textContent = '';
    show($('billing-screen'), true);
  }
  // Card details are never typed into this page: the existing server function creates a Stripe
  // Checkout session and we simply go to it.
  async function startSubscription() {
    const msg = $('billing-msg');
    msg.textContent = 'Redirecting to secure checkout…';
    try {
      const { data: { session } } = await db.auth.getSession();
      const res = await fetch(SUPABASE_URL + '/functions/v1/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
        body: JSON.stringify({
          price_id: STRIPE_PRICE_ID, product: PRODUCT_ID, user_id: state.user.id, email: state.user.email,
          success_url: window.location.origin + window.location.pathname + '?payment=success',
          cancel_url: window.location.origin + window.location.pathname + '?payment=cancel',
        }),
      });
      const out = await res.json();
      if (out.error || !out.url || !/^https?:\/\//.test(out.url)) throw new Error(out.error || 'No checkout address returned');
      window.location.href = out.url;
    } catch (err) {
      console.error('Checkout could not start:', err && err.message);
      msg.textContent = "Couldn't start checkout just now. Please try again in a moment.";
    }
  }
  async function handlePaymentResult() {
    const result = new URLSearchParams(window.location.search).get('payment');
    if (!result) return;
    window.history.replaceState({}, '', window.location.pathname);
    if (result === 'success' && state.user) {
      // the payment notice can take a moment to reach the database, so look again shortly
      setTimeout(async () => { if (await checkAccess()) await launchApp(); }, 1500);
    }
  }

  async function launchApp() {
    show($('auth-screen'), false); show($('billing-screen'), false); show($('app-screen'), true);
    $('trial-days').textContent = trialActive() ? plural(trialDaysLeft(), 'day') + ' trial left' : '✓ Subscribed';
    authMessage();
    await loadAll();
    switchTab('home');
  }

  // ════════════════════════════════════════════════════════════════
  // LOADING
  // ════════════════════════════════════════════════════════════════
  async function fetchAll(table, orderColumn, ascending) {
    const out = [];
    for (let from = 0; from < 500000; from += PAGE_SIZE) {
      const { data, error } = await db.from(table).select('*').eq('user_id', state.user.id)
        .order(orderColumn, { ascending }).order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
      if (error) return { error, data: out };
      out.push.apply(out, data || []);
      if (!data || data.length < PAGE_SIZE) break;
    }
    return { data: out };
  }
  async function loadAll() {
    const uid = state.user.id;
    const [sup, po, items, hist, returns, counter, settings] = await Promise.all([
      fetchAll('spo_suppliers', 'name', true),
      fetchAll('spo_purchase_orders', 'created_at', false),
      fetchAll('spo_purchase_order_items', 'purchase_order_id', true),
      fetchAll('spo_price_history', 'recorded_date', true),
      fetchAll('spo_returns', 'created_at', false),
      db.from('spo_counters').select('next_po_number').eq('user_id', uid).maybeSingle(),
      db.from('spo_settings').select('*').eq('user_id', uid).maybeSingle(),
    ]);
    const problems = [sup, po, items, hist, returns, counter, settings].filter(r => r.error);
    problems.forEach(r => console.error('Load failed:', r.error.code || '', r.error.message));
    state.loadProblem = problems.length > 0;

    state.suppliers = (sup.data || []).map(L.supplierFromRow);
    const byOrder = {};
    (items.data || []).forEach(it => { (byOrder[it.purchase_order_id] = byOrder[it.purchase_order_id] || []).push(it); });
    state.orders = (po.data || []).map(p => L.orderFromRow(p, byOrder[p.id]));
    state.history = (hist.data || []).map(L.priceFromRow);
    state.returns = (returns.data || []).map(L.returnFromRow);
    state.nextPONumber = counter.data && counter.data.next_po_number ? Number(counter.data.next_po_number) : 1;
    state.settings = L.settingsFromRow(settings.data);

    const banner = $('load-banner');
    banner.textContent = state.loadProblem ? "Some of your data couldn't be loaded just now. Refresh the page — if this keeps happening, please contact Build Tracker." : '';
    show(banner, state.loadProblem);
  }
  async function reload() { await loadAll(); renderAll(); }

  // ════════════════════════════════════════════════════════════════
  // NAVIGATION
  // ════════════════════════════════════════════════════════════════
  const VIEWS = ['home', 'orders', 'goodsin', 'returns', 'suppliers', 'prices', 'settings'];
  const SEARCH_HINT = { orders: 'Search orders by number, supplier, part or job / reg…', goodsin: 'Search deliveries by order number, supplier or part…',
    returns: 'Search returns by part, supplier or credit note…', suppliers: 'Search suppliers…', prices: 'Search prices by part or supplier…' };
  const PANELS = { orders: ['order-form', 'reorder-panel'], goodsin: ['receive-panel'], returns: ['return-form'], suppliers: ['supplier-form'] };
  const LIST_CARDS = { orders: 'orders-card', goodsin: 'goodsin-card', returns: 'returns-card', suppliers: 'suppliers-card' };

  function closePanels() {
    Object.keys(PANELS).forEach(view => { PANELS[view].forEach(id => show($(id), false)); show($(LIST_CARDS[view]), true); });
    state.editOrderId = null; state.editSupplierId = null; state.editReturnId = null; state.receiveOrderId = null;
  }
  function switchTab(name, keepSearch) {
    state.tab = name;
    closePanels();
    VIEWS.forEach(v => show($('view-' + v), v === name));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    if (!keepSearch) $('search').value = '';
    show($('search-wrap'), !!SEARCH_HINT[name]);
    $('search').placeholder = SEARCH_HINT[name] || 'Search…';
    renderAll();
  }
  // Show one form in place of the list on its tab.
  function openPanel(view, panelId) {
    if (state.tab !== view) switchTab(view);
    PANELS[view].forEach(id => show($(id), id === panelId));
    show($(LIST_CARDS[view]), false);
    show($('search-wrap'), false);
    $(panelId).scrollIntoView({ block: 'start' });
  }
  function closePanel() {
    const view = state.tab;
    closePanels();
    show($('search-wrap'), !!SEARCH_HINT[view]);
    renderAll();
  }

  function renderAll() {
    const t = today();
    const stats = L.dashboardStats({ orders: state.orders, returns: state.returns, today: t });
    const flag = (id, n) => { const el = $(id); el.textContent = n ? String(n) : ''; show(el, n > 0); };
    flag('count-goodsin', stats.overdueCount);
    flag('count-returns', stats.chaseCount);
    if (state.tab === 'home') renderHome(stats, t);
    if (state.tab === 'orders') renderOrders(t);
    if (state.tab === 'goodsin') renderGoodsIn(t);
    if (state.tab === 'returns') renderReturns(t);
    if (state.tab === 'suppliers') renderSuppliers(t);
    if (state.tab === 'prices') renderPrices();
    if (state.tab === 'settings') fillSettings();
  }

  // ════════════════════════════════════════════════════════════════
  // HOME
  // ════════════════════════════════════════════════════════════════
  function renderHome(s, t) {
    const tiles = [
      { id: 'open', label: 'Open orders', value: s.openCount, sub: L.money(s.openValue), cls: '' },
      { id: 'overdue', label: 'Overdue', value: s.overdueCount, sub: s.overdueCount ? 'past the expected date' : 'nothing late', cls: s.overdueCount ? 'warn' : '' },
      { id: 'awaiting', label: 'Awaiting delivery', value: s.awaitingCount, sub: 'sent or confirmed', cls: '' },
      { id: 'partial', label: 'Part delivered', value: s.partialCount, sub: 'something still to come', cls: s.partialCount ? 'note' : '' },
      { id: 'credit', label: 'Credit to come', value: L.money(s.creditValue), sub: plural(s.creditCount, 'return') + (s.chaseCount ? ' · ' + s.chaseCount + ' to chase' : ''), cls: s.chaseCount ? 'warn' : '' },
      { id: 'spend', label: 'Spend this month', value: L.money(s.spendThisMonth), sub: 'last month ' + L.money(s.spendLastMonth), cls: '' },
    ];
    setHTML($('tiles'), html`${tiles.map(x => html`<button type="button" class="tile ${x.cls}" data-tile="${x.id}"><span class="tile-label">${x.label}</span><span class="tile-value">${x.value}</span><span class="tile-sub">${x.sub}</span></button>`)}`);

    const steps = [
      { done: !!state.settings.businessName, text: 'Add your business details (they are printed on your orders)', action: 'open-settings', button: 'Add details' },
      { done: state.suppliers.length > 0, text: 'Add your first supplier', action: 'new-supplier', button: '+ Add supplier' },
      { done: state.orders.length > 0, text: 'Raise your first purchase order', action: 'new-order', button: '+ New order' },
    ];
    show($('checklist-card'), steps.some(x => !x.done));
    setHTML($('checklist'), html`${steps.map(x => html`<li><span class="${x.done ? 'done' : ''}">${x.done ? '✓ ' : ''}${x.text}</span>${!x.done && html`<button type="button" class="btn btn-sm btn-outline" data-action="${x.action}">${x.button}</button>`}</li>`)}`);

    const attention = L.attentionItems({ orders: state.orders, returns: state.returns, today: t }).slice(0, 8);
    setHTML($('attention-list'), attention.length ? html`${attention.map(a => {
      if (a.kind === 'overdue') {
        const po = orderById(a.id);
        return html`<div class="attention-row"><div><span class="ref">${po.ref}</span> · ${supplierName(po.supplierId)}<small>${plural(a.days, 'day')} late — expected ${L.formatDate(po.dueDate)}</small></div><button type="button" class="btn btn-sm btn-outline" data-action="receive-order" data-id="${po.id}">Receive</button></div>`;
      }
      const r = returnById(a.id);
      return html`<div class="attention-row"><div>${r.itemName} · ${supplierName(r.supplierId)}<small>${a.kind === 'chase' ? 'sent back ' + plural(a.days, 'day') + ' ago, no credit yet — ' + L.money(r.amount) : 'logged ' + plural(a.days, 'day') + ' ago, still to send back'}</small></div><button type="button" class="btn btn-sm btn-outline" data-action="edit-return" data-id="${r.id}">Open</button></div>`;
    })}` : html`<div class="empty">Nothing needs chasing right now. 👍</div>`);

    const top = L.topSuppliers(state.orders, t);
    const max = top.length ? top[0].spend : 0;
    setHTML($('top-suppliers'), top.length ? html`${top.map(x => html`<div class="bar-row"><div class="bar-head"><span>${supplierName(x.supplierId)} <small>(${plural(x.count, 'order')})</small></span><strong>${L.money(x.spend)}</strong></div><div class="bar"><span style="width:${max > 0 ? Math.round(x.spend / max * 100) : 0}%"></span></div></div>`)}` : html`<div class="empty">Your biggest suppliers will show here once you have sent some orders.</div>`);
  }

  // ════════════════════════════════════════════════════════════════
  // ORDERS
  // ════════════════════════════════════════════════════════════════
  function progressHtml(po) {
    const r = L.receivedSummary(po.items);
    const done = po.goodsIn === 'yes';
    const pct = done ? 100 : (r.ordered > 0 ? Math.round(r.received / r.ordered * 100) : 0);
    const label = done ? 'Delivered' : r.received > 0 ? r.received + ' of ' + r.ordered : po.goodsIn === 'partial' ? 'Part delivered' : 'Not delivered';
    return html`<div class="progress"><div class="bar"><span style="width:${pct}%"></span></div><small>${label}</small></div>`;
  }
  function renderOrders(t) {
    document.querySelectorAll('#order-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.filter === state.orderFilter));
    const list = L.filterOrders(state.orders, { filter: state.orderFilter, q: $('search').value, supplierName, today: t });
    const empty = $('orders-empty');
    show(empty, !list.length); show($('orders-table'), list.length > 0);
    empty.textContent = state.orders.length ? 'No orders match that.' : 'No purchase orders yet — click "+ New order" to raise your first one.';
    setHTML($('orders-list'), html`${list.map(po => {
      const overdue = L.isOverdue(po, t);
      return html`<tr class="${overdue ? 'overdue' : ''}">
        <td data-label="Order"><span><span class="ref">${po.ref}</span>${overdue && html` <span class="badge badge-overdue">Overdue ${plural(L.daysBetween(po.dueDate, t), 'day')}</span>`}</span></td>
        <td data-label="Supplier">${supplierName(po.supplierId)}</td>
        <td data-label="Ordered">${L.formatDate(po.date)}</td>
        <td data-label="Expected">${L.formatDate(po.dueDate)}</td>
        <td data-label="Status"><span class="badge badge-${po.status}">${L.STATUS_LABELS[po.status]}</span></td>
        <td data-label="Delivery">${progressHtml(po)}</td>
        <td data-label="Total" class="num"><strong>${L.money(po.total)}</strong></td>
        <td class="actions">
          <button type="button" class="btn btn-sm btn-primary" data-action="edit-order" data-id="${po.id}">Edit</button>
          ${L.isOpen(po) && po.status !== 'draft' && html`<button type="button" class="btn btn-sm btn-outline" data-action="receive-order" data-id="${po.id}">Receive</button>`}
          <button type="button" class="btn btn-sm btn-outline" data-action="again-order" data-id="${po.id}">Order again</button>
          <button type="button" class="btn btn-sm btn-outline" data-action="print-order" data-id="${po.id}">Print</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="delete-order" data-id="${po.id}">Delete</button>
        </td></tr>`;
    })}`);
  }

  function itemRowHtml(line) {
    const net = L.lineTotals(line).net;
    const rate = L.VAT_RATES.indexOf(Number(line.vatRate)) !== -1 ? Number(line.vatRate) : state.settings.defaultVatRate;
    return html`<div class="item-row" data-line-id="${line.id || ''}">
      <div><span class="lbl">Description / part</span><input type="text" class="item-name" list="item-names" maxlength="200" value="${line.name || ''}" placeholder="Part name or number" autocomplete="off" aria-label="Description or part"><div class="item-hint"></div></div>
      <div><span class="lbl">Job / reg</span><input type="text" class="item-job" maxlength="60" value="${line.jobRef || ''}" placeholder="optional" autocomplete="off" aria-label="Job or registration"></div>
      <div><span class="lbl">Qty</span><input type="number" class="item-qty" min="0" step="any" inputmode="decimal" value="${line.qty === undefined ? 1 : line.qty}" aria-label="Quantity"></div>
      <div><span class="lbl">Unit price £</span><input type="number" class="item-price" min="0" step="0.01" inputmode="decimal" value="${line.price === undefined || line.price === null ? '' : line.price}" placeholder="0.00" aria-label="Unit price in pounds, excluding VAT"></div>
      <div><span class="lbl">VAT</span><select class="item-vat" aria-label="VAT rate">${L.VAT_RATES.map(r => r === rate ? html`<option value="${r}" selected>${r}%</option>` : html`<option value="${r}">${r}%</option>`)}</select></div>
      <div><span class="lbl">Line total</span><input type="text" class="item-line-total" readonly tabindex="-1" value="${L.money(net)}" aria-label="Line total excluding VAT"></div>
      <div><span class="lbl">Notes</span><input type="text" class="item-notes" maxlength="200" value="${line.notes || ''}" placeholder="Size, colour…" autocomplete="off" aria-label="Line notes"></div>
      <button type="button" class="btn btn-danger item-remove" data-action="remove-item" aria-label="Remove this item">✕</button>
    </div>`;
  }
  function addItemRow(line) {
    appendHTML($('po-items'), itemRowHtml(line || { vatRate: state.settings.defaultVatRate }));
    const row = $('po-items').lastElementChild;
    updateHint(row);
    return row;
  }
  function rowValues(row) {
    return { id: row.dataset.lineId || null, name: row.querySelector('.item-name').value, jobRef: row.querySelector('.item-job').value, qty: row.querySelector('.item-qty').value,
      price: row.querySelector('.item-price').value, vatRate: row.querySelector('.item-vat').value, notes: row.querySelector('.item-notes').value };
  }
  function updateTotals() {
    const lines = Array.from(document.querySelectorAll('#po-items .item-row')).map(row => {
      const v = rowValues(row);
      row.querySelector('.item-line-total').value = L.money(L.lineTotals(v).net);
      return v;
    });
    const t = L.orderTotals(lines);
    $('po-subtotal').textContent = L.money(t.subtotal); $('po-vat').textContent = L.money(t.vat); $('po-total').textContent = L.money(t.total);
  }
  function updateHint(row) {
    const supplierId = $('po-supplier').value, v = rowValues(row), parts = [];
    const existing = state.editOrderId ? (orderById(state.editOrderId).items.find(i => i.id === v.id) || null) : null;
    if (existing && existing.qtyReceived > 0) parts.push(html`${existing.qtyReceived} already received`);
    const last = v.name.trim() ? L.lastPrice(state.history, supplierId, v.name) : null;
    if (last !== null) {
      parts.push(html`Last paid ${L.money(last)}`);
      const change = v.price !== '' ? L.priceChange(last, v.price) : null;
      if (change) parts.push(html`<span class="${change.diff > 0 ? 'warn' : ''}">${change.diff > 0 ? '▲' : '▼'} ${L.money(Math.abs(change.diff))} (${Math.abs(change.pct)}%) ${change.diff > 0 ? 'more' : 'less'} than last time</span>`);
    }
    const reference = v.price !== '' ? v.price : last;
    const cheaper = reference ? L.cheaperElsewhere(state.history, supplierId, v.name, reference) : null;
    if (cheaper) parts.push(html`<span class="warn">${supplierName(cheaper.supplierId)} charged ${L.money(cheaper.price)}</span>`);
    setHTML(row.querySelector('.item-hint'), html`${parts.map((p, i) => html`${i ? ' · ' : ''}${p}`)}`);
  }
  function refreshItemNames() {
    const seen = {}, names = [];
    const add = n => { const k = String(n || '').trim().toLowerCase(); if (k && !seen[k] && names.length < 400) { seen[k] = true; names.push(String(n).trim()); } };
    const supplierId = $('po-supplier').value;
    state.history.filter(h => h.supplierId === supplierId).forEach(h => add(h.name));
    state.history.forEach(h => add(h.name));
    state.orders.forEach(o => o.items.forEach(i => add(i.name)));
    setHTML($('item-names'), html`${names.map(n => html`<option value="${n}"></option>`)}`);
  }
  function autoExpectedDate() {
    const due = $('po-due-date');
    if (state.editOrderId || (due.value && due.dataset.auto !== '1')) return;
    const s = supplierById($('po-supplier').value);
    const d = s ? L.expectedDate($('po-date').value, s.leadTime) : '';
    due.value = d; due.dataset.auto = '1';
    $('po-due-hint').textContent = d ? "From this supplier's usual delivery time (" + plural(s.leadTime, 'day') + ').' : '';
  }
  function onSupplierChosen() {
    const s = supplierById($('po-supplier').value);
    if (s && !state.editOrderId) setSelect($('po-payment-terms'), s.terms, termsLabel(s.terms));
    autoExpectedDate();
    refreshItemNames();
    document.querySelectorAll('#po-items .item-row').forEach(updateHint);
  }

  // po = an existing order to edit, or null for a new one (optionally started from `start`).
  function openOrderForm(po, start) {
    if (!state.suppliers.length) { toast('Add a supplier first, then raise the order.', 'error'); openSupplierForm(null); return; }
    openPanel('orders', 'order-form');
    state.editOrderId = po ? po.id : null;
    const s0 = start || {};
    $('order-form-title').textContent = po ? 'Edit ' + po.ref : 'New purchase order';
    fillSupplierSelect($('po-supplier'), po ? po.supplierId : (supplierById(s0.supplierId) ? s0.supplierId : undefined));
    $('po-date').value = po ? po.date : today();
    $('po-ref').value = po ? po.ref : L.poRef(new Date().getFullYear(), state.nextPONumber);
    $('po-status').value = po ? po.status : 'draft';
    $('po-notes').value = po ? po.notes : (s0.notes || '');
    $('po-due-date').value = po ? po.dueDate : ''; $('po-due-date').dataset.auto = po ? '' : '1'; $('po-due-hint').textContent = '';
    const sup = supplierById($('po-supplier').value);
    setSelect($('po-payment-terms'), po ? po.paymentTerms : (sup ? sup.terms : 30), termsLabel(po ? po.paymentTerms : (sup ? sup.terms : 30)));
    $('po-items').textContent = '';
    refreshItemNames();
    const lines = po ? po.items : (s0.lines || []);
    if (lines.length) lines.forEach(l => addItemRow(l)); else addItemRow();
    autoExpectedDate();
    updateTotals();
  }
  function readOrderForm() {
    const existing = state.editOrderId ? orderById(state.editOrderId) : null;
    const known = {};
    if (existing) existing.items.forEach(i => { known[i.id] = i; });
    const lines = Array.from(document.querySelectorAll('#po-items .item-row')).map(row => {
      const v = rowValues(row);
      // only trust a line id that really belongs to this order; received quantities always come from our own records
      const mine = v.id && known[v.id] ? known[v.id] : null;
      return Object.assign(v, { id: mine ? mine.id : null, qtyReceived: mine ? mine.qtyReceived : 0 });
    });
    return { supplierId: $('po-supplier').value, date: $('po-date').value, dueDate: $('po-due-date').value, status: $('po-status').value,
      paymentTerms: $('po-payment-terms').value, notes: $('po-notes').value, lines };
  }

  async function saveOrder(then) {
    const checked = L.validateOrder(readOrderForm());
    if (!checked.ok) return toast(checked.errors[0], 'error');
    const o = checked.value, uid = state.user.id;
    const existing = state.editOrderId ? orderById(state.editOrderId) : null;
    const totals = L.orderTotals(o.lines);
    let goodsIn = L.deliveryState(o.lines);
    if (existing && goodsIn === 'no' && existing.goodsIn === 'partial') goodsIn = 'partial';   // an older order marked part-delivered by hand
    const row = { user_id: uid, supplier_id: o.supplierId, order_date: o.date, due_date: o.dueDate || null, payment_terms_days: o.paymentTerms,
      status: o.status, goods_in: goodsIn, notes: o.notes, subtotal: totals.subtotal, vat_total: totals.vat, total: totals.total };

    let orderId;
    if (existing) {
      const { error } = await db.from('spo_purchase_orders').update(row).eq('id', existing.id);
      if (error) return fail('save the order', error);
      orderId = existing.id;
    } else {
      row.ref = L.poRef(new Date().getFullYear(), state.nextPONumber);
      const { data, error } = await db.from('spo_purchase_orders').insert(row).select().single();
      if (error || !data) return fail('save the order', error);
      orderId = data.id;
    }

    const lineRows = o.lines.map((l, i) => ({ id: l.id || crypto.randomUUID(), purchase_order_id: orderId, user_id: uid, name: l.name, job_ref: l.jobRef || null,
      qty: l.qty, price: l.price, vat_rate: l.vatRate, qty_received: l.qtyReceived, notes: l.notes || null, position: i }));
    const saved = await db.from('spo_purchase_order_items').upsert(lineRows);
    if (saved.error) {
      if (!existing) await db.from('spo_purchase_orders').delete().eq('id', orderId);          // don't leave an order with no lines behind
      return fail('save the order', saved.error);
    }
    if (existing) {
      const keep = {}; lineRows.forEach(l => { keep[l.id] = true; });
      const removed = existing.items.filter(i => !keep[i.id]).map(i => i.id);
      if (removed.length) {
        const gone = await db.from('spo_purchase_order_items').delete().in('id', removed);
        if (gone.error) { await reload(); return fail('remove the deleted lines', gone.error); }
      }
    } else {
      const next = state.nextPONumber + 1;
      const counted = await db.from('spo_counters').upsert({ user_id: uid, next_po_number: next });
      if (counted.error) console.error('Order number counter not updated:', counted.error.message);
    }
    const prices = L.priceRowsToLog(state.history, o.supplierId, o.lines, o.date)
      .map(p => ({ user_id: uid, supplier_id: p.supplierId, item_name: p.name, price: p.price, recorded_date: p.date }));
    if (prices.length) {
      const logged = await db.from('spo_price_history').insert(prices);
      if (logged.error) console.error('Price history not updated:', logged.error.message);
    }

    await loadAll();
    closePanel();
    if (then === 'print') printOrder(orderId);
    else if (then === 'email') emailOrder(orderId);
    else toast('Order saved');
  }

  async function deleteOrder(id) {
    const po = orderById(id);
    if (!po || !window.confirm('Delete order ' + po.ref + '? This cannot be undone.')) return;
    const { error } = await db.from('spo_purchase_orders').delete().eq('id', id);
    if (error) return fail('delete the order', error);
    await reload();
    toast('Order deleted');
  }

  function printOrder(id) {
    const po = orderById(id);
    if (!po) return;
    const sup = supplierById(po.supplierId) || { name: 'Unknown supplier', address: '', contact: '', email: '', phone: '', account: '' };
    const s = state.settings, t = L.orderTotals(po.items);
    setHTML($('print-area'), html`<div class="po-doc">
      <h1><span>Purchase Order</span><span>${po.ref}</span></h1>
      <div class="po-parties">
        <div><h2>From</h2><strong>${s.businessName || '(add your business name under "My business")'}</strong><div class="pre">${s.address}</div>${s.phone && html`<div>Tel: ${s.phone}</div>`}${s.email && html`<div>${s.email}</div>`}${s.vatNumber && html`<div>VAT no: ${s.vatNumber}</div>`}</div>
        <div><h2>To</h2><strong>${sup.name}</strong><div class="pre">${sup.address}</div>${sup.contact && html`<div>Attn: ${sup.contact}</div>`}${sup.email && html`<div>${sup.email}</div>`}${sup.phone && html`<div>Tel: ${sup.phone}</div>`}</div>
        <div><h2>Order</h2><div>Date: ${L.formatDate(po.date)}</div><div>Delivery wanted by: ${L.isISODate(po.dueDate) ? L.formatDate(po.dueDate) : 'to be confirmed'}</div><div>Payment terms: ${termsLabel(po.paymentTerms)}</div>${sup.account && html`<div>Our account no: ${sup.account}</div>`}</div>
      </div>
      <table>
        <thead><tr><th>Description</th><th>Ref</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">VAT</th><th class="num">Net</th></tr></thead>
        <tbody>${po.items.map(i => html`<tr><td>${i.name}${i.notes && html` <small>(${i.notes})</small>`}</td><td>${i.jobRef}</td><td class="num">${i.qty}</td><td class="num">${L.money(i.price)}</td><td class="num">${i.vatRate}%</td><td class="num">${L.money(L.lineTotals(i).net)}</td></tr>`)}</tbody>
      </table>
      <table class="po-totals">
        <tr><td>Subtotal (ex VAT)</td><td class="num">${L.money(t.subtotal)}</td></tr>
        <tr><td>VAT</td><td class="num">${L.money(t.vat)}</td></tr>
        <tr><td>Total</td><td class="num">${L.money(t.total)}</td></tr>
      </table>
      ${po.notes && html`<p class="pre"><strong>Notes:</strong> ${po.notes}</p>`}
      <div class="po-foot">Please quote order number ${po.ref} on your delivery note and invoice.${s.address && html` Deliver to: ${s.address.replace(/\n/g, ', ')}.`}</div>
    </div>`);
    window.print();
  }

  function emailOrder(id) {
    const po = orderById(id), sup = po ? supplierById(po.supplierId) : null;
    if (!po) return;
    if (!sup || !sup.email) return toast('Order saved. That supplier has no email address yet — add one on the Suppliers tab.', 'error');
    const mail = L.orderEmail(po, sup, state.settings);
    const href = L.mailtoHref(sup.email, mail.subject, mail.body);
    if (!href) return toast("Order saved. That supplier's email address doesn't look right — check it on the Suppliers tab.", 'error');
    const link = $('mail-link');
    link.setAttribute('href', href);
    link.click();
    toast('Order saved — email draft opened in your mail app');
  }

  // ── reorder suggestions ──
  function showReorder() {
    openPanel('orders', 'reorder-panel');
    const groups = L.reorderGroups(state.orders, today());
    setHTML($('reorder-list'), groups.length ? html`${groups.map(g => html`<div class="reorder-group" data-supplier="${g.supplierId}">
      <h3><span>${supplierName(g.supplierId)}</span><button type="button" class="btn btn-sm btn-primary" data-action="reorder-create" data-supplier="${g.supplierId}">Create order for ticked parts</button></h3>
      ${g.items.map((i, n) => html`<label class="reorder-item"><input type="checkbox" class="reorder-check" data-index="${n}"><span>${i.name} <small>last ${L.money(i.lastPrice)} on ${L.formatDate(i.lastDate)}</small></span></label>`)}
    </div>`)}` : html`<div class="empty">Nothing has been ordered in the last 3 months, so there is nothing to suggest yet.</div>`);
  }
  function createReorder(supplierId, button) {
    const group = L.reorderGroups(state.orders, today()).find(g => g.supplierId === supplierId);
    const box = button.closest('.reorder-group');
    const picked = group && box ? Array.from(box.querySelectorAll('.reorder-check:checked')).map(c => group.items[Number(c.dataset.index)]).filter(Boolean) : [];
    if (!picked.length) return toast('Tick at least one part first.', 'error');
    openOrderForm(null, { supplierId, lines: picked.map(i => ({ name: i.name, qty: 1, price: i.lastPrice, vatRate: L.VAT_RATES.indexOf(i.vatRate) !== -1 && i.vatRate > 0 ? i.vatRate : state.settings.defaultVatRate })) });
  }

  // ════════════════════════════════════════════════════════════════
  // GOODS IN
  // ════════════════════════════════════════════════════════════════
  function renderGoodsIn(t) {
    const q = $('search').value;
    const list = L.filterOrders(state.orders, { filter: 'open', q, supplierName, today: t }).filter(po => po.status !== 'draft')
      .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
    const empty = $('goodsin-empty');
    show(empty, !list.length); show($('goodsin-table'), list.length > 0);
    empty.textContent = q ? 'No deliveries match that.' : 'Nothing is waiting to arrive. Orders appear here once they are marked as sent.';
    setHTML($('goodsin-list'), html`${list.map(po => {
      const overdue = L.isOverdue(po, t);
      return html`<tr class="${overdue ? 'overdue' : ''}">
        <td data-label="Order"><span><span class="ref">${po.ref}</span>${overdue && html` <span class="badge badge-overdue">Overdue ${plural(L.daysBetween(po.dueDate, t), 'day')}</span>`}</span></td>
        <td data-label="Supplier">${supplierName(po.supplierId)}</td>
        <td data-label="Expected">${L.formatDate(po.dueDate)}</td>
        <td data-label="Status"><span class="badge badge-${po.status}">${L.STATUS_LABELS[po.status]}</span></td>
        <td data-label="Delivery">${progressHtml(po)}</td>
        <td class="actions"><button type="button" class="btn btn-sm btn-primary" data-action="receive-order" data-id="${po.id}">Receive</button></td></tr>`;
    })}`);
  }
  function openReceive(id) {
    const po = orderById(id);
    if (!po) return;
    openPanel('goodsin', 'receive-panel');
    state.receiveOrderId = id;
    $('receive-title').textContent = 'Receive delivery — ' + po.ref + ' · ' + supplierName(po.supplierId);
    setHTML($('receive-lines'), html`${po.items.map(i => {
      const outstanding = Math.max(0, Math.round((i.qty - i.qtyReceived) * 1000) / 1000);
      return html`<tr class="receive-row" data-item-id="${i.id}">
        <td data-label="Part">${i.name}${i.jobRef && html` <small>[${i.jobRef}]</small>`}</td>
        <td data-label="Ordered" class="num">${i.qty}</td>
        <td data-label="Received so far" class="num">${i.qtyReceived}</td>
        <td data-label="Arrived now" class="num">${outstanding > 0 ? html`<input type="number" class="receive-now" min="0" max="${outstanding}" step="any" inputmode="decimal" value="${outstanding}" aria-label="How many of ${i.name} arrived now">` : html`<span class="badge badge-yes">All in</span>`}</td>
        <td class="actions">${i.qtyReceived > 0 && html`<button type="button" class="btn btn-sm btn-outline" data-action="return-line" data-id="${po.id}" data-item-id="${i.id}">Return…</button>`}</td></tr>`;
    })}`);
  }
  async function saveReceipt() {
    const po = orderById(state.receiveOrderId);
    if (!po) return;
    const arrived = {};
    document.querySelectorAll('#receive-lines .receive-row').forEach(row => { const input = row.querySelector('.receive-now'); if (input) arrived[row.dataset.itemId] = input.value; });
    const r = L.applyReceipt(po.items, arrived);
    if (!r.ok) return toast(r.errors[0].message, 'error');
    if (!r.anyArrived) return toast('Nothing to save — enter how many arrived on at least one line.', 'error');
    const changed = r.lines.filter((l, i) => l.qtyReceived !== po.items[i].qtyReceived);
    const results = await Promise.all(changed.map(l => db.from('spo_purchase_order_items').update({ qty_received: l.qtyReceived }).eq('id', l.id)));
    const bad = results.find(x => x.error);
    if (bad) { await reload(); return fail('save what arrived', bad.error); }
    const update = { goods_in: r.state };
    if (r.state === 'yes') { update.delivered_date = today(); if (po.status !== 'invoiced') update.status = 'delivered'; }
    const { error } = await db.from('spo_purchase_orders').update(update).eq('id', po.id);
    if (error) { await reload(); return fail('update the order', error); }
    await loadAll();
    closePanel();
    toast(r.state === 'yes' ? 'Everything is in — order marked delivered' : 'Saved — the rest is still to come');
  }
  async function resetReceipt() {
    const po = orderById(state.receiveOrderId);
    if (!po || !window.confirm('Clear everything recorded as received on ' + po.ref + ' and start again?')) return;
    const lines = await db.from('spo_purchase_order_items').update({ qty_received: 0 }).eq('purchase_order_id', po.id);
    if (lines.error) return fail('clear what was received', lines.error);
    const { error } = await db.from('spo_purchase_orders').update({ goods_in: 'no', delivered_date: null, status: po.status === 'delivered' ? 'sent' : po.status }).eq('id', po.id);
    if (error) { await reload(); return fail('update the order', error); }
    await loadAll();
    closePanel();
    toast('Cleared — nothing is recorded as received');
  }

  // ════════════════════════════════════════════════════════════════
  // RETURNS AND CREDITS
  // ════════════════════════════════════════════════════════════════
  function renderReturns(t) {
    document.querySelectorAll('#return-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.rfilter === state.returnFilter));
    const owed = state.returns.filter(r => r.status !== 'credited').reduce((sum, r) => sum + r.amount, 0);
    $('returns-owed').textContent = owed > 0 ? L.money(owed) + ' still to come back' : '';
    const list = L.filterReturns(state.returns, { filter: state.returnFilter, q: $('search').value, supplierName, today: t });
    const empty = $('returns-empty');
    show(empty, !list.length); show($('returns-table'), list.length > 0);
    empty.textContent = state.returns.length ? 'No returns match that.' : 'No returns logged. When a part goes back, log it here so the credit is not forgotten.';
    setHTML($('returns-list'), html`${list.map(r => {
      const flag = L.returnFlag(r, t), po = r.orderId ? orderById(r.orderId) : null;
      const when = r.status === 'credited' ? 'credited ' + L.formatDate(r.creditedDate) + (r.creditRef ? ' · ' + r.creditRef : '')
        : r.status === 'returned' ? 'sent back ' + L.formatDate(r.returnedDate) : 'logged ' + L.formatDate(String(r.createdAt).slice(0, 10));
      return html`<tr>
        <td data-label="Part"><span>${r.itemName}${po && html`<br><small>${po.ref}</small>`}</span></td>
        <td data-label="Supplier">${supplierName(r.supplierId)}</td>
        <td data-label="Reason">${reasonLabel(r.reason)}</td>
        <td data-label="Qty" class="num">${r.qty}</td>
        <td data-label="Credit due" class="num"><strong>${L.money(r.amount)}</strong></td>
        <td data-label="Status"><span><span class="badge badge-${r.status}">${L.RETURN_STATUS_LABELS[r.status]}</span>${flag === 'chase' && html` <span class="badge badge-chase">Chase</span>`}${flag === 'send' && html` <span class="badge badge-send">Still here</span>`}<br><small>${when}</small></span></td>
        <td class="actions">
          ${r.status === 'to_return' && html`<button type="button" class="btn btn-sm btn-primary" data-action="return-sent" data-id="${r.id}">Sent back</button>`}
          ${r.status !== 'credited' && html`<button type="button" class="btn btn-sm btn-primary" data-action="return-credited" data-id="${r.id}">Credit received</button>`}
          <button type="button" class="btn btn-sm btn-outline" data-action="edit-return" data-id="${r.id}">Edit</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="delete-return" data-id="${r.id}">Delete</button>
        </td></tr>`;
    })}`);
  }
  function fillReturnOrders(selectedOrderId) {
    const supplierId = $('ret-supplier').value;
    const orders = state.orders.filter(o => o.supplierId === supplierId).slice(0, 200);
    setHTML($('ret-order'), html`<option value="">— not linked to an order —</option>${orders.map(o => html`<option value="${o.id}">${o.ref} · ${L.formatDate(o.date)}</option>`)}`);
    $('ret-order').value = orders.some(o => o.id === selectedOrderId) ? selectedOrderId : '';
  }
  // ret = an existing return to edit, or null for a new one (optionally started from `start`).
  function openReturnForm(ret, start) {
    if (!state.suppliers.length) { toast('Add a supplier first.', 'error'); openSupplierForm(null); return; }
    openPanel('returns', 'return-form');
    state.editReturnId = ret ? ret.id : null;
    const v = ret || Object.assign({ supplierId: undefined, orderId: null, itemName: '', qty: 1, amount: '', reason: 'wrong_part', status: 'to_return', returnedDate: '', creditRef: '', creditedDate: '', notes: '' }, start || {});
    $('return-form-title').textContent = ret ? 'Edit return' : 'Log a return';
    fillSupplierSelect($('ret-supplier'), ret ? ret.supplierId : (supplierById(v.supplierId) ? v.supplierId : undefined));
    fillReturnOrders(v.orderId);
    setHTML($('ret-reason'), html`${L.RETURN_REASONS.map(r => html`<option value="${r.id}">${r.label}</option>`)}`);
    setHTML($('ret-status'), html`${L.RETURN_STATUSES.map(s => html`<option value="${s}">${L.RETURN_STATUS_LABELS[s]}</option>`)}`);
    $('ret-reason').value = v.reason; $('ret-status').value = v.status;
    $('ret-item').value = v.itemName; $('ret-qty').value = v.qty; $('ret-amount').value = v.amount;
    $('ret-returned-date').value = v.returnedDate || ''; $('ret-credit-ref').value = v.creditRef || ''; $('ret-credited-date').value = v.creditedDate || '';
    $('ret-notes').value = v.notes || '';
  }
  async function saveReturn() {
    const checked = L.validateReturn({ supplierId: $('ret-supplier').value, orderId: $('ret-order').value || null, itemName: $('ret-item').value, qty: $('ret-qty').value,
      amount: $('ret-amount').value, reason: $('ret-reason').value, status: $('ret-status').value, returnedDate: $('ret-returned-date').value,
      creditRef: $('ret-credit-ref').value, creditedDate: $('ret-credited-date').value, notes: $('ret-notes').value });
    if (!checked.ok) return toast(checked.errors[0], 'error');
    const r = checked.value;
    if (r.orderId && !orderById(r.orderId)) r.orderId = null;
    if (r.status !== 'to_return' && !r.returnedDate) r.returnedDate = today();
    if (r.status === 'credited' && !r.creditedDate) r.creditedDate = today();
    const row = { user_id: state.user.id, supplier_id: r.supplierId, purchase_order_id: r.orderId, item_name: r.itemName, qty: r.qty, amount: r.amount, reason: r.reason,
      status: r.status, returned_date: r.returnedDate || null, credit_ref: r.creditRef || null, credited_date: r.creditedDate || null, notes: r.notes || null };
    const { error } = state.editReturnId
      ? await db.from('spo_returns').update(row).eq('id', state.editReturnId)
      : await db.from('spo_returns').insert(row);
    if (error) return fail('save the return', error);
    await loadAll();
    closePanel();
    toast('Return saved');
  }
  async function markReturnSent(id) {
    const { error } = await db.from('spo_returns').update({ status: 'returned', returned_date: today() }).eq('id', id);
    if (error) return fail('update the return', error);
    await reload();
    toast('Marked as sent back today');
  }
  async function deleteReturn(id) {
    const r = returnById(id);
    if (!r || !window.confirm('Delete this return? If the credit has not arrived yet it will no longer be tracked.')) return;
    const { error } = await db.from('spo_returns').delete().eq('id', id);
    if (error) return fail('delete the return', error);
    await reload();
    toast('Return deleted');
  }

  // ════════════════════════════════════════════════════════════════
  // SUPPLIERS
  // ════════════════════════════════════════════════════════════════
  function renderSuppliers(t) {
    const q = $('search').value.trim().toLowerCase();
    const list = state.suppliers.filter(s => !q || (s.name + ' ' + s.contact + ' ' + s.account + ' ' + s.email).toLowerCase().indexOf(q) !== -1);
    const stats = L.supplierStats(state.orders, t);
    const empty = $('suppliers-empty');
    show(empty, !list.length); show($('suppliers-table'), list.length > 0);
    empty.textContent = state.suppliers.length ? 'No suppliers match that.' : 'No suppliers yet — click "+ Add supplier" to add your first one.';
    setHTML($('supplier-list'), html`${list.map(s => {
      const st = stats[s.id] || { orderCount: 0, openCount: 0, spend12m: 0 };
      const tel = L.telHref(s.phone), mail = L.mailtoHref(s.email, '', '');
      return html`<tr>
        <td data-label="Supplier"><span><strong>${s.name}</strong>${s.account && html`<br><small>Acct ${s.account}</small>`}</span></td>
        <td data-label="Contact"><span>${s.contact}${s.email && html`<br>${mail ? html`<a href="${mail}">${s.email}</a>` : s.email}`}${s.phone && html`<br>${tel ? html`<a href="${tel}">${s.phone}</a>` : s.phone}`}</span></td>
        <td data-label="Terms">${termsLabel(s.terms)}</td>
        <td data-label="Delivery time">${s.leadTime ? plural(s.leadTime, 'day') : '—'}</td>
        <td data-label="Orders">${st.orderCount}${st.openCount > 0 && html` <small>(${st.openCount} open)</small>`}</td>
        <td data-label="Spend (12 months)" class="num">${L.money(st.spend12m)}</td>
        <td class="actions">
          <button type="button" class="btn btn-sm btn-primary" data-action="edit-supplier" data-id="${s.id}">Edit</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="delete-supplier" data-id="${s.id}">Delete</button>
        </td></tr>`;
    })}`);
  }
  function openSupplierForm(s) {
    openPanel('suppliers', 'supplier-form');
    state.editSupplierId = s ? s.id : null;
    $('supplier-form-title').textContent = s ? 'Edit supplier' : 'Add supplier';
    $('sup-name').value = s ? s.name : ''; $('sup-contact').value = s ? s.contact : ''; $('sup-email').value = s ? s.email : '';
    $('sup-phone').value = s ? s.phone : ''; $('sup-account').value = s ? s.account : ''; $('sup-address').value = s ? s.address : '';
    $('sup-lead').value = s ? s.leadTime : '';
    setSelect($('sup-terms'), s ? s.terms : 30, termsLabel(s ? s.terms : 30));
    $('sup-name').focus();
  }
  async function saveSupplier() {
    const checked = L.validateSupplier({ name: $('sup-name').value, contact: $('sup-contact').value, email: $('sup-email').value, phone: $('sup-phone').value,
      terms: $('sup-terms').value, account: $('sup-account').value, leadTime: $('sup-lead').value, address: $('sup-address').value });
    if (!checked.ok) return toast(checked.errors[0], 'error');
    const s = checked.value;
    const row = { user_id: state.user.id, name: s.name, contact: s.contact, email: s.email, phone: s.phone, payment_terms_days: s.terms, account: s.account, lead_time_days: s.leadTime, address: s.address };
    const { error } = state.editSupplierId
      ? await db.from('spo_suppliers').update(row).eq('id', state.editSupplierId)
      : await db.from('spo_suppliers').insert(row);
    if (error) return fail('save the supplier', error);
    await loadAll();
    closePanel();
    toast('Supplier saved');
  }
  async function deleteSupplier(id) {
    const s = supplierById(id);
    if (!s) return;
    const count = state.orders.filter(o => o.supplierId === id).length;
    const question = 'Delete this supplier?' + (count ? ' Its ' + plural(count, 'order') + ' will be kept but will show "Unknown supplier".' : '');
    if (!window.confirm(question)) return;
    const { error } = await db.from('spo_suppliers').delete().eq('id', id);
    if (error) return fail('delete the supplier', error);
    await reload();
    toast('Supplier deleted');
  }

  // ════════════════════════════════════════════════════════════════
  // PRICE HISTORY
  // ════════════════════════════════════════════════════════════════
  function renderPrices() {
    const q = $('search').value.trim().toLowerCase();
    const all = L.historyWithChange(state.history).filter(h => !q || (h.name + ' ' + supplierName(h.supplierId)).toLowerCase().indexOf(q) !== -1);
    const list = all.slice(0, 500);
    const empty = $('prices-empty');
    show(empty, !list.length); show($('prices-table'), list.length > 0);
    empty.textContent = state.history.length ? 'No prices match that.' : 'No prices yet — they are logged automatically when you save an order.';
    setHTML($('prices-list'), html`${list.map(h => html`<tr>
      <td data-label="Date">${L.formatDate(h.date)}</td>
      <td data-label="Supplier">${supplierName(h.supplierId)}</td>
      <td data-label="Part">${h.name}</td>
      <td data-label="Price (ex VAT)" class="num"><strong>${L.money(h.price)}</strong></td>
      <td data-label="Change" class="num">${h.change ? html`<span class="${h.change.diff > 0 ? 'up' : 'down'}">${h.change.diff > 0 ? '▲' : '▼'} ${L.money(Math.abs(h.change.diff))} (${Math.abs(h.change.pct)}%)</span>` : html`<small>—</small>`}</td></tr>`)}${all.length > list.length && html`<tr><td colspan="5"><small>Showing the newest 500 of ${all.length}. Search to narrow it down.</small></td></tr>`}`);
  }

  // ════════════════════════════════════════════════════════════════
  // MY BUSINESS
  // ════════════════════════════════════════════════════════════════
  function fillSettings() {
    const s = state.settings;
    $('set-name').value = s.businessName; $('set-address').value = s.address; $('set-phone').value = s.phone;
    $('set-email').value = s.email; $('set-vat-number').value = s.vatNumber; $('set-vat-rate').value = String(s.defaultVatRate);
  }
  async function saveSettings() {
    const checked = L.validateSettings({ businessName: $('set-name').value, address: $('set-address').value, phone: $('set-phone').value, email: $('set-email').value,
      vatNumber: $('set-vat-number').value, defaultVatRate: $('set-vat-rate').value });
    if (!checked.ok) return toast(checked.errors[0], 'error');
    const s = checked.value;
    const { error } = await db.from('spo_settings').upsert({ user_id: state.user.id, business_name: s.businessName, address: s.address, phone: s.phone, email: s.email,
      vat_number: s.vatNumber, default_vat_rate: s.defaultVatRate, updated_at: new Date().toISOString() });
    if (error) return fail('save your details', error);
    state.settings = s;
    toast('Details saved');
  }

  // ════════════════════════════════════════════════════════════════
  // WIRING — one listener per kind of event, no handlers written into the page
  // ════════════════════════════════════════════════════════════════
  const actions = {
    'auth-tab': d => switchAuthTab(d.tabName),
    'subscribe': () => startSubscription(),
    'billing-back': () => { show($('billing-screen'), false); show($('app-screen'), true); },
    'open-billing': () => showBilling(false),
    'logout': () => doLogout(),
    'open-settings': () => switchTab('settings'),
    'close-settings': () => switchTab('home'),
    'save-settings': () => saveSettings(),

    'new-order': () => openOrderForm(null),
    'edit-order': d => { const po = orderById(d.id); if (po) openOrderForm(po); },
    'again-order': d => {
      const po = orderById(d.id);
      if (!po) return;
      // an order from before VAT was recorded has 0% on every line: start the copy at the usual rate instead
      const noVat = po.items.every(i => !i.vatRate);
      openOrderForm(null, { supplierId: po.supplierId, notes: po.notes, lines: po.items.map(i => ({ name: i.name, jobRef: '', qty: i.qty, price: i.price, vatRate: noVat ? state.settings.defaultVatRate : i.vatRate, notes: i.notes })) });
    },
    'print-order': d => printOrder(d.id),
    'delete-order': d => deleteOrder(d.id),
    'cancel-order': () => closePanel(),
    'save-order': d => saveOrder(d.then),
    'add-item': () => { const row = addItemRow(); row.querySelector('.item-name').focus(); },
    'remove-item': (d, el) => { el.closest('.item-row').remove(); updateTotals(); },
    'show-reorder': () => showReorder(),
    'close-reorder': () => closePanel(),
    'reorder-create': (d, el) => createReorder(d.supplier, el),

    'receive-order': d => openReceive(d.id),
    'cancel-receipt': () => closePanel(),
    'save-receipt': () => saveReceipt(),
    'clear-receipt': () => { document.querySelectorAll('#receive-lines .receive-now').forEach(i => { i.value = '0'; }); },
    'reset-receipt': () => resetReceipt(),
    'return-line': d => {
      const po = orderById(d.id), item = po ? po.items.find(i => i.id === d.itemId) : null;
      if (item) openReturnForm(null, { supplierId: po.supplierId, orderId: po.id, itemName: item.name, qty: item.qtyReceived, amount: L.lineTotals({ qty: item.qtyReceived, price: item.price, vatRate: 0 }).net });
    },

    'new-return': () => openReturnForm(null),
    'edit-return': d => { const r = returnById(d.id); if (r) openReturnForm(r); },
    'return-sent': d => markReturnSent(d.id),
    'return-credited': d => { const r = returnById(d.id); if (r) { openReturnForm(r); $('ret-status').value = 'credited'; if (!$('ret-credited-date').value) $('ret-credited-date').value = today(); $('ret-credit-ref').focus(); } },
    'delete-return': d => deleteReturn(d.id),
    'cancel-return': () => closePanel(),
    'save-return': () => saveReturn(),

    'new-supplier': () => openSupplierForm(null),
    'edit-supplier': d => { const s = supplierById(d.id); if (s) openSupplierForm(s); },
    'delete-supplier': d => deleteSupplier(d.id),
    'cancel-supplier': () => closePanel(),
    'save-supplier': () => saveSupplier(),
  };
  const TILE_TARGETS = { open: ['orders', 'open'], overdue: ['orders', 'overdue'], partial: ['orders', 'partial'], spend: ['orders', 'all'], awaiting: ['goodsin'], credit: ['returns', 'open'] };

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const tabBtn = target.closest('[data-tab]');
    if (tabBtn) return switchTab(tabBtn.dataset.tab);
    const chip = target.closest('[data-filter]');
    if (chip) { state.orderFilter = chip.dataset.filter; return renderAll(); }
    const rchip = target.closest('[data-rfilter]');
    if (rchip) { state.returnFilter = rchip.dataset.rfilter; return renderAll(); }
    const tile = target.closest('[data-tile]');
    if (tile) {
      const go = TILE_TARGETS[tile.dataset.tile];
      if (!go) return;
      if (go[0] === 'orders') state.orderFilter = go[1];
      if (go[0] === 'returns') state.returnFilter = go[1];
      return switchTab(go[0]);
    }
    const btn = target.closest('[data-action]');
    if (!btn || !Object.prototype.hasOwnProperty.call(actions, btn.dataset.action)) return;
    busy(btn.tagName === 'BUTTON' ? btn : null, async () => { await actions[btn.dataset.action](btn.dataset, btn); });
  });

  $('form-login').addEventListener('submit', event => { event.preventDefault(); busy($('login-btn'), doLogin); });
  $('form-signup').addEventListener('submit', event => { event.preventDefault(); busy($('signup-btn'), doSignup); });
  $('search').addEventListener('input', () => renderAll());
  $('po-supplier').addEventListener('change', onSupplierChosen);
  $('po-date').addEventListener('change', autoExpectedDate);
  $('po-due-date').addEventListener('input', () => { $('po-due-date').dataset.auto = ''; $('po-due-hint').textContent = ''; });
  $('ret-supplier').addEventListener('change', () => fillReturnOrders(null));
  $('po-items').addEventListener('input', event => {
    const row = event.target instanceof Element ? event.target.closest('.item-row') : null;
    if (!row) return;
    updateTotals();
    updateHint(row);
  });
  $('po-items').addEventListener('change', event => {
    const el = event.target instanceof Element ? event.target : null;
    const row = el ? el.closest('.item-row') : null;
    if (!row || !el.classList.contains('item-name')) return;
    // a part bought from this supplier before: start from the last price paid
    const price = row.querySelector('.item-price');
    const last = L.lastPrice(state.history, $('po-supplier').value, el.value);
    if (price.value === '' && last !== null) { price.value = String(last); updateTotals(); }
    updateHint(row);
  });

  db.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT' && state.user) backToSignIn(); });

  // ════════════════════════════════════════════════════════════════
  // START
  // ════════════════════════════════════════════════════════════════
  (async function start() {
    try {
      const { data: { session } } = await db.auth.getSession();
      if (session && session.user) {
        state.user = session.user;
        if (await checkAccess()) await launchApp();
      }
      await handlePaymentResult();
    } catch (err) {
      console.error('Start-up failed:', err && err.message);
    }
  })();
})();
