import { state, save, onChange, upsertTask, deleteTask, updateSettings, setWork, liveTasks, mergeRemote, exportable, CATEGORIES, PRIORITIES, uid } from './store.js';
import { parseProgramacion } from './programacion.js';
import { refreshFeeds, feedEvents, feedStatus, feedProblems, clearFeedCache } from './feeds.js';
import * as G from './google.js';
import * as LF from './localfile.js';
import { normalizeClientId, isCalendarLink, proxyError, feedUrlError, el, toast, toYMD, fmtDayLong, parseYMD, addDays, mondayOf, hm2min, min2hm, fmtDur, fmtDay, DOW, MONTHS } from './util.js';

const $ = (s) => document.querySelector(s);
const SNAP = 15;
const PRIO_RANK = { alta: 0, media: 1, baja: 2, '': 3 };
const CLIENT_KEY = 'cfs.clientId';
const getClientId = () => { try { return normalizeClientId(localStorage.getItem(CLIENT_KEY) || ''); } catch { return ''; } };
G.setClientId(getClientId());

let anchor = new Date();
let viewDays = 7;
let tab = 'week';
let lastPointerType = 'mouse';

// ======================================================================
// Utilidades de calendario
// ======================================================================
const VIEW_KEY = 'cfs.view', ZOOM_KEY = 'cfs.zoom';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const ZMIN = 26, ZMAX = 130;
function applyZoom(px, keepMin) {
  const sc = $('#cal-scroll');
  const y = sc.clientHeight / 2;
  const mid = keepMin ?? ((sc.scrollTop + y) / ppm() + dayStartMin());
  const v = Math.round(Math.max(ZMIN, Math.min(ZMAX, px)));
  document.documentElement.style.setProperty('--hour', v + 'px');
  lsSet(ZOOM_KEY, v);
  renderWeek();
  sc.scrollTop = (mid - dayStartMin()) * ppm() - y;
}
// ---------- Eventos de iCloud movidos (se muestran ya movidos hasta que iCloud publique el cambio) ----------
const MOVES_KEY = 'cfs.evmoves';
const getMoves = () => { try { return JSON.parse(localStorage.getItem(MOVES_KEY)) || {}; } catch { return {}; } };
const setMoves = (m) => { try { localStorage.setItem(MOVES_KEY, JSON.stringify(m)); } catch {} };
function calEvents(from, to) {
  const fe = feedEvents(from, to);
  const mv = getMoves();
  const keys = Object.keys(mv);
  if (!keys.length) return fe;
  let dirty = false;
  const out = fe.filter((f) => !mv[f.id]);
  for (const k of keys) {
    const m = mv[k], s = new Date(m.start), e = new Date(m.end);
    // iCloud ya refleja el cambio (o el aviso es muy antiguo): olvidarlo
    if (Date.now() - m.at > 12 * 3600e3 || fe.some((f) => f.uid === m.uid && f.start.getTime() === s.getTime() && f.id !== k)) { delete mv[k]; dirty = true; continue; }
    if (s < to && e > from) out.push({ ...m.ev, id: 'mv:' + k, origId: k, occ: m.occ, start: s, end: e, pending: true });
  }
  if (dirty) setMoves(mv);
  return out;
}
const caldavOn = () => !!(state.settings.caldavToken && state.settings.proxy && !proxyError(state.settings.proxy));
async function caldavCall(path, body) {
  const base = state.settings.proxy.trim().split('?')[0].replace(/\/+$/, '');
  let r;
  try { r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Planner-Token': state.settings.caldavToken }, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('No se pudo conectar con el worker (¿has desplegado la versión nueva?)'); }
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch {}
  if (!r.ok) throw new Error(j.error || (txt && txt.length < 300 ? txt : '') || `El worker respondió ${r.status}`);
  return j;
}
/** Mueve un evento de iCloud (solo esa ocurrencia si se repite). start/end: Date. */
async function moveEvent(ev, start, end) {
  if (!caldavOn()) { toast('Para mover eventos de iCloud, configura «Mover eventos de iCloud» en Ajustes', 5000); return; }
  if (!ev.uid) { toast('Este evento no tiene identificador de iCloud; no se puede mover'); return; }
  const key = ev.origId || ev.id;
  const occ = ev.occ || ev.recurrenceId || (ev.recurring ? ev.start.toISOString() : null);
  const body = ev.allDay
    ? { uid: ev.uid, occurrence: occ && toYMD(new Date(occ)), allDay: true, start: toYMD(start), end: toYMD(end) }
    : { uid: ev.uid, occurrence: occ, allDay: false, start: start.toISOString(), end: end.toISOString() };
  const mv = getMoves(), prev = mv[key];
  const { start: _s, end: _e, id: _i, origId: _o, pending: _p, ...rest } = ev;
  mv[key] = { uid: ev.uid, occ, start: start.toISOString(), end: end.toISOString(), at: Date.now(), ev: rest };
  setMoves(mv); render();
  toast('Moviendo en iCloud…');
  try {
    await caldavCall('/caldav/move', body);
    toast(`✓ «${ev.title}» movido en tu calendario de iCloud`);
    setTimeout(async () => { await refreshFeeds(true); render(); }, 30000);
  } catch (e) {
    const m2 = getMoves(); if (prev) m2[key] = prev; else delete m2[key]; setMoves(m2); render();
    toast('⚠︎ No se pudo mover en iCloud: ' + e.message, 7000);
  }
}
const evDur = (ev) => Math.max(15, Math.round((ev.end - ev.start) / 60000));

function visibleDays() {
  const start = viewDays === 7 ? mondayOf(anchor) : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  return Array.from({ length: viewDays }, (_, i) => addDays(start, i));
}
const hourPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 48;
const ppm = () => hourPx() / 60;
const snap = (m) => Math.round(m / SNAP) * SNAP;
const dayStartMin = () => state.settings.dayStart * 60;
const dayEndMin = () => state.settings.dayEnd * 60;

function sortTasks(list) {
  return list.sort((a, b) => (PRIO_RANK[a.priority || ''] - PRIO_RANK[b.priority || '']) || ((a.order || 0) - (b.order || 0)));
}
const isScheduled = (t) => !!(t.date && t.start);

/** Bloques ocupados/visibles de un día. */
function itemsForDay(dateStr, fe) {
  const timed = [], allDay = [];
  for (const w of state.work.events) {
    if (w.date !== dateStr) continue;
    if (w.kind === 'festivo') allDay.push({ type: 'festivo', title: w.title, date: dateStr, ref: w });
    else timed.push({ type: 'trabajo', date: dateStr, s: hm2min(w.start), e: hm2min(w.end), title: w.title, sub: [w.trip ? `Viaje ${w.tripDay}/${w.tripDays}` : 'Trabajo', w.detail].filter(Boolean).join(' · '), ref: w });
  }
  const d0 = parseYMD(dateStr), d1 = addDays(d0, 1);
  for (const f of fe) {
    if (!(f.start < d1 && f.end > d0)) continue;
    if (f.allDay) { allDay.push({ type: f.category, title: f.title, ref: f, date: dateStr, allDay: true }); continue; }
    const cs = f.start < d0 ? d0 : f.start, ce = f.end > d1 ? d1 : f.end;
    const s = cs.getHours() * 60 + cs.getMinutes();
    const e = ce.getTime() === d1.getTime() ? 1440 : ce.getHours() * 60 + ce.getMinutes();
    timed.push({ type: f.category, date: dateStr, s, e, title: f.title, sub: f.location, ref: f });
  }
  for (const t of liveTasks()) {
    // tareas sin hora pero con fecha (p. ej. de Google Tasks): arriba, en la fila de todo el día
    if (!t.start && !t.done && (t.date || t.due) === dateStr) { allDay.push({ type: 'task', title: t.title, task: t, date: dateStr }); continue; }
    if (t.date !== dateStr || !t.start) continue;
    const s = hm2min(t.start);
    timed.push({ type: 'task', date: dateStr, s, e: s + (t.duration || 60), title: t.title, task: t });
  }
  return { timed, allDay };
}

function layout(items) {
  items.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
  let cluster = [], cols = [], clusterEnd = -1;
  const flush = () => { for (const it of cluster) it.ncol = cols.length; cluster = []; cols = []; };
  for (const it of items) {
    if (it.s >= clusterEnd) { flush(); clusterEnd = -1; }
    let c = cols.findIndex((end) => end <= it.s);
    if (c < 0) { c = cols.length; cols.push(0); }
    cols[c] = it.e; it.col = c; cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();
  return items;
}

// ======================================================================
// Render: semana
// ======================================================================
function renderWeek() {
  const days = visibleDays();
  const n = days.length;
  document.documentElement.style.setProperty('--days', n);
  const today = toYMD(new Date());
  const first = days[0], last = days[n - 1];
  $('#range-label').textContent = first.getMonth() === last.getMonth()
    ? `${first.getDate()}–${last.getDate()} ${MONTHS[first.getMonth()]} ${first.getFullYear()}`
    : `${first.getDate()} ${MONTHS[first.getMonth()].slice(0, 3)} – ${last.getDate()} ${MONTHS[last.getMonth()].slice(0, 3)} ${last.getFullYear()}`;

  const colW = ($('#cal').clientWidth - 52) / n;
  const compact = colW < 80;
  $('#cal').classList.toggle('compact', compact);
  document.querySelectorAll('#view-seg button').forEach((b) => b.classList.toggle('on', +b.dataset.days === n));
  $('#cal-head').replaceChildren(el('div'), ...days.map((d) => {
    const ds = toYMD(d), wk = d.getDay() === 0 || d.getDay() === 6;
    return el('div', { class: `dh${ds === today ? ' today' : ''}${wk ? ' weekend' : ''}`, title: fmtDay(ds), onclick: () => { if (n > 1) { setView(1); goTo(d); } } },
      el('div', { class: 'dow', text: compact ? DOW[d.getDay()].slice(0, 1).toUpperCase() : DOW[d.getDay()] }), el('div', { class: 'dnum', text: d.getDate() }));
  }));

  const fe = calEvents(first, addDays(last, 1));
  const perDay = days.map((d) => itemsForDay(toYMD(d), fe));

  $('#cal-allday').replaceChildren(el('div', { class: 'gutter' }), ...perDay.map((p) =>
    el('div', { class: 'ad' }, p.allDay.map((a) => el('button', { type: 'button', class: `chip ${a.type}`, title: a.title, text: (a.type === 'task' ? '☐ ' : '') + a.title, onclick: () => detailSheet(a) })))));

  const grid = $('#cal-grid');
  const hours = el('div', { class: 'hours' });
  for (let h = state.settings.dayStart; h < state.settings.dayEnd; h++) hours.append(el('div', { class: 'hl', text: h === state.settings.dayStart ? '' : `${h}:00` }));
  const height = (dayEndMin() - dayStartMin()) * ppm();
  const cols = days.map((d, i) => {
    const ds = toYMD(d);
    const col = el('div', { class: `day-col${ds === today ? ' today' : ''}${d.getDay() % 6 === 0 ? ' weekend' : ''}`, dataset: { date: ds }, style: { height: height + 'px' } });
    for (const it of layout(perDay[i].timed)) col.append(renderBlock(it));
    if (ds === today) {
      const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
      if (m >= dayStartMin() && m <= dayEndMin()) col.append(el('div', { class: 'now-line', style: { top: (m - dayStartMin()) * ppm() + 'px' } }));
    }
    return col;
  });
  grid.replaceChildren(hours, ...cols);
  const sc = $('#cal-scroll'), sw = sc.offsetWidth - sc.clientWidth;
  $('#cal-head').style.paddingRight = $('#cal-allday').style.paddingRight = sw + 'px';
}

function renderBlock(it) {
  const s = Math.max(it.s, dayStartMin()), e = Math.min(it.e, dayEndMin());
  const top = (s - dayStartMin()) * ppm();
  const h = Math.max((e - s) * ppm(), 16) - 1;
  const w = 100 / it.ncol;
  const style = { top: top + 'px', height: h + 'px', left: `calc(${it.col * w}% + 1px)`, width: `calc(${w}% - 3px)` };
  if (e <= s) style.display = 'none';
  const time = `${min2hm(it.s % 1440)}–${min2hm(Math.min(it.e, 1440) % 1440 || 0).replace(/^00:00$/, '24:00')}`;
  if (it.type !== 'task') {
    const movable = !!(it.ref?.feed && caldavOn());
    const b = el('div', { class: `ev ${it.type}${movable ? ' movable' : ''}${it.ref?.pending ? ' pending' : ''}${conflictIds.has(it.ref?.id) ? ' conflict' : ''}`, style, title: `${it.title}\n${time}${it.sub ? '\n' + it.sub : ''}`, onclick: () => { if (!suppressClick && !moveMode) detailSheet(it); } },
      el('div', { class: 't', text: it.title }), el('div', { class: 's', text: [time, it.sub].filter(Boolean).join(' · ') }));
    if (movable) {
      const ev = it.ref, pseudo = { id: ev.id, title: ev.title, duration: evDur(ev), start: min2hm(it.s) };
      b.addEventListener('pointerdown', (e) => { lastPointerType = e.pointerType; press(e, { type: 'move', task: pseudo, event: ev, el: b }); });
    }
    return b;
  }
  const t = it.task;
  const blk = el('div', { class: `ev task${t.done ? ' done' : ''}${h < 34 ? ' short' : ''}${conflictIds.has(t.id) ? ' conflict' : ''}`, style, dataset: { id: t.id }, title: `${t.title}\n${time} (${fmtDur(t.duration)})\nDoble clic para editar · arrastra para mover` },
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'ck', 'aria-label': t.done ? 'Marcar pendiente' : 'Marcar hecha', text: t.done ? '✓' : '', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); toggleDone(t); } }),
      el('div', { class: 't', text: t.title || '(sin título)' })),
    el('div', { class: 's', text: time }),
    el('div', { class: 'rz', onpointerdown: (e) => press(e, { type: 'resize', task: t, el: blk }) }));
  blk.addEventListener('pointerdown', (e) => press(e, { type: 'move', task: t, el: blk }));
  // un toque/clic → detalle con acciones; doble clic (ratón) → editor completo
  let clickT;
  blk.addEventListener('click', (e) => {
    if (suppressClick || moveMode || e.target.closest('.ck,.rz')) return;
    if (lastPointerType === 'touch') { taskSheet(t.id); return; }
    clearTimeout(clickT); clickT = setTimeout(() => taskSheet(t.id), 240);
  });
  blk.addEventListener('dblclick', (e) => { if (lastPointerType !== 'touch') { clearTimeout(clickT); e.stopPropagation(); taskModal(state.tasks[t.id]); } });
  return blk;
}

