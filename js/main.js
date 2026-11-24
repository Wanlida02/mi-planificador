import { state, save, onChange, upsertTask, deleteTask, updateSettings, setWork, liveTasks, mergeRemote, exportable, CATEGORIES, PRIORITIES, uid } from './store.js';
import { parseProgramacion } from './programacion.js';
import { refreshFeeds, feedEvents, feedStatus, clearFeedCache } from './feeds.js';
import * as G from './google.js';
import { el, toast, toYMD, parseYMD, addDays, mondayOf, hm2min, min2hm, fmtDur, fmtDay, DOW, MONTHS } from './util.js';

const $ = (s) => document.querySelector(s);
const SNAP = 15;
const PRIO_RANK = { alta: 0, media: 1, baja: 2, '': 3 };
const CLIENT_KEY = 'cfs.clientId';
const getClientId = () => { try { return localStorage.getItem(CLIENT_KEY) || ''; } catch { return ''; } };
G.setClientId(getClientId());

let anchor = new Date();
let viewDays = 7;
let tab = 'week';
let lastPointerType = 'mouse';

// ======================================================================
// Utilidades de calendario
// ======================================================================
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
    if (w.kind === 'festivo') allDay.push({ type: 'festivo', title: w.title });
    else timed.push({ type: 'trabajo', s: hm2min(w.start), e: hm2min(w.end), title: w.title, sub: [w.trip ? `Viaje ${w.tripDay}/${w.tripDays}` : 'Trabajo', w.detail].filter(Boolean).join(' · '), ref: w });
  }
  const d0 = parseYMD(dateStr), d1 = addDays(d0, 1);
  for (const f of fe) {
    if (!(f.start < d1 && f.end > d0)) continue;
    if (f.allDay) { allDay.push({ type: f.category, title: f.title, ref: f }); continue; }
    const cs = f.start < d0 ? d0 : f.start, ce = f.end > d1 ? d1 : f.end;
    const s = cs.getHours() * 60 + cs.getMinutes();
    const e = ce.getTime() === d1.getTime() ? 1440 : ce.getHours() * 60 + ce.getMinutes();
    timed.push({ type: f.category, s, e, title: f.title, sub: f.location, ref: f });
  }
  for (const t of liveTasks()) {
    if (t.date !== dateStr || !t.start) continue;
    const s = hm2min(t.start);
    timed.push({ type: 'task', s, e: s + (t.duration || 60), title: t.title, task: t });
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

  $('#cal-head').replaceChildren(el('div'), ...days.map((d) => {
    const ds = toYMD(d), wk = d.getDay() === 0 || d.getDay() === 6;
    return el('div', { class: `dh${ds === today ? ' today' : ''}${wk ? ' weekend' : ''}` },
      el('div', { class: 'dow', text: DOW[d.getDay()] }), el('div', { class: 'dnum', text: d.getDate() }));
  }));

  const fe = feedEvents(first, addDays(last, 1));
  const perDay = days.map((d) => itemsForDay(toYMD(d), fe));

  $('#cal-allday').replaceChildren(el('div', { class: 'gutter' }), ...perDay.map((p) =>
    el('div', { class: 'ad' }, p.allDay.map((a) => el('div', { class: `chip ${a.type}`, title: a.title, text: a.title })))));

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
    return el('div', { class: `ev ${it.type}`, style, title: `${it.title}\n${time}${it.sub ? '\n' + it.sub : ''}`, ondblclick: () => infoModal(it) },
      el('div', { class: 't', text: it.title }), el('div', { class: 's', text: [time, it.sub].filter(Boolean).join(' · ') }));
  }
  const t = it.task;
  const blk = el('div', { class: `ev task${t.done ? ' done' : ''}${h < 34 ? ' short' : ''}`, style, dataset: { id: t.id }, title: `${t.title}\n${time} (${fmtDur(t.duration)})\nDoble clic para editar · arrastra para mover` },
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'ck', 'aria-label': t.done ? 'Marcar pendiente' : 'Marcar hecha', text: t.done ? '✓' : '', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); toggleDone(t); } }),
      el('div', { class: 't', text: t.title || '(sin título)' })),
    el('div', { class: 's', text: time }),
    el('div', { class: 'rz', onpointerdown: (e) => press(e, { type: 'resize', task: t, el: blk }) }));
  blk.addEventListener('pointerdown', (e) => press(e, { type: 'move', task: t, el: blk }));
  blk.addEventListener('dblclick', (e) => { if (lastPointerType !== 'touch') { e.stopPropagation(); taskModal(t); } });
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
  c.addEventListener('click', () => { if (!suppressClick) taskModal(t); });
  return c;
}

