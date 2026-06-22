import type { AppConfig } from "./types";

export interface WorldDate {
  day: number;
  year: number;
  month: number;
  dayOfMonth: number;
  monthName: string;
  eraYear: number;
  eraLabel: string;
  label: string;
  slugPart: string;
  startsAt: number;
  endsAt: number;
}

export function getWorldDate(app: AppConfig, now = Date.now()): WorldDate {
  const dayMs = Math.max(1, app.homepage.rotation_hours) * 60 * 60 * 1000;
  const parsedEpoch = Date.parse(app.world.epoch_real_time);
  const epoch = Number.isFinite(parsedEpoch) ? parsedEpoch : Date.parse("2026-01-01T00:00:00.000Z");
  const elapsedDays = Math.max(0, Math.floor((now - epoch) / dayMs));
  const day = Math.max(1, app.world.epoch_day) + elapsedDays;
  const date = addUtcDays(parseWorldDate(app.world.epoch_date), day - Math.max(1, app.world.epoch_day));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const dayOfMonth = date.getUTCDate();
  const monthName = MONTH_NAMES[date.getUTCMonth()] ?? "January";
  const eraPivot = parseEraPivotDate(app.world.era_pivot_date);
  const beforePivot =
    year < eraPivot.year ||
    (year === eraPivot.year && month < eraPivot.month) ||
    (year === eraPivot.year && month === eraPivot.month && dayOfMonth < eraPivot.day);
  const eraDistance = beforePivot
    ? Math.max(1, eraPivot.year - year)
    : year - eraPivot.year;
  const eraYear = beforePivot ? -eraDistance : eraDistance;
  const eraLabel = beforePivot ? `${eraDistance} BK` : `${eraDistance} AK`;
  const startsAt = epoch + elapsedDays * dayMs;
  return {
    day,
    year,
    month,
    dayOfMonth,
    monthName,
    eraYear,
    eraLabel,
    label: `${monthName} ${dayOfMonth}, ${year} (${eraLabel})`,
    slugPart: `day-${day.toString().padStart(6, "0")}`,
    startsAt,
    endsAt: startsAt + dayMs,
  };
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseWorldDate(value: string): Date {
  const parsed = parseDateParts(value) ?? { year: 2026, month: 1, day: 1 };
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseEraPivotDate(value: string): { year: number; month: number; day: number } {
  return parseDateParts(value) ?? { year: 2000, month: 1, day: 1 };
}

function parseDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function todaysNewsSlug(worldDate: WorldDate): string {
  return `todays-news-${worldDate.slugPart}`;
}

export function todaysNewsTitle(worldDate: WorldDate): string {
  return `Today's News: ${worldDate.label}`;
}