// ======================================================================
// Render: lateral y pendientes
// ======================================================================
function card(t, { compact = false } = {}) {
  const today = toYMD(new Date());
  const meta = [];
  if (t.category) meta.push(el('span', { class: `tag cat-${t.category}`, text: t.category }));
  meta.push(el('span', { class: 'tag', text: fmtDur(t.duration || 60) }));
  if (isScheduled(t)) meta.push(el('span', { class: 'tag when', text: `${fmtDay(t.date)} ${t.start}` }));
  if (t.due) meta.push(el('span', { class: `tag${t.due < today && !t.done ? ' overdue' : ''}`, text: `límite ${fmtDay(t.due)}` }));
  if (t.google) meta.push(el('span', { class: 'tag', title: 'Importada de Google Tasks', text: 'G' }));
  const c = el('div', { class: `card${t.done ? ' done' : ''}`, dataset: { id: t.id } },
    el('button', { type: 'button', class: 'ck', text: t.done ? '✓' : '', 'aria-label': 'Hecha', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); toggleDone(t); } }),
    el('div', { class: 'body' }, el('div', { class: 'ct', text: t.title || '(sin título)' }), el('div', { class: 'meta' }, meta)),
    !compact && !t.done ? el('button', { type: 'button', class: 'btn small go', text: isScheduled(t) ? 'Reprogramar' : 'Programar', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); taskModal(t, { focusSchedule: true }); } }) : null);
  c.addEventListener('pointerdown', (e) => press(e, { type: 'card', task: t, el: c }));
  c.addEventListener('click', () => { if (!suppressClick) taskSheet(t.id); });
  return c;
}

function renderSide() {
  const list = sortTasks(liveTasks().filter((t) => !t.done && !isScheduled(t)));
  $('#side-list').replaceChildren(...(list.length ? list.map((t) => card(t, { compact: true })) : [el('div', { class: 'empty', text: 'Nada pendiente de programar 🎉' })]));
  $('#tray-list').replaceChildren(...(list.length ? list.map((t) => card(t, { compact: true })) : [el('div', { class: 'empty', text: 'Nada pendiente de programar 🎉 · pulsa + para crear una tarea' })]));
  $('#tray-title').textContent = list.length ? `Por programar (${list.length})` : 'Nada por programar · pulsa + para crear una tarea';
  $('#tray').classList.toggle('empty', !list.length);
  $('#pending-count').textContent = list.length || '';
}

function renderKanban() {
  const cat = $('#filter-cat').value, showSched = $('#filter-scheduled').checked, showDone = $('#filter-done').checked;
  const tasks = liveTasks().filter((t) => (showDone || !t.done) && (showSched || !isScheduled(t) || t.done && showDone)
    && (!cat || (cat === '-' ? !t.category : t.category === cat)));
  $('#kanban').replaceChildren(...PRIORITIES.map((p) => {
    const items = sortTasks(tasks.filter((t) => (t.priority || '') === p.id));
    return el('div', { class: 'kcol', dataset: { prio: p.id } },
      el('div', { class: 'kcol-head' }, el('span', {}, el('i', { class: `p p-${p.id}` }), p.label), el('span', { class: 'n', text: items.length })),
      el('div', { class: 'kcol-list' }, items.length ? items.map((t) => card(t)) : el('div', { class: 'empty', text: 'Arrastra tareas aquí' })));
  }));
}

function renderFilters() {
  const sel = $('#filter-cat'), v = sel.value;
  sel.replaceChildren(el('option', { value: '', text: 'Todas las categorías' }), ...CATEGORIES.map((c) => el('option', { value: c, text: c })), el('option', { value: '-', text: 'Sin categoría' }));
  sel.value = v;
}

// ======================================================================
// Solapes del trabajo con otras cosas
// ======================================================================
const DISMISS_KEY = 'cfs.conflicts.dismissed', SEEN_KEY = 'cfs.conflicts.seen';
const readSet = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k)) || []); } catch { return new Set(); } };
const writeSet = (k, set) => { try { localStorage.setItem(k, JSON.stringify([...set].slice(-500))); } catch {} };
let conflicts = [], conflictIds = new Set();

function computeConflicts() {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const today = toYMD(from);
  const work = state.work.events.filter((w) => w.kind === 'trabajo' && w.date >= today);
  if (!work.length) return [];
  const to = addDays(parseYMD(work.reduce((m, w) => (w.date > m ? w.date : m), today)), 1);
  const fe = calEvents(from, to).filter((f) => !f.allDay);
  const tasks = liveTasks().filter((t) => isScheduled(t) && !t.done && t.date >= today);
  const at = (date, hm) => { const d = parseYMD(date); d.setMinutes(hm2min(hm)); return d; };
  const out = [];
  const wk = (w) => ({ id: w.id, title: w.title, detail: w.detail, start: w.start, end: w.end });
  work.forEach((w, i) => {
    const ws = at(w.date, w.start), we = at(w.date, w.end);
    for (const f of fe) if (f.start < we && f.end > ws) out.push({ key: `${w.id}|${f.id}`, date: w.date, kind: 'cita', work: wk(w), other: { id: f.id, type: f.category, title: f.title, start: f.start, end: f.end } });
    for (const t of tasks) {
      if (t.date !== w.date) continue;
      const ts = at(t.date, t.start), te = new Date(ts.getTime() + (t.duration || 60) * 60000);
      if (ts < we && te > ws) out.push({ key: `${w.id}|${t.id}`, date: w.date, kind: 'tarea', work: wk(w), other: { id: t.id, type: 'task', title: t.title, start: ts, end: te, task: t } });
    }
    for (const w2 of work.slice(i + 1)) {
      if (w2.date !== w.date || w2.title === w.title) continue;
      if (at(w2.date, w2.start) < we && at(w2.date, w2.end) > ws) out.push({ key: `${w.id}|${w2.id}`, date: w.date, kind: 'trabajo', work: wk(w), other: { id: w2.id, type: 'trabajo', title: `${w2.title} ${w2.detail || ''}`.trim(), start: at(w2.date, w2.start), end: at(w2.date, w2.end) } });
    }
  });
  const dismissed = readSet(DISMISS_KEY);
  return out.filter((c) => !dismissed.has(c.key)).sort((a, b) => a.date.localeCompare(b.date));
}

let notifyT;
function updateConflicts() {
  conflicts = computeConflicts();
  conflictIds = new Set(conflicts.flatMap((c) => [c.work.id, c.other.id]));
  const btn = $('#conflict-btn');
  btn.hidden = !conflicts.length;
  $('#conflict-count').textContent = conflicts.length;
  // avisar de los nuevos (solo citas y trabajo; las tareas las mueves tú)
  clearTimeout(notifyT);
  notifyT = setTimeout(() => {
    const seen = readSet(SEEN_KEY);
    const fresh = conflicts.filter((c) => c.kind !== 'tarea' && !seen.has(c.key));
    conflicts.forEach((c) => seen.add(c.key)); writeSet(SEEN_KEY, seen);
    if (!fresh.length) return;
    const c = fresh[0];
    const msg = fresh.length === 1
      ? `${fmtDay(c.date)}: ${c.work.title} (${c.work.start}–${c.work.end}) choca con “${c.other.title}”`
      : `${fresh.length} solapes nuevos del trabajo con otras cosas. El primero: ${fmtDay(c.date)}, “${c.other.title}”`;
    toast('⚠︎ ' + msg, 7000);
    systemNotify('Solape con el trabajo', msg);
  }, 400);
}

async function systemNotify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: 'icon-512.png', badge: 'icon-180.png', tag: 'conflictos' });
    else new Notification(title, { body, icon: 'icon-512.png' });
  } catch {}
}

