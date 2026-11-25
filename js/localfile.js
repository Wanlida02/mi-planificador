// Recordar un archivo local (Edge/Chrome de escritorio) para releerlo al abrir la app.
// Pensado para el Excel de Teams sincronizado con OneDrive en el ordenador.
const DB = 'cfs-files', STORE = 'handles', KEY = 'excel';

export const supported = typeof window !== 'undefined' && 'showOpenFilePicker' in window;

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result ?? null);
    t.onerror = () => rej(t.error);
  });
}

export async function getHandle() {
  if (!supported) return null;
  try { return await tx('readonly', (s) => s.get(KEY)); } catch { return null; }
}
export async function forget() { try { await tx('readwrite', (s) => s.delete(KEY)); } catch {} }

export async function pick() {
  const [h] = await window.showOpenFilePicker({
    types: [{ description: 'Excel', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xlsm'] } }],
  });
  await tx('readwrite', (s) => s.put(h, KEY));
  return h;
}

/** 'granted' | 'prompt' | 'denied'. Con ask=true pide permiso (requiere un clic del usuario). */
export async function permission(h, ask = false) {
  const o = { mode: 'read' };
  let p = await h.queryPermission(o);
  if (p !== 'granted' && ask) p = await h.requestPermission(o);
  return p;
}
