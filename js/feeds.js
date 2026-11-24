// Descarga y cachea calendarios iCloud publicados (.ics).
import { parseICS } from './ics.js';
import { state } from './store.js';

const CACHE_KEY = 'cfs.ics.';
const TTL = 15 * 60 * 1000;
const mem = new Map(); // url -> {text, at}
const status = new Map(); // feedId -> {ok, error, at}

export const feedStatus = (id) => status.get(id);

export function normalizeUrl(u) { return u.trim().replace(/^webcals?:\/\//i, 'https://'); }

function proxied(url) {
  const p = (state.settings.proxy || '').trim();
  if (!p) return null;
  return p.includes('{url}') ? p.replace('{url}', encodeURIComponent(url)) : `${p}${p.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.ok) return await r.text();
  } catch { /* CORS: probar proxy */ }
  const p = proxied(url);
  if (!p) throw new Error('El navegador bloquea la descarga directa (CORS). Configura el proxy en Ajustes.');
  const r = await fetch(p, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Proxy ${r.status}`);
  return r.text();
}

function getCached(url) {
  if (mem.has(url)) return mem.get(url);
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY + url)); if (c) { mem.set(url, c); return c; } } catch {}
  return null;
}

/** Refresca todos los feeds (si caducados o force). Devuelve true si algo cambió. */
export async function refreshFeeds(force = false) {
  let changed = false;
  await Promise.all(state.settings.feeds.filter((f) => f.url && f.category !== 'ignorar').map(async (f) => {
    const url = normalizeUrl(f.url);
    const c = getCached(url);
    if (!force && c && Date.now() - c.at < TTL) return;
    try {
      const text = await fetchText(url);
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('La URL no devuelve un calendario .ics');
      const entry = { text, at: Date.now() };
      mem.set(url, entry);
      try { localStorage.setItem(CACHE_KEY + url, JSON.stringify(entry)); } catch {}
      parsedCache.clear();
      status.set(f.id, { ok: true, at: Date.now() });
      changed = true;
    } catch (e) {
      status.set(f.id, { ok: false, error: e.message, at: Date.now() });
    }
  }));
  return changed;
}

const parsedCache = new Map();
/** Eventos de todos los feeds entre dos fechas: [{...ev, category}] */
export function feedEvents(from, to) {
  const key = from.getTime() + '-' + to.getTime() + '-' + state.settings.feeds.map((f) => f.url + f.category).join('|');
  if (parsedCache.has(key)) return parsedCache.get(key);
  const out = [];
  for (const f of state.settings.feeds) {
    if (!f.url || f.category === 'ignorar') continue;
    const c = getCached(normalizeUrl(f.url));
    if (!c) continue;
    try { for (const e of parseICS(c.text, from, to)) out.push({ ...e, category: f.category, feed: f.name }); }
    catch (e) { status.set(f.id, { ok: false, error: 'Error leyendo .ics: ' + e.message }); }
  }
  if (parsedCache.size > 20) parsedCache.clear();
  parsedCache.set(key, out);
  return out;
}
export function clearFeedCache() { parsedCache.clear(); }
