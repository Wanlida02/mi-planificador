export const pad = (n) => String(n).padStart(2, '0');
export const toYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYMD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
export const hm2min = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
export const min2hm = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
export const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`);
export const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const fmtDay = (s) => { const d = parseYMD(s); return `${DOW[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };

/** Crea un elemento. attrs: class, dataset, on*, text, y atributos normales. */
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

let toastT;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

/** Limpia el Client ID pegado (iOS a veces añade http:// o una barra final). */
export function normalizeClientId(s) {
  const m = /[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/i.exec(s || '');
  return m ? m[0] : (s || '').trim();
}
/** Devuelve un mensaje de error si la URL del proxy no es válida ('' si está bien o vacía). */
export function proxyError(s) {
  const v = (s || '').trim();
  if (!v) return '';
  if (/googleusercontent\.com/i.test(v)) return 'Eso es el Client ID de Google, no el proxy. Aquí va la URL de tu worker de Cloudflare (https://ics-proxy.….workers.dev); el Client ID va en el apartado Google.';
  if (isCalendarLink(v)) return 'Eso es el enlace de un calendario, no el proxy. Los calendarios van con «+ Añadir calendario» (arriba); aquí va la URL de tu worker de Cloudflare (https://ics-proxy.….workers.dev).';
  if (!/^https:\/\//i.test(v)) return 'La URL del proxy debe empezar por https:// (la de tu worker de Cloudflare).';
  try { new URL(v); } catch { return 'La URL del proxy no es válida.'; }
  return '';
}
/** Devuelve un mensaje si el enlace no parece un calendario publicado de iCloud. */
export function feedUrlError(s) {
  const v = (s || '').trim();
  if (!v) return '';
  if (!/^(webcals?|https?):\/\//i.test(v)) return 'El enlace debe empezar por webcal:// o https://';
  return '';
}

export const isCalendarLink = (v) => /^webcals?:\/\//i.test(v.trim()) || /caldav\.icloud\.com\/published/i.test(v);
const DOW_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
export const fmtDayLong = (s) => { const d = parseYMD(s); return `${DOW_LONG[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`; };