function renderSide() {
  const list = sortTasks(liveTasks().filter((t) => !t.done && !isScheduled(t)));
  $('#side-list').replaceChildren(...(list.length ? list.map((t) => card(t, { compact: true })) : [el('div', { class: 'empty', text: 'Nada pendiente de programar 🎉' })]));
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

function render() {
  renderWeek();
  renderSide();
  if (tab === 'backlog') renderKanban();
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
  if (info.type === 'move' && lastTap.key === key && now - lastTap.t < 380) { lastTap = { key: '', t: 0 }; taskModal(info.task); return; }
  lastTap = { key, t: now };
}

function startDrag(e) {
  const info = pressSt.info;
  if (pressSt.timer) clearTimeout(pressSt.timer);
  drag = { ...info, x: e.clientX, y: e.clientY };
  document.body.classList.add('is-dragging');
  if (info.type === 'move') {
    const r = info.el.getBoundingClientRect();
    drag.grab = Math.max(0, (pressSt.y - r.top) / ppm());
    info.el.classList.add('dragging');
    drag.ghost = info.el.cloneNode(true);
    drag.ghost.classList.remove('dragging'); drag.ghost.classList.add('ghost');
    Object.assign(drag.ghost.style, { left: '2px', width: 'calc(100% - 6px)' });
  } else if (info.type === 'resize') {
    drag.start = hm2min(info.task.start);
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
  const edge = 36;
  if (drag.y < r.top + edge && drag.y > r.top - 60) sc.scrollTop -= 10;
  else if (drag.y > r.bottom - edge && drag.y < r.bottom + 60) sc.scrollTop += 10;
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
    const end = Math.max(drag.start + SNAP, snap(minAt(col, e.clientY)));
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
  drag.el?.classList.remove('dragging', 'dragging-src');
  document.querySelectorAll('.kcol.over').forEach((k) => k.classList.remove('over'));
  document.body.classList.remove('is-dragging');
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 50);
}
function abortDrag() { cleanupDrag(); drag = null; render(); }

function endDrag() {
  const d = drag; cleanupDrag(); drag = null;
  if (d.type === 'resize') { if (d.duration) upsertTask({ id: d.task.id, duration: d.duration }); else render(); return; }
  if (d.type === 'create') { if (d.e > d.s) taskModal(null, { date: d.col.dataset.date, start: min2hm(d.s), duration: d.e - d.s }); return; }
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
  const fe = feedEvents(from, addDays(from, horizon + 1));
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
mform.addEventListener('submit', (e) => { e.preventDefault(); onSubmit?.(); });
function openModal(title, body, foot, submit) {
  onSubmit = submit;
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
  const start = el('input', { type: 'time', step: 900, value: d.start || '' });
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

function infoModal(it) {
  const lines = [el('div', { class: 'muted', text: `${it.type === 'trabajo' ? 'Trabajo (programación anual)' : it.type === 'familia' ? 'Luna / familia' : 'Personal'} · ${min2hm(it.s)}–${min2hm(Math.min(it.e, 1439))}` })];
  if (it.sub) lines.push(el('div', { text: it.sub }));
  openModal(it.title, lines, [el('button', { type: 'button', class: 'btn primary', text: 'Cerrar', onclick: closeModal })]);
}

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
      const n = await importExcel(f);
      workStatus.textContent = `✓ ${n.work} días de trabajo y ${n.fest} festivos (${n.years.join(', ')}) cargados de “${f.name}”.`;
    } catch (e) { workStatus.textContent = '⚠︎ ' + e.message; }
  });

  // feeds
  const feeds = s.feeds.map((f) => ({ ...f }));
  const feedList = el('div', { class: 'glist', style: { maxHeight: 'none', background: 'none' } });
  const drawFeeds = () => feedList.replaceChildren(...feeds.map((f, i) => {
    const st = feedStatus(f.id);
    const name = el('input', { value: f.name, placeholder: 'Nombre (p.ej. Familia)', oninput: (e) => { f.name = e.target.value; } });
    const url = el('input', { value: f.url, placeholder: 'webcal://p…-caldav.icloud.com/published/2/…', oninput: (e) => { f.url = e.target.value; } });
    const cat = el('select', { onchange: (e) => { f.category = e.target.value; } },
      el('option', { value: 'familia', text: 'Luna/Familia' }), el('option', { value: 'personal', text: 'Personal' }), el('option', { value: 'ignorar', text: 'Ignorar' }));
    cat.value = f.category;
    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBottom: '8px', borderBottom: '1px solid var(--line-soft)' } },
      el('div', { class: 'feed' }, name, cat, el('button', { type: 'button', class: 'btn icon small', 'aria-label': 'Quitar', text: '×', onclick: () => { feeds.splice(i, 1); drawFeeds(); } })),
      url,
      st ? el('div', { class: 'muted', text: st.ok ? `✓ Actualizado ${new Date(st.at).toLocaleTimeString('es-ES')}` : `⚠︎ ${st.error}` }) : null);
  }));
  drawFeeds();
  const proxy = el('input', { value: s.proxy, placeholder: 'https://ics-proxy.tu-usuario.workers.dev' });

  const clientId = el('input', { value: getClientId(), placeholder: 'xxxx.apps.googleusercontent.com' });
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
      el('div', { class: 'muted', text: 'Elige “Programación Anual 2026.xlsx” desde iCloud Drive. Se marcan los días con tus iniciales: viaje de varios días y jornada de un día. Al cargar otro año se conservan los anteriores.' }),
      fileInput, workStatus,
      el('div', { class: 'row2' }, field('Mis iniciales', initials), el('span')),
      el('div', { class: 'row2' }, field('Viaje: desde', tS), field('Viaje: hasta', tE)),
      el('div', { class: 'row2' }, field('Día suelto: desde', dS), field('Día suelto: hasta', dE))),
    el('div', { class: 'section' }, el('h3', { text: '📅 Calendarios de iCloud' }),
      el('div', { class: 'muted' }, 'En el iPhone: Calendario → Calendarios → (i) junto a “Familia” → activa “Calendario público” → Compartir enlace. Repite con “Calendar”. Pega aquí los enlaces.'),
      feedList,
      el('button', { type: 'button', class: 'btn small', text: '+ Añadir calendario', onclick: () => { feeds.push({ id: uid(), name: '', url: '', category: feeds.length ? 'personal' : 'familia' }); drawFeeds(); } }),
      field('Proxy para iCloud (ver README)', proxy)),
    el('div', { class: 'section' }, el('h3', { text: '🔄 Google (Tasks + sincronización)' }),
      field('Client ID de OAuth (ver README)', clientId), gState,
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
  const saveClient = () => { try { localStorage.setItem(CLIENT_KEY, clientId.value.trim()); } catch {} G.setClientId(clientId.value.trim()); };
  openModal('Ajustes', body, [
    el('button', { type: 'button', class: 'btn', text: 'Cancelar', onclick: closeModal }),
    el('button', { type: 'submit', class: 'btn primary', text: 'Guardar' }),
  ], async () => {
    saveClient();
    updateSettings({
      initials: initials.value.trim().toUpperCase() || 'FS', tripStart: tS.value, tripEnd: tE.value, dayWorkStart: dS.value, dayWorkEnd: dE.value,
      feeds: feeds.filter((f) => f.url.trim()).map((f) => ({ ...f, url: f.url.trim(), name: f.name.trim() || 'Calendario' })),
      proxy: proxy.value.trim(),
      dayStart: Math.max(0, Math.min(12, +hStart.value || 6)), dayEnd: Math.max(13, Math.min(24, +hEnd.value || 23)),
      planStart: pS.value || '08:00', planEnd: pE.value || '21:00',
    });
    closeModal();
    clearFeedCache();
    if (await refreshFeeds(true)) render();
    const bad = state.settings.feeds.map((f) => feedStatus(f.id)).filter((x) => x && !x.ok);
    if (bad.length) toast('⚠︎ ' + bad[0].error, 5000);
  });
}

