const MONTH_NAMES = Object.freeze({ JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 });
const WEEKDAY_NAMES = Object.freeze({ SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 });
const WEEKDAY_FROM_INTL = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
const FIELD_DEFINITIONS = Object.freeze([
  { name: 'minuto', min: 0, max: 59 },
  { name: 'ora', min: 0, max: 23 },
  { name: 'giorno del mese', min: 1, max: 31 },
  { name: 'mese', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'giorno della settimana', min: 0, max: 7, names: WEEKDAY_NAMES, normalize: (value) => value === 7 ? 0 : value },
]);

export const CRON_TIME_ZONE = 'Europe/Rome';
export const CRON_PRESETS = Object.freeze([
  { id: 'weekdays-hourly', label: 'Feriali · ogni ora 08–19', expression: '0 8-19 * * 1-5' },
  { id: 'weekdays-three-times', label: 'Feriali · ore 09, 14 e 18', expression: '0 9,14,18 * * 1-5' },
  { id: 'daily-twice', label: 'Ogni giorno · 08:30 e 15:30', expression: '30 8,15 * * *' },
  { id: 'weekdays-half-hour', label: 'Feriali · ogni 30 min 08–18:30', expression: '*/30 8-18 * * 1-5' },
  { id: 'daily-morning', label: 'Ogni giorno · ore 08:00', expression: '0 8 * * *' },
]);

function namedValue(token, names) {
  const upper = String(token).toUpperCase();
  if (names && Object.hasOwn(names, upper)) return names[upper];
  if (!/^\d+$/.test(upper)) return Number.NaN;
  return Number(upper);
}

function expandPart(part, definition) {
  const [rangeToken, stepToken] = part.split('/');
  if (!rangeToken || part.split('/').length > 2) throw new Error(`Valore cron non valido nel campo ${definition.name}: “${part}”.`);
  const step = stepToken === undefined ? 1 : Number(stepToken);
  if (!Number.isInteger(step) || step < 1) throw new Error(`Step non valido nel campo ${definition.name}: “${part}”.`);

  let start;
  let end;
  if (rangeToken === '*') {
    start = definition.min;
    end = definition.max;
  } else if (rangeToken.includes('-')) {
    const pieces = rangeToken.split('-');
    if (pieces.length !== 2) throw new Error(`Intervallo non valido nel campo ${definition.name}: “${part}”.`);
    start = namedValue(pieces[0], definition.names);
    end = namedValue(pieces[1], definition.names);
  } else {
    start = namedValue(rangeToken, definition.names);
    end = start;
    if (stepToken !== undefined) end = definition.max;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < definition.min || end > definition.max || start > end) {
    throw new Error(`Valore fuori intervallo nel campo ${definition.name}: “${part}”.`);
  }

  const values = [];
  for (let value = start; value <= end; value += step) values.push(definition.normalize ? definition.normalize(value) : value);
  return values;
}

function parseField(source, definition) {
  const token = String(source || '').trim();
  if (!token) throw new Error(`Campo cron ${definition.name} mancante.`);
  const values = new Set();
  token.split(',').forEach((part) => expandPart(part.trim(), definition).forEach((value) => values.add(value)));
  return { values, wildcard: token === '*', source: token };
}

export function parseCronExpression(expression) {
  const source = String(expression || '').trim().replace(/\s+/g, ' ');
  const fields = source.split(' ');
  if (fields.length !== 5) throw new Error('L’espressione cron deve contenere esattamente 5 campi: minuto, ora, giorno, mese e giorno della settimana.');
  const parsed = fields.map((field, index) => parseField(field, FIELD_DEFINITIONS[index]));
  return { source, minute: parsed[0], hour: parsed[1], dayOfMonth: parsed[2], month: parsed[3], dayOfWeek: parsed[4] };
}

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(date).reduce((output, part) => {
    if (part.type !== 'literal') output[part.type] = part.value;
    return output;
  }, {});
  return {
    minute: Number(parts.minute), hour: Number(parts.hour), dayOfMonth: Number(parts.day), month: Number(parts.month),
    dayOfWeek: WEEKDAY_FROM_INTL[parts.weekday],
  };
}