const hmOf = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
function conflictsModal() {
  const dismissed = readSet(DISMISS_KEY);
  const rows = conflicts.map((c) => {
    const label = { cita: c.other.type === 'familia' ? 'Luna / familia' : 'Personal', tarea: 'Tarea', trabajo: 'Otro trabajo' }[c.kind];
    const row = el('div', { class: `conflict-row k-${c.other.type}` },
      el('div', { class: 'cr-date', text: fmtDay(c.date) }),
      el('div', { class: 'cr-body' },
        el('div', {}, el('b', { text: `${c.work.title}` }), ` ${c.work.detail || ''} · ${c.work.start}–${c.work.end}`),
        el('div', {}, '↔ ', el('b', { text: c.other.title }), ` · ${hmOf(c.other.start)}–${hmOf(c.other.end)} `, el('span', { class: 'tag', text: label }))),
      el('div', { class: 'cr-actions' },
        el('button', { type: 'button', class: 'btn small', text: 'Ver', onclick: () => { closeModal(); switchTab('week'); goTo(parseYMD(c.date)); } }),
        c.kind === 'tarea' ? el('button', { type: 'button', class: 'btn small', text: '⚡ Mover', title: 'Mover la tarea al próximo hueco libre', onclick: () => {
          const slot = findSlot(c.other.task.duration || 60, c.other.task.id);
          if (!slot) return toast('No hay huecos libres');
          upsertTask({ id: c.other.task.id, ...slot }); toast(`Movida a ${fmtDay(slot.date)} ${slot.start}`); conflictsModal();
        } }) : null,
        el('button', { type: 'button', class: 'btn small', text: 'Ignorar', title: 'No volver a avisar de este solape', onclick: () => { dismissed.add(c.key); writeSet(DISMISS_KEY, dismissed); updateConflicts(); renderWeek(); conflicts.length ? conflictsModal() : closeModal(); } })));
    return row;
  });
  openModal(`⚠︎ Solapes con el trabajo (${conflicts.length})`, [
    el('div', { class: 'muted', text: 'Días de tu programación (FS) que coinciden con citas de tus calendarios, tareas programadas u otro trabajo.' }),
    ...(rows.length ? rows : [el('div', { class: 'empty', text: 'Sin solapes 🎉' })]),
  ], [el('button', { type: 'button', class: 'btn primary', text: 'Cerrar', onclick: closeModal })]);
}

function renderNotice() {
  const n = $('#notice');
  const probs = feedProblems();
  if (!probs.length) { n.hidden = true; return; }
  n.hidden = false;
  n.replaceChildren(el('span', { text: `⚠︎ No se pudo cargar ${probs.map((p) => `«${p.f.name}»`).join(', ')}: ${probs[0].st.error}` }),
    el('button', { type: 'button', class: 'btn small', text: 'Revisar ajustes', onclick: settingsModal }));
}

// ======================================================================
// Hoy: agenda del día elegido y el siguiente, con huecos libres
// ======================================================================
let todayAnchor = null;
function renderToday() {
  const base = todayAnchor || new Date(); base.setHours(0, 0, 0, 0);
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes(), todayStr = toYMD(now);
  const fe = calEvents(base, addDays(base, 2));
  const ps = hm2min(state.settings.planStart || '08:00'), pe = hm2min(state.settings.planEnd || '21:00');
  const out = [];
  // tareas vencidas (fecha límite pasada, sin hacer ni programar)
  const overdue = liveTasks().filter((t) => !t.done && !isScheduled(t) && t.due && t.due < todayStr);
  if (overdue.length && toYMD(base) === todayStr) {
    out.push(el('div', { class: 'ag-day' }, '⏰ Vencidas', el('span', { class: 'muted', text: `${overdue.length}` })));
    for (const t of overdue) out.push(el('button', { type: 'button', class: 'ag-row task', onclick: () => taskSheet(t.id) },
      el('div', { class: 'tm' }, '—'), el('div', { class: 'ti' }, t.title, el('div', { class: 'su', text: 'Fecha límite: ' + fmtDay(t.due) })), el('span')));
  }
  for (let i = 0; i < 2; i++) {
    const d = addDays(base, i), ds = toYMD(d);
    const lab = ds === todayStr ? 'Hoy' : ds === toYMD(addDays(now, 1)) ? 'Mañana' : ds === toYMD(addDays(now, -1)) ? 'Ayer' : '';
    out.push(el('div', { class: 'ag-day' }, lab || fmtDayLong(ds).replace(/^./, (c) => c.toUpperCase()), lab ? el('span', { class: 'muted', text: fmtDayLong(ds) }) : null));
    const { timed, allDay } = itemsForDay(ds, fe);
    const conf = (it) => conflictIds.has(it.ref?.id || it.task?.id);
    for (const a of allDay) out.push(el('button', { type: 'button', class: `ag-row ${a.type}`, onclick: () => detailSheet(a) },
      el('div', { class: 'tm', text: 'Todo el día' }), el('div', { class: 'ti' }, (a.type === 'task' ? '☐ ' : '') + a.title, a.type === 'task' ? el('div', { class: 'su', text: 'Tarea sin hora: tócala para elegir hueco' }) : null), el('span')));
    timed.sort((a, b) => a.s - b.s);
    // huecos libres dentro del horario de planificación
    let cur = ps;
    if (ds === todayStr) cur = Math.max(cur, Math.ceil(nowMin / SNAP) * SNAP);
    const rows = [];
    for (const it of timed) {
      if (it.s - cur >= 30 && it.s > ps && cur < pe) rows.push({ free: [cur, Math.min(it.s, pe)] });
      rows.push({ it });
      cur = Math.max(cur, it.e);
    }
    if (pe - cur >= 30) rows.push({ free: [cur, pe] });
    if (!timed.length && !allDay.length) out.push(el('div', { class: 'ag-empty', text: 'Nada programado.' }));
    for (const r of rows) {
      if (r.free) {
        const [a, b] = r.free;
        out.push(el('div', { class: 'ag-free' }, el('span', { text: `Libre ${min2hm(a)}–${endHM(b)} · ${fmtDur(b - a)}` }),
          el('button', { type: 'button', class: 'btn small', text: '+ Tarea aquí', onclick: () => taskModal(null, { date: ds, start: min2hm(a), duration: Math.min(60, b - a) }) })));
        continue;
      }
      const it = r.it, t = it.task;
      const isNow = ds === todayStr && it.s <= nowMin && it.e > nowMin, past = ds === todayStr && it.e <= nowMin;
      out.push(el('button', { type: 'button', class: `ag-row ${it.type}${t?.done ? ' done' : ''}${isNow ? ' now' : ''}${past ? ' past' : ''}`, onclick: () => detailSheet(it) },
        el('div', { class: 'tm' }, min2hm(it.s), el('small', { text: endHM(Math.min(it.e, 1440)) })),
        el('div', { class: 'ti' }, (t ? (t.done ? '✓ ' : '☐ ') : '') + it.title,
          el('div', { class: 'su', text: [it.type === 'trabajo' ? it.sub : t ? fmtDur(t.duration || 60) : (CAT_LABEL[it.type] || '') + (it.ref?.location ? ' · ' + it.ref.location : '')].filter(Boolean).join(' · ') }),
          conf(it) ? el('div', { class: 'ag-warn', text: '⚠︎ Se solapa con el trabajo' }) : null),
        isNow ? el('span', { class: 'tag', text: 'Ahora' }) : el('span')));
    }
  }
  $('#agenda').replaceChildren(...out);
}

function render() {
  renderNotice();
  updateConflicts();
  updateExcelBtn();
  renderWeek();
  renderSide();
  if (tab === 'backlog') renderKanban();
  if (tab === 'today') renderToday();
}

// ======================================================================
// Arrastrar / redimensionar (ratón y táctil)
// ======================================================================
let pressSt = null, drag = null, suppressClick = false, lastTap = { key: '', t: 0 };

function press(e, info) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  lastPointerType = e.pointerType;
  e.stopPropagation();
  if (pressSt) cancelPress();
  pressSt = { x: e.clientX, y: e.clientY, info, touch: e.pointerType !== 'mouse', id: e.pointerId };
  if (info.type === 'resize') { e.preventDefault(); startDrag(e); return; }
  if (pressSt.touch) pressSt.timer = setTimeout(() => { if (pressSt) { navigator.vibrate?.(12); startDrag({ clientX: pressSt.x, clientY: pressSt.y }); } }, 320);
}
function cancelPress() { if (pressSt?.timer) clearTimeout(pressSt.timer); pressSt = null; }

window.addEventListener('pointermove', (e) => {
  if (!pressSt) return;
  if (drag) { e.preventDefault(); moveDrag(e); return; }
  const d = Math.hypot(e.clientX - pressSt.x, e.clientY - pressSt.y);
  if (pressSt.touch) { if (d > 8) cancelPress(); }
  else if (d > 4) startDrag(e);
}, { passive: false });
window.addEventListener('pointerup', (e) => {
  if (!pressSt) return;
  if (drag) { endDrag(e); }
  else if (pressSt.touch) handleTap(pressSt.info);
  cancelPress();
});
window.addEventListener('pointercancel', () => { if (drag) abortDrag(); cancelPress(); });
document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });

function handleTap(info) {
  const key = info.type + (info.task?.id || info.date || '');
  const now = Date.now();
  lastTap = { key, t: now };
}

function startDrag(e) {
  const info = pressSt.info;
  if (pressSt.touch && info.el) info.el.classList.add('lifted');
  if (pressSt.timer) clearTimeout(pressSt.timer);
  drag = { ...info, x: e.clientX, y: e.clientY };
  document.body.classList.add('is-dragging');
  if (info.type === 'move') {
    const r = info.el.getBoundingClientRect();
    drag.grab = Math.max(0, (pressSt.y - r.top) / ppm());
    drag.inCal = true;
    info.el.classList.add('dragging');
    drag.ghost = info.el.cloneNode(true);
    drag.ghost.classList.remove('dragging', 'lifted', 'pending'); drag.ghost.classList.add('ghost');
    Object.assign(drag.ghost.style, { left: '2px', width: 'calc(100% - 6px)' });
  } else if (info.type === 'resize') {
    drag.start = hm2min(info.task.start);
    drag.inCal = true;
    // mantener la distancia entre el dedo y el borde inferior (el borde sigue al dedo)
    drag.rOff = (info.el.getBoundingClientRect().bottom - pressSt.y) / ppm();
  } else if (info.type === 'card') {
    info.el.classList.add('dragging-src');
    drag.float = el('div', { class: 'float-card', text: info.task.title || '(sin título)' });
    document.body.append(drag.float);
    drag.grab = 0;
    const dur = info.task.duration || 60;
    drag.ghost = el('div', { class: 'ev task ghost', style: { left: '2px', width: 'calc(100% - 6px)', height: dur * ppm() - 1 + 'px' } },
      el('div', { class: 't', text: info.task.title }), el('div', { class: 's' }));
  } else if (info.type === 'create') {
    drag.box = el('div', { class: 'sel-box' });
    info.col.append(drag.box);
  }
  drag.scrollTimer = setInterval(autoScroll, 30);
  moveDrag(e);
}

function autoScroll() {
  if (!drag) return;
  const sc = $('#cal-scroll'); const r = sc.getBoundingClientRect();
  if (drag.x < r.left || drag.x > r.right) return;
  // solo cuando el dedo/ratón ya está dentro del calendario (al arrastrar desde la bandeja de abajo no debe desplazarse solo)
  if (!drag.inCal) return;
  const edge = 36;
  if (drag.y < r.top + edge && drag.y > r.top - 40) sc.scrollTop -= 10;
  else if (drag.y > r.bottom - edge && drag.y < r.bottom + 40) sc.scrollTop += 10;
  else return;
  moveDrag({ clientX: drag.x, clientY: drag.y });
}

function colAt(x, y) {
  const elx = document.elementFromPoint(x, y);
  return elx?.closest?.('.day-col') || null;
}
function minAt(col, y) { return (y - col.getBoundingClientRect().top) / ppm() + dayStartMin(); }

