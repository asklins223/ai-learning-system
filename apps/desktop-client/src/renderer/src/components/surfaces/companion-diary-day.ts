/**
 * Diary day arithmetic for the companion centre (page 20).
 *
 * The diary is addressed by a **local calendar day** (`YYYY-MM-DD`), because that
 * is the contract the server stores (`companion-daily-summary.ts` writes the
 * user's own day, not a UTC instant). Everything here therefore works on
 * year/month/day parts in local time and never on an epoch millisecond count:
 * `new Date("2026-09-16")` is UTC midnight, which is the previous day for anyone
 * west of Greenwich, and `+86400000` drifts across a DST boundary.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local calendar day of a `Date`, as the server spells it. */
export function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  return toIsoDate(fromIsoDate(value)) === value;
}

function fromIsoDate(value: string): Date {
  const match = ISO_DATE.exec(value);
  if (!match) throw new Error(`not an ISO calendar day: ${value}`);
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

/** Steps a calendar day forward or back without ever going through UTC. */
export function shiftIsoDate(value: string, days: number): string {
  const date = fromIsoDate(value);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

export function todayIsoDate(now: Date = new Date()): string {
  return toIsoDate(now);
}

/** The three most recent days read as words; older ones read as a date. */
export function diaryDayLabel(value: string, today: string = todayIsoDate()): string {
  if (value === today) return "今天";
  if (value === shiftIsoDate(today, -1)) return "昨天";
  if (value === shiftIsoDate(today, -2)) return "前天";
  const [, , month, day] = ISO_DATE.exec(value) ?? [];
  if (!month || !day) return value;
  return `${Number(month)} 月 ${Number(day)} 日`;
}

/**
 * How far back the day strip reaches. A week is what the strip can hold before
 * the labels stop being readable at the compact viewport.
 */
export const DIARY_STRIP_DAYS = 7;

/** Newest first, ending at `anchor` (inclusive). */
export function diaryDayStrip(anchor: string, days: number = DIARY_STRIP_DAYS): readonly string[] {
  return Array.from({ length: days }, (_, index) => shiftIsoDate(anchor, -index));
}
