'use strict';
/* 1041GR Daily Report — offline-first field reporting
   Supabase project: pgs-1041gr-reporting. Static site; no build step. */

const APP_VERSION = '1.3.1';
const INACTIVE_DAYS = 14;        // sign in again after this many days without opening the app
const LAST_ACTIVE_KEY = 'gr1041-last-active';
const SB_URL = 'https://alevpanognwhxmrnnrfy.supabase.co';
const SB_KEY = 'sb_publishable_MlooM73Te-qosUTJfXXIpw_ECOTAqtl';
const AUTH_KEY = 'gr1041-auth';
const PROJECT_CODE = '1041GR';
const RAG = { 1: 'Red: not done / behind', 2: 'Amber: in progress / partly done', 3: 'Green: done / on track' };
const RAG_SHORT = { 1: 'Red', 2: 'Amber', 3: 'Green' };

const sb = window.supabase.createClient(SB_URL, SB_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: AUTH_KEY }
});

/* ---------------- small helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); const dt = new Date(y, m - 1, d); return `${DAYS[dt.getDay()]} ${d} ${MONTHS[m - 1]} ${y}`; };
const fmtTime = ts => { if (!ts) return ''; const d = new Date(ts); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const num = v => (v === '' || v === null || v === undefined || isNaN(+v)) ? null : +v;
const fmtNum = v => v === null || v === undefined ? '–' : (Math.round(v * 100) / 100).toLocaleString('en');
const errMsg = e => (e && (e.message || e.error_description || e.error)) || String(e);
function toast(msg, ms = 3500) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), ms); }
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('network timeout')), ms))]); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------------- IndexedDB ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('gr1041', 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        db.createObjectStore('kv');
        db.createObjectStore('reports', { keyPath: 'id' });
        const ph = db.createObjectStore('photos', { keyPath: 'id' });
        ph.createIndex('report_id', 'report_id');
      };
      rq.onsuccess = () => { DB.db = rq.result; res(); };
      rq.onerror = () => rej(rq.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode); const s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get: (st, k) => DB.tx(st, 'readonly', s => s.get(k)),
  all: (st) => DB.tx(st, 'readonly', s => s.getAll()),
  put: (st, v, k) => DB.tx(st, 'readwrite', s => k === undefined ? s.put(v) : s.put(v, k)),
  del: (st, k) => DB.tx(st, 'readwrite', s => s.delete(k)),
  clear: (st) => DB.tx(st, 'readwrite', s => s.clear()),
};

/* ---------------- state ---------------- */
const S = {
  me: null, project: null, teams: [], kpis: [], openings: [], users: {}, reports: new Map(), photos: new Map(),
  online: navigator.onLine, syncing: false, lastSync: null, lastErr: null, authNeeded: false, swUpdate: false,
};
const isOffice = () => S.me && (S.me.role === 'admin' || S.me.role === 'supervisor');
const isAdmin = () => S.me && S.me.role === 'admin';
const teamName = id => (S.teams.find(t => t.id === id) || {}).name || 'Unknown team';
const userName = id => (S.users[id] || {}).full_name || '';
const activeKpis = () => S.kpis.filter(k => k.active).sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
const pendingCount = () => [...S.reports.values()].filter(r => r._dirty).length + [...S.photos.values()].filter(p => !p.uploaded || p.captionDirty || p.deleted).length;
const hasStoredAuth = () => { try { return !!localStorage.getItem(AUTH_KEY); } catch { return false; } };

async function saveKV(k, v) { await DB.put('kv', v, k); }
async function persistReport(r) { S.reports.set(r.id, r); await DB.put('reports', r); }
async function persistPhoto(p) { S.photos.set(p.id, p); await DB.put('photos', p); }

/* ---------------- network state ---------------- */
function renderNet() {
  const el = $('#netstate'); if (!el) return;
  const pend = pendingCount();
  let txt, cls = 'net';
  if (S.syncing) txt = 'Syncing…';
  else if (!S.online) { txt = pend ? `Offline · ${pend} waiting` : 'Offline'; cls += ' off'; }
  else if (S.authNeeded) { txt = 'Sign in to sync'; cls += ' err'; }
  else if (S.lastErr) { txt = pend ? `Sync problem · ${pend} waiting` : 'Sync problem'; cls += ' err'; }
  else txt = pend ? `${pend} waiting` : 'All sent ✓';
  el.className = cls; el.textContent = txt;
  el.title = (S.lastSync ? 'Last sync ' + fmtTime(S.lastSync) : 'Not synced yet') + (S.lastErr ? '\n' + S.lastErr : '');
  el.onclick = () => { if (S.lastErr) toast(S.lastErr, 6000); sync(); };
  const who = $('#who');
  if (who) who.innerHTML = S.me ? `${esc(S.me.full_name)} · <a href="#/me">Me</a>` : '';
}
window.addEventListener('online', () => { S.online = true; renderNet(); sync(); });
window.addEventListener('offline', () => { S.online = false; renderNet(); });

/* ---------------- boot ---------------- */
async function boot() {
  await DB.open();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) { S.swUpdate = true; route(); } });
      });
    }).catch(() => {});
  }
  S.me = await DB.get('kv', 'me') || null;
  const ref = await DB.get('kv', 'ref');
  if (ref) Object.assign(S, { project: ref.project, teams: ref.teams, kpis: ref.kpis, openings: ref.openings || [], users: ref.users || {} });
  S.lastSync = await DB.get('kv', 'lastSync') || null;
  for (const r of await DB.all('reports')) S.reports.set(r.id, r);
  for (const p of await DB.all('photos')) S.photos.set(p.id, p);

  sb.auth.onAuthStateChange((ev, session) => {
    // never await Supabase calls inside this callback (it holds the auth lock); defer instead
    if (ev === 'SIGNED_IN' && session) { S.authNeeded = false; setTimeout(() => afterSignIn(session), 0); }
  });

  // security: after INACTIVE_DAYS without use, sign in again (unsent reports stay on the phone)
  const last = +(localStorage.getItem(LAST_ACTIVE_KEY) || 0);
  if (S.me && hasStoredAuth() && last && Date.now() - last > INACTIVE_DAYS * 864e5) {
    try { await withTimeout(sb.auth.signOut({ scope: 'local' }), 3000); } catch {}
    try { localStorage.removeItem(AUTH_KEY); } catch {}
  }
  if (S.me && !hasStoredAuth()) { S.reauth = true; S.me = null; }
  markActive(true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markActive(true); });
  document.addEventListener('input', () => markActive());
  window.addEventListener('hashchange', route);
  route(); // open straight from what is on the phone; never wait for the network here
  // The session check can hang for a while offline (expired token, refresh retries), so run it in the background.
  withTimeout(sb.auth.getSession(), 6000).then(({ data }) => {
    if (data.session) afterSignIn(data.session);
    else if (S.me) { S.authNeeded = navigator.onLine; renderNet(); }
  }).catch(() => { S.online = navigator.onLine; renderNet(); });
  setInterval(() => { if (S.online && S.me) sync(); }, 120000);
}

let lastMark = 0;
function markActive(force) {
  if (!S.me && !force) return;
  const now = Date.now(); if (!force && now - lastMark < 60000) return; lastMark = now;
  try { if (S.me || !localStorage.getItem(LAST_ACTIVE_KEY)) localStorage.setItem(LAST_ACTIVE_KEY, String(now)); } catch {}
}

let signingIn = false;
async function afterSignIn(session) {
  if (signingIn) return; signingIn = true;
  try {
    const { data: me, error } = await sb.from('app_user').select('*').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    if (!me || !me.active) {
      await sb.auth.signOut(); S.me = null; await DB.del('kv', 'me');
      toast('Your account is not active for 1041GR reporting. Ask the office.', 6000); route(); return;
    }
    const prev = S.me || await DB.get('kv', 'me');
    if (prev && prev.id !== me.id) await wipeLocal(); // another person signs in on this device
    S.me = me; S.reauth = false; await saveKV('me', me); markActive(true);
    if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + '#/');
    route();
    sync();
  } catch (e) {
    const m = errMsg(e);
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) S.online = false; else S.lastErr = m;
    renderNet(); route();
  } finally { signingIn = false; }
}

async function wipeLocal() {
  await DB.clear('reports'); await DB.clear('photos'); await DB.clear('kv');
  S.reports.clear(); S.photos.clear(); S.lastSync = null;
}

