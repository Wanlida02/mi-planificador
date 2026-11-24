// Estado de la app, persistencia local y fusión con la copia de Google Drive.
const KEY = 'cfs.state.v1';
const listeners = new Set();

export const CATEGORIES = ['Trabajo', 'Casa', 'Luna/Familia', 'Personal'];
export const PRIORITIES = [
  { id: 'alta', label: 'Alta' }, { id: 'media', label: 'Media' }, { id: 'baja', label: 'Baja' }, { id: '', label: 'Sin clasificar' },
];

const defaults = () => ({
  tasks: {},
  work: { events: [], fileName: '', importedAt: 0 },
  settings: {
    feeds: [], proxy: '', initials: 'FS', dayStart: 6, dayEnd: 23,
    tripStart: '07:00', tripEnd: '17:00', dayWorkStart: '07:00', dayWorkEnd: '15:00',
  },
  settingsUpdatedAt: 0,
});

export const state = load();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) { const d = defaults(); return { ...d, ...s, settings: { ...d.settings, ...s.settings }, work: { ...d.work, ...s.work } }; }
  } catch {}
  return defaults();
}

export function save({ sync = true } = {}) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  for (const fn of listeners) fn({ sync });
}
export function onChange(fn) { listeners.add(fn); }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function liveTasks() { return Object.values(state.tasks).filter((t) => !t.deleted); }

export function upsertTask(patch) {
  const id = patch.id || uid();
  const prev = state.tasks[id] || { id, title: '', notes: '', date: null, start: null, duration: 60, done: false, priority: '', category: '', due: '', order: Date.now(), createdAt: Date.now() };
  state.tasks[id] = { ...prev, ...patch, id, updatedAt: Date.now() };
  save();
  return state.tasks[id];
}
export function deleteTask(id) {
  if (!state.tasks[id]) return;
  state.tasks[id] = { id, deleted: true, updatedAt: Date.now() };
  save();
}
export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  state.settingsUpdatedAt = Date.now();
  save();
}
export function setWork(work) { state.work = { ...work }; save(); }

/** Fusión con datos remotos (Drive): por tarea gana la última modificación. */
export function mergeRemote(remote) {
  if (!remote) return false;
  let changed = false;
  for (const [id, rt] of Object.entries(remote.tasks || {})) {
    const lt = state.tasks[id];
    if (!lt || (rt.updatedAt || 0) > (lt.updatedAt || 0)) { state.tasks[id] = rt; changed = true; }
  }
  if ((remote.work?.importedAt || 0) > (state.work.importedAt || 0)) { state.work = remote.work; changed = true; }
  if ((remote.settingsUpdatedAt || 0) > (state.settingsUpdatedAt || 0)) {
    state.settings = { ...state.settings, ...remote.settings }; state.settingsUpdatedAt = remote.settingsUpdatedAt; changed = true;
  }
  // purgar papelera de más de 60 días
  const cutoff = Date.now() - 60 * 86400000;
  for (const [id, t] of Object.entries(state.tasks)) if (t.deleted && t.updatedAt < cutoff) delete state.tasks[id];
  if (changed) save({ sync: false });
  return changed;
}

export function exportable() { return JSON.parse(JSON.stringify(state)); }
