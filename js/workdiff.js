// Comparar dos programaciones (días de trabajo FS) y describir los cambios.
const sig = (evs) => evs.map((e) => `${e.title}|${e.detail || ''}|${e.start}-${e.end}`).sort().join(' + ');
const label = (evs) => evs.map((e) => `${e.title}${e.detail ? ' (' + e.detail + ')' : ''}${e.trip ? ` · viaje ${e.tripDay}/${e.tripDays}` : ''}`).join(' + ');

/** Cambios de días de trabajo entre `oldEvents` y `newEvents`, solo en `years` y desde `fromDate` (YYYY-MM-DD). */
export function diffWork(oldEvents, newEvents, years, fromDate) {
  const by = (evs) => {
    const m = new Map();
    for (const e of evs) {
      if (e.kind !== 'trabajo' || !years.includes(+e.date.slice(0, 4)) || e.date < fromDate) continue;
      if (!m.has(e.date)) m.set(e.date, []);
      m.get(e.date).push(e);
    }
    return m;
  };
  const a = by(oldEvents), b = by(newEvents);
  const added = [], removed = [], changed = [];
  for (const [d, evs] of b) {
    if (!a.has(d)) added.push({ date: d, text: label(evs) });
    else if (sig(a.get(d)) !== sig(evs)) changed.push({ date: d, before: label(a.get(d)), text: label(evs) });
  }
  for (const [d, evs] of a) if (!b.has(d)) removed.push({ date: d, text: label(evs) });
  const s = (x) => x.sort((p, q) => p.date.localeCompare(q.date));
  return { added: s(added), removed: s(removed), changed: s(changed), total: added.length + removed.length + changed.length };
}

export function diffSummary(d) {
  const p = [];
  if (d.added.length) p.push(`${d.added.length} día${d.added.length > 1 ? 's' : ''} nuevo${d.added.length > 1 ? 's' : ''}`);
  if (d.removed.length) p.push(`${d.removed.length} quitado${d.removed.length > 1 ? 's' : ''}`);
  if (d.changed.length) p.push(`${d.changed.length} cambiado${d.changed.length > 1 ? 's' : ''}`);
  return p.join(', ');
}
