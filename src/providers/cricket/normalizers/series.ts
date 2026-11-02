import type { RawSeries } from '../live/schemas.js';
import type { Country, SeriesInfo } from '../types.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function parseMonthDay(text: string): { month: number; day: number } | null {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2})$/.exec(text.trim());
  if (!m?.[1] || !m[2]) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  return month < 0 ? null : { month, day: Number(m[2]) };
}

function yearFromName(name: string): number | null {
  const m = /\b(20\d{2})\b/.exec(name);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * Series dates come as "2027-10-02" or year-less "Nov 21" (A-04). Infer the year from the
 * start date, then the series name; roll the end into next year if it's earlier in the calendar.
 */
export function parseSeriesDates(start: string | undefined, end: string | undefined, name: string): { startDate: Date | null; endDate: Date | null; startHadYear: boolean } {
  let startDate: Date | null = null;
  let startHadYear = false;
  const startText = start?.trim() ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(startText)) {
    startDate = new Date(`${startText}T00:00:00Z`);
    startHadYear = true;
  } else {
    const md = parseMonthDay(startText);
    const year = yearFromName(name);
    if (md && year) startDate = new Date(Date.UTC(year, md.month, md.day));
  }

  let endDate: Date | null = null;
  const endText = end?.trim() ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(endText)) {
    endDate = new Date(`${endText}T00:00:00Z`);
  } else {
    const md = parseMonthDay(endText);
    const baseYear = startDate?.getUTCFullYear() ?? yearFromName(name);
    if (md && baseYear) {
      const rollover = startDate && md.month < startDate.getUTCMonth() ? 1 : 0;
      endDate = new Date(Date.UTC(baseYear + rollover, md.month, md.day));
    }
  }
  return { startDate, endDate, startHadYear };
}

export function normalizeSeries(raw: RawSeries): SeriesInfo {
  const { startDate, endDate, startHadYear } = parseSeriesDates(raw.startDate ?? raw.startdate, raw.endDate ?? raw.enddate, raw.name);
  return {
    providerId: raw.id,
    name: raw.name.trim(),
    startDate,
    endDate,
    fixtureCounts: { odi: raw.odi, t20: raw.t20, test: raw.test, total: raw.matches },
    squadsAnnounced: raw.squads,
    // A-09: a zero-fixture row with a year-less start date duplicates a real series.
    isShadow: raw.matches === 0 && !startHadYear,
  };
}

export function normalizeCountry(raw: { id: string; name: string; genericFlag?: string | undefined }): Country {
  return { code: raw.id.toUpperCase(), name: raw.name.trim(), flagUrl: raw.genericFlag ?? '' };
}

/** "Zimbabwe Women" / "India U19" / "England Lions" → country name to look up a flag. */
export function countryNameForTeam(teamName: string): string {
  return teamName.replace(/\b(Women|U-?19|U-?23|A|XI|Emerging|Lions)\b/gi, '').replace(/\s+/g, ' ').trim();
}