export function cronMatchesDate(parsedOrExpression, date, timeZone = CRON_TIME_ZONE) {
  const parsed = typeof parsedOrExpression === 'string' ? parseCronExpression(parsedOrExpression) : parsedOrExpression;
  const local = localDateParts(date, timeZone);
  const dayOfMonthMatches = parsed.dayOfMonth.values.has(local.dayOfMonth);
  const dayOfWeekMatches = parsed.dayOfWeek.values.has(local.dayOfWeek);
  const dayMatches = !parsed.dayOfMonth.wildcard && !parsed.dayOfWeek.wildcard
    ? dayOfMonthMatches || dayOfWeekMatches
    : dayOfMonthMatches && dayOfWeekMatches;
  return parsed.minute.values.has(local.minute)
    && parsed.hour.values.has(local.hour)
    && parsed.month.values.has(local.month)
    && dayMatches;
}

export function getNextCronOccurrence(expression, fromDate = new Date(), timeZone = CRON_TIME_ZONE) {
  const parsed = parseCronExpression(expression);
  const start = new Date(fromDate);
  if (Number.isNaN(start.getTime())) throw new Error('Data iniziale non valida per il calcolo cron.');
  let cursor = new Date(Math.floor(start.getTime() / 60_000) * 60_000 + 60_000);
  const maxMinutes = 366 * 24 * 60 + 1440;
  for (let checked = 0; checked < maxMinutes; checked++, cursor = new Date(cursor.getTime() + 60_000)) {
    if (cronMatchesDate(parsed, cursor, timeZone)) return cursor;
  }
  throw new Error('Nessuna esecuzione trovata entro un anno: controlla l’espressione cron.');
}

export function getNextCronOccurrences(expression, fromDate = new Date(), count = 5, timeZone = CRON_TIME_ZONE) {
  const occurrences = [];
  let cursor = new Date(fromDate);
  for (let index = 0; index < Math.min(Math.max(Number(count) || 5, 1), 20); index++) {
    cursor = getNextCronOccurrence(expression, cursor, timeZone);
    occurrences.push(new Date(cursor));
  }
  return occurrences;
}

function describeWeekdays(field) {
  if (field.wildcard) return '';
  const values = [...field.values].sort((a, b) => a - b).join(',');
  if (values === '1,2,3,4,5') return 'dal lunedì al venerdì';
  if (values === '0,6') return 'nel fine settimana';
  const labels = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
  return `nei giorni ${[...field.values].sort((a, b) => a - b).map((value) => labels[value]).join(', ')}`;
}

export function describeCronExpression(expression) {
  const parsed = parseCronExpression(expression);
  const weekdays = describeWeekdays(parsed.dayOfWeek);
  let timing;
  const minuteSource = parsed.minute.source;
  const hourValues = [...parsed.hour.values].sort((a, b) => a - b);
  if (/^\*\/\d+$/.test(minuteSource)) {
    timing = `Ogni ${minuteSource.slice(2)} minuti${parsed.hour.wildcard ? '' : ` tra le ${String(hourValues[0]).padStart(2, '0')}:00 e le ${String(hourValues.at(-1)).padStart(2, '0')}:59`}`;
  } else if (parsed.minute.values.size === 1) {
    const minute = String([...parsed.minute.values][0]).padStart(2, '0');
    timing = parsed.hour.wildcard
      ? `Ogni ora al minuto ${minute}`
      : `Alle ${hourValues.map((hour) => `${String(hour).padStart(2, '0')}:${minute}`).join(', ')}`;
  } else {
    timing = `Ai minuti ${[...parsed.minute.values].sort((a, b) => a - b).map((value) => String(value).padStart(2, '0')).join(', ')}`;
    if (!parsed.hour.wildcard) timing += ` delle ore ${hourValues.map((value) => String(value).padStart(2, '0')).join(', ')}`;
  }
  return [timing, weekdays].filter(Boolean).join(', ');
}

export function previewCronExpression(expression, { fromDate = new Date(), count = 5, timeZone = CRON_TIME_ZONE } = {}) {
  const nextRuns = getNextCronOccurrences(expression, fromDate, count, timeZone).map((date) => date.toISOString());
  return { valid: true, expression: parseCronExpression(expression).source, timeZone, description: describeCronExpression(expression), nextRuns };
}

