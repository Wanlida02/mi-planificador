// Calendario de vacaciones (artefacto «Calendario de vacaciones»): importación y consulta.
// Formatos: JSON del botón «Exportar al planificador» o el .ics de «Exportar a calendario».
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fmtHM = (m) => `${Math.floor(m / 60)}:${pad(m % 60)}`;

function fromICS(text) {
  const entries = {};
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  let ev = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (l === 'END:VEVENT') {
      if (ev?.s && ev.e && ev.t) {
        const a = new Date(+ev.s.slice(0, 4), +ev.s.slice(4, 6) - 1, +ev.s.slice(6, 8));
        const b = new Date(+ev.e.slice(0, 4), +ev.e.slice(4, 6) - 1, +ev.e.slice(6, 8));
        const ap = /asuntos propios\s*\((\d+):(\d{2})/i.exec(ev.t);
        for (let d = new Date(a); d < b; d.setDate(d.getDate() + 1)) entries[iso(d)] = ap ? { t: 'A', m: +ap[1] * 60 + +ap[2] } : { t: 'V' };
      }
      ev = null; continue;
    }
    if (!ev) continue;
    const m = /^(DTSTART|DTEND|SUMMARY)[^:]*:(.*)$/i.exec(l);
    if (m) ev[{ DTSTART: 's', DTEND: 'e', SUMMARY: 't' }[m[1].toUpperCase()]] = m[2].trim().replace(/\\([,;\\])/g, '$1');
  }
  return { entries, workday: 450, holidays: { nacional: [], local: [], senasa: [] } };
}

/** Lee el texto (JSON o .ics) y devuelve {entries, workday, holidays}. Lanza un Error claro si no lo entiende. */
export function parseVacations(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('El archivo está vacío');
  if (/^BEGIN:VCALENDAR/i.test(t)) {
    const r = fromICS(t);
    if (!Object.keys(r.entries).length) throw new Error('El .ics no tiene días de vacaciones ni asuntos propios');
    return r;
  }
  let j;
  try { j = JSON.parse(t); } catch { throw new Error('No es un JSON válido. Usa «📤 Exportar al planificador» en tu calendario de vacaciones.'); }
  const src = j.entries ? j : j.plan?.entries ? j.plan : null;
  if (!src) throw new Error('El JSON no tiene días («entries»). Usa «📤 Exportar al planificador» en tu calendario de vacaciones.');
  const entries = {};
  for (const [d, e] of Object.entries(src.entries)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !e) continue;
    if (e.t === 'V') entries[d] = { t: 'V' };
    else if (e.t === 'A') entries[d] = { t: 'A', m: Math.max(1, +e.m || 0) };
  }
  const h = src.holidays || j.holidays || {};
  const list = (x) => (Array.isArray(x) ? x.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : []);
  return { entries, workday: +src.workday || 450, holidays: { nacional: list(h.nacional), local: list(h.local), senasa: list(h.senasa) } };
}

/** Qué hay ese día en el calendario de vacaciones: {kind, title, full, minutes} o null. */
export function vacationOn(vac, date) {
  if (!vac) return null;
  const e = vac.entries?.[date];
  if (e?.t === 'V') return { kind: 'vac', title: '🏖️ Vacaciones', full: true };
  if (e?.t === 'A') { const full = e.m >= (vac.workday || 450); return { kind: 'vacap', title: `🕒 Asuntos propios ${full ? '(jornada)' : fmtHM(e.m) + ' h'}`, full, minutes: e.m }; }
  const h = vac.holidays || {};
  if (h.nacional?.includes(date)) return { kind: 'vacfest', title: '🎉 Festivo', full: true };
  if (h.local?.includes(date)) return { kind: 'vacfest', title: '🎉 Festivo local', full: true };
  if (h.senasa?.includes(date)) return { kind: 'vacfest', title: '🟢 Día libre SENASA', full: true };
  return null;
}

export function summary(vac) {
  const es = Object.values(vac?.entries || {});
  const h = vac?.holidays || {};
  return { v: es.filter((e) => e.t === 'V').length, a: es.filter((e) => e.t === 'A').length, h: (h.nacional?.length || 0) + (h.local?.length || 0) + (h.senasa?.length || 0) };
}
