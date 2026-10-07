const DAY = 86400000;
// A range preserves the uncertainty of relative and date-only labels.
export function publicationRange(note, now = Date.now()) {
  const value = note.rawTime;
  if (value !== null && value !== undefined && value !== '') {
    const n = Number(value);
    const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(value);
    if (Number.isFinite(ms) && ms >= Date.UTC(2010, 0, 1) && ms <= now + 60000)
      return { start: ms, end: ms, source: 'publish-time', exact: true };
  }
  const t = String(note.dateText || '').trim();
  if (!t || /编辑|修改|更新/.test(t)) return null;
  const relative = t.match(/^(\d+)\s*(秒|分钟|小时|天)前/);
  if (relative) {
    const unit = { 秒: 1000, 分钟: 60000, 小时: 3600000, 天: DAY }[relative[2]];
    return { start: now - (Number(relative[1]) + 1) * unit, end: now - Number(relative[1]) * unit, source: 'relative-label', exact: false };
  }
  if (t.startsWith('刚刚')) return { start: now - 60000, end: now, source: 'relative-label', exact: false };
  // XHS dates use China time (UTC+8), independent of the host's timezone.
  const chinaNow = new Date(now + 8 * 3600000);
  let year = chinaNow.getUTCFullYear(), month, day;
  const full = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s|$)/);
  const short = t.match(/^(\d{1,2})[-/.](\d{1,2})(?:\s|$)/);
  const relativeDay = t.match(/^(今天|昨天|前天)(?:\s|$)/);
  let start;
  if (relativeDay) {
    start = Date.UTC(year, chinaNow.getUTCMonth(), chinaNow.getUTCDate()) - 8 * 3600000 - { 今天: 0, 昨天: DAY, 前天: 2 * DAY }[relativeDay[1]];
  } else {
    if (full) [, year, month, day] = full.map(Number);
    else if (short) { month = Number(short[1]); day = Number(short[2]); }
    else return null;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    start = check.getTime() - 8 * 3600000;
    if (!full && start > now + DAY) start = Date.UTC(year - 1, month - 1, day) - 8 * 3600000;
  }
  return { start, end: start + DAY - 1, source: 'date-label', exact: false };
}
