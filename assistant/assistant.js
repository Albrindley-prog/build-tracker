/* ==========================================================================
   Website assistant — chat bubble that answers questions about our software.

   Add to a page with:
     <link rel="stylesheet" href="assistant/assistant.css">
     <script src="assistant/assistant.js" defer></script>
   On a page that doesn't define SUPABASE_URL / SUPABASE_ANON_KEY, add
   data-endpoint="https://<project>.supabase.co/functions/v1/ask-assistant" and
   data-key="<public anon key>" to the script tag.

   The AI key is NOT here. This page only talks to the ask-assistant Supabase
   function, which holds the key. Everything shown is built with textContent, never
   innerHTML, so nothing the assistant (or a visitor) writes can inject code.
   ========================================================================== */
(function () {
  'use strict';

  // Where to send questions. Pages that already define SUPABASE_URL and
  // SUPABASE_ANON_KEY (like the homepage) need no extra settings.
  var script = document.currentScript;
  var ENDPOINT = (script && script.getAttribute('data-endpoint')) ||
    (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL + '/functions/v1/ask-assistant' : '');
  var KEY = (script && script.getAttribute('data-key')) ||
    (typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : '');
  if (!ENDPOINT || !KEY) return; // not configured: show nothing rather than a broken button
  // How long to wait for an answer. 35 seconds is plenty for the real thing; the local
  // preview (a slower AI on your own computer) asks for longer with data-timeout-ms.
  var TIMEOUT_MS = Number(script && script.getAttribute('data-timeout-ms')) || 35000;

  var EMAIL = 'info@build-tracker.co.uk';
  var SITE_HOSTS = ['build-tracker.co.uk', 'www.build-tracker.co.uk'];
  var MAX_CHARS = 500;
  var KEEP = 10; // messages sent with each question
  var STORE_KEY = 'bt-assistant-chat';
  var VISITOR_KEY = 'bt-assistant-visitor';

  var GREETING = "Hi! I'm Build Tracker's AI assistant. Ask me about our software, prices and free trials, or whether we can tailor something for your business.";
  var CHIPS = [
    'What does it cost?',
    'Which tool do I need?',
    'Can you tailor software for us?',
    'How does the free trial work?'
  ];

  /* ---- browser storage (can be blocked, so every use is wrapped) ---- */
  function read(store, key) { try { return window[store].getItem(key); } catch (e) { return null; } }
  function write(store, key, val) { try { window[store].setItem(key, val); } catch (e) { /* private window etc. */ } }
  function remove(store, key) { try { window[store].removeItem(key); } catch (e) { } }

  function visitorId() {
    var id = read('localStorage', VISITOR_KEY);
    if (!id) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      write('localStorage', VISITOR_KEY, id);
    }
    return id;
  }

  /* ---- state ---- */
  var messages = [];
  try {
    var saved = JSON.parse(read('sessionStorage', STORE_KEY) || '[]');
    if (Array.isArray(saved)) {
      messages = saved.filter(function (m) {
        return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
      }).slice(-KEEP);
    }
  } catch (e) { messages = []; }
  var busy = false;

  function persist() { write('sessionStorage', STORE_KEY, JSON.stringify(messages.slice(-KEEP))); }

  /* ---- little DOM helpers ---- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(paths) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) { var p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  var ICON_CHAT = ['M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.6-.8L3 21l1.9-5.1A8.4 8.4 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z'];
  var ICON_SEND = ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4 20-7z'];

  /* ---- build the widget ---- */
  var root = el('div', 'btx-root');

  var launcher = el('button', 'btx-launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.appendChild(svg(ICON_CHAT));
  launcher.appendChild(el('span', null, 'Ask us a question'));

  var panel = el('section', 'btx-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Chat with us');

  var head = el('div', 'btx-head');
  var headText = el('div', 'btx-head-text');
  headText.appendChild(el('div', 'btx-title', 'Ask about Build Tracker'));
  headText.appendChild(el('div', 'btx-sub', 'AI assistant · can make mistakes'));
  var newBtn = el('button', 'btx-iconbtn btx-newchat', 'New chat');
  newBtn.type = 'button';
  newBtn.title = 'Start a new chat';
  var closeBtn = el('button', 'btx-iconbtn', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close chat');
  head.appendChild(headText);
  head.appendChild(newBtn);
  head.appendChild(closeBtn);

  var log = el('div', 'btx-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-relevant', 'additions');

  var form = el('form', 'btx-form');
  var label = el('label', 'btx-sr', 'Your question');
  var input = el('textarea', 'btx-input');
  input.rows = 1;
  input.maxLength = MAX_CHARS;
  input.placeholder = 'Type your question…';
  input.id = 'btx-input';
  label.setAttribute('for', 'btx-input');
  input.setAttribute('enterkeyhint', 'send');
  var sendBtn = el('button', 'btx-send');
  sendBtn.type = 'submit';
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.appendChild(svg(ICON_SEND));
  form.appendChild(label);
  form.appendChild(input);
  form.appendChild(sendBtn);

  var foot = el('div', 'btx-foot');
  foot.appendChild(document.createTextNode('AI assistant. Chats are saved so we can improve it, so please don’t share card or password details. Prefer a person? '));
  var mail = el('a', null, 'Email us');
  mail.href = 'mailto:' + EMAIL + '?subject=Question%20from%20the%20website';
  foot.appendChild(mail);
  foot.appendChild(document.createTextNode('.'));

  panel.appendChild(head);
  panel.appendChild(log);
  panel.appendChild(form);
  panel.appendChild(foot);
  root.appendChild(launcher);
  root.appendChild(panel);

  /* ---- showing messages ---- */
  // Turns plain text into text + safe links. Only our own website addresses, our
  // email address and phone numbers become links; anything else stays plain text.
  var TOKEN = /(https?:\/\/[^\s<>"]+)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(\b0\d{3,4}[ ]?\d{6}\b)/g;

  function siteHref(raw) {
    var trail = '';
    var m = raw.match(/[.,;:!?)\]]+$/);
    if (m) { trail = m[0]; raw = raw.slice(0, -trail.length); }
    try {
      var u = new URL(raw);
      if (SITE_HOSTS.indexOf(u.hostname) === -1 || u.protocol !== 'https:') return null;
      // Keep visitors on whatever host they are on now (so it also works when testing locally)
      return { href: (u.pathname || '/') + u.search + u.hash, text: raw, trail: trail };
    } catch (e) { return null; }
  }

  function fill(node, text) {
    var last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(text)) !== null) {
      var piece = m[0], a = null;
      if (m[1]) {
        var s = siteHref(piece);
        if (s) { a = el('a', null, s.text); a.href = s.href; piece = s.text + s.trail; }
      } else if (m[2]) {
        if (m[2].toLowerCase().slice(-('@build-tracker.co.uk'.length)) === '@build-tracker.co.uk') {
          a = el('a', null, m[2]); a.href = 'mailto:' + m[2];
        }
      } else if (m[3]) {
        a = el('a', null, m[3]); a.href = 'tel:' + m[3].replace(/\s/g, '');
      }
      if (a) {
        if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
        node.appendChild(a);
        var trailing = m[1] ? piece.slice(a.textContent.length) : '';
        if (trailing) node.appendChild(document.createTextNode(trailing));
        last = m.index + m[0].length;
      }
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }

  function scrollDown() { log.scrollTop = log.scrollHeight; }

  // (Re)writes an assistant bubble. The assistant is told not to use markdown, so any
  // stray bold marks are tidied away.
  function setBotText(node, text) {
    node.textContent = '';
    fill(node, text.replace(/\*\*/g, ''));
  }

  function addMsg(kind, text) {
    var n = el('div', 'btx-msg ' + (kind === 'user' ? 'btx-me' : kind === 'note' ? 'btx-bot btx-note' : 'btx-bot'));
    if (kind === 'user') n.textContent = text; else setBotText(n, text);
    log.appendChild(n);
    scrollDown();
    return n;
  }

  var chipsBox = null;
  function showChips() {
    if (chipsBox || messages.length) return;
    chipsBox = el('div', 'btx-chips');
    CHIPS.forEach(function (c) {
      var b = el('button', 'btx-chip', c);
      b.type = 'button';
      b.addEventListener('click', function () { send(c); });
      chipsBox.appendChild(b);
    });
    log.appendChild(chipsBox);
  }
  function hideChips() { if (chipsBox) { chipsBox.remove(); chipsBox = null; } }

  var typingNode = null, typingWait = null;
  function showTyping() {
    typingNode = el('div', 'btx-msg btx-bot btx-typing');
    typingNode.setAttribute('aria-label', 'The assistant is typing');
    typingNode.appendChild(el('span')); typingNode.appendChild(el('span')); typingNode.appendChild(el('span'));
    log.appendChild(typingNode);
    scrollDown();
    // If an answer is slow, say so, so it never looks frozen.
    var node = typingNode;
    typingWait = setTimeout(function () {
      if (typingNode === node) { node.appendChild(el('em', 'btx-wait', 'Still thinking…')); scrollDown(); }
    }, 8000);
  }
  function hideTyping() {
    clearTimeout(typingWait);
    if (typingNode) { typingNode.remove(); typingNode = null; }
  }

  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b;
    panel.setAttribute('aria-busy', b ? 'true' : 'false');
    // Screen readers wait until the whole answer is in rather than reading every fragment.
    log.setAttribute('aria-busy', b ? 'true' : 'false');
  }

  function renderAll() {
    log.textContent = '';
    chipsBox = null;
    addMsg('bot', GREETING);
    messages.forEach(function (m) { addMsg(m.role === 'user' ? 'user' : 'bot', m.content); });
    showChips();
  }

  /* ---- talking to the function ---- */
  function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

    hideChips();
    addMsg('user', text);
    messages.push({ role: 'user', content: text });
    messages = messages.slice(-KEEP);
    persist();
    input.value = '';
    autosize();
    setBusy(true);
    showTyping();

    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);

    // Whatever goes wrong, the visitor sees something kind and their question is put
    // back in the box so they can send it again.
    function problem(msg) {
      hideTyping();
      messages.pop(); // the unanswered question isn't part of the conversation
      persist();
      addMsg('note', msg || ('Sorry, I couldn’t reach the assistant. Please try again, or email ' + EMAIL + '.'));
      input.value = text;
      autosize();
    }

    function keepAnswer(answer) {
      messages.push({ role: 'assistant', content: answer });
      messages = messages.slice(-KEEP);
      persist();
    }

    // The answer arrives in pieces ("server-sent events"): show the words as they come,
    // so the first ones appear straight away instead of after the whole answer.
    function readStream(res) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '', answer = '', bubble = null, finished = false, failure = null;

      function show() {
        if (!bubble) { hideTyping(); bubble = addMsg('bot', ''); }
        setBotText(bubble, answer);
        scrollDown();
      }
      function onEvent(ev) {
        if (ev.t === 'delta' && typeof ev.text === 'string') { answer += ev.text; show(); }
        else if (ev.t === 'replace' && typeof ev.text === 'string') { answer = ev.text; show(); }
        else if (ev.t === 'done') { finished = true; }
        else if (ev.t === 'error') { failure = ev.message || 'error'; }
      }
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buffer += decoder.decode(r.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop();
          parts.forEach(function (part) {
            try { onEvent(JSON.parse(part.replace(/^data:\s?/, ''))); } catch (e) { /* ignore a broken line */ }
          });
          return pump();
        });
      }
      return pump().then(function () {
        clearTimeout(timer);
        if (finished && answer.trim()) {
          keepAnswer(answer);
        } else {
          if (bubble) bubble.remove(); // a half-written answer is worse than a clear message
          problem(typeof failure === 'string' && failure !== 'error' ? failure : undefined);
        }
      });
    }

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': KEY, 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({ messages: messages, visitorId: visitorId(), stream: true }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (res.ok && type.indexOf('text/event-stream') !== -1 && res.body && res.body.getReader) {
        return readStream(res);
      }
      // Anything else (a limit reached, switched off, a problem) is a short JSON message.
      return res.json().then(function (data) { return data; }, function () { return null; }).then(function (data) {
        clearTimeout(timer);
        if (data && data.ok && typeof data.reply === 'string' && data.reply) {
          hideTyping();
          addMsg('bot', data.reply);
          keepAnswer(data.reply);
        } else {
          problem(data && data.message);
        }
      });
    }).catch(function () {
      clearTimeout(timer);
      problem();
    }).then(function () {
      setBusy(false);
      if (panel.contains(document.activeElement) || !isTouch()) input.focus();
    });
  }

  /* ---- open / close ---- */
  function isTouch() { return window.matchMedia && matchMedia('(hover: none)').matches; }
  function isOpen() { return root.classList.contains('btx-open'); }

  function openChat() {
    root.classList.add('btx-open');
    launcher.setAttribute('aria-expanded', 'true');
    if (!log.childNodes.length) renderAll();
    scrollDown();
    if (!isTouch()) input.focus();
  }
  function closeChat() {
    root.classList.remove('btx-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }

  function autosize() {
    input.style.height = 'auto';
    var h = input.scrollHeight + 2; // + the 1px border top and bottom
    input.style.height = Math.min(h, 120) + 'px';
    input.style.overflowY = h > 120 ? 'auto' : 'hidden';
  }

  launcher.addEventListener('click', openChat);
  closeBtn.addEventListener('click', closeChat);
  newBtn.addEventListener('click', function () {
    if (busy) return;
    messages = [];
    remove('sessionStorage', STORE_KEY);
    renderAll();
    input.value = '';
    autosize();
  });
  form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen()) closeChat(); });

  // Using a link to another part of our page: get the chat out of the way on phones.
  log.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="/"], a[href^="#"]');
    if (a && window.matchMedia && matchMedia('(max-width: 520px)').matches) closeChat();
  });

  function mount() { document.body.appendChild(root); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
