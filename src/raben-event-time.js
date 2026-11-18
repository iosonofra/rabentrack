import { parseRabenEventDate } from './raben-beta-client.js';

const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const cache = new Map();
export function romeParts(date) {
  return Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}
export function romeDay(date) {
  const p = romeParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

// Raben's offset-free dates are Italian local time, regardless of server TZ.
// For date-only events use the end of that day, avoiding premature SLA alerts.
export function parseOperationalDate(value) {
  const raw = String(value || '').trim().slice(0, 100);
  if (cache.has(raw)) return cache.get(raw);
  let result = null;
  const calendar = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const checkCalendar = calendar ? new Date(Date.UTC(+calendar[1], +calendar[2] - 1, +calendar[3])) : null;
  const validCalendar = !calendar || (checkCalendar.getUTCFullYear() === +calendar[1] && checkCalendar.getUTCMonth() === +calendar[2] - 1 && checkCalendar.getUTCDate() === +calendar[3]);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    const time = Date.parse(raw);
    if (validCalendar && Number.isFinite(time)) result = { time, day: romeDay(new Date(time)), precision: 'datetime', value: raw };
  } else {
    const parsed = parseRabenEventDate(raw);
    const validRaw = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{4})(?:[,\sT]+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(raw);
    const match = validRaw && parsed.local.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/);
    if (match) {
      const [, year, month, day, hour, minute, second] = match;
      const dateOnly = hour === undefined;
      const h = dateOnly ? 23 : Number(hour), m = dateOnly ? 59 : Number(minute), s = dateOnly ? 59 : Number(second);
      const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), h, m, s);
      const check = new Date(wall);
      if (check.getUTCFullYear() === Number(year) && check.getUTCMonth() === Number(month) - 1 && check.getUTCDate() === Number(day) && h <= 23 && m <= 59 && s <= 59) {
        const candidates = new Set();
        for (const offset of [-12, 12]) {
          const probe = wall + offset * 3600000;
          const p = romeParts(new Date(probe));
          const zoneOffset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - probe;
          const time = wall - zoneOffset;
          const actual = romeParts(new Date(time));
          if (`${actual.year}-${actual.month}-${actual.day}` === `${year}-${month}-${day}` && +actual.hour === h && +actual.minute === m && +actual.second === s) candidates.add(time);
        }
        // In the repeated autumn hour choose the later instant conservatively.
        if (candidates.size) result = { time: Math.max(...candidates) + (dateOnly ? 999 : 0), day: `${year}-${month}-${day}`, precision: dateOnly ? 'date' : 'datetime', value: parsed.local };
      }
    }
  }
  cache.set(raw, result);
  if (cache.size > 1024) cache.delete(cache.keys().next().value);
  return result;
}

export function latestRabenEvent(record = {}) {
  const values = [record.rabenLastEventAt, record.rabenStatusAt, record.rabenStatusDateRaw,
    ...(Array.isArray(record.rabenTimeline) ? record.rabenTimeline.slice(0, 60).map((event) => event.statusAt || event.statusDateRaw || event.date) : [])];
  let latest = null;
  const local = [];
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    if (/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
      const date = parseOperationalDate(raw);
      if (date && (!latest || date.time > latest.time)) latest = date;
    } else {
      const parsed = parseRabenEventDate(raw);
      if (parsed.local) local.push({ value: raw, key: parsed.local.length === 10 ? parsed.local + 'T23:59:59' : parsed.local });
    }
  }
  // Sort the bounded timeline cheaply, converting only the newest valid local
  // date to an instant instead of invoking Intl for every historical event.
  local.sort((a, b) => a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
  for (const candidate of local) {
    const date = parseOperationalDate(candidate.value);
    if (!date) continue;
    if (!latest || date.time > latest.time) latest = date;
    break;
  }
  return latest;
}

export function isTechnicalRabenStatus(status) {
  return !status || ['Non verificato', 'Errore verifica', 'Da verificare manualmente', 'Spedizione non trovata', 'Intervento manuale richiesto'].includes(status);
}