function moveDrag(e) {
  drag.x = e.clientX; drag.y = e.clientY;
  const t = drag.task;
  if (drag.type === 'resize') {
    const col = drag.el.parentElement;
    const end = Math.max(drag.start + SNAP, snap(minAt(col, e.clientY) + (drag.rOff || 0)));
    drag.duration = Math.min(end, 1440) - drag.start;
    drag.el.style.height = drag.duration * ppm() - 1 + 'px';
    drag.el.querySelector('.s').textContent = `${t.start}–${min2hm(drag.start + drag.duration)} · ${fmtDur(drag.duration)}`;
    return;
  }
  if (drag.type === 'create') {
    const a = snap(minAt(drag.col, pressSt.y) - SNAP / 2), b = snap(minAt(drag.col, e.clientY) + SNAP / 2);
    drag.s = Math.max(dayStartMin(), Math.min(a, b)); drag.e = Math.min(dayEndMin(), Math.max(a + SNAP, b));
    Object.assign(drag.box.style, { top: (drag.s - dayStartMin()) * ppm() + 'px', height: (drag.e - drag.s) * ppm() + 'px' });
    drag.box.textContent = `${min2hm(drag.s)}–${min2hm(drag.e)}`;
    return;
  }
  if (drag.float) { drag.float.style.left = e.clientX + 12 + 'px'; drag.float.style.top = e.clientY + 8 + 'px'; }
  // sobre el calendario
  const col = colAt(e.clientX, e.clientY);
  document.querySelectorAll('.kcol.over').forEach((k) => k.classList.remove('over'));
  drag.dropLine?.remove();
  if (col) drag.inCal = true;
  if (col && drag.ghost) {
    const dur = t.duration || 60;
    let m = snap(minAt(col, e.clientY) - (drag.type === 'card' ? Math.min(dur, 60) / 2 : drag.grab));
    m = Math.max(0, Math.min(1440 - dur, m));
    drag.target = { date: col.dataset.date, start: min2hm(m) };
    if (drag.ghost.parentElement !== col) col.append(drag.ghost);
    drag.ghost.style.top = (m - dayStartMin()) * ppm() + 'px';
    drag.ghost.querySelector('.s').textContent = `${fmtDay(col.dataset.date)} · ${min2hm(m)}–${min2hm(m + dur)}`;
    if (drag.float) drag.float.style.display = 'none';
    return;
  }
  drag.ghost?.remove();
  drag.target = null;
  if (drag.float) drag.float.style.display = '';
  // sobre el tablero de prioridades
  if (drag.type === 'card') {
    const k = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.kcol');
    if (k) {
      k.classList.add('over');
      const list = k.querySelector('.kcol-list');
      const cards = [...list.querySelectorAll('.card')].filter((c) => c.dataset.id !== t.id);
      let idx = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      if (idx < 0) idx = cards.length;
      drag.dropLine = el('div', { class: 'drop-line' });
      if (cards[idx]) list.insertBefore(drag.dropLine, cards[idx]); else list.append(drag.dropLine);
      drag.kTarget = { prio: k.dataset.prio, before: cards[idx]?.dataset.id, after: cards[idx - 1]?.dataset.id };
    } else drag.kTarget = null;
  }
}

function cleanupDrag() {
  clearInterval(drag.scrollTimer);
  drag.ghost?.remove(); drag.float?.remove(); drag.box?.remove(); drag.dropLine?.remove();
  drag.el?.classList.remove('dragging', 'dragging-src', 'lifted');
  document.querySelectorAll('.kcol.over').forEach((k) => k.classList.remove('over'));
  document.body.classList.remove('is-dragging');
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 50);
}
function abortDrag() { cleanupDrag(); drag = null; render(); }

function endDrag() {
  const d = drag; cleanupDrag(); drag = null;
  if (d.type === 'resize') { if (d.duration) upsertTask({ id: d.task.id, duration: d.duration }); else render(); return; }
  if (d.type === 'create') { if (d.e > d.s) taskModal(null, { date: d.col.dataset.date, start: min2hm(d.s), duration: d.e - d.s }); return; }
  if (d.target && d.event) {
    const st = parseYMD(d.target.date); st.setMinutes(hm2min(d.target.start));
    if (st.getTime() === d.event.start.getTime()) { render(); return; }
    moveEvent(d.event, st, new Date(st.getTime() + (d.event.end - d.event.start)));
    return;
  }
  if (d.target) { upsertTask({ id: d.task.id, ...d.target }); toast(`“${d.task.title}” → ${fmtDay(d.target.date)} ${d.target.start}`); return; }
  if (d.kTarget) {
    const ord = (id) => state.tasks[id]?.order || 0;
    const { before, after, prio } = d.kTarget;
    let order;
    if (before && after) order = (ord(before) + ord(after)) / 2;
    else if (before) order = ord(before) - 1000;
    else if (after) order = ord(after) + 1000;
    else order = Date.now();
    upsertTask({ id: d.task.id, priority: prio, order });
    return;
  }
  render();
}

// crear arrastrando en hueco vacío (ratón) o doble clic / doble toque
$('#cal-grid').addEventListener('pointerdown', (e) => {
  const col = e.target.closest('.day-col');
  if (!col || e.target !== col) return;
  lastPointerType = e.pointerType;
  if (e.pointerType === 'mouse') { if (e.button === 0) press(e, { type: 'create', col }); return; }
  // doble toque en hueco vacío
  const now = Date.now(), key = 'slot' + col.dataset.date;
  if (lastTap.key === key && now - lastTap.t < 380 && Math.abs(lastTap.y - e.clientY) < 30) {
    lastTap = { key: '', t: 0 };
    newTaskAt(col, e.clientY);
  } else lastTap = { key, t: now, y: e.clientY };
});
$('#cal-grid').addEventListener('dblclick', (e) => {
  const col = e.target.closest('.day-col');
  if (!col || e.target !== col || lastPointerType === 'touch') return;
  newTaskAt(col, e.clientY);
});
function newTaskAt(col, y) {
  const m = Math.floor(minAt(col, y) / 30) * 30;
  taskModal(null, { date: col.dataset.date, start: min2hm(Math.max(0, Math.min(1380, m))), duration: 60 });
}

// ======================================================================
// Acciones
// ======================================================================
function toggleDone(t) {
  const done = !t.done;
  upsertTask({ id: t.id, done, doneAt: done ? Date.now() : null });
  if (t.google && G.isSignedIn()) G.setTaskCompleted(t.google.listId, t.google.taskId, done).catch((e) => toast('Google Tasks: ' + e.message));
}

/** Busca el próximo hueco libre de `duration` minutos. */
function findSlot(duration, excludeId) {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const horizon = 60;
  const fe = calEvents(from, addDays(from, horizon + 1));
  const ps = hm2min(state.settings.planStart || '08:00'), pe = hm2min(state.settings.planEnd || '21:00');
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  for (let i = 0; i <= horizon; i++) {
    const ds = toYMD(addDays(from, i));
    const busy = itemsForDay(ds, fe).timed.filter((it) => !(it.task && it.task.id === excludeId)).map((it) => [it.s, it.e]).sort((a, b) => a[0] - b[0]);
    let cur = i === 0 ? Math.max(ps, Math.ceil((nowMin + 5) / SNAP) * SNAP) : ps;
    for (const [s, e] of busy) {
      if (s - cur >= duration) break;
      if (e > cur) cur = Math.ceil(e / SNAP) * SNAP;
    }
    if (cur + duration <= pe) return { date: ds, start: min2hm(cur) };
  }
  return null;
}

// ======================================================================
// Modales
// ======================================================================
const modal = $('#modal'), mform = $('#modal-form');
let onSubmit = null;
mform.noValidate = true; // iOS bloquea en silencio el envío si un campo no pasa su validación
mform.addEventListener('submit', (e) => { e.preventDefault(); onSubmit?.(); });
function openModal(title, body, foot, submit, { sheet = false } = {}) {
  onSubmit = submit;
  modal.classList.toggle('sheet', sheet);
  mform.replaceChildren(
    el('div', { class: 'm-head' }, el('h2', { text: title }), el('button', { type: 'button', class: 'btn icon', 'aria-label': 'Cerrar', text: '×', onclick: closeModal })),
    el('div', { class: 'm-body' }, body), el('div', { class: 'm-foot' }, foot));
  if (!modal.open) modal.showModal();
}
function closeModal() { modal.close(); onSubmit = null; }
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
const field = (label, input) => el(input.matches?.('input,select,textarea') ? 'label' : 'div', { class: 'field' }, el('span', { text: label }), input);

function seg(options, value, onPick) {
  const wrap = el('div', { class: 'seg' });
  const draw = (v) => wrap.replaceChildren(...options.map((o) => el('button', { type: 'button', class: o.id === v ? 'on' : '', text: o.label, onclick: () => { value = o.id; draw(o.id); onPick(o.id); } })));
  draw(value);
  return wrap;
}

function durationSelect(value) {
  const s = el('select', {});
  const vals = new Set([15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 420, 480, value]);
  for (const v of [...vals].sort((a, b) => a - b)) s.append(el('option', { value: v, text: fmtDur(v) }));
  s.value = value;
  return s;
}

function taskModal(t, preset = {}) {
  const isNew = !t;
  const d = { title: '', notes: '', date: '', start: '', duration: 60, priority: '', category: '', due: '', done: false, ...(t || {}), ...preset };
  const title = el('input', { class: 'title-input', value: d.title, placeholder: 'Título de la tarea', required: true });
  const notes = el('textarea', { placeholder: 'Notas' }); notes.value = d.notes || '';
  const date = el('input', { type: 'date', value: d.date || '' });
  const start = el('input', { type: 'time', value: d.start || '' });
  const dur = durationSelect(d.duration || 60);
  const due = el('input', { type: 'date', value: d.due || '' });
  const done = el('input', { type: 'checkbox' }); done.checked = !!d.done;
  let prio = d.priority || '', cat = d.category || '';
  const slotBtn = el('button', { type: 'button', class: 'btn small', text: '⚡ Próximo hueco libre', onclick: () => {
    const s = findSlot(+dur.value, t?.id);
    if (!s) return toast('No hay huecos en los próximos 60 días');
    date.value = s.date; start.value = s.start; toast(`Hueco: ${fmtDay(s.date)} ${s.start}`);
  } });
  const unBtn = el('button', { type: 'button', class: 'btn small', text: 'Quitar del calendario', onclick: () => { date.value = ''; start.value = ''; } });
  const body = [
    title,
    el('div', { class: 'section' }, el('h3', { text: 'Programación' }),
      el('div', { class: 'row3' }, field('Día', date), field('Hora inicio', start), field('Duración', dur)),
      el('div', { class: 'seg' }, slotBtn, unBtn)),
    el('div', { class: 'section' }, el('h3', { text: 'Clasificación' }),
      field('Prioridad', seg(PRIORITIES, prio, (v) => { prio = v; })),
      field('Categoría', seg([...CATEGORIES.map((c) => ({ id: c, label: c })), { id: '', label: 'Ninguna' }], cat, (v) => { cat = v; })),
      el('div', { class: 'row2' }, field('Fecha límite', due), el('label', { class: 'chk', style: { alignSelf: 'end', paddingBottom: '8px' } }, done, ' Hecha'))),
    field('Notas', notes),
    t?.google ? el('div', { class: 'muted', text: 'Importada de Google Tasks. Al marcarla como hecha se completa también allí.' }) : null,
  ];
  const foot = [
    !isNew ? el('div', { class: 'left' }, el('button', { type: 'button', class: 'btn danger', text: 'Eliminar', onclick: () => { if (confirm('¿Eliminar esta tarea?')) { deleteTask(t.id); closeModal(); toast('Tarea eliminada'); } } })) : null,
    el('button', { type: 'button', class: 'btn', text: 'Cancelar', onclick: closeModal }),
    el('button', { type: 'submit', class: 'btn primary', text: 'Guardar' }),
  ];
  openModal(isNew ? 'Nueva tarea' : 'Editar tarea', body, foot, () => {
    if (!title.value.trim()) { title.focus(); return; }
    let st = start.value, dt = date.value;
    if (dt && !st) st = '09:00';
    if (!dt) st = '';
    const wasDone = !!t?.done;
    const saved = upsertTask({ id: t?.id, title: title.value.trim(), notes: notes.value, date: dt || null, start: st || null, duration: +dur.value, priority: prio, category: cat, due: due.value, done: done.checked, doneAt: done.checked ? (t?.doneAt || Date.now()) : null });
    if (saved.google && wasDone !== done.checked && G.isSignedIn()) G.setTaskCompleted(saved.google.listId, saved.google.taskId, done.checked).catch(() => {});
    closeModal();
    if (dt && st && tab === 'week') goTo(parseYMD(dt));
  });
  if (preset.focusSchedule) setTimeout(() => date.focus(), 50); else if (isNew) setTimeout(() => title.focus(), 50);
}

