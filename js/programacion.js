// Parser de "Programación Anual YYYY.xlsx" (hojas "Programación YYYY").
// Estructura: fila 1 = nombres de mes; fila 2 = "Equipo A".."Equipo F","EVENTOS";
// para cada mes, la columna del día está 2 columnas antes de "Equipo A".
// Filas siguientes: una por día del mes. Celdas combinadas verticalmente = varios días.

const MONTHS = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO',
  'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

function colToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function numToCol(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function addr(r, c) { return numToCol(c) + (r + 1); }
function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return { c: colToNum(m[1]), r: parseInt(m[2], 10) - 1 };
}
function sheetRange(ws) {
  const [a, b] = (ws['!ref'] || 'A1:A1').split(':');
  const s = parseRef(a), e = parseRef(b || a);
  return { s, e };
}
const val = (ws, r, c) => { const cell = ws[addr(r, c)]; return cell ? cell.v : undefined; };
const clean = (v) => String(v ?? '').replace(/ /g, ' ').trim();

export function hasInitials(text, initials) {
  const toks = clean(text).toUpperCase().split(/[\s\/,;+\-()\.]+/).filter(Boolean);
  return toks.includes(initials.toUpperCase());
}

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

/**
 * Devuelve {events:[{id,date,title,detail,days,start,end,kind:'trabajo'|'festivo'}], years:[...]}
 */
export function parseProgramacion(wb, opts = {}) {
  const initials = opts.initials || 'FS';
  const tripHours = opts.tripHours || ['07:00', '17:00'];
  const dayHours = opts.dayHours || ['07:00', '15:00'];
  const raw = []; // {date, label, detail, spanId}
  const festivos = [];
  const years = [];

  for (const name of wb.SheetNames) {
    const ym = /^Programaci[oó]n\s+(\d{4})$/i.exec(name.trim());
    if (!ym) continue;
    const year = parseInt(ym[1], 10);
    years.push(year);
    const ws = wb.Sheets[name];
    const { e } = sheetRange(ws);
    // índice de celdas combinadas por su esquina superior izquierda
    const merges = new Map();
    for (const m of ws['!merges'] || []) merges.set(`${m.s.r},${m.s.c}`, m);

    // localizar bloques de mes vía cabecera "Equipo A" en la fila 2 (r=1)
    const blocks = [];
    for (let c = 0; c <= e.c; c++) {
      if (/^Equipo A$/i.test(clean(val(ws, 1, c)))) {
        let end = c;
        while (end <= e.c && clean(val(ws, 1, end)) && !/^EVENTOS$/i.test(clean(val(ws, 1, end)))) end++;
        blocks.push({ dayCol: c - 2, first: c, last: Math.min(end, e.c) });
      }
    }
    // mes: buscar nombre del mes en fila 1 dentro del bloque; si no, por orden
    blocks.forEach((b, i) => {
      let month = i;
      for (let c = b.dayCol; c <= b.last; c++) {
        const k = MONTHS.indexOf(clean(val(ws, 0, c)).toUpperCase());
        if (k >= 0) { month = k; break; }
      }
      b.month = month;
    });

    for (const b of blocks) {
      // mapa fila -> día
      const rowDay = new Map();
      for (let r = 2; r <= e.r; r++) {
        const d = val(ws, r, b.dayCol);
        if (typeof d === 'number' && d >= 1 && d <= 31) rowDay.set(r, d);
      }
      for (const [r, d] of rowDay) {
        for (let c = b.first; c <= b.last; c++) {
          const text = clean(val(ws, r, c));
          if (!text) continue;
          const m = merges.get(`${r},${c}`);
          const rEnd = m ? m.e.r : r;
          const days = [];
          for (let rr = r; rr <= rEnd; rr++) if (rowDay.has(rr)) days.push(rowDay.get(rr));
          if (/FESTIVO|SEMANA SANTA/i.test(text) && !hasInitials(text, initials)) {
            for (const dd of days) festivos.push({ date: ymd(year, b.month, dd), title: text.replace(/\s+/g, ' ') });
            continue;
          }
          if (!hasInitials(text, initials)) continue;
          const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
          const label = lines[0];
          const detail = lines.slice(1).join(' ');
          const spanId = `${year}-${b.month}-${r}-${c}`;
          for (const dd of days) raw.push({ date: ymd(year, b.month, dd), label, detail, spanId, norm: text.replace(/\s+/g, '').toUpperCase() });
        }
      }
    }
  }

  // Agrupar: misma celda combinada, o días consecutivos con el mismo texto (p.ej. viaje que cruza de mes)
  raw.sort((a, b) => a.date.localeCompare(b.date));
  const groups = [];
  const dayMs = 86400000;
  for (const it of raw) {
    const t = Date.parse(it.date + 'T12:00:00Z');
    const g = groups.find((g) => (g.spanIds.has(it.spanId) || g.norm === it.norm) &&
      Math.round((t - g.lastT) / dayMs) <= 1 && t >= g.lastT);
    if (g) { if (t !== g.lastT) g.dates.push(it.date); g.lastT = t; g.spanIds.add(it.spanId); }
    else groups.push({ ...it, dates: [it.date], lastT: t, spanIds: new Set([it.spanId]) });
  }
  const events = [];
  for (const g of groups) {
    const multi = g.dates.length > 1;
    const [start, end] = multi ? tripHours : dayHours;
    g.dates.forEach((date, i) => events.push({
      id: `w-${g.dates[0]}-${g.norm.slice(0, 24)}-${i}`,
      kind: 'trabajo', date, start, end,
      title: g.label, detail: g.detail,
      trip: multi, tripDay: i + 1, tripDays: g.dates.length,
    }));
  }
  const seen = new Set();
  for (const f of festivos) {
    const k = f.date + f.title; if (seen.has(k)) continue; seen.add(k);
    events.push({ id: `f-${f.date}`, kind: 'festivo', date: f.date, allDay: true, title: f.title });
  }
  events.sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
  return { events, years };
}
