// Parser ICS mínimo (iCloud): VEVENT, DTSTART/DTEND (fecha, local, UTC, TZID),
// RRULE (DAILY/WEEKLY/MONTHLY/YEARLY con INTERVAL, COUNT, UNTIL, BYDAY), EXDATE, RECURRENCE-ID.

function unfold(text) { return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const [name, ...ps] = head.split(';');
  const params = {};
  for (const p of ps) { const [k, v] = p.split('='); params[k.toUpperCase()] = (v || '').replace(/"/g, ''); }
  return { name: name.toUpperCase(), params, value };
}

function unescapeText(s) { return s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1'); }

// Convierte hora de pared en una zona IANA a Date (instante)
function zonedToDate(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const off = (t) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return asUTC - t;
    };
    let t = guess - off(guess);
    t = guess - off(t);
    return new Date(t);
  } catch { return new Date(y, mo, d, h, mi, s); }
}

function parseDate(prop) {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
  if (prop.params.TZID) return { date: zonedToDate(+y, +mo - 1, +d, +h, +mi, +s, prop.params.TZID), allDay: false };
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
}

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function expand(ev, rangeStart, rangeEnd) {
  const dur = ev.end - ev.start;
  if (!ev.rrule) return (ev.start < rangeEnd && ev.end > rangeStart) ? [{ start: ev.start, end: ev.end }] : [];
  const r = Object.fromEntries(ev.rrule.split(';').map((kv) => kv.split('=')));
  const freq = r.FREQ, interval = parseInt(r.INTERVAL || '1', 10);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const until = r.UNTIL ? parseDate({ value: r.UNTIL, params: {} }).date : null;
  const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => DAYS[x.slice(-2)]) : null;
  const out = [];
  let n = 0;
  const base = new Date(ev.start);
  const exd = new Set(ev.exdates.map((d) => d.getTime()));
  const push = (s) => {
    if (until && s > until) return false;
    if (n >= count) return false;
    n++;
    const e = new Date(s.getTime() + dur);
    if (!exd.has(s.getTime()) && s < rangeEnd && e > rangeStart) out.push({ start: s, end: e });
    return true;
  };
  const LIMIT = 5000;
  for (let i = 0; i < LIMIT; i++) {
    let cur;
    if (freq === 'DAILY') { cur = new Date(base); cur.setDate(base.getDate() + i * interval); }
    else if (freq === 'WEEKLY') {
      const wk = new Date(base); wk.setDate(base.getDate() - base.getDay() + i * 7 * interval);
      const ds = byday || [base.getDay()];
      let stop = false;
      for (const d of [...ds].sort()) {
        const c = new Date(wk); c.setDate(wk.getDate() + d);
        c.setHours(base.getHours(), base.getMinutes(), base.getSeconds());
        if (c < base) continue;
        if (c > rangeEnd) { stop = true; break; }
        if (!push(c)) { stop = true; break; }
      }
      if (stop) break;
      continue;
    }
    else if (freq === 'MONTHLY') { cur = new Date(base); cur.setMonth(base.getMonth() + i * interval); if (cur.getDate() !== base.getDate()) continue; }
    else if (freq === 'YEARLY') { cur = new Date(base); cur.setFullYear(base.getFullYear() + i * interval); if (cur.getDate() !== base.getDate()) continue; }
    else break;
    if (cur > rangeEnd) break;
    if (!push(cur)) break;
  }
  return out;
}

/** Devuelve eventos [{id,title,start:Date,end:Date,allDay,location}] dentro del rango */
export function parseICS(text, rangeStart, rangeEnd) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null, depth = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; depth = 1; continue; }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:')) {
      depth--;
      if (line === 'END:VEVENT' && depth === 0) { events.push(cur); cur = null; }
      continue;
    }
    if (depth !== 1) continue;
    const p = parseLine(line); if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.title = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value); break;
      case 'URL': cur.url = p.value.trim(); break;
      case 'DTSTART': { const d = parseDate(p); if (d) { cur.start = d.date; cur.allDay = d.allDay; } break; }
      case 'DTEND': { const d = parseDate(p); if (d) cur.end = d.date; break; }
      case 'DURATION': cur.duration = p.value; break;
      case 'RRULE': cur.rrule = p.value; break;
      case 'EXDATE': for (const v of p.value.split(',')) { const d = parseDate({ value: v, params: p.params }); if (d) cur.exdates.push(d.date); } break;
      case 'RECURRENCE-ID': { const d = parseDate(p); if (d) cur.recurrenceId = d.date; break; }
      case 'STATUS': cur.status = p.value; break;
    }
  }
  // duraciones
  for (const e of events) {
    if (!e.start) continue;
    if (!e.end) {
      if (e.duration) {
        const m = /P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(e.duration) || [];
        const ms = (((+m[1] || 0) * 7 + (+m[2] || 0)) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000;
        e.end = new Date(e.start.getTime() + ms);
      } else e.end = new Date(e.start.getTime() + (e.allDay ? 86400000 : 3600000));
    }
  }
  // excepciones (RECURRENCE-ID) sustituyen ocurrencias
  const overrides = new Map();
  for (const e of events) if (e.recurrenceId) {
    const k = e.uid; if (!overrides.has(k)) overrides.set(k, []);
    overrides.get(k).push(e.recurrenceId.getTime());
  }
  const out = [];
  for (const e of events) {
    if (!e.start || e.status === 'CANCELLED') continue;
    if (!e.recurrenceId && overrides.has(e.uid)) e.exdates.push(...overrides.get(e.uid).map((t) => new Date(t)));
    for (const occ of expand(e, rangeStart, rangeEnd)) {
      out.push({ id: `${e.uid || e.title}-${occ.start.getTime()}`, uid: e.uid || '', recurrenceId: e.recurrenceId ? e.recurrenceId.toISOString() : null, title: e.title || '(sin título)', location: e.location || '', description: e.description || '', url: e.url || '', recurring: !!e.rrule, start: occ.start, end: occ.end, allDay: !!e.allDay });
    }
  }
  return out;
}
