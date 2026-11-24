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

export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const params = new URL(request.url).searchParams;
    try {
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
