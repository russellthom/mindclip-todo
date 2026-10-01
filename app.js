/* Mindclip To-Do — single-page app, no build step.
   Data lives in a PRIVATE GitHub repo; this file contains no personal data. */
(function () {
  'use strict';

  var OWNER = 'russellthom';
  var REPO = 'mindclip-todos-data';
  var PATH = 'todos.json';
  var BRANCH = 'main';
  var API = 'https://api.github.com/repos/' + OWNER + '/' + REPO;
  var LS = { token: 'mct_token', cache: 'mct_cache', ui: 'mct_ui' };
  var SAVE_DELAY = 1200;
  var LISTS = ['work', 'personal', 'waiting'];
  var PRI = { High: 0, Med: 1, Medium: 1, Low: 2 };

  var state = {
    token: null,
    doc: null,
    sha: null,
    pending: new Set(),   // ids edited locally, not yet saved
    deleted: new Set(),   // ids deleted locally, not yet saved
    version: 0,           // bumps on each local edit
    saving: false,
    again: false,
    timer: null,
    lastFetch: 0,
    tab: 'work',
    filter: 'open',
    q: '',
    editing: null         // {list, item, isNew}
  };

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  // ---------- utils ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nowIso() { return new Date().toISOString(); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function isIsoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }
  function uid() {
    var a = new Uint8Array(5);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function b64decodeUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function b64encodeUtf8(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function fmtDate(s) {
    if (!isIsoDate(s)) return s || '';
    var p = s.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    var opts = { month: 'short', day: 'numeric', weekday: 'short' };
    if (p[0] !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }
  function daysBetween(a, b) {
    var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }
  function isOverdue(it) { return !it.done && isIsoDate(it.due) && it.due < todayStr(); }
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 2500);
  }
  function emptyDoc() { return { updated: nowIso(), lists: { work: [], personal: [], waiting: [] } }; }
  function normalize(doc) {
    doc = doc && typeof doc === 'object' ? doc : emptyDoc();
    doc.lists = doc.lists || {};
    LISTS.forEach(function (k) { if (!Array.isArray(doc.lists[k])) doc.lists[k] = []; });
    Object.keys(doc.lists).forEach(function (k) {
      doc.lists[k].forEach(function (it) {
        if (!it.id) it.id = uid();
        if (typeof it.done !== 'boolean') it.done = String(it.status || '').toLowerCase() === 'done';
      });
    });
    return doc;
  }

  // ---------- local cache (this device only) ----------
  function saveCache() {
    try {
      localStorage.setItem(LS.cache, JSON.stringify({
        doc: state.doc, sha: state.sha,
        pending: Array.from(state.pending), deleted: Array.from(state.deleted)
      }));
    } catch (e) { /* quota; ignore */ }
  }
  function loadCache() {
    try {
      var c = JSON.parse(localStorage.getItem(LS.cache) || 'null');
      if (c && c.doc) {
        state.doc = normalize(c.doc); state.sha = c.sha || null;
        state.pending = new Set(c.pending || []); state.deleted = new Set(c.deleted || []);
        return true;
      }
    } catch (e) { }
    return false;
  }
  function saveUi() {
    try { localStorage.setItem(LS.ui, JSON.stringify({ tab: state.tab, filter: state.filter })); } catch (e) { }
  }
  function loadUi() {
    try {
      var u = JSON.parse(localStorage.getItem(LS.ui) || '{}');
      if (LISTS.indexOf(u.tab) >= 0) state.tab = u.tab;
      if (['open', 'done', 'all'].indexOf(u.filter) >= 0) state.filter = u.filter;
    } catch (e) { }
  }

  // ---------- GitHub API ----------
  function gh(method, url, body) {
    var opts = {
      method: method,
      cache: 'no-store',
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + state.token }
    };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts);
  }
  function apiError(res, data) {
    var e = new Error((data && data.message) || ('HTTP ' + res.status));
    e.status = res.status;
    return e;
  }
  // Returns {doc, sha} ; doc=null if the file does not exist yet.
  async function fetchRemote() {
    var res = await gh('GET', API + '/contents/' + PATH + '?ref=' + BRANCH + '&_=' + Date.now());
    if (res.status === 404) {
      // Either the file is missing or the token can't see the repo. Distinguish via repo endpoint.
      var r2 = await gh('GET', API);
      if (r2.status === 404 || r2.status === 403) {
        var e = new Error('Token cannot access ' + OWNER + '/' + REPO + '. Check repository access and Contents permission.');
        e.status = 404; throw e;
      }
      return { doc: null, sha: null };
    }
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) throw apiError(res, data);
    var text;
    if (data.content && data.encoding === 'base64') {
      text = b64decodeUtf8(data.content);
    } else {
      // >1 MB files: fetch blob
      var br = await gh('GET', API + '/git/blobs/' + data.sha);
      var bd = await br.json();
      if (!br.ok) throw apiError(br, bd);
      text = b64decodeUtf8(bd.content);
    }
    return { doc: normalize(JSON.parse(text)), sha: data.sha };
  }

  // Merge remote into local: last edit wins per item (by `edited`).
  function merge(remote, local) {
    if (!remote) return local;
    if (!local) return remote;
    var out = { updated: remote.updated, lists: {} };
    var keys = Object.keys(remote.lists).concat(Object.keys(local.lists).filter(function (k) { return !(k in remote.lists); }));
    keys.forEach(function (k) {
      var r = remote.lists[k] || [], l = local.lists[k] || [];
      var lmap = {}; l.forEach(function (it) { lmap[it.id] = it; });
      var rids = {};
      var res = [];
      r.forEach(function (ri) {
        rids[ri.id] = true;
        if (state.deleted.has(ri.id)) return;               // deleted here
        var li = lmap[ri.id];
        if (li && state.pending.has(ri.id)) {
          res.push(String(li.edited || '') >= String(ri.edited || '') ? li : ri);
        } else {
          res.push(ri);                                        // take remote version
        }
      });
      l.forEach(function (li) {
        if (!rids[li.id] && state.pending.has(li.id)) res.push(li); // new here
        // local-only and not pending => deleted elsewhere; drop
      });
      out.lists[k] = res;
    });
    return normalize(out);
  }

  async function load(quiet) {
    if (!quiet) setStatus('loading', 'Loading…');
    try {
      var r = await fetchRemote();
      state.lastFetch = Date.now();
      var hasLocalChanges = state.pending.size || state.deleted.size;
      if (!r.doc) {
        state.doc = state.doc || emptyDoc();
        state.sha = null;
        render(); saveCache();
        scheduleSave(0);
        return true;
      }
      state.doc = hasLocalChanges ? merge(r.doc, state.doc) : r.doc;
      state.sha = r.sha;
      saveCache();
      render();
      if (hasLocalChanges) scheduleSave(0); else setStatus('saved', 'Up to date');
      return true;
    } catch (e) {
      handleError(e, 'Load failed');
      return false;
    }
  }

  function handleError(e, prefix) {
    console.error(e);
    if (e.status === 401) {
      setStatus('error', 'Token rejected');
      toast('GitHub rejected the token (expired or revoked). Sign out and connect a new one.', 5000);
    } else if (e.status === 404 || e.status === 403) {
      setStatus('error', 'No access');
      toast(e.message, 5000);
    } else if (!navigator.onLine) {
      setStatus('error', 'Offline – not saved');
    } else {
      setStatus('error', prefix + ': ' + e.message);
    }
  }

  function scheduleSave(delay) {
    clearTimeout(state.timer);
    setStatus('saving', 'Saving…');
    state.timer = setTimeout(save, delay == null ? SAVE_DELAY : delay);
  }

  async function save() {
    clearTimeout(state.timer); state.timer = null;
    if (state.saving) { state.again = true; return; }
    if (!state.pending.size && !state.deleted.size && state.sha) { setStatus('saved', 'Saved'); return; }
    state.saving = true; state.again = false;
    setStatus('saving', 'Saving…');
    var v = state.version;
    try {
      for (var attempt = 0; attempt < 5; attempt++) {
        state.doc.updated = nowIso();
        var body = {
          message: 'Update todos from app (' + (navigator.platform || 'web') + ')',
          content: b64encodeUtf8(JSON.stringify(state.doc, null, 1)),
          branch: BRANCH
        };
        if (state.sha) body.sha = state.sha;
        var res = await gh('PUT', API + '/contents/' + PATH, body);
        var data = await res.json().catch(function () { return null; });
        if (res.ok) {
          state.sha = data.content.sha;
          if (state.version === v) { state.pending.clear(); state.deleted.clear(); }
          else state.again = true;
          saveCache();
          setStatus('saved', 'Saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
          return;
        }
        if (res.status === 409 || res.status === 422) {
          // sha conflict: someone else saved. Refetch, merge, retry.
          var r = await fetchRemote();
          state.doc = r.doc ? merge(r.doc, state.doc) : state.doc;
          state.sha = r.sha;
          render();
          await new Promise(function (ok) { setTimeout(ok, 300 * (attempt + 1)); });
          continue;
        }
        throw apiError(res, data);
      }
      throw new Error('Too many conflicts, will retry');
    } catch (e) {
      handleError(e, 'Save failed');
      saveCache();
      // auto-retry later if transient
      if (e.status !== 401 && e.status !== 404 && e.status !== 403) {
        clearTimeout(state.retryTimer);
        state.retryTimer = setTimeout(function () { if (state.pending.size || state.deleted.size) save(); }, 15000);
      }
    } finally {
      state.saving = false;
      if (state.again) scheduleSave(300);
    }
  }

  function markEdited(item) {
    item.edited = nowIso();
    state.pending.add(item.id);
    state.version++;
    saveCache();
    scheduleSave();
  }

  // ---------- status indicator ----------
  function setStatus(kind, text) {
    var el = $('#saveStatus');
    el.className = 'save-status ' + kind;
    el.textContent = text;
    el.title = text;
  }

  // ---------- rendering ----------
  function sortItems(a, b, listKey) {
    if (a.done !== b.done) return a.done ? 1 : -1;
    var da = a.due || (listKey === 'waiting' ? a.since : '') || '';
    var db = b.due || (listKey === 'waiting' ? b.since : '') || '';
    var ia = isIsoDate(da), ib = isIsoDate(db);
    if (ia && ib && da !== db) return da < db ? -1 : 1;
    if (ia !== ib) return ia ? -1 : 1;           // blank / unparseable due last
    if (!ia && !ib && da !== db) { if (!da) return 1; if (!db) return -1; }
    var pa = a.priority in PRI ? PRI[a.priority] : 3, pb = b.priority in PRI ? PRI[b.priority] : 3;
    if (pa !== pb) return pa - pb;
    return String(a.task || '').localeCompare(String(b.task || ''));
  }

  function render() {
    if (!state.doc) return;
    var key = state.tab;
    $$('.tab').forEach(function (t) {
      var k = t.dataset.list, items = state.doc.lists[k] || [];
      t.classList.toggle('active', k === key);
      t.setAttribute('aria-selected', k === key);
      var open = items.filter(function (i) { return !i.done; }).length;
      var od = items.filter(isOverdue).length;
      t.querySelector('.count').textContent = open + (od ? ' · ' + od + '!' : '');
    });
    $$('.seg button').forEach(function (b) { b.classList.toggle('active', b.dataset.filter === state.filter); });

    var q = state.q.trim().toLowerCase();
    var items = (state.doc.lists[key] || []).filter(function (it) {
      if (state.filter === 'open' && it.done) return false;
      if (state.filter === 'done' && !it.done) return false;
      if (q) {
        var hay = [it.task, it.project, it.notes, it.person, it.status].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) { return sortItems(a, b, key); });

    var today = todayStr();
    var html = items.map(function (it) {
      var od = isOverdue(it);
      var chips = [];
      if (it.status && it.status !== 'Open' && it.status !== 'Done') chips.push('<span class="chip st-' + esc(it.status) + '">' + esc(it.status) + '</span>');
      if (it.priority) chips.push('<span class="chip p-' + esc(it.priority) + '">' + esc(it.priority) + '</span>');
      if (it.due) {
        if (od) chips.push('<span class="chip overdue">Overdue ' + daysBetween(it.due, today) + 'd · ' + esc(fmtDate(it.due)) + '</span>');
        else if (it.due === today && !it.done) chips.push('<span class="chip overdue" style="background:var(--warn);color:#000">Today</span>');
        else chips.push('<span class="chip">Due ' + esc(fmtDate(it.due)) + '</span>');
      }
      if (it.person) chips.push('<span class="chip">' + esc(it.person) + '</span>');
      if (key === 'waiting' && it.since) chips.push('<span>since ' + esc(fmtDate(it.since)) + '</span>');
      if (it.project) chips.push('<span>' + esc(it.project) + '</span>');
      return '<li class="item' + (it.done ? ' done' : '') + (od ? ' overdue' : '') +
        (it.status === 'Check' ? ' status-check' : '') + '" data-id="' + esc(it.id) + '">' +
        '<button class="check" aria-label="' + (it.done ? 'Mark not done' : 'Mark done') + '"><span>&#10003;</span></button>' +
        '<div class="body"><div class="title">' + esc(it.task || '(untitled)') + '</div>' +
        '<div class="meta-line">' + chips.join('') + '</div></div></li>';
    }).join('');
    $('#list').innerHTML = html;
    $('#empty').classList.toggle('hidden', items.length > 0);
  }

  function findItem(id) {
    var list = state.doc.lists[state.tab] || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // ---------- editor ----------
  function openEditor(item, isNew) {
    var f = $('#editForm');
    var key = state.tab;
    state.editing = { list: key, item: item, isNew: isNew };
    $('#editTitle').textContent = isNew ? 'New item' : 'Edit';
    f.task.value = item.task || '';
    f.person.value = item.person || '';
    // keep any non-standard status value selectable
    var sel = f.status;
    Array.prototype.slice.call(sel.options).forEach(function (o) { if (o.dataset.extra) o.remove(); });
    if (item.status && ['Open', 'Check', 'Done'].indexOf(item.status) < 0) {
      var o = new Option(item.status, item.status); o.dataset.extra = '1'; sel.add(o);
    }
    sel.value = item.status || (item.done ? 'Done' : 'Open');
    f.priority.value = item.priority || '';
    f.due.value = isIsoDate(item.due) ? item.due : '';
    f.since.value = isIsoDate(item.since) ? item.since : '';
    var raw = $('.due-raw');
    if (item.due && !isIsoDate(item.due)) { raw.textContent = 'Original due text: "' + item.due + '" (kept unless you pick a date)'; raw.classList.remove('hidden'); }
    else raw.classList.add('hidden');
    f.project.value = item.project || '';
    f.notes.value = item.notes || '';
    var isWaiting = key === 'waiting';
    $('.f-person').classList.toggle('hidden', !isWaiting);
    $('.f-since').classList.toggle('hidden', !isWaiting);
    var meta = [];
    if (item.source) meta.push('<div><b>Source:</b> ' + esc(item.source) + '</div>');
    if (item.timestamp) meta.push('<div><b>Timestamp:</b> ' + esc(item.timestamp) + '</div>');
    if (item.added) meta.push('<div><b>Added:</b> ' + esc(item.added) + '</div>');
    if (item.edited) meta.push('<div><b>Last edited:</b> ' + esc(new Date(item.edited).toLocaleString()) + '</div>');
    $('.meta').classList.toggle('hidden', !meta.length);
    $('.meta-body').innerHTML = meta.join('');
    $('#deleteBtn').classList.toggle('hidden', isNew);
    $('#editor').classList.remove('hidden');
    if (isNew) setTimeout(function () { f.task.focus(); }, 50);
  }
  function closeEditor() { $('#editor').classList.add('hidden'); state.editing = null; }

  function submitEditor(ev) {
    ev.preventDefault();
    var ed = state.editing; if (!ed) return;
    var f = $('#editForm'), it = ed.item;
    if (!ed.isNew) {
      // the doc may have been replaced by a background merge; edit the live object
      var live = (state.doc.lists[ed.list] || []).filter(function (x) { return x.id === it.id; })[0];
      if (!live) { closeEditor(); render(); toast('That item was deleted on another device.'); return; }
      it = live;
    }
    var task = f.task.value.trim();
    if (!task) { f.task.focus(); return; }
    var before = JSON.stringify(it);
    it.task = task;
    if (ed.list === 'waiting') {
      it.person = f.person.value.trim();
      if (f.since.value) it.since = f.since.value;
    }
    it.status = f.status.value;
    it.done = it.status.toLowerCase() === 'done';
    it.priority = f.priority.value;
    if (f.due.value) it.due = f.due.value;
    else if (isIsoDate(it.due) || !it.due) it.due = '';
    it.project = f.project.value.trim();
    it.notes = f.notes.value.trim();
    if (ed.isNew) {
      it.added = todayStr();
      if (ed.list === 'waiting' && !it.since) it.since = it.added;
      state.doc.lists[ed.list].push(it);
      markEdited(it);
    } else if (JSON.stringify(it) !== before) {
      markEdited(it);
    }
    closeEditor();
    render();
  }

  function deleteCurrent() {
    var ed = state.editing; if (!ed || ed.isNew) return;
    if (!confirm('Delete this item?\n\n' + (ed.item.task || ''))) return;
    var list = state.doc.lists[ed.list];
    var i = -1;
    for (var j = 0; j < list.length; j++) if (list[j].id === ed.item.id) { i = j; break; }
    if (i >= 0) list.splice(i, 1);
    state.pending.delete(ed.item.id);
    state.deleted.add(ed.item.id);
    state.version++;
    saveCache();
    closeEditor();
    render();
    scheduleSave();
    toast('Deleted');
  }

  function newItem() {
    var it = { id: uid(), status: 'Open', priority: state.tab === 'waiting' ? '' : 'Med', due: '', task: '', project: '',
      source: 'Added in app', timestamp: '', notes: '', added: todayStr(), done: false, edited: nowIso() };
    if (state.tab === 'waiting') { it.person = ''; it.since = todayStr(); }
    openEditor(it, true);
  }

  // ---------- screens ----------
  function showLogin(msg) {
    $('#main').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#loginError').textContent = msg || '';
  }
  async function showMain() {
    $('#login').classList.add('hidden');
    $('#main').classList.remove('hidden');
    if (state.doc) render();
    await load(!!state.doc);
  }

  async function onLogin(ev) {
    ev.preventDefault();
    var t = $('#tokenInput').value.trim();
    if (!t) return;
    state.token = t;
    $('#loginError').textContent = 'Checking…';
    try {
      var r = await fetchRemote();
      localStorage.setItem(LS.token, t);
      $('#tokenInput').value = '';
      state.doc = r.doc; state.sha = r.sha; state.pending.clear(); state.deleted.clear();
      saveCache();
      $('#loginError').textContent = '';
      showMain();
    } catch (e) {
      state.token = null;
      $('#loginError').textContent = e.status === 401 ? 'GitHub rejected that token. Copy it again and paste the whole thing.'
        : (e.message || 'Could not connect.');
    }
  }

  function signOut() {
    var unsaved = state.pending.size || state.deleted.size;
    if (!confirm((unsaved ? 'You have UNSAVED changes that will be lost.\n\n' : '') +
      'Forget the GitHub token and cached list on this device?')) return;
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.cache);
    state.token = null; state.doc = null; state.sha = null;
    state.pending.clear(); state.deleted.clear();
    $('#menu').classList.add('hidden');
    $('#list').innerHTML = '';
    showLogin('Signed out. Token removed from this device.');
  }

  function exportJson() {
    var blob = new Blob([JSON.stringify(state.doc, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'todos-' + todayStr() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // ---------- events ----------
  function bind() {
    $('#loginForm').addEventListener('submit', onLogin);
    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () { state.tab = t.dataset.list; saveUi(); render(); window.scrollTo(0, 0); });
    });
    $$('.seg button').forEach(function (b) {
      b.addEventListener('click', function () { state.filter = b.dataset.filter; saveUi(); render(); });
    });
    $('#search').addEventListener('input', function (e) { state.q = e.target.value; render(); });
    $('#list').addEventListener('click', function (e) {
      var li = e.target.closest('.item'); if (!li) return;
      var it = findItem(li.dataset.id); if (!it) return;
      if (e.target.closest('.check')) {
        it.done = !it.done;
        it.status = it.done ? 'Done' : 'Open';
        markEdited(it);
        render();
        if (it.done && state.filter === 'open') toast('Marked done');
      } else {
        openEditor(it, false);
      }
    });
    $('#addBtn').addEventListener('click', newItem);
    $('#editForm').addEventListener('submit', submitEditor);
    $('#cancelEdit').addEventListener('click', closeEditor);
    $('#deleteBtn').addEventListener('click', deleteCurrent);
    $('#editor').addEventListener('click', function (e) { if (e.target.id === 'editor') closeEditor(); });
    $('#refreshBtn').addEventListener('click', function () {
      if (state.pending.size || state.deleted.size) save(); else load(false);
    });
    $('#menuBtn').addEventListener('click', function () {
      var n = 0; LISTS.forEach(function (k) { n += (state.doc && state.doc.lists[k] || []).length; });
      $('#menuInfo').textContent = 'Data: ' + OWNER + '/' + REPO + ' (private) · ' + n + ' items' +
        (state.doc && state.doc.updated ? ' · updated ' + new Date(state.doc.updated).toLocaleString() : '');
      $('#menu').classList.remove('hidden');
    });
    $('#closeMenu').addEventListener('click', function () { $('#menu').classList.add('hidden'); });
    $('#menu').addEventListener('click', function (e) { if (e.target.id === 'menu') $('#menu').classList.add('hidden'); });
    $('#signOutBtn').addEventListener('click', signOut);
    $('#exportBtn').addEventListener('click', exportJson);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeEditor(); $('#menu').classList.add('hidden'); }
    });
    document.addEventListener('visibilitychange', function () {
      if (!state.token) return;
      if (document.visibilityState === 'hidden') {
        if (state.timer) save();                       // flush pending save
      } else if (!state.saving && !state.timer && Date.now() - state.lastFetch > 20000) {
        load(true);                                    // pick up edits from other devices
      }
    });
    window.addEventListener('pagehide', function () { if (state.timer) save(); });
    window.addEventListener('online', function () { if (state.token && (state.pending.size || state.deleted.size)) save(); });
    window.addEventListener('beforeunload', function (e) {
      if (state.pending.size || state.deleted.size) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function init() {
    loadUi();
    bind();
    state.token = localStorage.getItem(LS.token);
    if (state.token) { loadCache(); showMain(); }
    else showLogin();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
