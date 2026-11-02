import { z } from 'zod';

/**
 * Lenient schemas for raw CricAPI payloads. Every field the provider has ever omitted is optional.
 * Unknown fields pass through untouched (and are dropped by the normalizers).
 * [UNSAMPLED] marks shapes taken from provider docs, not captured responses (ASSUMPTIONS A-16).
 */

const num = z.union([z.number(), z.string()]).transform((v) => (typeof v === 'number' ? v : Number(v.trim()) || 0));

export const rawInfoSchema = z
  .object({
    hitsToday: z.number().optional(),
    hitsUsed: z.number().optional(),
    hitsLimit: z.number().optional(),
    totalRows: z.number().optional(),
    offsetRows: z.number().optional(),
    cache: z.number().optional(),
  })
  .passthrough();

export const envelopeSchema = z
  .object({
    status: z.string(),
    reason: z.string().optional(),
    data: z.unknown(),
    info: rawInfoSchema.optional(),
  })
  .passthrough();

export const rawTeamInfoSchema = z.object({ name: z.string(), shortname: z.string().optional(), img: z.string().optional() }).passthrough();
export const rawScoreSchema = z.object({ r: num, w: num, o: num, inning: z.string() }).passthrough();

export const rawMatchSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().default(''),
    matchType: z.string().default(''),
    status: z.string().default(''),
    venue: z.string().optional(),
    date: z.string().optional(),
    dateTimeGMT: z.string().optional(),
    teams: z.array(z.string()).default([]),
    teamInfo: z.array(rawTeamInfoSchema).default([]),
    score: z.array(rawScoreSchema).default([]),
    series_id: z.string().optional(),
    bbbEnabled: z.boolean().default(false),
    hasSquad: z.boolean().default(false),
    matchStarted: z.boolean().default(false),
    matchEnded: z.boolean().default(false),
    // match_info only [UNSAMPLED]
    tossWinner: z.string().optional(),
    tossChoice: z.string().optional(),
    matchWinner: z.string().optional(),
  })
  .passthrough();
export type RawMatch = z.infer<typeof rawMatchSchema>;

export const rawCricScoreSchema = z
  .object({
    id: z.string().min(1),
    dateTimeGMT: z.string().optional(),
    matchType: z.string().default(''),
    status: z.string().default(''),
    ms: z.enum(['fixture', 'live', 'result']).catch('fixture'),
    t1: z.string().default(''),
    t2: z.string().default(''),
    t1s: z.string().default(''),
    t2s: z.string().default(''),
    t1img: z.string().optional(),
    t2img: z.string().optional(),
    series: z.string().optional(),
  })
  .passthrough();
export type RawCricScore = z.infer<typeof rawCricScoreSchema>;

export const rawSeriesSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    startDate: z.string().optional(),
    startdate: z.string().optional(),
    endDate: z.string().optional(),
    enddate: z.string().optional(),
    odi: num.default(0),
    t20: num.default(0),
    test: num.default(0),
    squads: num.default(0),
    matches: num.default(0),
  })
  .passthrough();
export type RawSeries = z.infer<typeof rawSeriesSchema>;

export const rawSeriesInfoSchema = z.object({ info: rawSeriesSchema, matchList: z.array(z.unknown()).default([]) }).passthrough();

export const rawSquadPlayerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    role: z.string().optional(),
    battingStyle: z.string().optional(),
    bowlingStyle: z.string().optional(),
    country: z.string().optional(),
    playerImg: z.string().optional(),
  })
  .passthrough();
export type RawSquadPlayer = z.infer<typeof rawSquadPlayerSchema>;

export const rawSquadSchema = z
  .object({ teamName: z.string(), shortname: z.string().optional(), img: z.string().optional(), players: z.array(rawSquadPlayerSchema).default([]) })
  .passthrough();
export type RawSquad = z.infer<typeof rawSquadSchema>;

export const rawPlayerStatSchema = z.object({ fn: z.string(), matchtype: z.string(), stat: z.string(), value: z.union([z.string(), z.number()]) }).passthrough();
export const rawPlayerInfoSchema = rawSquadPlayerSchema
  .extend({ placeOfBirth: z.string().optional(), dateOfBirth: z.string().optional(), stats: z.array(rawPlayerStatSchema).default([]) })
  .passthrough();
export type RawPlayerInfo = z.infer<typeof rawPlayerInfoSchema>;

export const rawCountrySchema = z.object({ id: z.string(), name: z.string(), genericFlag: z.string().optional() }).passthrough();

// ── [UNSAMPLED] match_scorecard ─────────────────────────────────────────────
const ref = z.object({ id: z.string().optional(), name: z.string().default('') }).passthrough();
export const rawScorecardInningsSchema = z
  .object({
    inning: z.string().default(''),
    batting: z
      .array(
        z
          .object({
            batsman: ref,
            'dismissal-text': z.string().optional(),
            dismissal: z.string().optional(),
            r: num.default(0),
            b: num.default(0),
            '4s': num.default(0),
            '6s': num.default(0),
          })
          .passthrough(),
      )
      .default([]),
    bowling: z
      .array(z.object({ bowler: ref, o: num.default(0), m: num.default(0), r: num.default(0), w: num.default(0), nb: num.default(0), wd: num.default(0) }).passthrough())
      .default([]),
    extras: z.object({ r: num.optional(), b: num.optional(), lb: num.optional(), w: num.optional(), nb: num.optional(), p: num.optional() }).passthrough().optional(),
  })
  .passthrough();
export type RawScorecardInnings = z.infer<typeof rawScorecardInningsSchema>;
export const rawScorecardSchema = rawMatchSchema.extend({ scorecard: z.array(rawScorecardInningsSchema).default([]) });

// ── [UNSAMPLED] match_bbb — field names vary across provider versions, so accept the common aliases ──
export const rawBallSchema = z
  .object({
    n: num.optional(),
    inning: num.default(0),
    over: num.default(0),
    ball: num.default(0),
    batsman: ref.optional(),
    batter: ref.optional(),
    nonStriker: ref.optional(),
    bowler: ref.optional(),
    runs: num.default(0),
    extras: num.default(0),
    extrasType: z.string().optional(),
    extraType: z.string().optional(),
    dismissal: z.string().optional(),
    wicket: z.union([z.boolean(), z.string()]).optional(),
    playerOut: ref.optional(),
    catcher: ref.optional(),
    fielder: ref.optional(),
    commentary: z.string().optional(),
    comment: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();
export type RawBall = z.infer<typeof rawBallSchema>;
export const rawBbbSchema = rawMatchSchema.extend({ bbb: z.array(rawBallSchema).default([]) });
