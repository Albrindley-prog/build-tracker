(function () {
  'use strict';

  const LANG = 'en-GB';
  const NOTES_KEY = 'voiceNotes.v1';
  const SAVE_AUDIO_KEY = 'voiceNotes.saveAudio';
  const MODEL_KEY = 'voiceNotes.ollamaModel';
  const LAST_BACKUP_KEY = 'voiceNotes.lastBackup';
  const DEFAULT_MODEL = 'llama3.2:3b'; // small and quick enough for an ordinary laptop
  const MAX_FAILURES = 6; // consecutive speech-service failures before we give up

  const $ = (id) => document.getElementById(id);
  const els = {
    banner: $('banner'), recordBtn: $('recordBtn'), recordLabel: $('recordLabel'),
    status: $('status'), timer: $('timer'), live: $('live'), saveAudio: $('saveAudio'),
    title: $('title'), body: $('body'), audioList: $('audioList'), saveState: $('saveState'),
    wordCount: $('wordCount'), exportOneBtn: $('exportOneBtn'), newBtn: $('newBtn'),
    exportAllBtn: $('exportAllBtn'), noteList: $('noteList'), noteCount: $('noteCount'),
    toast: $('toast'), editor: document.querySelector('.editor'),
    backupBtn: $('backupBtn'), restoreFile: $('restoreFile'), backupInfo: $('backupInfo'),
    modelSelect: $('modelSelect'), refreshModels: $('refreshModels'), summariseBtn: $('summariseBtn'),
    ollamaStatus: $('ollamaStatus'), summaryBody: $('summaryBody'),
  };

  // ---------------------------------------------------------------- helpers
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const getSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Opened from a Home Screen icon rather than inside a browser tab.
  const isStandalone = window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  const countWords = (t) => (t.trim().match(/\S+/g) || []).length;
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const shortDateTime = (ts) => new Date(ts).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const timeOnly = (ts) => new Date(ts).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const safeFileName = (s) =>
    (s || '').replace(/[\\/:*?"<>|\r\n]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Voice note';

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 6000);
  }

  function setStatus(text, kind = 'idle') {
    els.status.textContent = text;
    els.status.dataset.kind = kind;
  }

  // ---------------------------------------------------------------- storage
  // Note text lives in localStorage; audio blobs live in IndexedDB (too big for localStorage).
  let notes = loadNotes();

  function loadNotes() {
    try {
      const arr = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function persistNotes() {
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); return true; } catch { return false; }
  }

  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('voice-notes-audio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('clips');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch((err) => { dbPromise = null; throw err; });
    }
    return dbPromise;
  }
  function clipsTx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction('clips', mode);
      const req = fn(t.objectStore('clips'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = t.onabort = () => reject(t.error);
    }));
  }
  const getClips = (noteId) => clipsTx('readonly', (s) => s.get(noteId)).then((v) => v || []);
  const deleteClips = (noteId) => clipsTx('readwrite', (s) => s.delete(noteId));
  async function addClip(noteId, clip) {
    const clips = await getClips(noteId);
    clips.push(clip);
    await clipsTx('readwrite', (s) => s.put(clips, noteId));
  }

  // ---------------------------------------------------------------- current note
  function newDraft() {
    const now = Date.now();
    return {
      id: uid(), title: shortDateTime(now), text: '', createdAt: now, updatedAt: now,
      audioClips: 0,
      summary: null,      // { text, actions[], model, at, hash } once the user presses Summarise
      fresh: true,        // no content yet: timestamp is re-stamped when the first words arrive
      titleEdited: false, // true once the user types their own title
    };
  }
  let current = newDraft();

  function syncFromInputs() {
    current.title = els.title.value.trim() || shortDateTime(current.createdAt);
    current.text = els.body.value;
  }

  // First real content in a blank note: timestamp it now, not when the page was opened.
  function markStarted() {
    if (!current.fresh) return;
    current.fresh = false;
    current.createdAt = Date.now();
    if (!current.titleEdited) els.title.value = current.title = shortDateTime(current.createdAt);
  }

  let saveTimer;
  function scheduleSave() {
    setSaveState('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrent, 400);
  }

  function saveCurrent() {
    clearTimeout(saveTimer);
    syncFromInputs();
    const idx = notes.findIndex((n) => n.id === current.id);
    const hasContent = current.text.trim() !== '' || current.audioClips > 0;
    if (!hasContent && idx === -1) { setSaveState('Not saved yet'); return; }
    // Only a real edit counts as "updated": restoring a backup compares these times to keep the newer copy.
    const prev = idx === -1 ? null : notes[idx];
    const changed = !prev || prev.title !== current.title || prev.text !== current.text
      || prev.audioClips !== current.audioClips
      || JSON.stringify(prev.summary || null) !== JSON.stringify(current.summary || null);
    if (changed) current.updatedAt = Date.now();
    const record = {
      id: current.id, title: current.title, text: current.text,
      createdAt: current.createdAt, updatedAt: current.updatedAt, audioClips: current.audioClips,
      summary: current.summary || null,
    };
    if (idx === -1) notes.push(record); else notes[idx] = record;
    if (persistNotes()) setSaveState(`Saved at ${timeOnly(current.updatedAt)}`);
    else setSaveState('Could not save: browser storage is full or blocked', 'error');
    renderList();
  }

  function setSaveState(text, kind) {
    els.saveState.textContent = text;
    els.saveState.style.color = kind === 'error' ? 'var(--err)' : '';
  }

  function fillInputs() {
    els.title.value = current.title;
    els.body.value = current.text;
    updateWordCount();
    setSaveState(notes.some((n) => n.id === current.id) ? 'Saved' : 'Not saved yet');
    renderSummary();
  }

  function updateWordCount() {
    const n = countWords(els.body.value);
    els.wordCount.textContent = `${n} ${n === 1 ? 'word' : 'words'}`;
  }

  // Stop any recording (so its words and audio land in the right note), then save.
  async function settle() {
    if (state === 'recording') await stopRecording();
    else if (stopPromise) await stopPromise;
    saveCurrent();
  }

  async function newNote() {
    if (state === 'starting') return;
    await settle();
    current = newDraft();
    fillInputs();
    renderAudio();
    renderList();
    els.editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function openNote(id) {
    if (state === 'starting') return;
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    if (id !== current.id) {
      await settle();
      current = { ...note, fresh: false, titleEdited: true };
      fillInputs();
      renderAudio();
      renderList();
    }
    els.editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function deleteNote(id) {
    if (state === 'starting') return;
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    const extra = note.audioClips ? ' and its audio' : '';
    if (!confirm(`Delete “${note.title}”${extra}? This cannot be undone.`)) return;
    if (id === current.id && state === 'recording') await stopRecording();
    clearTimeout(saveTimer);
    notes = notes.filter((n) => n.id !== id);
    persistNotes();
    try { await deleteClips(id); } catch { /* nothing stored */ }
    if (id === current.id) {
      current = newDraft();
      fillInputs();
      renderAudio();
    }
    renderList();
  }

  // ---------------------------------------------------------------- rendering
  function renderList() {
    els.noteCount.textContent = notes.length;
    renderBackupInfo();
    els.noteList.replaceChildren();
    if (!notes.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No saved notes yet. Anything you record or type is saved here automatically.';
      els.noteList.append(li);
      return;
    }
    [...notes].sort((a, b) => b.createdAt - a.createdAt).forEach((note) => {
      const isOpen = note.id === current.id;
      const li = document.createElement('li');
      li.className = 'note' + (isOpen ? ' is-open' : '');

      const info = document.createElement('div');
      info.className = 'note-info';
      const title = document.createElement('div');
      title.className = 'note-title';
      title.textContent = note.title;
      const words = countWords(note.text);
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      meta.textContent = [
        shortDateTime(note.createdAt),
        `${words} ${words === 1 ? 'word' : 'words'}`,
        note.audioClips ? 'has audio' : null,
        note.summary ? 'summarised' : null,
      ].filter(Boolean).join(' · ');
      info.append(title, meta);
      if (note.text.trim()) {
        const snip = document.createElement('div');
        snip.className = 'note-snippet';
        snip.textContent = note.text.trim().slice(0, 200);
        info.append(snip);
      }

      const actions = document.createElement('div');
      actions.className = 'note-actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn small';
      open.dataset.action = 'open';
      open.dataset.id = note.id;
      open.textContent = isOpen ? 'Editing' : 'Open';
      open.disabled = isOpen;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn small danger';
      del.dataset.action = 'delete';
      del.dataset.id = note.id;
      del.textContent = 'Delete';
      actions.append(open, del);

      li.append(info, actions);
      els.noteList.append(li);
    });
  }

  let clipUrls = [];
  let audioToken = 0;
  async function renderAudio() {
    const token = ++audioToken;
    clipUrls.forEach((u) => URL.revokeObjectURL(u));
    clipUrls = [];
    els.audioList.replaceChildren();
    if (!current.audioClips) return;
    const noteId = current.id;
    let clips;
    try { clips = await getClips(noteId); } catch { clips = []; }
    if (token !== audioToken || noteId !== current.id) return; // superseded while loading
    clips.forEach((clip, i) => {
      const url = URL.createObjectURL(clip.blob);
      clipUrls.push(url);
      const wrap = document.createElement('div');
      wrap.className = 'clip';
      const label = document.createElement('span');
      label.className = 'clip-label';
      label.textContent = `Recording ${i + 1} · ${shortDateTime(clip.createdAt)} · ${clock(clip.duration || 0)}`;
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = url;
      fixInfiniteDuration(audio);
      wrap.append(label, audio);
      els.audioList.append(wrap);
    });
  }

  // Chrome's MediaRecorder files have no length header, so the seek bar misbehaves.
  // Jumping to a huge time makes the browser work out the real duration.
  function fixInfiniteDuration(audio) {
    audio.addEventListener('loadedmetadata', function onMeta() {
      if (audio.duration !== Infinity) return;
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.currentTime = 1e101;
      audio.addEventListener('timeupdate', function reset() {
        audio.removeEventListener('timeupdate', reset);
        audio.currentTime = 0;
      });
    });
  }

  // Live panel: the last bit of the note, then the words still being worked out.
  let interim = '';
  function renderLive() {
    els.live.replaceChildren();
    const hint = (text) => {
      const s = document.createElement('span');
      s.className = 'live-hint';
      s.textContent = text;
      els.live.append(s);
    };
    if (state !== 'recording') { hint('Your words will appear here as you speak.'); return; }
    let tail = els.body.value.replace(/\s+/g, ' ').trim();
    if (tail.length > 200) tail = '…' + tail.slice(-200).replace(/^\S*\s/, '');
    if (!tail && !interim.trim()) { hint('Listening… start speaking.'); return; }
    if (tail) els.live.append(document.createTextNode(tail + ' '));
    if (interim.trim()) {
      const s = document.createElement('span');
      s.className = 'interim';
      s.textContent = interim.trim();
      els.live.append(s);
    }
  }

  // ---------------------------------------------------------------- recording
  // idle -> starting -> recording -> stopping -> idle
  let state = 'idle';
  let stopPromise = null;
  let wantListening = false; // true while we should keep (re)starting recognition
  let recognition = null;
  let restartTimer;
  let failures = 0;
  let audio = null;          // { stream, recorder, chunks, mime, startedAt, noteId }
  let timerId;
  let timerStart;

  function updateUI() {
    const rec = state === 'recording';
    els.recordBtn.classList.toggle('is-recording', rec);
    els.recordBtn.setAttribute('aria-pressed', String(rec));
    els.recordBtn.disabled = state === 'starting' || state === 'stopping' || !getSR();
    els.recordLabel.textContent = { idle: 'Record', starting: 'Starting…', recording: 'Stop', stopping: 'Finishing…' }[state];
    els.saveAudio.disabled = state !== 'idle';
    document.title = rec ? '● Recording – Voice Notes' : 'Voice Notes';
  }

  function startTimer() {
    timerStart = Date.now();
    els.timer.hidden = false;
    const tick = () => { els.timer.textContent = clock((Date.now() - timerStart) / 1000); };
    tick();
    timerId = setInterval(tick, 500);
  }
  function stopTimer() {
    clearInterval(timerId);
    els.timer.hidden = true;
  }

  // What to tell the user when the browser refuses microphone / speech-recognition access.
  function blockedMessage() {
    if (isIOS && isStandalone) {
      return 'Speech-to-text may not work from a Home Screen icon on iPhone. Delete this icon, open the site in Safari, tap Share > Add to Home Screen, switch "Open as Web App" off, and add it again. (Or simply use it in a Safari tab.)';
    }
    if (isIOS) {
      return 'The microphone or speech recognition is blocked. In Safari tap "aA" in the address bar > Website Settings and allow the Microphone, and check that Dictation is on (Settings > General > Keyboard). Then press Record again.';
    }
    return 'The microphone (or speech recognition) is blocked. Click the padlock beside the address bar, allow the microphone, then press Record again.';
  }

  function micMessage(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return blockedMessage();
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No microphone was found. Plug one in (or check your sound settings) and try again.';
      case 'NotReadableError':
        return 'The microphone is being used by another program. Close it and try again.';
      default:
        return `Could not start the microphone (${(err && err.name) || 'unknown error'}).`;
    }
  }

  async function startRecording() {
    if (state !== 'idle' || !getSR()) return;
    state = 'starting';
    updateUI();
    setStatus('Starting… allow the microphone if your browser asks.', 'idle');
    try {
      if (els.saveAudio.checked) await startAudio();
    } catch (err) {
      state = 'idle';
      updateUI();
      setStatus(micMessage(err), 'error');
      return;
    }
    markStarted();
    wantListening = true;
    failures = 0;
    interim = '';
    state = 'recording';
    startTimer();
    updateUI();
    renderLive();
    setStatus('Listening… speak naturally.', 'live');
    startRecognition();
  }

  function stopRecording(reason) {
    if (state === 'stopping') return stopPromise;
    if (state !== 'recording') return Promise.resolve();
    state = 'stopping';
    wantListening = false;
    clearTimeout(restartTimer);
    stopTimer();
    updateUI();
    setStatus('Finishing…', 'idle');
    stopPromise = (async () => {
      await Promise.all([stopRecognition(), stopAudio()]);
      interim = '';
      state = 'idle';
      stopPromise = null;
      saveCurrent();
      renderAudio();
      renderLive();
      updateUI();
      if (reason) setStatus(reason, 'error');
      else setStatus(current.text.trim() ? 'Stopped. Your note is saved below.' : 'Stopped.', 'ok');
    })();
    return stopPromise;
  }

  // ----- speech recognition (restarts itself whenever the browser cuts it off)
  function startRecognition() {
    const SR = getSR();
    if (!SR || !wantListening) return;
    const r = new SR();
    r.lang = LANG;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = () => { if (wantListening) setStatus('Listening… speak naturally.', 'live'); };
    r.onresult = onSpeechResult;
    r.onerror = onSpeechError;
    r.onend = () => {
      if (recognition === r) recognition = null;
      interim = '';
      renderLive();
      if (r.stopWaiter) r.stopWaiter();
      else if (wantListening) scheduleRestart();
    };
    recognition = r;
    try {
      r.start();
    } catch {
      recognition = null;
      if (++failures >= MAX_FAILURES) stopRecording('Speech recognition keeps failing to start. Try reloading the page.');
      else scheduleRestart();
    }
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    const delay = failures ? Math.min(500 * 2 ** failures, 5000) : 100;
    restartTimer = setTimeout(startRecognition, delay);
  }

  function onSpeechResult(e) {
    failures = 0;
    let live = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) appendFinal(res[0].transcript);
      else live += res[0].transcript;
    }
    interim = live;
    renderLive();
  }

  function onSpeechError(e) {
    switch (e.error) {
      case 'no-speech':   // just silence; onend restarts us
      case 'aborted':
        return;
      case 'network':
        if (++failures >= MAX_FAILURES) {
          stopRecording('Stopped: could not reach the browser\'s speech service. Check your internet connection and try again.');
        } else {
          setStatus('Can\'t reach the speech service. Check your internet… retrying.', 'warn');
        }
        return;
      case 'not-allowed':
      case 'service-not-allowed':
        stopRecording(blockedMessage());
        return;
      case 'audio-capture':
        stopRecording('No microphone was found. Plug one in and try again.');
        return;
      case 'language-not-supported':
        stopRecording(`This browser does not support speech recognition for ${LANG}.`);
        return;
      default:
        setStatus(`Speech problem (${e.error}). Restarting…`, 'warn');
    }
  }

  function stopRecognition() {
    const r = recognition;
    if (!r) return Promise.resolve();
    return new Promise((resolve) => {
      // stop() (not abort()) so the last few words are still delivered; the timeout is a safety net.
      const timer = setTimeout(() => {
        try { r.abort(); } catch { /* already stopped */ }
        recognition = null;
        resolve();
      }, 3000);
      r.stopWaiter = () => { clearTimeout(timer); resolve(); };
      try { r.stop(); } catch { r.stopWaiter(); }
    });
  }

  function appendFinal(raw) {
    let text = raw.trim();
    if (!text) return;
    markStarted();
    const cur = els.body.value;
    if (cur.trim() === '' || /[.!?]\s*$/.test(cur)) text = text[0].toUpperCase() + text.slice(1);
    els.body.value = cur + (cur === '' || /\s$/.test(cur) ? '' : ' ') + text;
    els.body.scrollTop = els.body.scrollHeight;
    updateWordCount();
    refreshStale();
    scheduleSave();
  }

  // ----- audio capture (runs alongside speech recognition)
  function pickMime() {
    const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    return options.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startAudio() {
    if (!navigator.mediaDevices || !window.MediaRecorder) return; // no audio capture here: transcript only
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const mime = pickMime();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start(1000);
      audio = { stream, recorder, chunks, mime: recorder.mimeType, startedAt: Date.now(), noteId: current.id };
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop()); // don't leave the mic on
      throw err;
    }
  }

  function stopAudio() {
    const a = audio;
    audio = null;
    if (!a) return Promise.resolve();
    return new Promise((resolve) => {
      a.recorder.onstop = async () => {
        a.stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(a.chunks, { type: a.mime });
        if (blob.size > 0) {
          try {
            await addClip(a.noteId, {
              blob, type: a.mime, createdAt: a.startedAt, duration: (Date.now() - a.startedAt) / 1000,
            });
            current.audioClips += 1;
          } catch {
            toast('Could not save the audio (browser storage may be full or blocked).');
          }
        }
        resolve();
      };
      if (a.recorder.state === 'inactive') a.recorder.onstop(); else a.recorder.stop();
    });
  }

  // ---------------------------------------------------------------- AI summary (Ollama)
  // Runs only when the Summarise button is pressed. The server forwards the request to the
  // Ollama running on this computer, so nothing leaves the machine.
  const START_OLLAMA = 'Start it by opening the Ollama app from the Start menu (look for its icon in the system tray), or run `ollama serve` in a terminal.';
  // noBackend: a hosted copy of the app (no Voice Notes server behind it), so summaries aren't possible.
  let ollama = { running: false, models: [], serverDown: false, noBackend: false };
  let summarising = null;  // { noteId, model } while a request is in flight
  let summaryError = null; // { noteId, code, detail, model }

  const hashText = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return String(h);
  };
  const formatSize = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
  const savedModel = () => { try { return localStorage.getItem(MODEL_KEY); } catch { return null; } };

  // Text with `backticks` becomes <code> pieces (so commands stand out).
  function richText(parent, text) {
    text.split('`').forEach((part, i) => {
      if (!part) return;
      if (i % 2) {
        const c = document.createElement('code');
        c.textContent = part;
        parent.append(c);
      } else {
        parent.append(document.createTextNode(part));
      }
    });
  }

  function summaryErrorText(e) {
    switch (e.code) {
      case 'not_running':
        return `Ollama isn't running, so I can't make a summary. ${START_OLLAMA} Then press Summarise again.`;
      case 'model_missing':
        return `The model \`${e.model}\` isn't installed on this computer. Open a terminal, run \`ollama pull ${e.model}\`, wait for it to finish, then press ↻ and Summarise again.`;
      case 'timeout':
        return 'Ollama took too long to reply (over 5 minutes). Try a smaller model, or a shorter note.';
      case 'too_long':
        return 'This note is too long to summarise in one go. Try trimming it first.';
      case 'bad_output':
        return 'The model gave an answer I couldn\'t use. Press Summarise to try again, or pick a different model.';
      case 'no_backend':
        return 'Summaries need Ollama running on your own computer, and this copy of the app isn\'t connected to one.';
      case 'network':
        return 'Couldn\'t reach the Voice Notes server. Check that the terminal running "npm start" is still open.';
      default:
        return `Ollama reported a problem${e.detail ? `: ${e.detail}` : '.'}`;
    }
  }

  async function loadModels() {
    els.refreshModels.disabled = true;
    try {
      // Relative on purpose: when the app lives in a subfolder of a website, this stays inside that folder.
      const res = await fetch('api/ollama/models');
      if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) {
        // Static hosts answer unknown addresses with 404 or the home page, never JSON.
        ollama = { running: false, models: [], serverDown: false, noBackend: true };
      } else {
        const data = await res.json();
        ollama = { running: !!data.running, models: data.models || [], serverDown: false, noBackend: false };
      }
    } catch {
      ollama = { running: false, models: [], serverDown: true, noBackend: false };
    }
    els.refreshModels.disabled = false;
    renderModelSelect();
    renderOllamaStatus();
    renderSummary();
  }

  function renderModelSelect() {
    const sel = els.modelSelect;
    sel.replaceChildren();
    const add = (value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.append(o);
    };
    ollama.models.forEach((m) => add(m.name, `${m.name} (${formatSize(m.size)})`));
    if (!ollama.models.some((m) => m.name === DEFAULT_MODEL)) {
      add(DEFAULT_MODEL, ollama.running ? `${DEFAULT_MODEL} (not installed)` : DEFAULT_MODEL);
    }
    const values = [...sel.options].map((o) => o.value);
    const wanted = savedModel();
    sel.value = values.includes(wanted) ? wanted : DEFAULT_MODEL;
  }

  function renderOllamaStatus() {
    const p = els.ollamaStatus;
    p.replaceChildren();
    if (ollama.noBackend) {
      p.dataset.kind = '';
      p.textContent = 'Summaries need Ollama running on your own computer, and this copy of the app isn\'t connected to one. Everything else works on its own.';
    } else if (ollama.serverDown) {
      p.dataset.kind = 'warn';
      p.textContent = 'Can\'t reach the Voice Notes server, so summaries aren\'t available right now. (On your PC, check that the "npm start" window is still open.)';
    } else if (!ollama.running) {
      p.dataset.kind = 'warn';
      richText(p, `Ollama isn't running. ${START_OLLAMA} Then press ↻.`);
    } else {
      p.dataset.kind = '';
      let msg = 'Ollama is running. Smaller models are faster; bigger ones usually write better summaries.';
      if (ollama.models.length < 2) msg += ' To add a bigger one, run `ollama pull llama3.1:8b`, then press ↻.';
      richText(p, msg);
    }
  }

  function renderSummary() {
    const body = els.summaryBody;
    body.replaceChildren();
    const busyHere = summarising && summarising.noteId === current.id;
    els.summariseBtn.textContent = busyHere ? 'Summarising…' : current.summary ? 'Summarise again' : 'Summarise';
    els.summariseBtn.disabled = !!summarising;
    els.modelSelect.disabled = !!summarising;
    els.summariseBtn.closest('.summary-controls').hidden = ollama.noBackend;

    const para = (cls, text) => {
      const p = document.createElement('p');
      p.className = cls;
      if (text) p.textContent = text;
      return p;
    };

    if (busyHere) {
      body.append(para('summary-busy', `Asking ${summarising.model}… the first summary can take up to a minute while the model loads.`));
      return;
    }
    const hasError = summaryError && summaryError.noteId === current.id;
    if (hasError) {
      const p = para('summary-error');
      richText(p, summaryErrorText(summaryError));
      body.append(p); // any existing summary stays visible below it
    }
    const s = current.summary;
    if (!s) {
      if (!hasError && !ollama.noBackend) {
        body.append(para('summary-placeholder', 'No summary yet. Press Summarise for a short summary and a list of action points. It runs on your own computer using Ollama, and only when you press the button.'));
      }
      return;
    }

    const wrap = document.createElement('div');
    wrap.style.marginTop = body.firstChild ? '10px' : '0';
    wrap.append(para('summary-text', s.text));
    const h = document.createElement('h4');
    h.textContent = 'Action points';
    wrap.append(h);
    if (s.actions && s.actions.length) {
      const ul = document.createElement('ul');
      ul.className = 'summary-actions';
      s.actions.forEach((a) => {
        const li = document.createElement('li');
        li.textContent = a;
        ul.append(li);
      });
      wrap.append(ul);
    } else {
      wrap.append(para('summary-none', 'None'));
    }
    const foot = para('summary-foot', `Made by ${s.model} on ${shortDateTime(s.at)}.`);
    const stale = document.createElement('span');
    stale.className = 'stale';
    foot.append(stale, document.createTextNode(' '));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link-btn';
    remove.dataset.action = 'remove-summary';
    remove.textContent = 'Remove summary';
    foot.append(remove);
    wrap.append(foot);
    body.append(wrap);
    refreshStale();
  }

  // Warn when the note has been edited since the summary was written.
  function refreshStale() {
    const el = els.summaryBody.querySelector('.stale');
    if (!el || !current.summary) return;
    const changed = hashText(els.body.value) !== current.summary.hash;
    el.textContent = changed ? ' The note has changed since this was written. Press “Summarise again” to update it.' : '';
  }

  function attachSummary(noteId, summary) {
    if (noteId === current.id) {
      current.summary = summary;
      saveCurrent();
      return;
    }
    const note = notes.find((n) => n.id === noteId); // user moved to another note while we waited
    if (note) {
      note.summary = summary;
      persistNotes();
      renderList();
    }
  }

  async function summarise() {
    if (summarising) return;
    saveCurrent(); // makes sure the text box and the saved note agree
    if (!current.text.trim()) { toast('Write or record something first, then press Summarise.'); return; }
    const model = els.modelSelect.value || DEFAULT_MODEL;
    const noteId = current.id;
    const text = current.text;
    summarising = { noteId, model };
    summaryError = null;
    renderSummary();
    try {
      const res = await fetch('api/ollama/summarise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model }),
      });
      if (!(res.headers.get('content-type') || '').includes('json')) {
        const e = new Error('');
        e.code = 'no_backend';
        throw e;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.summary) {
        const e = new Error(data.detail || '');
        e.code = data.error || 'failed';
        throw e;
      }
      attachSummary(noteId, {
        text: data.summary, actions: data.actions || [], model: data.model || model,
        at: Date.now(), hash: hashText(text),
      });
    } catch (err) {
      summaryError = { noteId, code: err.code || 'network', detail: err.message, model };
      if (['not_running', 'network', 'model_missing', 'no_backend'].includes(summaryError.code)) loadModels();
    } finally {
      summarising = null;
      renderSummary();
    }
  }

  function removeSummary() {
    current.summary = null;
    summaryError = null;
    saveCurrent();
    renderSummary();
  }

  // ---------------------------------------------------------------- Backup and restore
  // A backup file holds notes and summaries (not audio). Restoring only ever adds notes or replaces an
  // older copy of the same note; it never deletes anything. Rules live in backup.js.
  const BACKUP_ERRORS = {
    not_json: 'That file isn\'t a Voice Notes backup (it could not be read).',
    not_backup: 'That file isn\'t a Voice Notes backup.',
    too_new: 'That backup was made by a newer version of the app. Update the app first, then try again.',
  };
  const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;

  function lastBackupAt() {
    try { return Number(localStorage.getItem(LAST_BACKUP_KEY)) || 0; } catch { return 0; }
  }

  function renderBackupInfo() {
    const last = lastBackupAt();
    const changed = notes.filter((n) => n.updatedAt > last).length;
    let text;
    let kind = '';
    if (!notes.length) {
      text = 'Nothing to back up yet.';
    } else if (!last) {
      text = 'No backup yet. Press Back up to save a copy of your notes.';
      kind = 'warn';
    } else if (changed) {
      text = `Last backup: ${shortDateTime(last)}. ${plural(changed, 'note')} changed since.`;
      kind = 'warn';
    } else {
      text = `Last backup: ${shortDateTime(last)}. Everything is backed up.`;
    }
    els.backupInfo.textContent = text;
    els.backupInfo.dataset.kind = kind;
  }

  function backupNotes() {
    if (!window.VoiceBackup) { toast('The backup code did not load. Reload the page and try again.'); return; }
    saveCurrent();
    if (!notes.length) { toast('You have no saved notes to back up yet.'); return; }
    const stamp = new Date().toISOString().slice(0, 10);
    const json = JSON.stringify(VoiceBackup.build(notes), null, 2);
    saveBlob(new Blob([json], { type: 'application/json' }), `Voice notes backup ${stamp}.json`);
    try { localStorage.setItem(LAST_BACKUP_KEY, String(Date.now())); } catch { /* ignore */ }
    renderBackupInfo();
    toast(`Backed up ${plural(notes.length, 'note')}. Keep the file somewhere safe.`);
  }

  async function restoreFromFile(file) {
    if (!file || state === 'starting') return;
    if (!window.VoiceBackup) { toast('The backup code did not load. Reload the page and try again.'); return; }
    if (file.size > 20 * 1024 * 1024) { toast('That file is too big to be a Voice Notes backup.'); return; }
    let text;
    try { text = await file.text(); } catch { toast('Could not read that file.'); return; }
    const parsed = VoiceBackup.parse(text);
    if (parsed.error) { toast(BACKUP_ERRORS[parsed.error]); return; }
    if (!parsed.notes.length) { toast('That backup has no notes in it.'); return; }

    // Show what would happen first. Nothing changes (and no recording is stopped) until they agree.
    const preview = VoiceBackup.plan(notes, parsed.notes);
    if (!preview.add.length && !preview.update.length) {
      toast(`Nothing to restore: all ${plural(parsed.notes.length, 'note')} in that backup are already here, or were edited more recently here.`);
      return;
    }
    const made = Date.parse(parsed.exportedAt);
    const lines = [
      `This backup has ${plural(parsed.notes.length, 'note')}${made ? `, made ${shortDateTime(made)}` : ''}.`,
      '',
      `• ${preview.add.length} will be added`,
      `• ${preview.update.length} will replace an older copy here`,
      `• ${preview.keep.length} are already here and stay as they are`,
      '',
      'Nothing is deleted, and audio recordings are not affected.',
    ];
    if (parsed.skipped) lines.push(`(${plural(parsed.skipped, 'damaged entry', 'damaged entries')} in the file will be ignored.)`);
    lines.push('', 'Restore now?');
    if (!confirm(lines.join('\n'))) return;

    await settle(); // stop any recording and save what is on screen, then plan again on the latest data
    const p = VoiceBackup.plan(notes, parsed.notes);
    const updates = new Map(p.update.map((n) => [n.id, n]));
    const next = notes.map((n) => (updates.has(n.id) ? { ...updates.get(n.id), audioClips: n.audioClips || 0 } : n));
    p.add.forEach((n) => next.push({ ...n, audioClips: 0 }));
    const before = notes;
    notes = next;
    if (!persistNotes()) {
      notes = before;
      toast('Could not restore: browser storage is full or blocked.');
      return;
    }
    if (updates.has(current.id)) { // the note on screen was replaced: show the restored version
      current = { ...notes.find((n) => n.id === current.id), fresh: false, titleEdited: true };
      fillInputs();
      renderAudio();
    }
    renderList();
    toast(`Restored: ${p.add.length} added, ${p.update.length} updated.`);
  }

  // ---------------------------------------------------------------- Word export
  async function downloadDoc(doc, fileName) {
    saveBlob(await docx.Packer.toBlob(doc), fileName);
  }

  function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function exportReady() {
    if (window.docx && window.VoiceExport) return true;
    toast('The Word export library did not load. Start the app with "npm start" and open http://localhost:3000.');
    return false;
  }

  async function exportCurrent() {
    if (!exportReady()) return;
    saveCurrent();
    if (!current.text.trim()) { toast('There is no text in this note to export yet.'); return; }
    try {
      await downloadDoc(VoiceExport.buildNoteDocument(current), `${safeFileName(current.title)}.docx`);
    } catch (err) {
      toast(`Export failed: ${err.message}`);
    }
  }

  async function exportAll() {
    if (!exportReady()) return;
    saveCurrent();
    if (!notes.length) { toast('You have no saved notes to export yet.'); return; }
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      await downloadDoc(VoiceExport.buildAllNotesDocument(notes), `Voice notes ${stamp}.docx`);
    } catch (err) {
      toast(`Export failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- wiring
  els.recordBtn.addEventListener('click', () => {
    if (state === 'recording') stopRecording(); else startRecording();
  });

  els.title.addEventListener('input', () => { current.titleEdited = true; scheduleSave(); });
  els.title.addEventListener('blur', () => {
    if (!els.title.value.trim()) {
      current.titleEdited = false;
      els.title.value = shortDateTime(current.createdAt);
      scheduleSave();
    }
  });
  els.body.addEventListener('input', () => {
    if (els.body.value.trim()) markStarted();
    updateWordCount();
    refreshStale();
    scheduleSave();
    if (state === 'recording') renderLive();
  });

  // iPhones usually can't record audio and run speech recognition at the same time (the mic can only
  // be used once), so there the audio option starts off unless the user has chosen otherwise.
  let audioPref = null;
  try { audioPref = localStorage.getItem(SAVE_AUDIO_KEY); } catch { /* ignore */ }
  els.saveAudio.checked = audioPref ? audioPref === 'yes' : !isIOS;
  if (isIOS) {
    const hint = document.createElement('p');
    hint.className = 'foot';
    hint.textContent = 'On iPhone, saving audio can stop the speech-to-text from working, so it starts off. You can tick it to try.';
    els.saveAudio.closest('.recorder').append(hint);
  }
  els.saveAudio.addEventListener('change', () => {
    try { localStorage.setItem(SAVE_AUDIO_KEY, els.saveAudio.checked ? 'yes' : 'no'); } catch { /* ignore */ }
  });

  els.summariseBtn.addEventListener('click', summarise);
  els.refreshModels.addEventListener('click', loadModels);
  els.modelSelect.addEventListener('change', () => {
    try { localStorage.setItem(MODEL_KEY, els.modelSelect.value); } catch { /* ignore */ }
  });
  els.summaryBody.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="remove-summary"]')) removeSummary();
  });

  els.newBtn.addEventListener('click', newNote);
  els.exportOneBtn.addEventListener('click', exportCurrent);
  els.exportAllBtn.addEventListener('click', exportAll);
  els.backupBtn.addEventListener('click', backupNotes);
  els.restoreFile.addEventListener('change', () => {
    const file = els.restoreFile.files[0];
    els.restoreFile.value = ''; // so choosing the same file again still triggers a change
    restoreFromFile(file);
  });

  els.noteList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'open') openNote(btn.dataset.id);
    else if (btn.dataset.action === 'delete') deleteNote(btn.dataset.id);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state === 'recording' || state === 'stopping') { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', saveCurrent);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveCurrent(); });

  // ---------------------------------------------------------------- start up
  const problems = [];
  if (!getSR()) {
    problems.push('This browser cannot turn speech into text. Please open this page in Google Chrome or Microsoft Edge. You can still type, save and export notes here.');
  }
  if (!window.isSecureContext) {
    problems.push('Open the app at http://localhost:3000 (not a network address) or the microphone will not work.');
  }
  if (problems.length) {
    els.banner.textContent = problems.join(' ');
    els.banner.hidden = false;
  }

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // Lets the app open offline once it has been visited (needs https, or localhost).
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode is a bonus, not essential */ });
  }

  fillInputs();
  renderList();
  renderLive();
  updateUI();
  renderModelSelect();
  loadModels(); // just checks what Ollama has; nothing is summarised until you press the button
})();