/* ---------------- sync ---------------- */
let syncAgain = false;
async function sync() {
  if (!S.me) return;
  if (S.syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { S.online = false; renderNet(); return; }
  S.syncing = true; renderNet();
  try {
    S.stage = 'session'; const { data } = await withTimeout(sb.auth.getSession(), 10000);
    if (!data.session) { S.authNeeded = true; throw new Error('Your sign-in has expired. Sign in again to send your reports; nothing is lost.'); }
    S.authNeeded = false;
    S.stage = 'ref'; await loadRef();
    S.stage = 'push'; await pushReports();
    S.stage = 'photos'; await pushPhotos();
    S.stage = 'pull'; await pull();
    S.stage = 'done';
    S.lastSync = Date.now(); await saveKV('lastSync', S.lastSync);
    S.lastErr = null; S.online = true;
  } catch (e) {
    const m = errMsg(e);
    if (/Failed to fetch|NetworkError|Load failed|network|timeout/i.test(m)) { S.online = false; S.lastErr = null; }
    else S.lastErr = m;
  } finally {
    S.syncing = false; renderNet();
    if (!editingNow()) route(true);
    if (syncAgain) { syncAgain = false; setTimeout(sync, 300); }
  }
}
const editingNow = () => location.hash.startsWith('#/edit/');

async function loadRef() {
  const { data: me } = await sb.from('app_user').select('*').eq('id', S.me.id).maybeSingle();
  S.stage = 'ref:me';
  if (me) { S.me = me; await saveKV('me', me); }
  S.stage = 'ref:project';
  const { data: proj, error: pe } = await sb.from('project').select('*').eq('code', PROJECT_CODE).maybeSingle();
  if (pe) throw pe;
  if (!proj) throw new Error('Project ' + PROJECT_CODE + ' not found');
  const [{ data: teams, error: te }, { data: kpis, error: ke }, { data: users }, { data: openings, error: oe }] = await Promise.all([
    sb.from('team').select('*').eq('project_id', proj.id).order('sort'),
    sb.from('kpi').select('*').eq('project_id', proj.id).order('sort'),
    sb.from('app_user').select('id,full_name,role,team_id,active'),
    sb.from('kpi_opening').select('*'),
  ]);
  if (te) throw te; if (ke) throw ke; if (oe) throw oe;
  S.project = proj; S.teams = teams; S.kpis = kpis; S.openings = (openings || []).map(o => ({ ...o, amount: +o.amount }));
  S.users = Object.fromEntries((users || []).map(u => [u.id, u]));
  await saveKV('ref', { project: proj, teams, kpis, openings: S.openings, users: S.users });
}

function payloadOf(r) {
  return {
    id: r.id, project_id: r.project_id, team_id: r.team_id, report_date: r.report_date,
    key_info: r.key_info || '', emerging_issues: r.emerging_issues || '', quotes: r.quotes || '',
    status: r.status, base_updated_at: r.base_updated_at || null,
    kpis: (r.kpis || []).filter(k => k.planned !== null || k.actual !== null || k.not_applicable || k.rag),
    activities: (r.activities || []).filter(a => (a.activity || '').trim()),
  };
}

async function pushReports(only, force = false) {
  const list = [...S.reports.values()].filter(r => r._dirty && (only ? r.id === only : !r._conflict));
  for (const r of list) {
    const mark = r._local_updated || 0;
    const { data, error } = await sb.rpc('save_report', { p: payloadOf(r), p_force: force });
    if (error) { r._err = errMsg(error); await persistReport(r); if (/fetch|network/i.test(r._err)) throw error; continue; }
    if (data.ok) {
      // edits made while the request was in flight keep the report marked as waiting
      r.updated_at = data.updated_at; r.base_updated_at = data.updated_at; r._err = null; r._conflict = null;
      r.created_by = r.created_by || S.me.id;
      if ((r._local_updated || 0) <= mark) r._dirty = false;
      await persistReport(r);
    } else {
      r._conflict = data; r._err = null; await persistReport(r);
    }
  }
}

async function pushPhotos() {
  for (const p of [...S.photos.values()]) {
    const r = S.reports.get(p.report_id);
    if (!p.uploaded && !p.deleted && (!r || !r.updated_at)) continue; // report not on the server yet
    const path = `${p.report_id}/${p.id}.jpg`;
    if (p.deleted) {
      if (p.uploaded) {
        await sb.storage.from('report-photos').remove([path]);
        const { error } = await sb.from('report_photo').delete().eq('id', p.id); if (error) throw error;
      }
      S.photos.delete(p.id); await DB.del('photos', p.id); continue;
    }
    if (!p.uploaded) {
      const up = await sb.storage.from('report-photos').upload(path, p.blob, { contentType: 'image/jpeg', upsert: true });
      if (up.error) { p.err = errMsg(up.error); await persistPhoto(p); continue; }
      const { error } = await sb.from('report_photo').upsert({ id: p.id, report_id: p.report_id, storage_path: path, caption: p.caption || null, taken_at: p.taken_at });
      if (error) { p.err = errMsg(error); await persistPhoto(p); continue; }
      p.uploaded = true; p.captionDirty = false; p.err = null; p.blob = null; // keep only the thumbnail on the device
      await persistPhoto(p);
    } else if (p.captionDirty) {
      const { error } = await sb.from('report_photo').update({ caption: p.caption || null }).eq('id', p.id);
      if (!error) { p.captionDirty = false; await persistPhoto(p); }
    }
  }
}

async function pull() {
  const since = (await DB.get('kv', 'lastPull')) || '1970-01-01T00:00:00Z';
  const started = new Date().toISOString();
  let from = 0; const page = 200; let maxTouched = since;
  for (;;) {
    const { data, error } = await sb.from('daily_report')
      .select('*, report_kpi(*), report_activity(*), report_photo(*)')
      .eq('project_id', S.project.id).gt('touched_at', since).order('touched_at').range(from, from + page - 1);
    if (error) throw error;
    for (const row of data) {
      if (row.touched_at > maxTouched) maxTouched = row.touched_at;
      const local = S.reports.get(row.id);
      if (local && local._dirty) { local.updated_at = row.updated_at; local.locked = row.locked; await persistReport(local); continue; }
      await persistReport(fromServer(row));
      // photos taken on other devices: record them (no blob, fetched on view)
      for (const ph of row.report_photo || []) {
        if (!S.photos.has(ph.id)) await persistPhoto({ id: ph.id, report_id: row.id, caption: ph.caption, taken_at: ph.taken_at, uploaded: true, remote: true, storage_path: ph.storage_path });
        else { const lp = S.photos.get(ph.id); if (!lp.captionDirty && lp.caption !== ph.caption) { lp.caption = ph.caption; await persistPhoto(lp); } }
      }
      for (const lp of [...S.photos.values()].filter(x => x.report_id === row.id && x.uploaded && !x.deleted))
        if (!(row.report_photo || []).some(x => x.id === lp.id)) { S.photos.delete(lp.id); await DB.del('photos', lp.id); }
    }
    if (data.length < page) break;
    from += page;
  }
  // remove reports deleted on the server (e.g. replaced), keeping anything not yet sent
  const { data: ids, error: ie } = await sb.from('daily_report').select('id').eq('project_id', S.project.id);
  if (ie) throw ie;
  const live = new Set(ids.map(x => x.id));
  for (const r of [...S.reports.values()]) if (!live.has(r.id) && r.updated_at && !r._dirty) { S.reports.delete(r.id); await DB.del('reports', r.id); }
  await saveKV('lastPull', maxTouched > since ? maxTouched : since);
  void started;
}

function fromServer(row) {
  return {
    id: row.id, project_id: row.project_id, team_id: row.team_id, report_date: row.report_date,
    key_info: row.key_info || '', emerging_issues: row.emerging_issues || '', quotes: row.quotes || '',
    status: row.status, locked: row.locked, created_by: row.created_by, updated_by: row.updated_by,
    created_at: row.created_at, updated_at: row.updated_at, base_updated_at: row.updated_at, submitted_at: row.submitted_at,
    kpis: (row.report_kpi || []).map(k => ({ kpi_id: k.kpi_id, planned: num(k.planned), actual: num(k.actual), not_applicable: k.not_applicable, rag: k.rag })),
    activities: (row.report_activity || []).sort((a, b) => a.sort - b.sort).map(a => ({ kind: a.kind, activity: a.activity, rag: a.rag, comment: a.comment || '' })),
    _dirty: false, _conflict: null, _err: null,
  };
}

/* ---------------- report model helpers ---------------- */
function canEdit(r) {
  if (!S.me) return false;
  if (r.locked && !isAdmin()) return false;
  if (isOffice()) return true;
  return r.team_id === S.me.team_id;
}
// totals from before the app (Admin → Key statistics → opening total), counted for reports after their as-of date
function openingFor(teamId, kpiId, date) {
  return S.openings.filter(o => o.kpi_id === kpiId && (teamId === null || o.team_id === teamId) && (!date || date > o.as_of)).reduce((a, o) => a + o.amount, 0);
}
const hasOpening = (teamId, kpiId, date) => S.openings.some(o => o.kpi_id === kpiId && (teamId === null || o.team_id === teamId) && (!date || date > o.as_of));
// project-wide figures for one day: up to the day before, the day itself, cumulative (all teams)
function dayFigures(kpiId, date) {
  let before = openingFor(null, kpiId, date), day = 0, anyDay = false, any = hasOpening(null, kpiId, date);
  for (const x of S.reports.values()) {
    if (x.report_date > date) continue;
    const k = (x.kpis || []).find(k => k.kpi_id === kpiId);
    if (!k || k.not_applicable || k.actual === null) continue;
    any = true;
    if (x.report_date < date) before += k.actual; else { day += k.actual; anyDay = true; }
  }
  return any ? { before, day: anyDay ? day : 0, cum: before + day, anyDay } : null;
}
function cumulative(r, kpiId) {
  let s = openingFor(r.team_id, kpiId, r.report_date), any = hasOpening(r.team_id, kpiId, r.report_date);
  for (const x of S.reports.values()) {
    if (x.team_id !== r.team_id || x.report_date > r.report_date || x._replaced) continue;
    const k = (x.kpis || []).find(k => k.kpi_id === kpiId);
    if (k && !k.not_applicable && k.actual !== null) { s += k.actual; any = true; }
  }
  return any ? s : null;
}
function previousReport(teamId, date) {
  return [...S.reports.values()].filter(r => r.team_id === teamId && r.report_date < date).sort((a, b) => b.report_date.localeCompare(a.report_date))[0];
}
function findReport(teamId, date) { return [...S.reports.values()].find(r => r.team_id === teamId && r.report_date === date); }

async function newReport(teamId, date) {
  if (!S.project) { toast('The app needs signal once to download the project setup.'); sync(); return; }
  if (!teamId || !date) { toast('Choose a team and a date.'); return; }
  const existing = findReport(teamId, date);
  if (existing) { location.hash = '#/edit/' + existing.id; return; }
  const prev = previousReport(teamId, date);
  const r = {
    id: uuid(), project_id: S.project.id, team_id: teamId, report_date: date,
    key_info: '', emerging_issues: '', quotes: '', status: 'draft', locked: false,
    created_by: S.me.id, updated_at: null, base_updated_at: null,
    kpis: activeKpis().map(k => {
      const pk = prev && (prev.kpis || []).find(x => x.kpi_id === k.id);
      return { kpi_id: k.id, planned: pk ? pk.planned : null, actual: null, not_applicable: pk ? pk.not_applicable : false, rag: null };
    }),
    // yesterday's planned activities become today's "completed" list, as the template asks
    activities: prev ? prev.activities.filter(a => a.kind === 'planned').map(a => ({ kind: 'completed', activity: a.activity, rag: null, comment: '' })) : [],
    _dirty: true, _local_updated: Date.now(), _conflict: null,
  };
  if (!r.activities.length) r.activities.push({ kind: 'completed', activity: '', rag: null, comment: '' });
  r.activities.push({ kind: 'planned', activity: '', rag: null, comment: '' });
  NEW_IDS.add(r.id);
  await persistReport(r);
  location.hash = '#/edit/' + r.id;
}

/* ---------------- routing ---------------- */
function route(soft) {
  const app = $('#app'); renderNet();
  if (!S.me) { app.innerHTML = movedBanner() + viewSignIn(); bindSignIn(); return; }
  if (soft === true && editingNow()) return;
  const h = location.hash || '#/';
  const [, page, arg] = h.split('/');
  if (EDIT_OPEN && !((page === 'edit' || page === 'view') && arg === EDIT_OPEN.id)) EDIT_OPEN = null;
  let html;
  if (page === 'edit' && arg) return renderEdit(arg);
  if (page === 'view' && arg) return renderView(arg);
  if (page === 'new') html = viewNew();
  else if (page === 'admin' && isAdmin()) return renderAdmin(arg || 'people');
  else if (page === 'summary' && isOffice()) html = viewSummary();
  else if (page === 'me') html = viewMe();
  else html = viewHome();
  app.innerHTML = movedBanner() + (S.swUpdate ? `<div class="note info noprint">A new version of the app is ready. <button class="link" onclick="location.reload()">Reload now</button></div>` : '') + html;
}

// The app moved from Cloudflare Pages (direct upload) to a GitHub-deployed Worker on 17 Nov 2026.
const NEW_HOME = 'https://pgs-1041gr-daily.henk-a62.workers.dev/';
function movedBanner() {
  if (!location.hostname.endsWith('.pages.dev')) return '';
  const pend = pendingCount();
  return `<div class="note bad"><b>This app has moved to a new address.</b> ${pend ? `First connect to signal and wait until the top bar shows "All sent ✓" (${pend} item(s) still waiting on this phone). Then ` : ''}open <a href="${NEW_HOME}">${NEW_HOME.replace('https://', '').replace(/\/$/, '')}</a>, sign in and add it to your home screen. You can then remove this old icon.</div>`;
}

/* ---------------- sign-in ---------------- */
let SI = { email: '', msg: '', sent: false };
function viewSignIn() {
  const waiting = pendingCount();
  return `<div class="card" style="max-width:440px;margin:30px auto"><h3>Sign in</h3><div class="body">
  ${S.reauth ? `<p class="note info">For security, the app asks you to sign in again after ${INACTIVE_DAYS} days without use.${waiting ? ` ${waiting} item(s) not yet sent are still on this phone and will be sent once you sign in with the same email.` : ''}</p>` : ''}
  ${!SI.sent ? `<p class="small muted">Use the email address the office invited. We'll send you a sign-in code.</p>
    <form id="siForm"><label class="f">Email<input id="siEmail" type="email" autocomplete="email" required value="${esc(SI.email)}"></label>
    <div class="actions"><button class="primary" type="submit">Send code</button></div></form>
    <p class="small muted">Got a personal sign-in link from the office? Just open it on this phone.</p>`
    : `<p class="small">We sent a code to <b>${esc(SI.email)}</b>. Enter it below.</p>
    <form id="siCode"><label class="f">Code<input id="siTok" inputmode="numeric" autocomplete="one-time-code" maxlength="10" style="font-size:22px;letter-spacing:4px"></label>
    <div class="actions"><button class="primary" type="submit">Sign in</button><button type="button" id="siBack">Use another email</button></div></form>`}
  <div class="err" id="siErr">${esc(SI.msg)}</div>
  ${!navigator.onLine ? '<p class="note">You are offline. You need signal once to sign in; after that the app works offline.</p>' : ''}
  </div></div>`;
}
function bindSignIn() {
  const f = $('#siForm');
  if (f) f.onsubmit = async e => {
    e.preventDefault(); SI.email = $('#siEmail').value.trim().toLowerCase(); SI.msg = '';
    const btn = f.querySelector('button'); btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email: SI.email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
    btn.disabled = false;
    if (error) SI.msg = /Database error|not been invited|Signups not allowed/i.test(error.message) ? 'This email has not been invited yet. Ask the office to add you.' : error.message;
    else SI.sent = true;
    route();
  };
  const c = $('#siCode');
  if (c) c.onsubmit = async e => {
    e.preventDefault();
    const { error } = await sb.auth.verifyOtp({ email: SI.email, token: $('#siTok').value.trim(), type: 'email' });
    if (error) { SI.msg = 'That code did not work: ' + error.message; route(); }
  };
  const b = $('#siBack'); if (b) b.onclick = () => { SI = { email: '', msg: '', sent: false }; route(); };
}

/* ---------------- home ---------------- */
function statusPills(r) {
  let h = '';
  if (r._conflict) h += '<span class="pill p-bad">Needs attention</span> ';
  else if (r._err) h += '<span class="pill p-bad">Not sent</span> ';
  else if (r._dirty) h += '<span class="pill p-pend">Waiting to send</span> ';
  h += r.status === 'submitted' ? '<span class="pill p-sub">Submitted</span>' : '<span class="pill p-draft">Draft</span>';
  if (r.locked) h += ' <span class="pill p-lock">Locked</span>';
  return h;
}
function viewHome() {
  const mine = isOffice() ? null : S.me.team_id;
  const all = [...S.reports.values()].filter(r => !mine || r.team_id === mine).sort((a, b) => b.report_date.localeCompare(a.report_date) || teamName(a.team_id).localeCompare(teamName(b.team_id)));
  const attention = all.filter(r => r._conflict || r._err);
  const today = todayISO();
  const myToday = mine ? findReport(mine, today) : null;
  let h = '';
  if (!S.me.team_id && !isOffice()) h += `<div class="note bad">You are not assigned to a team yet. Ask the office to assign you.</div>`;
  if (isOffice()) h += `<div class="tabs"><a class="on" href="#/">Reports</a><a href="#/summary">Summary</a>${isAdmin() ? '<a href="#/admin">Admin</a>' : ''}</div>`;
  if (attention.length) h += `<div class="note bad">${attention.length} report${attention.length > 1 ? 's need' : ' needs'} your attention before it can be sent.</div>`;
  h += `<div class="actions">`;
  if (mine) h += myToday ? `<a class="btn primary" href="#/edit/${myToday.id}">Open today's report</a>` : `<button class="primary" onclick="newReport('${mine}','${today}')">Start today's report</button>`;
  h += `<a class="btn" href="#/new">Report for another day${isOffice() ? ' / team' : ''}</a></div>`;
  if (!all.length) h += `<div class="card"><div class="body muted">No reports yet${S.lastSync ? '' : ' on this device'}.</div></div>`;
  else {
    h += `<div class="card list">`;
    let lastMonth = '';
    for (const r of all.slice(0, 200)) {
      const m = r.report_date.slice(0, 7);
      if (m !== lastMonth) { lastMonth = m; h += `<div class="legend" style="font-weight:600">${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}</div>`; }
      const done = r.activities.filter(a => a.kind === 'completed' && a.activity).length;
      h += `<a class="item" href="#/${canEdit(r) && !r.locked ? 'edit' : 'view'}/${r.id}"><div class="main"><div class="t">${fmtDate(r.report_date)}</div>
        <div class="s">${esc(teamName(r.team_id))} · ${done} activit${done === 1 ? 'y' : 'ies'}${r.created_by && userName(r.created_by) ? ' · ' + esc(userName(r.created_by)) : ''}</div></div><div>${statusPills(r)}</div></a>`;
    }
    h += `</div>`;
  }
  h += `<p class="small muted">Reports are kept on this device and sent when there is signal. ${S.lastSync ? 'Last synced ' + fmtTime(S.lastSync) + '.' : ''}</p>`;
  return h;
}

function viewNew() {
  const teams = isOffice() ? S.teams.filter(t => t.active) : S.teams.filter(t => t.id === S.me.team_id);
  return `<h2>New report</h2><div class="card"><div class="body">
    <div class="row"><label class="f">Date<input id="nDate" type="date" value="${todayISO()}" max="${todayISO()}"></label>
    <label class="f">Team<select id="nTeam">${teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label></div>
    <div class="actions"><button class="primary" onclick="newReport($('#nTeam').value,$('#nDate').value)" ${teams.length ? '' : 'disabled'}>Open report</button><a class="btn" href="#/">Cancel</a></div>
    <p class="small muted">If a report for that team and day already exists on this device, it opens instead.</p></div></div>`;
}

function viewMe() {
  const pend = pendingCount();
  return `<h2>${esc(S.me.full_name)}</h2><div class="card"><div class="body">
    <p>${esc(S.me.email)}<br><span class="muted">${esc(S.me.role)}${S.me.team_id ? ' · ' + esc(teamName(S.me.team_id)) : ''}</span></p>
    <p class="small muted">App version ${APP_VERSION}. ${S.lastSync ? 'Last synced ' + fmtTime(S.lastSync) : 'Not synced yet'}.</p>
    <div class="actions"><button onclick="sync()">Sync now</button>
    <button class="danger" onclick="signOut()">Sign out</button></div>
    ${pend ? `<p class="note">${pend} item(s) are still waiting to be sent. Signing out now would delete them from this phone.</p>` : ''}
    <p class="small muted">Tip: add this page to your home screen (Share → Add to Home Screen on iPhone; ⋮ → Install app on Android) so it opens like an app, even without signal.</p>
  </div></div>`;
}
async function signOut() {
  const pend = pendingCount();
  if (pend && !confirm(`${pend} item(s) have not been sent yet and will be deleted from this phone. Sign out anyway?`)) return;
  await sb.auth.signOut().catch(() => {});
  try { localStorage.removeItem(AUTH_KEY); } catch {}
  await wipeLocal(); S.me = null; SI = { email: '', msg: '', sent: false }; location.hash = '#/'; route();
}

/* ---------------- edit ---------------- */
let ED = null; // { r, ro }
let EDIT_OPEN = null; // { id, snap, photos:Set, isNew } — state when the report was opened, for Cancel
const NEW_IDS = new Set(); // reports created on this phone in this session
const persistSoon = debounce(async () => { if (ED) { await persistReport(ED.r); renderNet(); } }, 400);
function touch() { ED.r._dirty = true; ED.r._local_updated = Date.now(); persistSoon(); }

function renderEdit(id) {
  const r = S.reports.get(id);
  if (!r) { $('#app').innerHTML = `<div class="card"><div class="body">This report is not on this device. <a href="#/">Back</a></div></div>`; return; }
  const ro = !canEdit(r);
  if (ro) { location.replace('#/view/' + id); return; }
  // make sure every active KPI has a row
  for (const k of activeKpis()) if (!r.kpis.some(x => x.kpi_id === k.id)) r.kpis.push({ kpi_id: k.id, planned: null, actual: null, not_applicable: false, rag: null });
  ED = { r };
  if (!EDIT_OPEN || EDIT_OPEN.id !== id) EDIT_OPEN = {
    id, snap: JSON.stringify(r), isNew: NEW_IDS.has(id) && !r.updated_at,
    photos: new Set([...S.photos.values()].filter(p => p.report_id === id && !p.deleted).map(p => p.id)),
  };
  const teams = isOffice() ? S.teams.filter(t => t.active || t.id === r.team_id) : S.teams.filter(t => t.id === r.team_id);
  let h = conflictBanner(r);
  h += `<div class="row" style="align-items:center;margin-bottom:10px"><h2 style="margin:0;flex:1">Daily report</h2><div>${statusPills(r)}</div></div>
  <div class="card"><div class="body"><div class="row">
    <label class="f">Date<input type="date" id="eDate" value="${r.report_date}" max="${todayISO()}"></label>
    <label class="f">Team<select id="eTeam" ${teams.length < 2 ? 'disabled' : ''}>${teams.map(t => `<option value="${t.id}" ${t.id === r.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
  </div></div></div>
  <div class="note">Operational report only. Do not type names of families, next of kin or the deceased: use grave or household reference numbers.</div>`;

  h += `<div class="card"><h3>Key statistics</h3><div class="legend"><span><i class="dot r1"></i> ${RAG[1]}</span><span><i class="dot r2"></i> ${RAG[2]}</span><span><i class="dot r3"></i> ${RAG[3]}</span></div><div id="kpis">${kpiRows(r)}</div>
    <div class="body" style="border-top:1px solid var(--line)"><label class="f">Key information / new comments<textarea data-f="key_info" placeholder="Nothing to report">${esc(r.key_info)}</textarea></label></div></div>`;
  h += `<div class="card"><h3>Activities completed</h3><div id="actC">${actRows(r, 'completed')}</div><div class="addrow"><button onclick="addAct('completed')">+ Add activity</button></div></div>`;
  h += `<div class="card"><h3>Activities planned (next day)</h3><div id="actP">${actRows(r, 'planned')}</div><div class="addrow"><button onclick="addAct('planned')">+ Add planned activity</button></div></div>`;
  h += `<div class="card"><h3>Emerging issues</h3><div class="body"><textarea data-f="emerging_issues" placeholder="Nothing to report">${esc(r.emerging_issues)}</textarea></div></div>`;
  h += `<div class="card"><h3>Quotes / photos</h3><div class="body"><textarea data-f="quotes" placeholder="Quotes from the field (no personal names)">${esc(r.quotes)}</textarea></div>
    <div class="photos" id="photos"></div>
    <div class="addrow"><label class="btn">📷 Add photos<input type="file" accept="image/*" multiple id="phIn" style="display:none"></label>
    <span class="small muted"> Photos are shrunk on the phone before sending.</span></div></div>`;
  h += `<div class="sticky-actions"><div class="actions" style="margin:0">
    <button onclick="saveDraft()">Save draft</button>
    <button class="good" onclick="submitReport()">${r.status === 'submitted' ? 'Save changes' : 'Submit report'}</button>
    <a class="btn" href="#/view/${r.id}">Preview</a>
    <button onclick="cancelEdit()">Cancel</button>
    ${!r.updated_at ? `<button class="danger" onclick="discardReport()">Delete</button>` : ''}
  </div><div class="small muted" id="saveState">${r._dirty ? 'Saved on this phone; will be sent when there is signal.' : 'Sent.'}</div></div>`;
  $('#app').innerHTML = h;
  renderPhotos();
  bindEdit();
}

function kpiRows(r) {
  return activeKpis().map(k => {
    const v = r.kpis.find(x => x.kpi_id === k.id);
    const c = cumulative(r, k.id);
    return `<div class="kpi ${v.not_applicable ? 'dis' : ''}" data-k="${k.id}">
      <div class="lbl">${esc(k.label)}<label class="na"><input type="checkbox" data-kf="not_applicable" ${v.not_applicable ? 'checked' : ''}> N/A</label></div>
      <div class="nums">
        <label>Planned<input type="number" inputmode="decimal" step="any" data-kf="planned" value="${v.planned ?? ''}" ${v.not_applicable ? 'disabled' : ''}></label>
        <label>Actual<input type="number" inputmode="decimal" step="any" data-kf="actual" value="${v.actual ?? ''}" ${v.not_applicable ? 'disabled' : ''}></label>
        <label>Cumulative<span class="cum" data-cum>${v.not_applicable ? 'N/A' : fmtNum(c)}</span></label>
        <div class="rag">${[1, 2, 3].map(n => `<button type="button" data-v="${n}" title="${RAG[n]}" aria-label="${RAG[n]}" class="${v.rag === n ? 'on' : ''}"></button>`).join('')}</div>
      </div>${k.target_total ? `<div class="small muted">Project target ${fmtNum(k.target_total)}</div>` : ''}</div>`;
  }).join('');
}
function actRows(r, kind) {
  const list = r.activities.map((a, i) => ({ a, i })).filter(x => x.a.kind === kind);
  if (!list.length) return `<div class="body muted small">None yet.</div>`;
  return list.map(({ a, i }) => `<div class="act" data-i="${i}">
    <div class="top"><textarea rows="2" data-af="activity" placeholder="Activity and target">${esc(a.activity)}</textarea><button class="rm" title="Remove" data-rm>×</button></div>
    ${kind === 'completed' ? `<div class="row" style="align-items:center"><span class="small muted">Status</span><div class="rag">${[1, 2, 3].map(n => `<button type="button" data-v="${n}" title="${RAG[n]}" class="${a.rag === n ? 'on' : ''}"></button>`).join('')}</div></div>` : ''}
    <input data-af="comment" placeholder="Comments" value="${esc(a.comment)}"></div>`).join('');
}

function bindEdit() {
  const r = ED.r, app = $('#app');
  app.oninput = e => {
    const t = e.target;
    if (t.dataset.f) { r[t.dataset.f] = t.value; touch(); }
    else if (t.dataset.kf && t.type !== 'checkbox') {
      const k = r.kpis.find(x => x.kpi_id === t.closest('[data-k]').dataset.k); k[t.dataset.kf] = num(t.value); touch();
      if (t.dataset.kf === 'actual') refreshCum();
    } else if (t.dataset.af) { r.activities[+t.closest('[data-i]').dataset.i][t.dataset.af] = t.value; touch(); }
  };
  app.onchange = async e => {
    const t = e.target;
    if (t.dataset.kf === 'not_applicable') {
      const row = t.closest('[data-k]'); const k = r.kpis.find(x => x.kpi_id === row.dataset.k);
      k.not_applicable = t.checked; row.classList.toggle('dis', t.checked); $$('input[type=number]', row).forEach(i => i.disabled = t.checked); touch(); refreshCum();
    } else if (t.id === 'eDate' || t.id === 'eTeam') {
      const nd = $('#eDate').value, nt = $('#eTeam').value;
      const clash = [...S.reports.values()].find(x => x.id !== r.id && x.team_id === nt && x.report_date === nd);
      if (clash) { toast('There is already a report for that team and day. Opening it.'); location.hash = '#/edit/' + clash.id; return; }
      r.report_date = nd; r.team_id = nt; touch(); refreshCum();
    } else if (t.id === 'phIn') { await addPhotos(t.files); t.value = ''; }
  };
  app.onclick = e => {
    const t = e.target;
    const ragBtn = t.closest('.rag button');
    if (ragBtn) {
      const v = +ragBtn.dataset.v; const kr = ragBtn.closest('[data-k]'); const ar = ragBtn.closest('[data-i]');
      const obj = kr ? r.kpis.find(x => x.kpi_id === kr.dataset.k) : r.activities[+ar.dataset.i];
      obj.rag = obj.rag === v ? null : v;
      $$('button', ragBtn.parentElement).forEach(b => b.classList.toggle('on', +b.dataset.v === obj.rag)); touch(); return;
    }
    if (t.hasAttribute('data-rm')) {
      const i = +t.closest('[data-i]').dataset.i; const a = r.activities[i];
      if (a.activity && !confirm('Remove this activity?')) return;
      r.activities.splice(i, 1); touch(); redrawActs();
    }
  };
}
function refreshCum() {
  for (const row of $$('[data-k]')) {
    const v = ED.r.kpis.find(x => x.kpi_id === row.dataset.k);
    $('[data-cum]', row).textContent = v.not_applicable ? 'N/A' : fmtNum(cumulative(ED.r, row.dataset.k));
  }
}
function redrawActs() { $('#actC').innerHTML = actRows(ED.r, 'completed'); $('#actP').innerHTML = actRows(ED.r, 'planned'); }
function addAct(kind) {
  ED.r.activities.push({ kind, activity: '', rag: null, comment: '' }); touch(); redrawActs();
  const boxes = $$(kind === 'completed' ? '#actC textarea' : '#actP textarea'); boxes[boxes.length - 1]?.focus();
}
async function saveDraft() {
  await persistReport(ED.r); toast(navigator.onLine ? 'Saved. Sending…' : 'Saved on this phone. It will be sent when there is signal.');
  await sync(); updateSaveState();
}
async function submitReport() {
  const r = ED.r;
  const empty = r.kpis.filter(k => !k.not_applicable && k.actual === null && activeKpis().some(a => a.id === k.kpi_id)).length;
  if (empty && !confirm(`${empty} key statistic(s) have no actual figure. Submit anyway?`)) return;
  if (!r.activities.some(a => a.kind === 'completed' && a.activity.trim()) && !confirm('No completed activities are listed. Submit anyway?')) return;
  r.status = 'submitted'; r._dirty = true; r._local_updated = Date.now(); await persistReport(r);
  toast(navigator.onLine ? 'Submitted. Sending…' : 'Submitted on this phone. It will be sent when there is signal.');
  await sync();
  location.hash = '#/view/' + r.id;
}
function updateSaveState() { const el = $('#saveState'); if (el && ED) el.textContent = ED.r._conflict ? 'Not sent: see the message at the top.' : ED.r._dirty ? 'Saved on this phone; will be sent when there is signal.' : 'Sent.'; }
async function cancelEdit() {
  if (!ED || !EDIT_OPEN) { location.hash = '#/'; return; }
  const r = ED.r, o = EDIT_OPEN;
  const strip = x => { const c = JSON.parse(typeof x === 'string' ? x : JSON.stringify(x)); for (const k of ['_dirty', '_local_updated', '_err', '_conflict', 'updated_at', 'base_updated_at', 'locked']) delete c[k]; return JSON.stringify(c); };
  const curPhotos = [...S.photos.values()].filter(p => p.report_id === r.id && !p.deleted).map(p => p.id);
  const photosChanged = curPhotos.length !== o.photos.size || curPhotos.some(id => !o.photos.has(id));
  const changed = strip(r) !== strip(o.snap) || photosChanged;
  if (o.isNew && !r.updated_at) {
    if (!confirm('Discard this new report? Nothing has been sent.')) return;
    ED = null; EDIT_OPEN = null;
    S.reports.delete(r.id); await DB.del('reports', r.id);
    for (const p of [...S.photos.values()].filter(p => p.report_id === r.id)) { S.photos.delete(p.id); await DB.del('photos', p.id); }
    location.hash = '#/'; renderNet(); return;
  }
  if (!changed) { ED = null; EDIT_OPEN = null; location.hash = '#/'; return; }
  if (!confirm('Discard your changes since you opened this report?')) return;
  const back = JSON.parse(o.snap);
  if (r.updated_at && r.updated_at !== back.updated_at) {
    // some edits were already sent: send the original version back up
    back.updated_at = r.updated_at; back.base_updated_at = r.base_updated_at; back._dirty = true; back._local_updated = Date.now();
  }
  back._conflict = null; back._err = null;
  ED = null; EDIT_OPEN = null;
  await persistReport(back);
  for (const p of [...S.photos.values()].filter(p => p.report_id === r.id)) {
    if (o.photos.has(p.id)) { if (p.deleted) { p.deleted = false; await persistPhoto(p); } }
    else if (p.uploaded) { p.deleted = true; await persistPhoto(p); }
    else { S.photos.delete(p.id); await DB.del('photos', p.id); }
  }
  toast('Changes discarded.');
  location.hash = '#/'; renderNet(); sync();
}
async function discardReport() {
  if (!confirm('Delete this report from this phone? It has not been sent.')) return;
  const id = ED.r.id; S.reports.delete(id); await DB.del('reports', id);
  for (const p of [...S.photos.values()].filter(p => p.report_id === id)) { S.photos.delete(p.id); await DB.del('photos', p.id); }
  ED = null; location.hash = '#/';
}

/* ---------------- conflicts ---------------- */
function conflictBanner(r) {
  const c = r._conflict;
  if (r._err && !c) return `<div class="note bad">Could not send: ${esc(r._err)}</div>`;
  if (!c) return '';
  if (c.conflict === 'duplicate') return `<div class="note bad"><b>${esc(teamName(r.team_id))} already has a report for ${fmtDate(r.report_date)}</b>, sent by ${esc(c.other_by || 'someone else')} at ${fmtTime(c.other_updated_at)}.
    ${c.locked ? 'It has been locked by the office, so it cannot be replaced.' : ''}
    <div class="actions"><button class="primary" onclick="mergeInto('${c.other_id}')">Add my items to their report</button>
    ${!c.locked ? `<button onclick="forcePush()">Replace their report with mine</button>` : ''}
    <button onclick="$('#eDate').focus()">Change the date</button></div></div>`;
  if (c.conflict === 'changed') return `<div class="note bad"><b>This report was changed by ${esc(c.other_by || 'someone else')}</b> at ${fmtTime(c.other_updated_at)} after you last synced.
    <div class="actions"><button class="primary" onclick="forcePush()">Keep my version</button><button onclick="takeServer()">Use their version</button></div></div>`;
  if (c.conflict === 'locked') return `<div class="note bad"><b>The office has locked this report</b>, so your changes cannot be sent. <div class="actions"><button onclick="takeServer()">Discard my changes</button></div></div>`;
  return '';
}
async function forcePush() {
  const r = ED.r; if (!navigator.onLine) return toast('You need signal for this.');
  r._conflict = null; r._dirty = true; await persistReport(r);
  try { await pushReports(r.id, true); await pushPhotos(); await pull(); } catch (e) { toast(errMsg(e)); }
  renderEdit(r.id); renderNet();
}
async function takeServer() {
  const r = ED.r; if (!navigator.onLine) return toast('You need signal for this.');
  const { data, error } = await sb.from('daily_report').select('*, report_kpi(*), report_activity(*), report_photo(*)').eq('id', r.id).maybeSingle();
  if (error) return toast(errMsg(error));
  if (data) { await persistReport(fromServer(data)); renderEdit(r.id); }
  else { S.reports.delete(r.id); await DB.del('reports', r.id); location.hash = '#/'; }
  renderNet();
}
async function mergeInto(otherId) {
  const mine = ED.r; if (!navigator.onLine) return toast('You need signal for this.');
  const { data, error } = await sb.from('daily_report').select('*, report_kpi(*), report_activity(*), report_photo(*)').eq('id', otherId).maybeSingle();
  if (error || !data) return toast(error ? errMsg(error) : 'Could not find their report.');
  const o = fromServer(data);
  for (const k of mine.kpis) {
    const ok = o.kpis.find(x => x.kpi_id === k.kpi_id);
    if (!ok) o.kpis.push({ ...k });
    else { if (ok.actual === null && k.actual !== null) ok.actual = k.actual; if (ok.planned === null && k.planned !== null) ok.planned = k.planned; if (!ok.rag && k.rag) ok.rag = k.rag; }
  }
  const seen = new Set(o.activities.map(a => a.kind + '|' + a.activity.trim().toLowerCase()));
  for (const a of mine.activities) if (a.activity.trim() && !seen.has(a.kind + '|' + a.activity.trim().toLowerCase())) o.activities.push({ ...a });
  for (const f of ['key_info', 'emerging_issues', 'quotes']) if (mine[f] && mine[f].trim() && !o[f].includes(mine[f].trim())) o[f] = o[f] ? o[f] + '\n' + mine[f].trim() : mine[f].trim();
  o._dirty = true; o._local_updated = Date.now();
  for (const p of [...S.photos.values()].filter(p => p.report_id === mine.id && !p.uploaded)) { p.report_id = o.id; await persistPhoto(p); }
  S.reports.delete(mine.id); await DB.del('reports', mine.id);
  await persistReport(o);
  toast('Your items were added. Check the report, then submit.');
  location.hash = '#/edit/' + o.id;
  sync();
}

/* ---------------- photos ---------------- */
async function shrink(file, max, q) {
  const bmp = await (window.createImageBitmap ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null) : null);
  let w, hgt, src = bmp;
  if (!src) { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  w = src.width; hgt = src.height;
  const s = Math.min(1, max / Math.max(w, hgt));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(hgt * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', q));
}
async function addPhotos(files) {
  for (const f of files) {
    try {
      const blob = await shrink(f, 1600, 0.72), thumb = await shrink(f, 360, 0.6);
      await persistPhoto({ id: uuid(), report_id: ED.r.id, blob, thumb, caption: '', taken_at: new Date(f.lastModified || Date.now()).toISOString(), uploaded: false });
    } catch (e) { toast('Could not read that photo: ' + errMsg(e)); }
  }
  renderPhotos(); renderNet(); sync();
}
const urlCache = new Map();
function blobUrl(p, key) { const k = p.id + key; if (!urlCache.has(k) && p[key]) urlCache.set(k, URL.createObjectURL(p[key])); return urlCache.get(k); }
async function signedUrls(list) {
  const need = list.filter(p => p.uploaded && !urlCache.has(p.id + 'remote'));
  if (!need.length || !navigator.onLine) return;
  const { data } = await sb.storage.from('report-photos').createSignedUrls(need.map(p => p.storage_path || `${p.report_id}/${p.id}.jpg`), 3600);
  (data || []).forEach((d, i) => { if (d.signedUrl) urlCache.set(need[i].id + 'remote', d.signedUrl); });
}
function photoSrc(p, big) { return (big && blobUrl(p, 'blob')) || urlCache.get(p.id + 'remote') || blobUrl(p, 'thumb') || blobUrl(p, 'blob') || ''; }
async function renderPhotos() {
  const el = $('#photos'); if (!el || !ED) return;
  const list = [...S.photos.values()].filter(p => p.report_id === ED.r.id && !p.deleted);
  const draw = () => {
    el.innerHTML = list.map(p => `<div class="photo" data-p="${p.id}">${photoSrc(p) ? `<img src="${photoSrc(p)}" alt="">` : '<div style="height:120px" class="muted small">Photo (needs signal to show)</div>'}
    <div class="ph"><span>${p.uploaded ? 'Sent ✓' : p.err ? 'Not sent' : 'Waiting'}</span><button class="link" data-del style="color:var(--bad)">Remove</button></div>
    <input placeholder="Caption" value="${esc(p.caption)}" data-cap></div>`).join('');
  };
  draw();
  if (list.some(p => !p.thumb && !p.blob)) { await signedUrls(list); draw(); }
  el.oninput = e => { if (e.target.dataset.cap !== undefined) { const p = S.photos.get(e.target.closest('[data-p]').dataset.p); p.caption = e.target.value; if (p.uploaded) p.captionDirty = true; persistPhoto(p); renderNet(); } };
  el.onclick = async e => {
    if (e.target.dataset.del === undefined) return;
    if (!confirm('Remove this photo?')) return;
    const p = S.photos.get(e.target.closest('[data-p]').dataset.p);
    if (p.uploaded) { p.deleted = true; await persistPhoto(p); } else { S.photos.delete(p.id); await DB.del('photos', p.id); }
    renderPhotos(); renderNet(); sync();
  };
}

/* ---------------- report view (template layout, printable) ---------------- */
async function renderView(id) {
  const r = S.reports.get(id);
  if (!r) { $('#app').innerHTML = `<div class="card"><div class="body">This report is not on this device yet. <a href="#/">Back</a></div></div>`; return; }
  ED = null;
  const done = r.activities.filter(a => a.kind === 'completed' && a.activity);
  const plan = r.activities.filter(a => a.kind === 'planned' && a.activity);
  const kpiDefs = S.kpis.slice().sort((a, b) => a.sort - b.sort).filter(k => k.active || r.kpis.some(x => x.kpi_id === k.id && (x.actual !== null || x.planned !== null)));
  const photos = [...S.photos.values()].filter(p => p.report_id === id && !p.deleted);
  const dot = n => n ? `<span class="dot r${n}" title="${RAG[n]}"></span> <span class="small">${RAG_SHORT[n]}</span>` : '';
  let h = conflictBanner(r);
  h += `<div class="actions noprint">${canEdit(r) ? `<a class="btn primary" href="#/edit/${r.id}">Edit</a>` : ''}<button onclick="window.print()">Print / save as PDF</button>
    ${isOffice() && r.updated_at ? `<button onclick="toggleLock('${r.id}')">${r.locked ? 'Unlock' : 'Lock (reviewed)'}</button>` : ''}<a class="btn" href="#/">Back</a>
    <span style="margin-left:auto">${statusPills(r)}</span></div>
  <div class="rep card"><div class="co"><img src="logo.png" alt=""><div class="nm">PGS Heritage</div></div><div class="hdr"><div><h1>Daily Planning and Performance Report</h1><div>${esc(S.project?.code || PROJECT_CODE)} · ${esc(S.project?.name || '')}</div></div>
    <div class="d"><b>${fmtDate(r.report_date)}</b><br>${esc(teamName(r.team_id).toUpperCase())}</div></div>
    <div class="sec">Key statistics / information</div>
    <div class="scroll"><table><thead><tr><th>Statistic</th><th class="n">Planned</th><th class="n">Up to previous day</th><th class="n">Today (actual)</th><th class="n">Cumulative</th><th>Status</th></tr></thead><tbody>
    ${kpiDefs.map(k => { const v = r.kpis.find(x => x.kpi_id === k.id) || {}; const na = v.not_applicable; const c = cumulative(r, k.id);
      const prev = c === null ? null : c - (v.actual ?? 0);
      return `<tr><td>${esc(k.label)}</td><td class="n">${na ? 'N/A' : fmtNum(v.planned)}</td><td class="n">${na ? 'N/A' : fmtNum(prev)}</td><td class="n">${na ? 'N/A' : fmtNum(v.actual)}</td><td class="n"><b>${na ? 'N/A' : fmtNum(c)}</b></td><td>${dot(v.rag)}</td></tr>`; }).join('')}
    </tbody></table></div>
    <div class="txt"><b>Key information / new comments:</b> ${esc(r.key_info || 'Nothing to report')}</div>
    <div class="sec">Activities completed</div>
    <div class="scroll"><table><thead><tr><th>Team</th><th>Activity name and target</th><th>Status</th><th>Comments</th></tr></thead><tbody>
    ${done.length ? done.map((a, i) => `<tr>${i === 0 ? `<td rowspan="${done.length}">${esc(teamName(r.team_id))}</td>` : ''}<td style="white-space:pre-wrap">${esc(a.activity)}</td><td style="white-space:nowrap">${dot(a.rag)}</td><td style="white-space:pre-wrap">${esc(a.comment)}</td></tr>`).join('') : `<tr><td colspan="4" class="muted">Nothing to report</td></tr>`}
    </tbody></table></div>
    <div class="sec">Activities planned</div>
    <div class="scroll"><table><thead><tr><th>Team</th><th>Activity name and target</th><th>Comments</th></tr></thead><tbody>
    ${plan.length ? plan.map((a, i) => `<tr>${i === 0 ? `<td rowspan="${plan.length}">${esc(teamName(r.team_id))}</td>` : ''}<td style="white-space:pre-wrap">${esc(a.activity)}</td><td style="white-space:pre-wrap">${esc(a.comment)}</td></tr>`).join('') : `<tr><td colspan="3" class="muted">Nothing to report</td></tr>`}
    </tbody></table></div>
    <div class="sec">Emerging issues</div><div class="txt">${esc(r.emerging_issues || 'Nothing to report')}</div>
    <div class="sec">Quotes / photos</div><div class="txt">${esc(r.quotes || (photos.length ? '' : 'Nothing to report'))}</div>
    <div class="photos" id="vPhotos"></div>
    <div class="txt small muted">Prepared by ${esc(userName(r.created_by) || (r.created_by === S.me.id ? S.me.full_name : ''))}${r.submitted_at ? ' · submitted ' + fmtTime(r.submitted_at) : ''}${r.updated_by && r.updated_by !== r.created_by ? ' · last changed by ' + esc(userName(r.updated_by)) + ' ' + fmtTime(r.updated_at) : ''}</div>
  </div>`;
  h += `<div class="card noprint" id="hist"><h3>Change history</h3><div class="body small muted">${r.updated_at ? (navigator.onLine ? 'Loading…' : 'The history needs signal.') : 'Not sent yet, so there is no history.'}</div></div>`;
  $('#app').innerHTML = h;
  if (r.updated_at && navigator.onLine) loadHistory(r);
  const drawPh = () => { const el = $('#vPhotos'); if (el) el.innerHTML = photos.map(p => `<div class="photo">${photoSrc(p, true) ? `<img src="${photoSrc(p, true)}" alt="">` : '<div style="height:80px;padding:6px" class="muted small">Photo (needs signal to show)</div>'}<div class="ph" style="font-size:12px;color:var(--ink)">${esc(p.caption || '')}</div></div>`).join(''); };
  drawPh();
  if (photos.length) { await signedUrls(photos); drawPh(); }
}
/* ---------------- change history ---------------- */
const ACTION_LBL = { created: 'Report started', edited: 'Changed', submitted: 'Submitted', replaced: 'Replaced by another report', locked: 'Locked (reviewed)', unlocked: 'Unlocked', photo_added: 'Photo added', photo_removed: 'Photo removed' };
const FIELD_LBL = { report_date: 'Date', team_id: 'Team', status: 'Status', key_info: 'Key information', emerging_issues: 'Emerging issues', quotes: 'Quotes' };
const short = (t, n = 70) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : (t || '(empty)'); };
const kpiLabel = id => (S.kpis.find(k => k.id === id) || {}).label || 'Statistic';
function describeChange(c) {
  const out = [], b = c.before, a = c.after;
  if (c.note && (c.action === 'photo_added' || c.action === 'photo_removed')) out.push(short(c.note));
  if (!b || !a) return out;
  for (const f of Object.keys(FIELD_LBL)) {
    if ((b[f] ?? '') === (a[f] ?? '')) continue;
    const v = x => f === 'team_id' ? teamName(x) : f === 'report_date' ? fmtDate(x) : short(x);
    out.push(`${FIELD_LBL[f]}: ${v(b[f])} → ${v(a[f])}`);
  }
  const bk = Object.fromEntries((b.kpis || []).map(k => [k.kpi_id, k])), ak = Object.fromEntries((a.kpis || []).map(k => [k.kpi_id, k]));
  for (const id of new Set([...Object.keys(bk), ...Object.keys(ak)])) {
    const x = bk[id] || {}, y = ak[id] || {}, parts = [];
    const n = v => v === null || v === undefined ? '–' : fmtNum(+v);
    if (n(x.planned) !== n(y.planned)) parts.push(`planned ${n(x.planned)} → ${n(y.planned)}`);
    if (n(x.actual) !== n(y.actual)) parts.push(`actual ${n(x.actual)} → ${n(y.actual)}`);
    if (!!x.not_applicable !== !!y.not_applicable) parts.push(y.not_applicable ? 'set to N/A' : 'N/A removed');
    if ((x.rag || null) !== (y.rag || null)) parts.push(`status ${RAG_SHORT[x.rag] || '–'} → ${RAG_SHORT[y.rag] || '–'}`);
    if (parts.length) out.push(`${kpiLabel(id)}: ${parts.join(', ')}`);
  }
  const key = x => x.kind + '|' + (x.activity || '').trim();
  const ba = new Map((b.activities || []).map(x => [key(x), x])), aa = new Map((a.activities || []).map(x => [key(x), x]));
  const kindLbl = k => k === 'completed' ? 'completed' : 'planned';
  for (const [k, x] of ba) if (!aa.has(k)) out.push(`Removed ${kindLbl(x.kind)} activity: ${short(x.activity)}`);
  for (const [k, y] of aa) {
    const x = ba.get(k);
    if (!x) { out.push(`Added ${kindLbl(y.kind)} activity: ${short(y.activity)}`); continue; }
    if ((x.rag || null) !== (y.rag || null)) out.push(`Status of “${short(y.activity, 40)}”: ${RAG_SHORT[x.rag] || '–'} → ${RAG_SHORT[y.rag] || '–'}`);
    if ((x.comment || '') !== (y.comment || '')) out.push(`Comment on “${short(y.activity, 40)}”: ${short(x.comment, 40)} → ${short(y.comment, 40)}`);
  }
  return out;
}
async function loadHistory(r) {
  const el = $('#hist .body'); if (!el) return;
  const { data, error } = await sb.from('report_change').select('*').eq('report_id', r.id).order('at', { ascending: false }).limit(200);
  if (!$('#hist .body')) return;
  if (error) { el.textContent = 'Could not load the history: ' + errMsg(error); return; }
  if (!data.length) { el.textContent = 'No changes recorded yet.'; return; }
  el.classList.remove('muted');
  el.innerHTML = `<table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${data.map(c => {
    const lines = describeChange(c);
    return `<tr><td style="white-space:nowrap">${fmtTime(c.at)}</td><td>${esc(userName(c.user_id) || (c.user_id === S.me.id ? S.me.full_name : 'Someone'))}</td>
      <td><b>${esc(ACTION_LBL[c.action] || c.action)}</b>${lines.length ? `<div class="small">${lines.map(esc).join('<br>')}</div>` : ''}</td></tr>`; }).join('')}</tbody></table>`;
}

async function toggleLock(id) {
  const r = S.reports.get(id); if (!navigator.onLine) return toast('You need signal for this.');
  const { error } = await sb.from('daily_report').update({ locked: !r.locked }).eq('id', id);
  if (error) return toast(errMsg(error));
  r.locked = !r.locked; await persistReport(r); renderView(id);
}

/* ---------------- summary (office) ---------------- */
let SUM_DATE = null;
function printDaily() { document.body.classList.add('print-daily'); window.print(); setTimeout(() => document.body.classList.remove('print-daily'), 500); }
function dailySummaryCard() {
  const dates = [...new Set([...S.reports.values()].map(r => r.report_date))].sort();
  const d = SUM_DATE || dates[dates.length - 1] || todayISO();
  const prevDate = dates.filter(x => x < d).pop();
  const rows = activeKpis().map(k => ({ k, f: dayFigures(k.id, d) }));
  const reps = [...S.reports.values()].filter(r => r.report_date === d).sort((a, b) => teamName(a.team_id).localeCompare(teamName(b.team_id)));
  const comments = reps.flatMap(r => [r.key_info, r.emerging_issues].filter(t => t && t.trim() && !/^nothing to report\.?$/i.test(t.trim())).map(t => ({ team: teamName(r.team_id), t: t.trim() })));
  const multi = S.teams.filter(t => t.active).length > 1;
  return `<div class="card rep" id="dailySum"><div class="co"><img src="logo.png" alt=""><div class="nm">PGS Heritage</div></div>
    <div class="hdr"><div><h1>Grave Relocation Programme – Daily Summary</h1><div>${esc(S.project?.code || PROJECT_CODE)} · all teams</div></div><div class="d"><b>${fmtDate(d)}</b></div></div>
    <div class="body noprint"><div class="row"><label class="f" style="max-width:220px">Day<input type="date" value="${d}" onchange="SUM_DATE=this.value;route()"></label>
      <button onclick="printDaily()">Print / save as PDF</button></div>
      ${!reps.length ? '<p class="note">No report on this device for that day.</p>' : reps.some(r => r.status !== 'submitted') ? '<p class="note">Some reports for this day are still drafts.</p>' : ''}</div>
    <div class="scroll"><table><thead><tr><th>Description</th><th class="n">Up to ${prevDate ? esc(fmtDate(prevDate).replace(/^\w+ /, '')) : 'previous day'}</th><th class="n">${esc(fmtDate(d).replace(/^\w+ /, ''))}</th><th class="n">Cumulative</th></tr></thead><tbody>
    ${rows.map(({ k, f }) => `<tr><td>${esc(k.label)}</td><td class="n">${f ? fmtNum(f.before) : '–'}</td><td class="n">${f && f.anyDay ? fmtNum(f.day) : '–'}</td><td class="n"><b>${f ? fmtNum(f.cum) : '–'}</b></td></tr>`).join('')}
    </tbody></table></div>
    <div class="txt"><b>New comments:</b>${comments.length ? `<ul style="margin:4px 0 0;padding-left:20px">${comments.map(c => `<li>${multi ? `<b>${esc(c.team)}:</b> ` : ''}${esc(c.t)}</li>`).join('')}</ul>` : ' None recorded for the day'}</div>
  </div>`;
}
function viewSummary() {
  const reps = [...S.reports.values()];
  const today = todayISO();
  const rows = activeKpis().map(k => {
    let tot = openingFor(null, k.id), per = {};
    for (const o of S.openings.filter(o => o.kpi_id === k.id)) per[o.team_id] = (per[o.team_id] || 0) + o.amount;
    for (const r of reps) { const v = (r.kpis || []).find(x => x.kpi_id === k.id); if (v && !v.not_applicable && v.actual !== null) { tot += v.actual; per[r.team_id] = (per[r.team_id] || 0) + v.actual; } }
    return { k, tot, per };
  });
  const teams = S.teams.filter(t => t.active);
  let h = `<div class="tabs"><a href="#/">Reports</a><a class="on" href="#/summary">Summary</a>${isAdmin() ? '<a href="#/admin">Admin</a>' : ''}</div>`;
  h += `<div class="card"><h3>Reports in for today (${fmtDate(today)})</h3><div class="body">${teams.map(t => { const r = findReport(t.id, today);
    return `<div>${r ? (r.status === 'submitted' ? '✅' : '📝') : '⬜'} ${esc(t.name)} ${r ? `<a href="#/view/${r.id}" class="small">open</a>` : '<span class="small muted">nothing yet</span>'}</div>`; }).join('')}</div></div>`;
  h += dailySummaryCard();
  h += `<div class="card"><h3>Cumulative to date</h3><div class="scroll"><table><thead><tr><th>Statistic</th>${teams.map(t => `<th class="n">${esc(t.name)}</th>`).join('')}<th class="n">All teams</th><th class="n">Target</th><th class="n">%</th></tr></thead><tbody>
    ${rows.map(({ k, tot, per }) => `<tr><td>${esc(k.label)}</td>${teams.map(t => `<td class="n">${fmtNum(per[t.id] ?? null)}</td>`).join('')}<td class="n"><b>${fmtNum(tot)}</b></td><td class="n">${fmtNum(k.target_total)}</td><td class="n">${k.target_total ? Math.round(tot / k.target_total * 100) + '%' : '–'}</td></tr>`).join('')}
    </tbody></table></div></div>
    <p class="small muted">Includes every report synced to this device, drafts included, plus totals from before the app (set in Admin → Key statistics).</p>
    <div class="card noprint"><h3>Keep a copy in Excel</h3><div class="body">
      <p class="small">Downloads every report as an Excel workbook (reports, key statistics, activities, photo list), so PGS keeps its own copy outside the app.${lastExport() ? ' Last downloaded on this device: ' + fmtTime(lastExport()) + '.' : ''}</p>
      ${lastExport() && Date.now() - lastExport() > 7 * 864e5 ? '<p class="note">It has been more than a week since the last download from this device.</p>' : ''}
      <button class="primary" id="xlsBtn" onclick="exportExcel()">Download all reports (Excel)</button></div></div>`;
  return h;
}

/* ---------------- Excel export ---------------- */
const lastExport = () => +(localStorage.getItem('gr1041-last-export') || 0);
function loadScript(src) {
  return new Promise((res, rej) => { if (window.XLSX) return res(); const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = () => rej(new Error('Could not load the Excel tool. You need signal the first time.')); document.head.appendChild(sc); });
}
async function exportExcel() {
  const btn = $('#xlsBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    if (navigator.onLine) await sync();
    await loadScript('xlsx.mini.min.js');
    const reps = [...S.reports.values()].sort((a, b) => a.report_date.localeCompare(b.report_date) || teamName(a.team_id).localeCompare(teamName(b.team_id)));
    const ragTxt = n => n ? RAG_SHORT[n] : '';
    const kpis = S.kpis.slice().sort((a, b) => a.sort - b.sort);
    const sheetReports = [['Date', 'Team', 'Status', 'Locked', 'Prepared by', 'Submitted', 'Last changed', 'Key information', 'Emerging issues', 'Quotes', 'Not yet sent from this device']];
    const sheetKpi = [['Date', 'Team', 'Statistic', 'Planned', 'Actual', 'N/A', 'Cumulative (team)', 'Status']];
    const sheetAct = [['Date', 'Team', 'Type', 'Activity and target', 'Status', 'Comments']];
    const sheetPh = [['Date', 'Team', 'Caption', 'Taken', 'File in Supabase storage']];
    for (const r of reps) {
      const tn = teamName(r.team_id);
      sheetReports.push([r.report_date, tn, r.status === 'submitted' ? 'Submitted' : 'Draft', r.locked ? 'Yes' : '', userName(r.created_by), r.submitted_at ? fmtTime(r.submitted_at) : '', r.updated_at ? fmtTime(r.updated_at) : '', r.key_info || '', r.emerging_issues || '', r.quotes || '', r._dirty ? 'Yes' : '']);
      for (const k of kpis) {
        const v = (r.kpis || []).find(x => x.kpi_id === k.id); if (!v || (v.planned === null && v.actual === null && !v.not_applicable && !v.rag)) continue;
        sheetKpi.push([r.report_date, tn, k.label, v.not_applicable ? '' : v.planned, v.not_applicable ? '' : v.actual, v.not_applicable ? 'N/A' : '', v.not_applicable ? '' : cumulative(r, k.id), ragTxt(v.rag)]);
      }
      for (const a of r.activities || []) if ((a.activity || '').trim()) sheetAct.push([r.report_date, tn, a.kind === 'completed' ? 'Completed' : 'Planned', a.activity, a.kind === 'completed' ? ragTxt(a.rag) : '', a.comment || '']);
      for (const p of [...S.photos.values()].filter(p => p.report_id === r.id && !p.deleted)) sheetPh.push([r.report_date, tn, p.caption || '', p.taken_at ? fmtTime(p.taken_at) : '', p.storage_path || `${p.report_id}/${p.id}.jpg`]);
    }
    const wb = XLSX.utils.book_new();
    const add = (rows, name, widths) => { const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = widths.map(w => ({ wch: w })); ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: rows[0].length - 1 } }) }; XLSX.utils.book_append_sheet(wb, ws, name); };
    add(sheetReports, 'Reports', [11, 24, 10, 7, 20, 14, 14, 50, 50, 40, 12]);
    add(sheetKpi, 'Key statistics', [11, 24, 42, 9, 9, 6, 16, 8]);
    add(sheetAct, 'Activities', [11, 24, 10, 70, 8, 50]);
    add(sheetPh, 'Photos', [11, 24, 40, 14, 60]);
    add([['Statistic', 'Team', 'Total before the app', 'Up to and including', 'Note'], ...S.openings.map(o => [kpiLabel(o.kpi_id), teamName(o.team_id), o.amount, o.as_of, o.note || ''])], 'Totals before app', [36, 24, 18, 18, 50]);
    add([['PGS Heritage · ' + (S.project?.code || PROJECT_CODE) + ' daily reports'], ['Downloaded', new Date().toLocaleString('en-GB')], ['By', S.me.full_name], ['Reports', reps.length], ['Note', 'Photos stay in the app; this lists them. Status: Red = not done / behind, Amber = in progress, Green = done / on track.']], 'About', [14, 90]);
    XLSX.writeFile(wb, `${S.project?.code || PROJECT_CODE} daily reports ${todayISO()}.xlsx`);
    try { localStorage.setItem('gr1041-last-export', String(Date.now())); } catch {}
    toast('Excel file downloaded.');
  } catch (e) { toast(errMsg(e), 6000); }
  finally { if (location.hash.startsWith('#/summary')) route(); }
}

/* ---------------- admin ---------------- */
async function renderAdmin(tab) {
  const app = $('#app');
  let h = `<div class="tabs"><a href="#/">Reports</a><a href="#/summary">Summary</a><a class="on" href="#/admin">Admin</a></div>
    <div class="tabs">${['people', 'teams', 'kpis'].map(t => `<a href="#/admin/${t}" class="${t === tab ? 'on' : ''}">${{ people: 'People', teams: 'Teams', kpis: 'Key statistics' }[t]}</a>`).join('')}</div>`;
  if (!navigator.onLine) { app.innerHTML = h + '<div class="note">Admin changes need signal.</div>'; return; }
  app.innerHTML = h + '<p class="muted">Loading…</p>';
  try {
    if (tab === 'teams') h += adminTeams();
    else if (tab === 'kpis') h += adminKpis();
    else {
      const [{ data: inv, error: e1 }, { data: users, error: e2 }] = await Promise.all([sb.from('staff_invite').select('*').order('full_name'), sb.from('app_user').select('*')]);
      if (e1) throw e1; if (e2) throw e2;
      h += adminPeople(inv, users);
    }
  } catch (e) { h += `<div class="note bad">${esc(errMsg(e))}</div>`; }
  app.innerHTML = h;
}
const roleLbl = { admin: 'Admin (office)', supervisor: 'Supervisor (sees all teams)', field: 'Field (own team only)' };
function adminPeople(inv, users) {
  const byEmail = Object.fromEntries(users.map(u => [u.email, u]));
  return `<div class="card"><h3>People</h3><div class="scroll"><table><thead><tr><th>Name</th><th>Role / team</th><th>Status</th><th></th></tr></thead><tbody>
  ${inv.map(i => { const u = byEmail[i.email];
    return `<tr><td><b>${esc(i.full_name)}</b><div class="small muted">${esc(i.email)}</div></td><td>${esc(roleLbl[i.role])}<div class="small muted">${i.team_id ? esc(teamName(i.team_id)) : '–'}</div></td>
    <td>${u ? (u.active ? '<span class="pill p-sub">Signed in before</span>' : '<span class="pill p-lock">Switched off</span>') : '<span class="pill p-draft">Not signed in yet</span>'}</td>
    <td style="white-space:nowrap"><button class="link" onclick='editPerson(${JSON.stringify(i).replace(/'/g, '&#39;')})'>Edit</button>
    <button class="link" onclick="signinLink('${esc(i.email)}')">Sign-in link</button>
    ${u ? `<button class="link" onclick="setActive('${u.id}',${!u.active})">${u.active ? 'Switch off' : 'Switch on'}</button>` : ''}</td></tr>`; }).join('')}
  </tbody></table></div><div class="addrow"><button class="primary" onclick="editPerson(null)">+ Invite a person</button></div></div>
  <p class="small muted">Invited people sign in with an emailed code. Until the pgsheritage.com email records are verified, use <b>Sign-in link</b> and send the link to the person yourself (WhatsApp or Teams). A link works once and expires after about an hour.</p>`;
}
function dlg(title, body, buttons) {
  const d = document.createElement('dialog');
  d.innerHTML = `<div class="dh">${title}</div><div class="db">${body}<div class="err" id="dErr"></div></div><div class="df"></div>`;
  for (const [lbl, cls, fn] of buttons) { const b = document.createElement('button'); b.textContent = lbl; if (cls) b.className = cls; b.onclick = async () => { if (!fn) return d.close(); try { b.disabled = true; if (await fn(d) !== false) d.close(); } catch (e) { $('#dErr', d).textContent = errMsg(e); } finally { b.disabled = false; } }; $('.df', d).appendChild(b); }
  d.addEventListener('close', () => d.remove()); document.body.appendChild(d); d.showModal(); return d;
}
function editPerson(i) {
  const isNew = !i; i = i || { email: '', full_name: '', role: 'field', team_id: S.me.team_id || (S.teams[0] || {}).id };
  dlg(isNew ? 'Invite a person' : 'Edit ' + esc(i.full_name), `
    <label class="f">Full name<input id="pName" value="${esc(i.full_name)}"></label><br>
    <label class="f">Email<input id="pEmail" type="email" value="${esc(i.email)}" ${isNew ? '' : 'disabled'}></label><br>
    <label class="f">Role<select id="pRole">${Object.entries(roleLbl).map(([k, v]) => `<option value="${k}" ${k === i.role ? 'selected' : ''}>${v}</option>`).join('')}</select></label><br>
    <label class="f">Team<select id="pTeam"><option value="">– none –</option>${S.teams.map(t => `<option value="${t.id}" ${t.id === i.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>`,
    [['Cancel'], ['Save', 'primary', async d => {
      const row = { email: (isNew ? $('#pEmail', d).value : i.email).trim().toLowerCase(), full_name: $('#pName', d).value.trim(), role: $('#pRole', d).value, team_id: $('#pTeam', d).value || null };
      if (!row.email || !row.full_name) throw new Error('Name and email are needed');
      if (row.role === 'field' && !row.team_id) throw new Error('Field users need a team');
      const { error } = await sb.from('staff_invite').upsert(row); if (error) throw error;
      toast('Saved'); renderAdmin('people');
    }]]);
}
async function setActive(id, on) {
  const { error } = await sb.from('app_user').update({ active: on }).eq('id', id);
  if (error) return toast(errMsg(error)); renderAdmin('people');
}
async function signinLink(email) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(SB_URL + '/functions/v1/signin-link', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ email, redirectTo: location.origin + location.pathname }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.link) return toast(out.error || 'Could not create a link', 6000);
  const msg = `Your sign-in link for the 1041GR daily report app (opens once, valid about an hour): ${out.link}`;
  dlg('Sign-in link for ' + esc(email), `<p class="small">Send this to the person. It signs them in once on the phone where they open it.</p><textarea id="lnk" rows="5" readonly>${esc(out.link)}</textarea>`,
    [['Copy', '', async d => { await navigator.clipboard.writeText(out.link); toast('Copied'); return false; }],
     ['WhatsApp', '', async () => { window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank'); return false; }],
     ['Done', 'primary', null]]);
}
function adminTeams() {
  return `<div class="card"><h3>Teams</h3><div class="scroll"><table><thead><tr><th>Name</th><th class="n">Order</th><th>Active</th><th></th></tr></thead><tbody>
    ${S.teams.map(t => `<tr><td>${esc(t.name)}</td><td class="n">${t.sort}</td><td>${t.active ? 'Yes' : 'No'}</td><td><button class="link" onclick='editTeam(${JSON.stringify(t).replace(/'/g, '&#39;')})'>Edit</button></td></tr>`).join('')}
    </tbody></table></div><div class="addrow"><button class="primary" onclick="editTeam(null)">+ Add team</button></div></div>`;
}
function editTeam(t) {
  const isNew = !t; t = t || { name: '', sort: S.teams.length + 1, active: true };
  dlg(isNew ? 'Add team' : 'Edit team', `<label class="f">Name<input id="tName" value="${esc(t.name)}"></label><br>
    <label class="f">Order<input id="tSort" type="number" value="${t.sort}"></label><br><label><input type="checkbox" id="tAct" ${t.active ? 'checked' : ''}> Active</label>`,
    [['Cancel'], ['Save', 'primary', async d => {
      const row = { name: $('#tName', d).value.trim(), sort: +$('#tSort', d).value || 0, active: $('#tAct', d).checked, project_id: S.project.id };
      if (!row.name) throw new Error('Name needed');
      const { error } = isNew ? await sb.from('team').insert(row) : await sb.from('team').update(row).eq('id', t.id); if (error) throw error;
      await loadRef(); renderAdmin('teams');
    }]]);
}
function adminKpis() {
  return `<div class="card"><h3>Key statistics</h3><div class="scroll"><table><thead><tr><th>Statistic</th><th class="n">Total before the app</th><th class="n">Project target</th><th class="n">Order</th><th>Active</th><th></th></tr></thead><tbody>
    ${S.kpis.slice().sort((a, b) => a.sort - b.sort).map(k => `<tr><td>${esc(k.label)}</td><td class="n">${hasOpening(null, k.id) ? fmtNum(openingFor(null, k.id)) + `<div class="small muted">up to ${esc(fmtDate(S.openings.find(o => o.kpi_id === k.id).as_of))}</div>` : '–'}</td><td class="n">${fmtNum(k.target_total)}</td><td class="n">${k.sort}</td><td>${k.active ? 'Yes' : 'No'}</td><td><button class="link" onclick='editKpi(${JSON.stringify(k).replace(/'/g, '&#39;')})'>Edit</button></td></tr>`).join('')}
    </tbody></table></div><div class="addrow"><button class="primary" onclick="editKpi(null)">+ Add statistic</button></div></div>
    <p class="small muted">Switch a statistic off rather than deleting it, so old reports keep their figures. Changes reach phones at their next sync.</p>`;
}
function editKpi(k) {
  const isNew = !k; k = k || { label: '', target_total: null, sort: S.kpis.length + 1, active: true };
  dlg(isNew ? 'Add key statistic' : 'Edit key statistic', `<label class="f">Statistic<input id="kLbl" value="${esc(k.label)}"></label><br>
    <label class="f">Project target (optional)<input id="kTgt" type="number" step="any" value="${k.target_total ?? ''}"></label><br>
    <label class="f">Order<input id="kSort" type="number" value="${k.sort}"></label><br><label><input type="checkbox" id="kAct" ${k.active ? 'checked' : ''}> Active</label>
    <fieldset style="margin-top:12px;border:1px solid var(--line2);border-radius:8px;padding:8px 10px"><legend class="small">Total before the app (optional)</legend>
      <p class="small muted" style="margin:0 0 6px">For work counted before teams used the app, e.g. "Up to 14 Nov". It is added to the cumulative figures for reports after that date.</p>
      ${S.teams.filter(t => t.active).map(t => { const o = S.openings.find(o => o.kpi_id === k.id && o.team_id === t.id) || {};
        return `<div class="row" data-ot="${t.id}"><label class="f">${esc(t.name)}<input type="number" step="any" data-oa value="${o.amount ?? ''}"></label><label class="f">Up to and including<input type="date" data-od value="${o.as_of || ''}"></label></div>`; }).join('')}
    </fieldset>`,
    [['Cancel'], ['Save', 'primary', async d => {
      const row = { label: $('#kLbl', d).value.trim(), target_total: num($('#kTgt', d).value), sort: +$('#kSort', d).value || 0, active: $('#kAct', d).checked, project_id: S.project.id };
      if (!row.label) throw new Error('Name needed');
      const res = isNew ? await sb.from('kpi').insert(row).select('id').single() : await sb.from('kpi').update(row).eq('id', k.id).select('id').single();
      if (res.error) throw res.error;
      const kid = res.data.id;
      for (const el of $$('[data-ot]', d)) {
        const amt = num($('[data-oa]', el).value), dt = $('[data-od]', el).value;
        if (amt === null) { const { error } = await sb.from('kpi_opening').delete().eq('kpi_id', kid).eq('team_id', el.dataset.ot); if (error) throw error; continue; }
        if (!dt) throw new Error('Give the date the total runs up to');
        const { error } = await sb.from('kpi_opening').upsert({ kpi_id: kid, team_id: el.dataset.ot, amount: amt, as_of: dt });
        if (error) throw error;
      }
      await loadRef(); renderAdmin('kpis');
    }]]);
}

boot().catch(e => { $('#app').innerHTML = `<div class="note bad">The app could not start: ${esc(errMsg(e))}</div>`; });
