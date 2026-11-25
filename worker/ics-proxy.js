// Cloudflare Worker: proxy mínimo para que la app lea datos de iCloud desde el navegador.
//  - Calendarios públicos:   https://<worker>.workers.dev/?url=<webcal/https de icloud.com>
//  - Archivo de iCloud Drive: https://<worker>.workers.dev/?share=<enlace https://www.icloud.com/iclouddrive/...>
// Solo acepta direcciones de iCloud, así que no sirve como proxy abierto.
const ICLOUD = /(^|\.)icloud\.com$/i;
const ICLOUD_CONTENT = /(^|\.)icloud-content\.com$/i;

function findDownloadUrl(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'downloadURL' && typeof v === 'string') return v;
    const r = findDownloadUrl(v);
    if (r) return r;
  }
  return null;
}

async function resolveShare(link) {
  const u = new URL(link);
  if (!ICLOUD.test(u.hostname)) throw new Response('Host no permitido', { status: 403 });
  const m = /\/iclouddrive\/([^/?#]+)/.exec(u.pathname);
  if (!m) throw new Response('No parece un enlace de iCloud Drive (…/iclouddrive/…)', { status: 400 });
  const name = decodeURIComponent((u.hash || '').slice(1)) || 'archivo.xlsx';
  const r = await fetch('https://ckdatabasews.icloud.com/database/1/com.apple.cloudkit/production/public/records/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com' },
    body: JSON.stringify({ shortGUIDs: [{ value: m[1] }] }),
  });
  if (!r.ok) throw new Response(`iCloud respondió ${r.status} al resolver el enlace`, { status: 502 });
  const data = await r.json();
  const dl = findDownloadUrl(data);
  if (!dl) throw new Response('El enlace no da acceso al archivo (¿compartido como "Cualquiera con el enlace"?)', { status: 404 });
  const url = dl.replace('${f}', encodeURIComponent(name));
  if (!ICLOUD_CONTENT.test(new URL(url).hostname) && !ICLOUD.test(new URL(url).hostname)) throw new Response('Descarga fuera de iCloud', { status: 502 });
  return url;
}


// ---------------------------------------------------------------------------
// CalDAV (mover eventos de iCloud). Requiere secretos en el worker:
//   ICLOUD_USER (tu Apple ID), ICLOUD_APP_PASSWORD (contraseña específica de app)
//   PLANNER_TOKEN (código privado que también pones en la app)
// ---------------------------------------------------------------------------
const DAV_ROOT = 'https://caldav.icloud.com';
let homeCache = null;

function davAuth(env) { return 'Basic ' + btoa(`${env.ICLOUD_USER}:${env.ICLOUD_APP_PASSWORD}`); }
async function dav(env, method, url, body, headers = {}) {
  const r = await fetch(url, { method, body, headers: { Authorization: davAuth(env), 'Content-Type': 'application/xml; charset=utf-8', ...headers } });
  if (r.status === 401) throw new Response('iCloud rechazó el usuario o la contraseña específica de app (revisa los secretos del worker)', { status: 502 });
  return r;
}
const xmlUnescape = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, '\r').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const tag = (name) => new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'i');
const responses = (xml) => xml.match(/<(?:[\w-]+:)?response[\s>][\s\S]*?<\/(?:[\w-]+:)?response>/gi) || [];
const pick = (xml, name) => { const m = tag(name).exec(xml); return m ? m[1].trim() : ''; };

async function calendarHome(env) {
  if (homeCache) return homeCache;
  let r = await dav(env, 'PROPFIND', DAV_ROOT + '/', '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', { Depth: '0' });
  const principal = pick(pick(await r.text(), 'current-user-principal'), 'href');
  if (!principal) throw new Response('No encuentro tu cuenta en iCloud CalDAV', { status: 502 });
  r = await dav(env, 'PROPFIND', new URL(principal, DAV_ROOT).toString(), '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>', { Depth: '0' });
  const home = pick(pick(await r.text(), 'calendar-home-set'), 'href');
  homeCache = new URL(home, DAV_ROOT).toString().replace(':443/', '/');
  return homeCache;
}

async function listCalendars(env) {
  const home = await calendarHome(env);
  const r = await dav(env, 'PROPFIND', home, '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>', { Depth: '1' });
  const xml = await r.text();
  return responses(xml).filter((x) => /calendar/i.test(pick(x, 'resourcetype')) && /VEVENT/.test(x))
    .map((x) => ({ href: new URL(xmlUnescape(pick(x, 'href')), home).toString(), name: xmlUnescape(pick(x, 'displayname')) }));
}

