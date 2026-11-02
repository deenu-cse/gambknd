import type { MatchFormat, Venue } from '../types.js';

const PLACEHOLDER_IMAGES = [/h\.cricapi\.com\/img\/icon512\.png/i];

/** Team identity: URL-safe slug of the name. "Bulgaria Women" and "bulgaria women" → "bulgaria-women". */
export function normalizeTeamKey(name: string): string {
  return name
    .replace(/\[[^\]]*\]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "Gambia [GAM]" → { name: "Gambia", short: "GAM" } */
export function splitBracketName(raw: string): { name: string; short: string | null } {
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(raw.trim());
  return m?.[1] && m[2] ? { name: m[1].trim(), short: m[2].trim() } : { name: raw.trim(), short: null };
}

export function cleanImage(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  return PLACEHOLDER_IMAGES.some((p) => p.test(trimmed)) ? null : trimmed;
}

/** Provider uses "--" and "" for unknown. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  return t === '' || t === '--' || t === '-' ? null : t;
}

/** Initials (≤4 chars), with W for women's sides when not already present. */
export function deriveShortName(name: string): string {
  const women = /\bwomen\b/i.test(name);
  const words = name.replace(/\bwomen\b/gi, '').split(/\s+/).filter(Boolean);
  let short = words.length === 1 ? (words[0] ?? '').slice(0, 3) : words.map((w) => w[0] ?? '').join('').slice(0, 4);
  short = short.toUpperCase();
  return women && !short.endsWith('W') ? `${short}W` : short || 'TBC';
}

/** CricAPI overs are "X.Y" where Y is balls (0–5), not tenths. 5.5 = 35 balls. */
export function oversToBalls(overs: number): number {
  if (!Number.isFinite(overs) || overs < 0) return 0;
  const whole = Math.floor(overs);
  const extra = Math.min(5, Math.round((overs - whole) * 10));
  return whole * 6 + extra;
}

export function ballsToOvers(balls: number): string {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

/** "Ground, City, Region" → { name: "Ground", city: "City" } */
export function parseVenue(raw: string | null | undefined): Venue | null {
  const text = cleanText(raw);
  if (!text) return null;
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  return { name: parts[0] ?? text, city: parts[1] ?? null };
}

/** "A vs B, 2nd Match, Series, 2026" → "2nd Match" */
export function extractMatchLabel(title: string): string | null {
  const parts = title.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? (parts[1] ?? null) : null;
}

/** "A vs B, 2nd Match, ECA Womens European Cup, 2026" → "ECA Womens European Cup, 2026" */
export function extractSeriesName(title: string): string | null {
  const parts = title.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? parts.slice(2).join(', ') : null;
}

/**
 * The provider's matchType is unreliable: T10 leagues report "t20", some matches report "".
 * See ASSUMPTIONS A-13.
 */
export function inferFormat(matchType: string | null | undefined, ...context: Array<string | null | undefined>): MatchFormat {
  const text = context.filter(Boolean).join(' ');
  if (/\bT10\b/i.test(text)) return 'T10';
  switch ((matchType ?? '').trim().toLowerCase()) {
    case 't20':
      return 'T20';
    case 'odi':
      return 'ODI';
    case 'test':
      return 'TEST';
    default:
      if (/\btest\b/i.test(text)) return 'TEST';
      if (/\bODI\b|one[- ]day/i.test(text)) return 'ODI';
      return 'T20';
  }
}

export const STANDARD_OVERS: Record<MatchFormat, number | null> = { T10: 10, T20: 20, ODI: 50, TEST: null };

/** Reduced-overs games say so in the status: "… - 15 overs game". */
export function scheduledOversFor(format: MatchFormat, statusText: string): number | null {
  const m = /-\s*(\d{1,2})\s*overs?\s*(game|match|a side)/i.exec(statusText);
  if (m?.[1]) return Number(m[1]);
  return STANDARD_OVERS[format];
}

/** dateTimeGMT has no zone suffix; it is UTC. Midnight usually means "time not published" (A-03). */
export function parseGmt(raw: string | null | undefined, fallbackDate?: string | null): { date: Date; confirmed: boolean } {
  const src = cleanText(raw) ?? (fallbackDate ? `${fallbackDate}T00:00:00` : null);
  if (!src) return { date: new Date(0), confirmed: false };
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(src) ? src : `${src}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { date: new Date(0), confirmed: false };
  return { date, confirmed: !/T00:00:00/.test(src) };
}