const CAT_LABEL = { trabajo: 'Trabajo · programación anual', familia: 'Luna / familia', personal: 'Personal', festivo: 'Festivo', task: 'Tarea' };
const endHM = (e) => (e >= 1440 ? '24:00' : min2hm(e));

/** Detalle de un evento del calendario (iCloud, trabajo, festivo) o de una tarea. */
function detailSheet(it) {
  if (it.task) return taskSheet(it.task.id);
  const f = it.ref || {};
  const when = it.allDay || it.s == null ? `${fmtDayLong(it.date)} · todo el día` : `${fmtDayLong(it.date)} · ${min2hm(it.s)}–${endHM(it.e)}`;
  const body = [
    el('div', { class: 'sheet-cat' }, el('i', { class: `sw ${it.type}` }), (CAT_LABEL[it.type] || '') + (f.feed ? ` · calendario «${f.feed}»` : '')),
    el('div', { class: 'sheet-when', text: when }),
  ];
  if (it.type === 'trabajo') {
    if (f.detail) body.push(el('div', {}, el('b', { text: 'Equipo: ' }), f.detail));
    if (f.trip) body.push(el('div', { text: `Viaje de ${f.tripDays} días (día ${f.tripDay} de ${f.tripDays})` }));
  }
  if (f.location) body.push(el('div', {}, '📍 ', f.location));
  if (f.description) body.push(el('div', { class: 'sheet-desc', text: f.description }));
  if (f.url && /^https:\/\//i.test(f.url)) body.push(el('a', { href: f.url, target: '_blank', rel: 'noopener', text: '🔗 Abrir enlace' }));
  if (f.recurring) body.push(el('div', { class: 'muted', text: '↻ Evento que se repite' }));
  const cs = conflicts.filter((c) => c.work.id === f.id || c.other.id === f.id);
  for (const c of cs) {
    const o = c.work.id === f.id ? c.other : { title: c.work.title, start: null };
    body.push(el('div', { class: 'err', text: `⚠︎ Coincide con «${o.title}»${o.start ? ` (${hmOf(o.start)}–${hmOf(o.end)})` : ` (${c.work.start}–${c.work.end})`}` }));
  }
  if (f.feed && caldavOn() && f.uid) {
    const shift = (ms) => { closeModal(); moveEvent(f, new Date(f.start.getTime() + ms), new Date(f.end.getTime() + ms)); };
    const act = (label, fn, cls = '') => el('button', { type: 'button', class: `btn ${cls}`, text: label, onclick: fn });
    body.push(el('div', { class: 'sheet-actions' },
      act('⇄ Mover: tocar nuevo hueco', () => { closeModal(); enterMoveMode(null, f); }, 'primary'),
      el('div', { class: 'sheet-row' }, act('◀ Día antes', () => shift(-864e5)), act('Día después ▶', () => shift(864e5))),
      f.allDay ? null : el('div', { class: 'sheet-row' }, act('− 15 min', () => shift(-9e5)), act('+ 15 min', () => shift(9e5)), act('− 1 h', () => shift(-36e5)), act('+ 1 h', () => shift(36e5)))));
    body.push(el('div', { class: 'muted', text: (f.recurring || f.recurrenceId || f.occ ? 'Se repite: solo se moverá este día. ' : '') + 'El cambio se guarda en tu calendario de iCloud. También puedes mantenerlo pulsado y arrastrarlo.' }));
    if (f.pending) body.push(el('div', { class: 'muted', text: '⏳ Movido hace poco: iCloud tarda unos minutos en publicar el cambio.' }));
  } else if (f.feed) {
    body.push(el('div', { class: 'muted', text: 'Para moverlo desde aquí, activa «Mover eventos de iCloud» en Ajustes.' }));
  }
  if (it.type === 'trabajo') body.push(el('div', { class: 'muted', text: 'Viene de la programación anual (Excel): no se edita aquí.' }));
  openModal(it.title, body, [
    it.type !== 'festivo' ? el('button', { type: 'button', class: 'btn', text: '+ Tarea relacionada', onclick: () => taskModal(null, { title: it.title, due: it.date }) }) : null,
    el('button', { type: 'button', class: 'btn primary', text: 'Cerrar', onclick: closeModal }),
  ], null, { sheet: true });
}

/** Detalle de una tarea con acciones rápidas (pensado para el móvil). */
function taskSheet(id) {
  const t = state.tasks[id];
  if (!t || t.deleted) return closeModal();
  const sched = isScheduled(t);
  const act = (label, fn, cls = '') => el('button', { type: 'button', class: `btn ${cls}`, text: label, onclick: fn });
  const upd = (patch, msg) => { upsertTask({ id, ...patch }); if (msg) toast(msg); taskSheet(id); };
  const shiftDay = (n) => { const d = toYMD(addDays(parseYMD(t.date), n)); upd({ date: d }, `→ ${fmtDay(d)}`); if (tab === 'week') goTo(parseYMD(d)); };
  const meta = [];
  if (t.priority) meta.push(el('span', { class: 'tag', text: 'Prioridad ' + t.priority }));
  if (t.category) meta.push(el('span', { class: `tag cat-${t.category}`, text: t.category }));
  if (t.due) meta.push(el('span', { class: 'tag', text: 'Fecha límite: ' + fmtDay(t.due) }));
  if (t.google) meta.push(el('span', { class: 'tag', text: 'Google Tasks' }));
  const body = [
    el('div', { class: 'sheet-cat' }, el('i', { class: `sw ${t.done ? 'done' : 'task'}` }), t.done ? 'Tarea hecha' : 'Tarea pendiente'),
    el('div', { class: 'sheet-when', text: sched ? `${fmtDayLong(t.date)} · ${t.start}–${endHM(hm2min(t.start) + (t.duration || 60))} (${fmtDur(t.duration || 60)})` : `Sin hora en el calendario · ${fmtDur(t.duration || 60)}` }),
    meta.length ? el('div', { class: 'meta' }, meta) : null,
    t.notes ? el('div', { class: 'sheet-desc', text: t.notes }) : null,
    el('div', { class: 'sheet-actions' },
      act(t.done ? '↺ Marcar pendiente' : '✓ Marcar hecha', () => { toggleDone(t); taskSheet(id); }, t.done ? '' : 'primary'),
      act(sched ? '⇄ Mover: tocar nuevo hueco' : '📅 Elegir hueco en el calendario', () => { closeModal(); enterMoveMode(id); }),
      act('⚡ Próximo hueco libre', () => {
        const slot = findSlot(t.duration || 60, id);
        if (!slot) return toast('No hay huecos libres en 60 días');
        upd(slot, `→ ${fmtDay(slot.date)} ${slot.start}`); if (tab === 'week') goTo(parseYMD(slot.date));
      }),
      sched ? el('div', { class: 'sheet-row' }, act('◀ Día antes', () => shiftDay(-1)), act('Día después ▶', () => shiftDay(1))) : null,
      sched ? el('div', { class: 'sheet-row' },
        act('− 15 min', () => upd({ start: min2hm(Math.max(0, hm2min(t.start) - 15)) })), act('+ 15 min', () => upd({ start: min2hm(Math.min(1425, hm2min(t.start) + 15)) })),
        act('Más corta', () => upd({ duration: Math.max(15, (t.duration || 60) - 15) })), act('Más larga', () => upd({ duration: (t.duration || 60) + 15 }))) : null,
      sched ? act('Quitar del calendario', () => upd({ date: null, start: null }, 'Vuelve a «Por programar»')) : null),
    el('div', { class: 'muted', text: 'Consejo: en el calendario también puedes mantener pulsada la tarea y arrastrarla, o estirarla desde su borde inferior.' }),
  ];
  openModal(t.title || '(sin título)', body, [
    act('✎ Editar todo', () => taskModal(state.tasks[id])),
    act('Cerrar', closeModal, 'primary'),
  ], null, { sheet: true });
}

// ---------- Modo mover: tocar el hueco de destino ----------
let moveMode = null;
function enterMoveMode(id, ev) {
  const t = ev ? { title: ev.title } : state.tasks[id]; if (!t) return;
  moveMode = ev ? { event: ev } : { id };
  if (tab !== 'week') switchTab('week');
  if (ev) goTo(ev.start); else if (t.date) goTo(parseYMD(t.date));
  document.body.classList.add('move-mode');
  const bar = $('#movebar');
  bar.replaceChildren(el('span', {}, 'Toca el día y la hora para «', el('b', { text: t.title }), '» (puedes cambiar de semana con ‹ ›)'),
    el('button', { type: 'button', class: 'btn small', text: 'Cancelar', onclick: exitMoveMode }));
  bar.hidden = false;
}
function exitMoveMode() { moveMode = null; document.body.classList.remove('move-mode'); $('#movebar').hidden = true; }
const placeAt = (e) => {
  if (!moveMode) return;
  const col = e.target.closest?.('.day-col') || colAt(e.clientX, e.clientY);
  if (!col) return;
  e.stopPropagation(); e.preventDefault();
  if (moveMode.event) {
    const ev = moveMode.event, dur = evDur(ev);
    const m = Math.max(0, Math.min(1440 - dur, Math.floor(minAt(col, e.clientY) / SNAP) * SNAP));
    exitMoveMode();
    const st = parseYMD(col.dataset.date); st.setMinutes(m);
    moveEvent(ev, st, new Date(st.getTime() + (ev.end - ev.start)));
    return;
  }
  const t = state.tasks[moveMode.id], dur = t.duration || 60;
  const m = Math.max(0, Math.min(1440 - dur, Math.floor(minAt(col, e.clientY) / SNAP) * SNAP));
  exitMoveMode();
  upsertTask({ id: t.id, date: col.dataset.date, start: min2hm(m) });
  toast(`“${t.title}” → ${fmtDay(col.dataset.date)} ${min2hm(m)}`);
};
$('#cal-grid').addEventListener('pointerdown', (e) => { if (moveMode) e.stopPropagation(); }, true);
$('#cal-grid').addEventListener('click', placeAt, true);
document.addEventListener('keydown', (e) => { if (moveMode && e.key === 'Escape') exitMoveMode(); });

// ---------- Ajustes ----------
function settingsModal() {
  const s = state.settings;
  const w = state.work;
  const nWork = w.events.filter((e) => e.kind === 'trabajo').length;
  const fileInput = el('input', { type: 'file', accept: '.xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const initials = el('input', { value: s.initials, style: { width: '80px' } });
  const tS = el('input', { type: 'time', value: s.tripStart }), tE = el('input', { type: 'time', value: s.tripEnd });
  const dS = el('input', { type: 'time', value: s.dayWorkStart }), dE = el('input', { type: 'time', value: s.dayWorkEnd });
  const workStatus = el('div', { class: 'muted', text: w.importedAt ? `${nWork} días de trabajo de ${s.initials} cargados de “${w.fileName}” (${new Date(w.importedAt).toLocaleString('es-ES')}).` : 'Aún no has cargado ninguna programación.' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; if (!f) return;
    workStatus.textContent = 'Leyendo…';
    try {
      updateSettings({ initials: initials.value.trim().toUpperCase() || 'FS', tripStart: tS.value, tripEnd: tE.value, dayWorkStart: dS.value, dayWorkEnd: dE.value });
      const n = await importExcel(await f.arrayBuffer(), f.name);
      workStatus.textContent = excelMsg(n, f.name);
    } catch (e) { workStatus.textContent = '⚠︎ ' + e.message; }
  });

  // feeds
  const feeds = s.feeds.map((f) => ({ ...f }));
  const feedList = el('div', { class: 'glist', style: { maxHeight: 'none', background: 'none' } });
  const drawFeeds = () => feedList.replaceChildren(...feeds.map((f, i) => {
    const st = feedStatus(f.id);
    const name = el('input', { value: f.name, placeholder: 'Nombre (p.ej. Familia)', oninput: (e) => { f.name = e.target.value; } });
    const urlErr = el('div', { class: 'err', text: feedUrlError(f.url) });
    const url = el('input', { value: f.url, placeholder: 'webcal://p…-caldav.icloud.com/published/2/…', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', oninput: (e) => { f.url = e.target.value; urlErr.textContent = feedUrlError(f.url); } });
    const cat = el('select', { onchange: (e) => { f.category = e.target.value; } },
      el('option', { value: 'familia', text: 'Luna/Familia' }), el('option', { value: 'personal', text: 'Personal' }), el('option', { value: 'ignorar', text: 'Ignorar' }));
    cat.value = f.category;
    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBottom: '8px', borderBottom: '1px solid var(--line-soft)' } },
      el('div', { class: 'feed' }, name, cat, el('button', { type: 'button', class: 'btn icon small', 'aria-label': 'Quitar', text: '×', onclick: () => { feeds.splice(i, 1); drawFeeds(); } })),
      url, urlErr,
      st ? el('div', { class: 'muted', text: st.ok ? `✓ Actualizado ${new Date(st.at).toLocaleTimeString('es-ES')}` : `⚠︎ ${st.error}` }) : null);
  }));
  drawFeeds();
  const proxy = el('input', { value: s.proxy, placeholder: 'https://ics-proxy.tu-usuario.workers.dev', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', inputmode: 'url' });
  const proxyErr = el('div', { class: 'err' });
  const moveBtn = el('button', { type: 'button', class: 'btn small', text: '↪ Moverlo a Calendarios', onclick: () => {
    feeds.push({ id: uid(), name: feeds.some((f) => f.category === 'familia') ? 'Calendar' : 'Familia', url: proxy.value.trim(), category: feeds.some((f) => f.category === 'familia') ? 'personal' : 'familia' });
    proxy.value = ''; drawFeeds(); showProxyErr(); feedList.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast('Movido a Calendarios. Revisa el nombre y la categoría, y pon la URL del worker en Proxy.', 5000);
  } });
  const showProxyErr = () => { proxyErr.textContent = proxyError(proxy.value); moveBtn.hidden = !isCalendarLink(proxy.value); };
  proxy.addEventListener('input', showProxyErr);
  const excelLink = el('input', { value: s.excelLink || '', placeholder: 'https://www.icloud.com/iclouddrive/…#Programacion_Anual_2026' });
  const linkStatus = el('div', { class: 'muted', text: s.excelLink ? `Actualización diaria activa. Última comprobación: ${lastExcelCheck() ? new Date(lastExcelCheck()).toLocaleString('es-ES') : 'nunca'}.` : 'Sin enlace: la programación solo cambia cuando cargas el archivo a mano.' });
  const localStatus = el('div', { class: 'muted' });
  LF.getHandle().then((h) => { localStatus.textContent = h ? `📌 Archivo recordado: “${h.name}”. Se relee al abrir la app.` : ''; });
  const localBtn = LF.supported ? el('button', { type: 'button', class: 'btn small', text: '📌 Elegir y recordar archivo del ordenador', onclick: async () => {
    try {
      updateSettings({ initials: initials.value.trim().toUpperCase() || 'FS', tripStart: tS.value, tripEnd: tE.value, dayWorkStart: dS.value, dayWorkEnd: dE.value });
      const h = await LF.pick();
      const n = await readLocal(h, { force: true, ask: true });
      localStatus.textContent = `📌 Archivo recordado: “${h.name}”. Se relee al abrir la app.`;
      if (n) workStatus.textContent = excelMsg(n, h.name);
    } catch (e) { if (e.name !== 'AbortError') localStatus.textContent = '⚠︎ ' + e.message; }
  } }) : null;
  const reminder = el('input', { type: 'number', min: 1, max: 60, value: s.reminderDays || 7, style: { width: '70px' } });
  const linkBtn = el('button', { type: 'button', class: 'btn small', text: '↻ Actualizar ahora desde el enlace', onclick: async () => {
    updateSettings({ excelLink: excelLink.value.trim(), proxy: proxy.value.trim() });
    linkStatus.textContent = 'Descargando…';
    try { const n = await refreshExcel(true); linkStatus.textContent = n ? excelMsg(n, 'iCloud Drive') : 'Falta el enlace o el proxy.'; workStatus.textContent = linkStatus.textContent; }
    catch (e) { linkStatus.textContent = '⚠︎ ' + e.message; }
  } });

  const cdToken = el('input', { value: s.caldavToken || '', placeholder: 'código privado (el mismo que PLANNER_TOKEN en Cloudflare)', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const cdStatus = el('div', { class: 'muted', text: s.caldavToken ? 'Configurado. Pulsa «Probar conexión» para comprobarlo.' : 'Sin configurar: los eventos de iCloud solo se pueden ver.' });
  const cdGen = el('button', { type: 'button', class: 'btn small', text: '🎲 Generar código', onclick: () => {
    const a = new Uint8Array(18); crypto.getRandomValues(a);
    cdToken.value = Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 28);
    cdStatus.textContent = 'Copia este código y ponlo en Cloudflare como secreto PLANNER_TOKEN (ver README).';
    navigator.clipboard?.writeText(cdToken.value).then(() => toast('Código copiado'), () => {});
  } });
  const cdTest = el('button', { type: 'button', class: 'btn small', text: '🔌 Probar conexión', onclick: async () => {
    const pErr = proxyError(proxy.value); if (pErr || !proxy.value.trim()) { cdStatus.textContent = '⚠︎ Primero pon bien la URL del proxy (más arriba).'; return; }
    updateSettings({ proxy: proxy.value.trim(), caldavToken: cdToken.value.trim() });
    cdStatus.textContent = 'Conectando con iCloud…';
    try { const r = await caldavCall('/caldav/calendars'); cdStatus.textContent = `✓ Conectado. Calendarios: ${r.calendars.join(', ')}`; render(); }
    catch (e) { cdStatus.textContent = '⚠︎ ' + e.message; }
  } });
  const cdOpen = el('button', { type: 'button', class: 'btn small', text: '🌐 Abrir mi worker', onclick: () => {
    const pErr = proxyError(proxy.value);
    if (pErr || !proxy.value.trim()) { cdStatus.textContent = '⚠︎ Primero pon en «Proxy para iCloud» la URL de tu worker (https://ics-proxy.….workers.dev).'; return; }
    const url = proxy.value.trim().split('?')[0].replace(/\/+$/, '') + '/caldav/calendars';
    cdStatus.textContent = 'Abierto: ' + url + ' — si ves «Código privado incorrecto…», el código nuevo del worker está bien desplegado.';
    window.open(url, '_blank');
  } });
  const clientId = el('input', { value: getClientId(), placeholder: 'xxxx.apps.googleusercontent.com', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const clientErr = el('div', { class: 'err' });
  const gtAuto = el('input', { type: 'checkbox' }); gtAuto.checked = s.gtasksAuto !== false;
  const checkClient = () => { const v = clientId.value.trim(); clientErr.textContent = v && !/\.apps\.googleusercontent\.com$/i.test(normalizeClientId(v)) ? 'No parece un Client ID de Google (termina en .apps.googleusercontent.com).' : ''; };
  clientId.addEventListener('input', checkClient); checkClient();
  const gState = el('div', { class: 'muted', text: G.isSignedIn() ? '✓ Conectado a Google (sincronización activa).' : 'No conectado.' });

  const hStart = el('input', { type: 'number', min: 0, max: 12, value: s.dayStart, style: { width: '70px' } });
  const hEnd = el('input', { type: 'number', min: 13, max: 24, value: s.dayEnd, style: { width: '70px' } });
  const pS = el('input', { type: 'time', value: s.planStart || '08:00' }), pE = el('input', { type: 'time', value: s.planEnd || '21:00' });

  const importJson = el('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  importJson.addEventListener('change', async () => {
    const f = importJson.files[0]; if (!f) return;
    try { const data = JSON.parse(await f.text()); mergeRemote({ ...data, settingsUpdatedAt: Date.now() }); save(); toast('Copia importada'); closeModal(); } catch (e) { toast('Archivo no válido'); }
  });

  const body = [
    el('div', { class: 'section', style: { borderTop: 0, paddingTop: 0 } }, el('h3', { text: '📄 Programación anual (Excel)' }),
      el('div', { class: 'muted', text: 'Elige el Excel de la programación (descargado de Teams). Se marcan los días con tus iniciales: viaje de varios días y jornada de un día. Las celdas tachadas se ignoran. Al cargar otro año se conservan los anteriores.' }),
      fileInput, workStatus,
      localBtn ? el('div', { class: 'muted', text: 'En el ordenador del trabajo (Edge/Chrome): si sincronizas la carpeta de Teams con OneDrive, elige aquí el archivo sincronizado y la app lo releerá sola cada vez que la abras.' }) : null,
      localBtn, localStatus,
      el('div', { class: 'row2' }, field('Recordarme actualizarla cada (días)', reminder), el('span')),
      el('details', {}, el('summary', { class: 'muted', text: 'Alternativa: enlace de iCloud Drive (actualización diaria)' }),
        field('Enlace de iCloud Drive al Excel', excelLink), el('div', { class: 'seg' }, linkBtn,
          el('button', { type: 'button', class: 'btn small', text: '🔍 Ver respuesta del proxy', onclick: () => {
            if (!proxy.value.trim() || !excelLink.value.trim()) return toast('Pega antes el proxy y el enlace');
            window.open(shareUrl(proxy.value, excelLink.value), '_blank');
          } })), linkStatus),
      el('div', { class: 'row2' }, field('Mis iniciales', initials), el('span')),
      el('div', { class: 'row2' }, field('Viaje: desde', tS), field('Viaje: hasta', tE)),
      el('div', { class: 'row2' }, field('Día suelto: desde', dS), field('Día suelto: hasta', dE))),
    el('div', { class: 'section' }, el('h3', { text: '📅 Calendarios de iCloud' }),
      el('div', { class: 'muted' }, 'En el iPhone: Calendario → Calendarios → (i) junto a “Familia” → activa “Calendario público” → Compartir enlace. Repite con “Calendar”. Pega aquí los enlaces.'),
      feedList,
      el('button', { type: 'button', class: 'btn small', text: '+ Añadir calendario', onclick: () => { feeds.push({ id: uid(), name: '', url: '', category: feeds.length ? 'personal' : 'familia' }); drawFeeds(); } }),
      field('Proxy para iCloud: la URL de tu worker de Cloudflare (https://….workers.dev)', proxy), proxyErr, moveBtn),
    el('div', { class: 'section' }, el('h3', { text: '✏️ Mover eventos de iCloud' }),
      el('div', { class: 'muted', text: 'Para mover eventos de tu calendario de Apple desde aquí, tu worker de Cloudflare necesita tu Apple ID y una contraseña específica de app (guardados como secretos allí, nunca en la app). Pasos en el README.' }),
      field('Código privado', cdToken), el('div', { class: 'seg' }, cdGen, cdTest, cdOpen), cdStatus),
    el('div', { class: 'section' }, el('h3', { text: '🔔 Avisos de solapes' }),
      el('div', { class: 'muted', text: 'Al abrir la app (y cada hora con ella abierta) se revisa la programación y tus calendarios. Si un día de trabajo choca con una cita, aparece un aviso y se marca en rojo.' }),
      'Notification' in window ? el('button', { type: 'button', class: 'btn small', text: Notification.permission === 'granted' ? '✓ Notificaciones activadas' : 'Activar notificaciones del sistema', disabled: Notification.permission === 'granted', onclick: async (e) => {
        const r = await Notification.requestPermission(); e.target.textContent = r === 'granted' ? '✓ Notificaciones activadas' : 'Permiso denegado (actívalo en Ajustes del sistema)';
        if (r === 'granted') systemNotify('Planificador', 'Te avisaré aquí cuando el trabajo se solape con otra cosa.');
      } }) : el('div', { class: 'muted', text: 'En iPhone, las notificaciones solo funcionan con la app añadida a la pantalla de inicio.' })),
    el('div', { class: 'section' }, el('h3', { text: '🔄 Google (Tasks + sincronización)' }),
      field('Client ID de OAuth (ver README)', clientId), clientErr, gState,
      el('label', { class: 'chk', style: { color: 'var(--text)' } }, gtAuto, ' Traer automáticamente mis tareas de Google Tasks (las que tienen fecha salen ese día, arriba)'),
      el('div', { class: 'muted', text: 'Google Tasks no comparte la hora de las tareas (solo el día): ponle la hora aquí tocándola → «Elegir hueco».' }),
      el('div', { class: 'seg' },
        el('button', { type: 'button', class: 'btn small', text: G.isSignedIn() ? 'Volver a conectar' : 'Conectar con Google', onclick: async () => { saveClient(); try { await G.signIn(getClientId()); gState.textContent = '✓ Conectado.'; syncNow(true); } catch (e) { gState.textContent = '⚠︎ ' + e.message; } } }),
        G.isSignedIn() ? el('button', { type: 'button', class: 'btn small', text: 'Desconectar', onclick: () => { G.signOut(); gState.textContent = 'Desconectado.'; setSync('off'); } }) : null)),
    el('div', { class: 'section' }, el('h3', { text: '🕘 Horario' }),
      el('div', { class: 'row2' }, field('Calendario visible desde (h)', hStart), field('hasta (h)', hEnd)),
      el('div', { class: 'row2' }, field('Autoprogramar tareas desde', pS), field('hasta', pE))),
    el('div', { class: 'section' }, el('h3', { text: '💾 Copia de seguridad' }),
      el('div', { class: 'seg' },
        el('button', { type: 'button', class: 'btn small', text: 'Exportar JSON', onclick: () => { const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(exportable(), null, 1)], { type: 'application/json' })), download: `planificador-${toYMD(new Date())}.json` }); a.click(); } }),
        el('button', { type: 'button', class: 'btn small', text: 'Importar JSON', onclick: () => importJson.click() }), importJson)),
  ];
  const saveClient = () => { const v = normalizeClientId(clientId.value); clientId.value = v; try { localStorage.setItem(CLIENT_KEY, v); } catch {} G.setClientId(v); };
  showProxyErr();
  openModal('Ajustes', body, [
    el('button', { type: 'button', class: 'btn', text: 'Cancelar', onclick: closeModal }),
    el('button', { type: 'submit', class: 'btn primary', text: 'Guardar' }),
  ], async () => {
    const pErr = proxyError(proxy.value), fErr = feeds.map((f) => feedUrlError(f.url)).find(Boolean);
    if (pErr || fErr) { showProxyErr(); (pErr ? proxy : feedList).scrollIntoView({ block: 'center', behavior: 'smooth' }); toast('⚠︎ Revisa los campos marcados en rojo', 4000); return; }
    saveClient();
    updateSettings({
      initials: initials.value.trim().toUpperCase() || 'FS', tripStart: tS.value, tripEnd: tE.value, dayWorkStart: dS.value, dayWorkEnd: dE.value,
      feeds: feeds.filter((f) => f.url.trim()).map((f) => ({ ...f, url: f.url.trim(), name: f.name.trim() || 'Calendario' })),
      proxy: proxy.value.trim(), excelLink: excelLink.value.trim(), caldavToken: cdToken.value.trim(), gtasksAuto: gtAuto.checked, reminderDays: Math.max(1, +reminder.value || 7),
      dayStart: Math.max(0, Math.min(12, +hStart.value || 6)), dayEnd: Math.max(13, Math.min(24, +hEnd.value || 23)),
      planStart: pS.value || '08:00', planEnd: pE.value || '21:00',
    });
    closeModal();
    clearFeedCache();
    const nFeeds = state.settings.feeds.filter((f) => f.category !== 'ignorar').length;
    toast(nFeeds ? `✓ Guardado. Descargando ${nFeeds} calendario${nFeeds > 1 ? 's' : ''}…` : '✓ Guardado', 3000);
    await refreshFeeds(true);
    render();
    const bad = feedProblems();
    if (bad.length) toast(`⚠︎ ${bad[0].f.name}: ${bad[0].st.error}`, 7000);
    else if (nFeeds) toast(`✓ ${nFeeds} calendario${nFeeds > 1 ? 's' : ''} de iCloud cargado${nFeeds > 1 ? 's' : ''}`, 3000);
  });
}

const EXCEL_KEY = 'cfs.excelCheck';
const lastExcelCheck = () => { try { return +localStorage.getItem(EXCEL_KEY) || 0; } catch { return 0; } };
const excelMsg = (n, name) => `✓ ${n.work} días de trabajo, ${n.fest} festivos (${n.years.join(', ')})${n.cancelled ? ` · ${n.cancelled} cancelados (tachados) ignorados` : ''} — “${name}”, ${new Date().toLocaleString('es-ES')}.`;

/** Descarga el Excel desde el enlace de iCloud Drive (vía proxy). Una vez al día salvo force. */
const shareUrl = (proxy, link) => `${proxy.trim().replace(/[?&]$/, '')}${proxy.includes('?') ? '&' : '?'}share=${encodeURIComponent(link.trim())}`;
async function refreshExcel(force = false) {
  const { excelLink, proxy } = state.settings;
  if (!excelLink || !proxy) return null;
  if (!force && Date.now() - lastExcelCheck() < 20 * 3600 * 1000) return null;
  const url = shareUrl(proxy, excelLink);
  if (!/^https:\/\//i.test(proxy)) throw new Error('La URL del proxy debe empezar por https://');
  let r;
  try { r = await fetch(url, { cache: 'no-store' }); }
  catch (e) { throw new Error(`No hay respuesta válida del proxy (${e.message}). Pulsa «🔍 Ver respuesta del proxy» para ver el error real.`); }
  if (!r.ok) throw new Error(`No se pudo descargar el Excel: ${(await r.text()).slice(0, 160)}`);
  const name = decodeURIComponent((excelLink.split('#')[1] || 'Programación Anual')).replace(/_/g, ' ');
  const n = await importExcel(await r.arrayBuffer(), name);
  try { localStorage.setItem(EXCEL_KEY, String(Date.now())); } catch {}
  return n;
}
const LOCAL_KEY = 'cfs.localCheck';
const lastLocalCheck = () => { try { return +localStorage.getItem(LOCAL_KEY) || 0; } catch { return 0; } };

/** Lee el archivo local recordado. Importa si cambió (o si force). */
async function readLocal(h, { force = false, ask = false } = {}) {
  if (await LF.permission(h, ask) !== 'granted') return null;
  const f = await h.getFile();
  try { localStorage.setItem(LOCAL_KEY, String(Date.now())); } catch {}
  if (!force && state.work.fileModified === f.lastModified && state.work.fileName === f.name) return null;
  const n = await importExcel(await f.arrayBuffer(), f.name, { fileModified: f.lastModified });
  return n;
}

async function autoRefreshExcel() {
  try {
    const h = await LF.getHandle();
    if (h) { const n = await readLocal(h); if (n) toast('📄 Programación actualizada desde el archivo del ordenador'); }
    else { const n = await refreshExcel(false); if (n) toast('Programación actualizada desde iCloud Drive'); }
  } catch (e) { toast('⚠︎ Programación: ' + e.message, 5000); }
  updateExcelBtn();
}

/** Botón de arriba: recordatorio si la programación está vieja, o releer el archivo local si falta permiso. */
async function updateExcelBtn() {
  const btn = $('#excel-btn');
  const days = Math.floor((Date.now() - Math.max(state.work.importedAt || 0, lastLocalCheck())) / 86400000);
  const stale = state.work.importedAt && days >= (state.settings.reminderDays || 7);
  const h = await LF.getHandle();
  const needPerm = h && (await LF.permission(h).catch(() => 'denied')) !== 'granted';
  btn.hidden = !(stale || needPerm);
  const narrow = window.innerWidth <= 720;
  btn.textContent = needPerm ? (narrow ? '📄 Releer' : '📄 Releer programación') : (narrow ? `📄 ${days} d` : `📄 Actualizar programación (hace ${days} días)`);
  btn.title = needPerm ? 'Volver a leer el Excel recordado del ordenador' : `La programación se cargó hace ${days} días. Pulsa para elegir el archivo actualizado.`;
}
const pickerInput = el('input', { type: 'file', accept: '.xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', style: { display: 'none' } });
document.body.append(pickerInput);
pickerInput.addEventListener('change', async () => {
  const f = pickerInput.files[0]; if (!f) return;
  try { const n = await importExcel(await f.arrayBuffer(), f.name); toast(excelMsg(n, f.name), 6000); } catch (e) { toast('⚠︎ ' + e.message, 6000); }
  pickerInput.value = ''; updateExcelBtn();
});
async function excelBtnClick() {
  const h = await LF.getHandle();
  if (h) {
    try { const n = await readLocal(h, { force: true, ask: true }); if (n) { toast(excelMsg(n, h.name), 6000); updateExcelBtn(); return; } }
    catch (e) { toast('⚠︎ No pude leer “' + h.name + '”: ' + e.message + '. Elige el archivo de nuevo.', 6000); }
  }
  pickerInput.click();
}

async function importExcel(buf, fileName, meta = {}) {
  if (!window.XLSX) throw new Error('No se ha cargado la librería de Excel (¿sin conexión?)');
  const wb = XLSX.read(buf, { type: 'array', cellStyles: true });
  const s = state.settings;
  const r = parseProgramacion(wb, { initials: s.initials, tripHours: [s.tripStart, s.tripEnd], dayHours: [s.dayWorkStart, s.dayWorkEnd] });
  if (!r.years.length) throw new Error('No encuentro ninguna hoja “Programación AAAA” en el archivo');
  const keep = state.work.events.filter((e) => !r.years.includes(+e.date.slice(0, 4)));
  setWork({ events: [...keep, ...r.events], fileName, importedAt: Date.now(), fileModified: meta.fileModified || null });
  return { work: r.events.filter((e) => e.kind === 'trabajo').length, fest: r.events.filter((e) => e.kind === 'festivo').length, years: r.years, cancelled: r.cancelled.length };
}

// ---------- Google Tasks ----------
async function googleTasksModal() {
  if (!getClientId()) { toast('Primero configura el Client ID de Google en Ajustes'); settingsModal(); return; }
  try { if (!G.isSignedIn()) await G.signIn(getClientId()); } catch (e) { toast('Google: ' + e.message, 5000); return; }
  openModal('Importar de Google Tasks', [el('div', { class: 'muted', text: 'Cargando listas…' })], []);
  let lists;
  try {
    lists = await G.listTaskLists();
    await Promise.all(lists.map(async (l) => { l.items = await G.listTasks(l.id); }));
  } catch (e) { openModal('Importar de Google Tasks', [el('div', { text: '⚠︎ ' + e.message })], [el('button', { type: 'button', class: 'btn', text: 'Cerrar', onclick: closeModal })]); return; }
  const imported = new Set(liveTasks().filter((t) => t.google).map((t) => t.google.taskId));
  const checks = [];
  let prio = '';
  const groups = lists.map((l) => {
    const items = l.items.filter((it) => it.title?.trim());
    const boxes = items.map((it) => {
      const already = imported.has(it.id);
      const cb = el('input', { type: 'checkbox', disabled: already });
      if (!already) checks.push({ cb, it, list: l });
      return el('label', {}, cb, el('div', {}, el('div', { text: it.title }),
        el('div', { class: 'muted', text: [already ? 'Ya importada' : '', it.due ? 'Vence ' + fmtDay(it.due.slice(0, 10)) : '', (it.notes || '').slice(0, 80)].filter(Boolean).join(' · ') })));
    });
    const all = el('button', { type: 'button', class: 'btn small', text: 'Todas', onclick: () => { const mine = checks.filter((c) => c.list === l); const on = !mine.every((c) => c.cb.checked); mine.forEach((c) => { c.cb.checked = on; }); } });
    return el('div', { class: 'section' }, el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, el('h3', { text: `${l.title} (${items.length})` }), items.length ? all : null),
      el('div', { class: 'glist' }, boxes.length ? boxes : el('div', { class: 'muted', text: 'Sin tareas pendientes' })));
  });
  openModal('Importar de Google Tasks', [
    field('Prioridad para las importadas', seg(PRIORITIES, prio, (v) => { prio = v; })),
    ...groups,
  ], [
    el('button', { type: 'button', class: 'btn', text: 'Cancelar', onclick: closeModal }),
    el('button', { type: 'submit', class: 'btn primary', text: 'Importar seleccionadas' }),
  ], () => {
    const sel = checks.filter((c) => c.cb.checked);
    sel.forEach(({ it, list }, i) => upsertTask({ title: it.title.trim(), notes: it.notes || '', due: it.due ? it.due.slice(0, 10) : '', priority: prio, google: { listId: list.id, taskId: it.id }, order: Date.now() + i }));
    closeModal();
    toast(`${sel.length} tareas importadas`);
    if (sel.length) switchTab('backlog');
  });
}

// ======================================================================
// Sincronización (Google Drive appData)
// ======================================================================
let syncTimer = null, syncing = false;
function setSync(st, msg) {
  const dot = $('#sync-dot');
  dot.className = 'dot ' + ({ ok: 'ok', pending: 'pending', err: 'err', syncing: 'pending' }[st] || '');
  $('#sync-label').textContent = { ok: 'Sincronizado', pending: 'Sin sincronizar', err: 'Error', syncing: 'Sincronizando…' }[st] || 'Google';
  $('#sync-btn').classList.toggle('attn', st === 'pending' || st === 'err');
  $('#sync-btn').title = msg || 'Sincronizar con Google (Tasks y copia en Drive)';
}
/** Trae automáticamente las tareas de Google Tasks (nuevas, cambios, completadas y borradas). Devuelve cuántas son nuevas. */
async function syncGoogleTasks() {
  if (state.settings.gtasksAuto === false || !G.isSignedIn()) return 0;
  const lists = await G.listTaskLists();
  const byGid = new Map(Object.values(state.tasks).filter((t) => t.google?.taskId).map((t) => [t.google.taskId, t]));
  let added = 0, changed = 0, i = 0;
  const now = Date.now();
  for (const l of lists) {
    for (const g of await G.listTasks(l.id, { all: true })) {
      const loc = byGid.get(g.id);
      const due = g.due ? g.due.slice(0, 10) : '';
      const done = g.status === 'completed';
      if (!loc) {
        if (g.deleted || done || !g.title?.trim()) continue;
        const id = uid();
        state.tasks[id] = { id, title: g.title.trim(), notes: g.notes || '', due, date: null, start: null, duration: 60, done: false, priority: '', category: '', order: now + i++, createdAt: now, updatedAt: now, google: { listId: l.id, taskId: g.id, updated: g.updated || '' } };
        added++; continue;
      }
      if (loc.deleted) continue; // borrada aquí: no la resucitamos
      if (g.deleted) { state.tasks[loc.id] = { id: loc.id, deleted: true, updatedAt: now }; changed++; continue; }
      if ((g.updated || '') <= (loc.google.updated || '')) continue;
      state.tasks[loc.id] = { ...loc, title: g.title?.trim() || loc.title, notes: g.notes ?? loc.notes, due, done, doneAt: done ? (loc.doneAt || now) : null, google: { ...loc.google, listId: l.id, updated: g.updated || '' }, updatedAt: now };
      changed++;
    }
  }
  if (added || changed) { save({ sync: false }); G.driveSave(exportable()).catch(() => {}); }
  return added;
}

async function syncNow(interactive = false) {
  if (syncing) return;
  if (!getClientId()) { if (interactive) settingsModal(); return; }
  try {
    if (!G.isSignedIn()) { if (!interactive) { setSync('pending', 'Pulsa para conectar con Google y sincronizar'); return; } await G.signIn(getClientId()); }
    syncing = true; setSync('syncing');
    const remote = await G.driveLoad();
    if (mergeRemote(remote)) render();
    await G.driveSave(exportable());
    const n = await syncGoogleTasks().catch((e) => { toast('Google Tasks: ' + e.message, 5000); return 0; });
    if (n) toast(`📥 ${n} tarea${n > 1 ? 's' : ''} nueva${n > 1 ? 's' : ''} de Google Tasks`, 4000);
    setSync('ok', 'Sincronizado ' + new Date().toLocaleTimeString('es-ES'));
  } catch (e) { setSync('err', e.message); if (interactive) toast('Sincronización: ' + e.message, 5000); }
  finally { syncing = false; }
}
onChange(({ sync }) => {
  render();
  if (sync && getClientId()) { setSync('pending'); clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(false), 1500); }
});

