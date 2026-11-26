// Google: login (Google Identity Services), Drive appDataFolder (sincronización) y Google Tasks.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.readonly', // solo para leer el archivo de vacaciones que guarda el artefacto
].join(' ');
const READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FILE_NAME = 'calendario-fs-data.json';

let tokenClient = null;
let token = null; // {access_token, expires_at}
let pending = null;
try { token = JSON.parse(localStorage.getItem('cfs.token')); } catch {}
const keepToken = () => { try { localStorage.setItem('cfs.token', JSON.stringify(token)); } catch {} };

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => res(); s.onerror = () => rej(new Error('No se pudo cargar Google Identity Services'));
    document.head.appendChild(s);
  });
}

// un token concedido antes de añadir el permiso de lectura cuenta como «sin conectar» para pedirlo una vez
const hasAllScopes = () => !!token && (token.scope === undefined ? false : token.scope.includes(READ_SCOPE));
export function isSignedIn() { return !!token && token.expires_at > Date.now() + 60000 && hasAllScopes(); }
export function hasEverSignedIn() { try { return localStorage.getItem('cfs.google') === '1'; } catch { return false; } }

export async function signIn(clientId, { silent = false } = {}) {
  if (!clientId) throw new Error('Falta el Client ID de Google (Ajustes)');
  await loadGis();
  if (!tokenClient || tokenClient._cid !== clientId) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPES,
      callback: (r) => {
        if (r.error) { pending?.rej(new Error(r.error_description || r.error)); }
        else {
          token = { access_token: r.access_token, expires_at: Date.now() + (r.expires_in - 30) * 1000, scope: r.scope || '' };
          keepToken();
          try { localStorage.setItem('cfs.google', '1'); } catch {}
          pending?.res(token);
        }
        pending = null;
      },
      error_callback: (e) => { pending?.rej(new Error(e.message || e.type || 'login cancelado')); pending = null; },
    });
    tokenClient._cid = clientId;
  }
  return new Promise((res, rej) => {
    pending = { res, rej };
    const needConsent = !hasEverSignedIn() || (token && !hasAllScopes());
    tokenClient.requestAccessToken({ prompt: silent ? '' : (needConsent ? 'consent' : '') });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null;
  try { localStorage.removeItem('cfs.google'); localStorage.removeItem('cfs.token'); } catch {}
}

let clientIdRef = '';
export function setClientId(id) { clientIdRef = id; }

async function api(url, opts = {}) {
  if (!isSignedIn()) await signIn(clientIdRef, { silent: true });
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token.access_token}`, ...(opts.headers || {}) } });
  if (r.status === 401) { token = null; throw new Error('Sesión de Google caducada'); }
  if (!r.ok) throw new Error(`Google API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

// ---------- Drive appData ----------
let fileId = null;
async function findFile() {
  if (fileId) return fileId;
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const r = await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
  fileId = r.files?.[0]?.id || null;
  return fileId;
}

export async function driveLoad() {
  const id = await findFile();
  if (!id) return null;
  return api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
}

export async function driveSave(data) {
  const id = await findFile();
  const body = JSON.stringify(data);
  if (id) {
    await api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    });
    return;
  }
  const boundary = 'cfs' + Math.random().toString(36).slice(2);
  const meta = { name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' };
  const multipart = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
  });
  fileId = r.id;
}

// ---------- Google Tasks ----------
export async function listTaskLists() {
  const r = await api('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100');
  return r.items || [];
}
export async function listTasks(listId, { all = false } = {}) {
  let items = [], pageToken = '';
  const flags = all ? 'showCompleted=true&showHidden=true&showDeleted=true' : 'showCompleted=false';
  do {
    const r = await api(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?${flags}&maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`);
    items = items.concat(r.items || []);
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return items;
}
export async function setTaskCompleted(listId, taskId, done) {
  return api(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(done ? { status: 'completed' } : { status: 'needsAction', completed: null }),
  });
}

// ---------- Archivo de vacaciones que guarda el artefacto en Drive ----------
export const VAC_FILE = 'vacaciones-planificador.json';
/** Devuelve {id, modifiedTime, text} del archivo más reciente, o null. Solo descarga si es más nuevo que `since`. */
export async function latestVacationFile(since) {
  const q = encodeURIComponent(`name='${VAC_FILE}' and trashed=false`);
  const r = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime%20desc&pageSize=1&fields=files(id,modifiedTime)`);
  const f = r.files?.[0];
  if (!f) return null;
  if (since && f.modifiedTime <= since) return { id: f.id, modifiedTime: f.modifiedTime, unchanged: true };
  if (!isSignedIn()) await signIn(clientIdRef, { silent: true });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!res.ok) throw new Error(`No se pudo leer ${VAC_FILE} de Drive (${res.status})`);
  return { id: f.id, modifiedTime: f.modifiedTime, text: await res.text() };
}