// Cloudflare debilita el ETag de las respuestas que comprime (W/"…") y iCloud no lo acepta en If-Match:
// pedimos el ETag con PROPFIND (va en el cuerpo XML, que no se toca) y, si no, quitamos el «W/».
const cleanEtag = (e) => (e || '').trim().replace(/^W\//i, '');
async function strongEtag(env, href, fallback) {
  try {
    const r = await dav(env, 'PROPFIND', href, '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>', { Depth: '0' });
    const e = xmlUnescape(pick(await r.text(), 'getetag'));
    if (e) return cleanEtag(e);
  } catch (err) { if (err instanceof Response) throw err; }
  return cleanEtag(fallback);
}

// iCloud no admite buscar por UID (responde 412). Probamos: 1) GET directo {uid}.ics; 2) rango de fechas alrededor de `near`.
const davStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
async function findByUid(env, uid, near) {
  const cals = await listCalendars(env);
  for (const cal of cals) {
    const href = cal.href + encodeURIComponent(uid) + '.ics';
    const r = await dav(env, 'GET', href, undefined, { 'Content-Type': 'text/calendar' });
    if (r.ok) { const ics = await r.text(); if (ics.includes(uid)) return { href, etag: await strongEtag(env, href, r.headers.get('etag')), ics, calendar: cal.name }; }
  }
  if (!near) return null;
  const t = new Date(near).getTime();
  const q = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${davStamp(t - 2 * 864e5)}" end="${davStamp(t + 2 * 864e5)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  for (const cal of cals) {
    const r = await dav(env, 'REPORT', cal.href, q, { Depth: '1' });
    if (!r.ok && r.status !== 207) continue;
    for (const x of responses(await r.text())) {
      const data = xmlUnescape(pick(x, 'calendar-data'));
      if (!new RegExp(`\\nUID:${uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n`).test('\n' + data.replace(/\r\n/g, '\n') + '\n')) continue;
      return { href: new URL(xmlUnescape(pick(x, 'href')), cal.href).toString(), etag: cleanEtag(xmlUnescape(pick(x, 'getetag'))), ics: data, calendar: cal.name };
    }
  }
  return null;
}

// --- edición del ICS ---
const pad2 = (n) => String(n).padStart(2, '0');
const utcStamp = (d) => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
const dateStamp = (s) => s.replace(/-/g, '').slice(0, 8); // 'YYYY-MM-DD' → YYYYMMDD
function unfold(t) { return t.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }
function splitEvents(ics) {
  const lines = unfold(ics).split('\n');
  const blocks = []; let cur = null; const outside = [];
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { cur = [l]; continue; }
    if (cur) { cur.push(l); if (l === 'END:VEVENT') { blocks.push(cur); outside.push({ ev: blocks.length - 1 }); cur = null; } continue; }
    outside.push(l);
  }
  return { blocks, outside };
}
const prop = (block, name) => block.find((l) => l.split(/[;:]/)[0].toUpperCase() === name);
function setTimes(block, { start, end, allDay }) {
  const keep = block.filter((l) => !/^(DTSTART|DTEND|DURATION|DTSTAMP|LAST-MODIFIED|SEQUENCE)[;:]/i.test(l));
  const seq = parseInt((prop(block, 'SEQUENCE') || 'SEQUENCE:0').split(':')[1], 10) || 0;
  const now = utcStamp(new Date());
  const times = allDay
    ? [`DTSTART;VALUE=DATE:${dateStamp(start)}`, `DTEND;VALUE=DATE:${dateStamp(end)}`]
    : [`DTSTART:${utcStamp(new Date(start))}`, `DTEND:${utcStamp(new Date(end))}`];
  keep.splice(1, 0, ...times, `DTSTAMP:${now}`, `LAST-MODIFIED:${now}`, `SEQUENCE:${seq + 1}`);
  return keep;
}
function zoned(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const off = (t) => { const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t; };
    let t = guess - off(guess); t = guess - off(t); return t;
  } catch { return guess; }
}
/** Instante (ms) de una línea DTSTART/RECURRENCE-ID, con o sin TZID. */
function lineInstant(line) {
  const [head, v] = [line.slice(0, line.lastIndexOf(':')), line.slice(line.lastIndexOf(':') + 1).trim()];
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return NaN;
  const [, y, mo, d, h = 0, mi = 0, se = 0, z] = m;
  if (!m[4]) return Date.UTC(+y, +mo - 1, +d);
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const tz = (/TZID=([^;:]+)/i.exec(head) || [])[1];
  return tz ? zoned(+y, +mo - 1, +d, +h, +mi, +se, tz.replace(/"/g, '')) : Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
}
function sameInstant(line, occ, allDay) {
  if (!line) return false;
  const v = line.split(':').pop().trim();
  if (allDay) return v.slice(0, 8) === dateStamp(occ);
  return lineInstant(line) === new Date(occ).getTime();
}
/** Mueve el evento (o solo una ocurrencia de una serie) y devuelve el ICS nuevo. */
export function moveInIcs(ics, { uid, occurrence, start, end, allDay }) {
  const { blocks, outside } = splitEvents(ics);
  const mine = blocks.map((b, i) => ({ b, i })).filter(({ b }) => (prop(b, 'UID') || '').slice(4).trim() === uid);
  if (!mine.length) throw new Response('Evento no encontrado en iCloud', { status: 404 });
  const master = mine.find(({ b }) => !prop(b, 'RECURRENCE-ID'));
  const recurring = master && prop(master.b, 'RRULE');
  if (!recurring || !occurrence) {
    const target = master || mine[0];
    blocks[target.i] = setTimes(target.b, { start, end, allDay });
  } else {
    // solo esta ocurrencia: modificar la excepción si existe, o crear una nueva con RECURRENCE-ID
    const ex = mine.find(({ b }) => sameInstant(prop(b, 'RECURRENCE-ID'), occurrence, allDay));
    if (ex) blocks[ex.i] = setTimes(ex.b, { start, end, allDay });
    else {
      const base = master.b.filter((l) => !/^(RRULE|RDATE|EXDATE|EXRULE|RECURRENCE-ID)[;:]/i.test(l));
      const rid = allDay ? `RECURRENCE-ID;VALUE=DATE:${dateStamp(occurrence)}` : `RECURRENCE-ID:${utcStamp(new Date(occurrence))}`;
      const nb = setTimes(base, { start, end, allDay });
      nb.splice(1, 0, rid);
      blocks.push(nb);
      const endCal = outside.lastIndexOf('END:VCALENDAR');
      outside.splice(endCal, 0, { ev: blocks.length - 1 });
    }
  }
  return outside.map((x) => (typeof x === 'string' ? x : blocks[x.ev].join('\r\n'))).join('\r\n').replace(/(\r\n)+$/, '') + '\r\n';
}

async function caldavRoute(request, env, path) {
  if (!env.PLANNER_TOKEN || request.headers.get('X-Planner-Token') !== env.PLANNER_TOKEN) return [401, { error: 'Código privado incorrecto o sin configurar en el worker (PLANNER_TOKEN)' }];
  if (!env.ICLOUD_USER || !env.ICLOUD_APP_PASSWORD) return [500, { error: 'Faltan los secretos ICLOUD_USER / ICLOUD_APP_PASSWORD en el worker' }];
  if (path === '/caldav/calendars') return [200, { calendars: (await listCalendars(env)).map((c) => c.name) }];
  if (path === '/caldav/move' && request.method === 'POST') {
    const b = await request.json();
    if (!b.uid || !b.start || !b.end) return [400, { error: 'Faltan datos (uid, start, end)' }];
    let r, found;
    for (let attempt = 0; attempt < 2; attempt++) { // si iCloud dice que cambió, se relee y se reintenta una vez
      found = await findByUid(env, b.uid, b.near || b.occurrence || b.start);
      if (!found) return [404, { error: 'No encuentro ese evento en tu iCloud' }];
      const ics = moveInIcs(found.ics, b);
      r = await dav(env, 'PUT', found.href, ics, { 'Content-Type': 'text/calendar; charset=utf-8', ...(found.etag ? { 'If-Match': found.etag } : {}) });
      if (r.status !== 412) break;
    }
    if (r.status === 412) return [409, { error: 'El evento cambió en iCloud mientras lo movías. Vuelve a intentarlo.' }];
    if (!r.ok) return [502, { error: `iCloud respondió ${r.status} al guardar: ${(await r.text()).slice(0, 200)}` }];
    return [200, { ok: true, calendar: found.calendar }];
  }
  return [404, { error: 'Ruta desconocida' }];
}

export default {
  async fetch(request, env = {}) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Planner-Token' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const reqUrl = new URL(request.url);
    const params = reqUrl.searchParams;
    try {
      if (reqUrl.pathname.startsWith('/caldav/')) {
        const [status, body] = await caldavRoute(request, env, reqUrl.pathname);
        return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      if (params.get('share')) {
        const dl = await resolveShare(params.get('share'));
        const r = await fetch(dl);
        if (!r.ok) return new Response(`Descarga ${r.status}`, { status: 502, headers: cors });
        return new Response(r.body, { headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
      }
      const target = params.get('url');
      if (!target) return new Response('Falta ?url= o ?share=', { status: 400, headers: cors });
      const u = new URL(target.replace(/^webcals?:\/\//i, 'https://'));
      if (u.protocol !== 'https:' || !ICLOUD.test(u.hostname)) return new Response('Host no permitido', { status: 403, headers: cors });
      const r = await fetch(u.toString(), { headers: { 'User-Agent': 'ics-proxy' }, cf: { cacheTtl: 300 } });
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=300' } });
    } catch (e) {
      if (e instanceof Response) { const h = new Headers(e.headers); for (const [k, v] of Object.entries(cors)) h.set(k, v); return new Response(e.body, { status: e.status, headers: h }); }
      return new Response('Error: ' + (e && e.message), { status: 500, headers: cors });
    }
  },
};