// ======================================================================
// Navegación / arranque
// ======================================================================
function goTo(d) { anchor = d; renderWeek(); }
function step(dir) { anchor = addDays(viewDays === 7 ? mondayOf(anchor) : anchor, dir * viewDays); renderWeek(); }
function switchTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + t));
  document.body.classList.toggle('tab-backlog', t === 'backlog');
  document.body.classList.toggle('tab-today', t === 'today');
  lsSet('cfs.tab', t);
  render();
}
function computeViewDays() {
  const saved = +lsGet(VIEW_KEY);
  const nv = [1, 3, 7].includes(saved) ? saved : 7;
  if (nv !== viewDays) { viewDays = nv; return true; }
  return false;
}
function setView(n) {
  if (viewDays === 7 && n !== 7) { const t = new Date(); const w = visibleDays(); anchor = w.some((d) => toYMD(d) === toYMD(t)) ? t : w[0]; }
  viewDays = n; lsSet(VIEW_KEY, n); renderWeek();
}
function scrollToMorning() {
  const now = new Date();
  const m = Math.max(dayStartMin(), Math.min(now.getHours() * 60 - 90, 7 * 60));
  $('#cal-scroll').scrollTop = (m - dayStartMin()) * ppm();
}

document.querySelectorAll('#view-seg button').forEach((b) => { b.onclick = () => setView(+b.dataset.days); });
$('#zoom-in').onclick = () => applyZoom(hourPx() * 1.25);
$('#zoom-out').onclick = () => applyZoom(hourPx() / 1.25);
$('#tray-head').onclick = () => { const t = $('#tray'); t.classList.toggle('closed'); lsSet('cfs.tray', t.classList.contains('closed') ? '0' : '1'); };
if (lsGet('cfs.tray') === '0') $('#tray').classList.add('closed');
$('#fab').onclick = () => taskModal(null);
// pellizcar para hacer zoom de horas (2 dedos sobre el calendario)
{
  const sc = $('#cal-scroll');
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const grid = $('#cal-grid');
  sc.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    cancelPress();
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - sc.getBoundingClientRect().top;
    pinch = { d0: dist(e.touches), h0: hourPx(), h: hourPx(), midY, at: sc.scrollTop + midY };
    grid.style.transformOrigin = `0 ${pinch.at}px`;
  }, { passive: true });
  sc.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    pinch.h = Math.max(ZMIN, Math.min(ZMAX, pinch.h0 * dist(e.touches) / pinch.d0));
    grid.style.transform = `scaleY(${pinch.h / pinch.h0})`; // vista previa fluida
  }, { passive: false });
  const end = () => {
    if (!pinch) return;
    const { h0, h, at, midY } = pinch; pinch = null;
    grid.style.transform = ''; grid.style.transformOrigin = '';
    const min = at / (h0 / 60) + dayStartMin();
    const v = Math.round(h);
    document.documentElement.style.setProperty('--hour', v + 'px');
    lsSet(ZOOM_KEY, v);
    renderWeek();
    sc.scrollTop = (min - dayStartMin()) * ppm() - midY;
  };
  sc.addEventListener('touchend', (e) => { if (e.touches.length < 2) end(); });
  sc.addEventListener('touchcancel', end);
  // Safari: evitar que el pellizco haga zoom de toda la página
  for (const ev of ['gesturestart', 'gesturechange']) sc.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
