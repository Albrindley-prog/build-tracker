// Backup file format and restore rules. Pure functions (no page access) so they can be tested in Node.
// A backup holds notes and summaries only, not audio recordings.
(function (root) {
  'use strict';

  const FORMAT = 'voice-notes-backup';
  const VERSION = 1;

  // notes: the app's saved notes. Returns a plain object ready for JSON.stringify.
  function build(notes, now = Date.now()) {
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date(now).toISOString(),
      about: 'Voice Notes backup. Contains notes and summaries only; audio recordings are not included.',
      notes: notes.map((n) => ({
        id: n.id,
        title: n.title,
        text: n.text,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        summary: n.summary || null,
      })),
    };
  }

  function cleanSummary(s) {
    if (!s || typeof s !== 'object' || typeof s.text !== 'string' || !s.text.trim()) return null;
    return {
      text: s.text,
      actions: Array.isArray(s.actions) ? s.actions.filter((a) => typeof a === 'string' && a.trim()) : [],
      model: typeof s.model === 'string' ? s.model : '',
      at: Number.isFinite(s.at) ? s.at : 0,
      hash: typeof s.hash === 'string' ? s.hash : '',
    };
  }

  // jsonText: contents of a chosen file. Never trusts it: every field is checked and rebuilt.
  // -> { error: 'not_json' | 'not_backup' | 'too_new' } or { notes, skipped, exportedAt }
  function parse(jsonText) {
    let data;
    try { data = JSON.parse(jsonText); } catch { return { error: 'not_json' }; }
    if (!data || typeof data !== 'object' || data.format !== FORMAT || !Array.isArray(data.notes)) {
      return { error: 'not_backup' };
    }
    if (typeof data.version === 'number' && data.version > VERSION) return { error: 'too_new' };

    const notes = [];
    const seen = new Set();
    let skipped = 0;
    for (const n of data.notes) {
      const usable = n && typeof n === 'object'
        && typeof n.id === 'string' && n.id.length > 0 && n.id.length <= 100
        && typeof n.text === 'string' && !seen.has(n.id);
      if (!usable) { skipped++; continue; }
      seen.add(n.id);
      const createdAt = Number.isFinite(n.createdAt) ? n.createdAt : (Number.isFinite(n.updatedAt) ? n.updatedAt : Date.now());
      notes.push({
        id: n.id,
        title: typeof n.title === 'string' && n.title.trim() ? n.title.slice(0, 200) : 'Untitled note',
        text: n.text,
        createdAt,
        updatedAt: Number.isFinite(n.updatedAt) ? n.updatedAt : createdAt,
        summary: cleanSummary(n.summary),
      });
    }
    return { notes, skipped, exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '' };
  }

  // Which backup notes would be added, would replace an older copy here, or are left alone.
  // Nothing is ever deleted, and a note edited more recently here is never overwritten.
  function plan(existing, incoming) {
    const byId = new Map(existing.map((n) => [n.id, n]));
    const add = [];
    const update = [];
    const keep = [];
    for (const inc of incoming) {
      const cur = byId.get(inc.id);
      if (!cur) add.push(inc);
      else if (inc.updatedAt > (cur.updatedAt || 0)) update.push(inc);
      else keep.push(inc);
    }
    return { add, update, keep };
  }

  root.VoiceBackup = { build, parse, plan, FORMAT, VERSION };
})(typeof globalThis !== 'undefined' ? globalThis : window);
