// Cloudflare Worker: proxy mínimo para leer calendarios públicos de iCloud desde el navegador.
// Solo permite URLs de icloud.com, así no sirve como proxy abierto.
// Uso: https://<tu-worker>.workers.dev/?url=<url-del-calendario-codificada>
const ALLOWED_HOSTS = /(^|\.)icloud\.com$/i;
const ALLOWED_ORIGINS = []; // opcional: ['https://tu-usuario.github.io']

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '*';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.length ? (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]) : '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('Falta ?url=', { status: 400, headers: cors });
    let u;
    try { u = new URL(target.replace(/^webcals?:\/\//i, 'https://')); } catch { return new Response('URL no válida', { status: 400, headers: cors }); }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname)) return new Response('Host no permitido', { status: 403, headers: cors });
    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'ics-proxy' }, cf: { cacheTtl: 300 } });
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=300' },
    });
  },
};