$('#today-prev').onclick = () => { todayAnchor = addDays(todayAnchor || new Date(), -1); renderToday(); };
$('#today-next').onclick = () => { todayAnchor = addDays(todayAnchor || new Date(), 1); renderToday(); };
$('#today-now').onclick = () => { todayAnchor = null; renderToday(); };
$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);
$('#today').onclick = () => { goTo(new Date()); scrollToMorning(); };
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
$('#settings-btn').onclick = settingsModal;
$('#conflict-btn').onclick = conflictsModal;
$('#excel-btn').onclick = excelBtnClick;
$('#sync-btn').onclick = () => syncNow(true);
$('#side-add').onclick = () => taskModal(null);
$('#gtasks-btn').onclick = googleTasksModal;
$('#filter-cat').onchange = renderKanban;
$('#filter-scheduled').onchange = renderKanban;
$('#filter-done').onchange = renderKanban;
$('#quick-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#quick-title').value.trim(); if (!v) return;
  const cat = $('#filter-cat').value;
  upsertTask({ title: v, priority: $('#quick-prio').value, category: cat && cat !== '-' ? cat : '' });
  $('#quick-title').value = '';
  toast('Tarea añadida');
});
document.addEventListener('keydown', (e) => {
  if (modal.open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 't' || e.key === 'T') $('#today').click();
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); taskModal(null); }
});
let rT;
window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => { render(); }, 120); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  render();
  await refreshFeeds(); render();
  if (G.isSignedIn()) syncNow(false);
  autoRefreshExcel();
});
setInterval(() => { if (!drag) renderWeek(); }, 60000);
setInterval(async () => { if (document.visibilityState === 'visible') { await refreshFeeds(); render(); } }, 15 * 60000);

computeViewDays();
if (+lsGet(ZOOM_KEY)) document.documentElement.style.setProperty('--hour', Math.max(ZMIN, Math.min(ZMAX, +lsGet(ZOOM_KEY))) + 'px');
renderFilters();
render();
scrollToMorning();
if (['today', 'backlog'].includes(lsGet('cfs.tab'))) switchTab(lsGet('cfs.tab'));
if (getClientId()) { if (G.isSignedIn()) syncNow(false); else setSync('pending', 'Pulsa para conectar con Google y sincronizar'); }
refreshFeeds().then(() => render());
setTimeout(() => { if (window.XLSX) autoRefreshExcel(); else window.addEventListener('load', autoRefreshExcel, { once: true }); }, 1500);
setInterval(() => { if (document.visibilityState === 'visible') autoRefreshExcel(); }, 3600 * 1000);
updateExcelBtn();
if (!state.work.importedAt && !liveTasks().length) setTimeout(() => toast('Empieza en ⚙︎ Ajustes: carga tu programación y tus calendarios', 5000), 600);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
