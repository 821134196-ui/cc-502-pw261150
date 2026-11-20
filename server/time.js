const DAY_MS = 86400000;

export function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function todayUTC() {
  return isoDay(new Date());
}

export function addDays(day, n) {
  return isoDay(new Date(`${day}T00:00:00.000Z`).getTime() + n * DAY_MS);
}

export function daysAgo(n) {
  return addDays(todayUTC(), -n);
}

export function dayList(from, to) {
  const out = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard++ < 800) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

export function dayStamp(day, hour = 9, minute = 0) {
  return `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function hoursBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
}

export function dayDiff(a, b) {
  return Math.round((new Date(`${b}T00:00:00.000Z`) - new Date(`${a}T00:00:00.000Z`)) / DAY_MS);
}