async function importExcel(file) {
  if (!window.XLSX) throw new Error('No se ha cargado la librería de Excel (¿sin conexión?)');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellStyles: false });
  const s = state.settings;
  const r = parseProgramacion(wb, { initials: s.initials, tripHours: [s.tripStart, s.tripEnd], dayHours: [s.dayWorkStart, s.dayWorkEnd] });
  if (!r.years.length) throw new Error('No encuentro ninguna hoja “Programación AAAA” en el archivo');
  const keep = state.work.events.filter((e) => !r.years.includes(+e.date.slice(0, 4)));
  setWork({ events: [...keep, ...r.events], fileName: file.name, importedAt: Date.now() });
  return { work: r.events.filter((e) => e.kind === 'trabajo').length, fest: r.events.filter((e) => e.kind === 'festivo').length, years: r.years };
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
  $('#sync-btn').title = msg || 'Sincronizar con Google (Tasks y copia en Drive)';
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
  render();
}
function computeViewDays() {
  const nv = window.innerWidth <= 720 ? 3 : 7;
  if (nv !== viewDays) { viewDays = nv; return true; }
  return false;
}
function scrollToMorning() {
  const now = new Date();
  const m = Math.max(dayStartMin(), Math.min(now.getHours() * 60 - 90, 7 * 60));
  $('#cal-scroll').scrollTop = (m - dayStartMin()) * ppm();
}

$('#prev').onclick = () => step(-1);
$('#next').onclick = () => step(1);
$('#today').onclick = () => { goTo(new Date()); scrollToMorning(); };
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
$('#settings-btn').onclick = settingsModal;
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
window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => { computeViewDays(); render(); }, 120); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  render();
  if (await refreshFeeds()) render();
  if (G.isSignedIn()) syncNow(false);
});
setInterval(() => { if (!drag) renderWeek(); }, 60000);
setInterval(async () => { if (document.visibilityState === 'visible' && await refreshFeeds()) render(); }, 15 * 60000);

computeViewDays();
renderFilters();
render();
scrollToMorning();
if (getClientId()) { if (G.isSignedIn()) syncNow(false); else setSync('pending', 'Pulsa para conectar con Google y sincronizar'); }
refreshFeeds().then((c) => { if (c) render(); });
if (!state.work.importedAt && !liveTasks().length) setTimeout(() => toast('Empieza en ⚙︎ Ajustes: carga tu programación y tus calendarios', 5000), 600);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
