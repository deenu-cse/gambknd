# Cricket Data Provider — API Contract

Source of truth for this document: `allapi/apiresult.js` (12 numbered request/response captures).
Provider: **CricketData.org / CricAPI v1** — base URL `https://api.cricapi.com/v1/`.

Legend used below:

| Tag | Meaning |
|---|---|
| **[SAMPLED]** | A real response for this endpoint is in `apiresult.js`. Shape below is derived from it. |
| **[URL-CONFIRMED]** | The exact URL appears in `apiresult.js`. |
| **[INFERRED-NAME]** | Response captured, but the URL was not recorded; the endpoint name is inferred from the response shape + provider naming. |
| **[UNSAMPLED]** | Endpoint exists in the provider's public catalogue but we have **no** sample. Shape is from provider docs and **must be verified** before we rely on it. Code treats every field as optional. |

---

## 1. Global conventions

### 1.1 Auth
- API key in query string: `?apikey=<uuid>`. No headers, no OAuth.
- **The response body echoes the API key back** (`"apikey": "..."` at top level). The adapter must strip it before logging, caching or storing anything.
- Key lives only in `gambknd/.env` as `CRICAPI_KEY`. Never sent to any frontend.

### 1.2 Response envelope (every endpoint)

```ts
interface CricApiEnvelope<T> {
  apikey: string;              // echoed key — STRIP immediately
  data: T;                     // array for list endpoints, object for *_info / *_squad
  status: 'success' | 'failure';
  reason?: string;             // [UNSAMPLED] present when status === 'failure'
  info: CricApiInfo;
}

interface CricApiInfo {
  hitsToday: number;   // hits consumed today across the key (seen: 20, 21, 81)
  hitsUsed: number;    // hits this request cost (always 1 in samples)
  hitsLimit: number;   // daily quota — 100 on the "Lifetime Free" plan
  credits: number;     // 0 in samples
  server: number;      // backend node id — ignore
  offsetRows: number;  // echo of `offset`
  totalRows: number;   // total rows for paginated lists
  queryTime: number;   // ms, float
  s: number;           // unknown flag, always 0 — ignore
  cache: 0 | 1;        // 1 = served from provider cache (did still cost a hit)
}
```

Several captures in the file are truncated mid-object (1, 2, 3, 4, 5, 8, 9, 10). Their `status`/`info` blocks are cut off, but the shape is the same as the complete ones (6, 7, 12).

### 1.3 Rate limits — the most important constraint
- **`hitsLimit: 100` per day** on the current key ("Lifetime Free" plan, per the note at line 1507).
- Every call costs `hitsUsed: 1`, **cache hits included** (sample 7: `cache: 1`, still `hitsUsed: 1`).
- Sample 12 shows `hitsToday: 81`: most of a day's budget went on manual exploration.
- Reset time is not stated. We assume a UTC-midnight reset (see ASSUMPTIONS A-01) and also trust `info.hitsToday` from each response as the authoritative counter.
- Consequence: **polling every 3–5 s is impossible on this plan** (that would be 17,000+ hits/day). See §4 for the budget strategy.

### 1.4 Pagination
- `offset` query param, page size **25 rows** (samples 6/7: 25 rows returned, `totalRows: 19448`).
- Applies to: `currentMatches`, `matches`, `series`, `players`, `countries`.

### 1.5 Common data-quality quirks (apply everywhere)

| Quirk | Example | Handling |
|---|---|---|
| Placeholder image URL | `https://h.cricapi.com/img/icon512.png` | Normalize to `null` (we show our own initials avatar). |
| `"--"` as null | `role: "--"`, `placeOfBirth: "--"` | Normalize to `null`. |
| Dates without `Z` | `"2026-10-15T06:00:00"` | Parse as **UTC** (field is literally named `dateTimeGMT`). |
| Midnight = unknown time | `"2026-10-15T00:00:00"` for many associate matches | Keep it, but set `startTimeConfirmed = false` (A-03). |
| Dates without a year | series `endDate: "Nov 21"`, sometimes `startDate: "Mar 11"` | Year inference (A-04). |
| Overs as `X.Y` | `o: 5.5` = 5 overs **5 balls**, `13.3` = 13 overs 3 balls | **Never** treat as decimal. `balls = floor(o)*6 + round((o % 1)*10)`. |
| No team IDs anywhere | teams are bare strings | Team identity = normalized name key (A-05). |
| Inconsistent shortnames | `BW`, `SWE-W`, `AUTW`, or missing entirely | Store when present, else derive (A-06). |
| Padded strings | `stat: " runs "`, `value: " 0 "` | `trim()` everything, then parse numerically. |

---

## 2. Endpoints

### 2.1 `GET /currentMatches` — sample 1 · [SAMPLED] [INFERRED-NAME]

Params: `apikey`, `offset`.
Purpose: matches that are live, just finished, or about to start, **with structured scores**. One page = up to 25 matches = 1 hit.
Why we think it is `currentMatches`: every match in the sample is from the last 48 h, all have `score[]`, and the payload carries `series_id`, `bbbEnabled` and `hasSquad`.

```ts
interface RawCurrentMatch {
  id: string;                    // UUID — RELIABLE. Primary match key across all endpoints.
  name: string;                  // "Bulgaria Women vs Sweden Women, 2nd Match, ECA Womens European Cup, 2026" — RELIABLE
  matchType: 't20' | 'odi' | 'test' | '' | string; // UNRELIABLE: '' seen; T10 leagues report 't20'
  status: string;                // FREE TEXT — see §3
  venue: string;                 // "Ground, City, Region" — RELIABLE for matches with a fixed venue
  date: string;                  // "YYYY-MM-DD"
  dateTimeGMT: string;           // "YYYY-MM-DDTHH:mm:ss", UTC, no Z
  teams: [string, string];       // RELIABLE, order = home/first-listed
  teamInfo: RawTeamInfo[];       // UNRELIABLE: order ≠ teams[] order; can be 1 entry ("Tbc vs Tbc")
  score?: RawScore[];            // present once the match has started; absent for fixtures
  series_id: string;             // UUID — RELIABLE, links to series
  fantasyEnabled: boolean;
  bbbEnabled: boolean;           // false in ALL samples → ball-by-ball not available for these
  hasSquad: boolean;
  matchStarted: boolean;         // RELIABLE
  matchEnded: boolean;           // RELIABLE
}

interface RawTeamInfo {
  name: string;
  shortname?: string;            // OPTIONAL — missing for franchise teams (Abu Dhabi T10)
  img?: string;                  // may be placeholder
}

interface RawScore {
  r: number;                     // runs
  w: number;                     // wickets
  o: number;                     // overs in X.Y ball notation (NOT decimal)
  inning: string;                // UNRELIABLE label — see below
}
```

**`score[].inning` label quirks (observed):**
- Case varies: `"bulgaria women Inning 1"` (lowercase) next to `"Sweden Women Inning 1"`.
- The chasing side is sometimes labelled with **both** team names: `"Bulgaria Women,Sweden Women Inning 1"`. The batting team is *not* always the second name: in the Austria v Bulgaria match the label is `"Austria Women,Bulgaria Women Inning 1"` and Austria were the side batting.
- "Inning N" is the side's own innings count (Tests will have `Inning 2`), not the match innings number.
- Resolution: match a single-team label case-insensitively. For a comma label, the batting team is the team that has *not* already batted that innings number (elimination). See DATA_MAPPING §3.2.

**Result vs runs:** In `"Austria Women won by 10 wkts (DLS method)"` the winner scored **37** against **39**. Under DLS the higher run total does not necessarily win. **Resolvers must never infer the winner by comparing runs.** Use the status text (plus `matchWinner` from `match_info` when available).

### 2.2 `GET /cricScore` — sample 2 · [SAMPLED] [INFERRED-NAME]

Params: `apikey` only, no offset. Returns **every** current/upcoming/recent match in one call.
**Best value per hit for live polling.**

```ts
interface RawCricScore {
  id: string;                    // UUID — assumed to share id space with currentMatches/match_info (A-07)
  dateTimeGMT: string;
  matchType: 't20' | 'odi' | 'test' | '' | string;  // '' seen (India W v Zimbabwe W)
  status: string;                // "Match starts at Oct 23, 13:00 GMT" | result text | live text
  ms: 'fixture' | 'live' | 'result';  // ONLY structured status field the provider gives us
  t1: string;                    // "Gambia [GAM]" — name + [SHORT]
  t2: string;
  t1s: string;                   // "" for fixtures; score string e.g. "98/9 (20)" when live (A-08)
  t2s: string;
  t1img?: string;                // OPTIONAL
  t2img?: string;
  series: string;                // series NAME only — no series_id
}
```

Notes: no venue, no series id, no innings breakdown. We use it as a cheap **change detector**: if `t1s`/`t2s`/`ms`/`status` changed, spend a hit on the detailed endpoint for that match.

### 2.3 `GET /series` — samples 3 & 4 · [SAMPLED] [INFERRED-NAME]

Params: `apikey`, `offset`, optional `search` (sample 3 passes `search: 0`, which looks like an unfilled form value and returned the same unfiltered list as sample 4).

```ts
interface RawSeries {
  id: string;           // UUID — RELIABLE
  name: string;         // "ICC Men's Cricket World Cup 2027"
  startDate: string;    // usually "YYYY-MM-DD", SOMETIMES "Mar 11" (no year)
  endDate: string;      // ALWAYS "Mon DD" (no year) in samples, e.g. "Nov 21"
  odi: number;          // count of ODI fixtures
  t20: number;
  test: number;
  squads: number;       // number of squads announced
  matches: number;      // total fixtures; 0 on "shadow duplicate" series
}
```

**Duplicates:** the same series appears twice: `4a708cd9…` (`startDate "2027-03-11"`, `matches: 1`) and `eb59e02f…` (`startDate "Mar 11"`, `matches: 0`). The same happens for "Sri Lanka tour of New Zealand 2027" (three ids). Rule: `matches === 0` together with a year-less `startDate` marks a shadow row. We still store it, flagged `isShadow` and hidden from users (A-09).

### 2.4 `GET /matches` — sample 5 · [SAMPLED] [INFERRED-NAME]

Params: `apikey`, `offset`. Fixture list (upcoming first, newest dates first). Same shape as `RawCurrentMatch` minus `score`.
Sample quirks: `teams: ["Tbc","Tbc"]` with only one `teamInfo` entry; franchise teams with no `shortname`; T10 league reported as `matchType: "t20"`.

### 2.5 `GET /players` — samples 6 & 7 · [SAMPLED] [INFERRED-NAME]

Params: `apikey`, `offset`, optional `search`. `totalRows: 19448` (~778 pages), so **never bulk-sync**. Use it for search only.

```ts
interface RawPlayerListItem { id: string; name: string; country: string; }
```

### 2.6 `GET /series_info?id=<seriesId>` — sample 8 · [SAMPLED] [INFERRED-NAME]

```ts
interface RawSeriesInfo {
  info: {
    id: string; name: string;
    startdate: string;   // NOTE lowercase key here (vs `startDate` in /series)
    enddate: string;     // "Oct 14" — no year
    odi: number; t20: number; test: number; squads: number; matches: number;
  };
  matchList: RawSeriesMatch[];   // same as RawCurrentMatch but WITHOUT series_id and WITHOUT score
}
```

Matches are **not** sorted (13th, 21st, 14th, 7th…). Sort by `dateTimeGMT` ourselves.

### 2.7 `GET /players_info?id=<playerId>` — sample 9 · [SAMPLED] [URL-CONFIRMED]

```ts
interface RawPlayerInfo {
  id: string;
  name: string;
  role?: string;          // "WK-Batsman" | "Batsman" | "Bowler" | "Batting Allrounder" | "Bowling Allrounder" | "--"
  battingStyle?: string;  // "Right Handed Bat" | "Left Handed Bat"
  bowlingStyle?: string;  // "Right-arm fast-medium" | "Left-arm orthodox" | ...
  placeOfBirth?: string;  // "--" → null
  dateOfBirth?: string;   // [UNSAMPLED] provider docs list it
  country: string;
  playerImg?: string;     // placeholder → null
  stats: RawPlayerStat[];
}

interface RawPlayerStat {
  fn: 'batting' | 'bowling';
  matchtype: 'test' | 'odi' | 't20' | string;
  stat: string;   // PADDED: " m ", " inn ", " runs ", " bf ", " hs ", " avg ", " sr ", " no ", " 4s ", " 6s ", " 50 ", " 100 ", " 200 "
                  //   bowling: " m ", " inn ", " b ", " runs ", " wkts ", " avg ", " econ ", " sr ", " bbi ", " bbm ", " 5w ", " 10w "
  value: string;  // PADDED STRING: " 0 ", " 0.0 ", " -/- " (best bowling), possibly "45*" for not-out HS (A-10)
}
```

The stats are an EAV list: pivot into `{ batting: { t20: {...}, odi: {...}, test: {...} }, bowling: {...} }`.

### 2.8 `GET /series_squad?id=<seriesId>` — sample 10 · [SAMPLED] [URL-CONFIRMED]

```ts
type RawSeriesSquad = Array<{
  teamName: string;
  shortname: string;
  img: string;
  players: Array<{
    id: string;              // same id space as players_info — RELIABLE
    name: string;
    role?: string;           // OPTIONAL / "--"
    battingStyle?: string;   // OPTIONAL
    bowlingStyle?: string;   // OPTIONAL (absent for pure batters / keepers)
    country: string;
    playerImg?: string;
  }>;
}>;
```

This is the **series squad**, not the playing XI. Pre-match player markets use it as the candidate pool (A-11).

### 2.9 `GET /series_points?id=<seriesId>` — sample 11 · [URL-CONFIRMED] **no response captured**

Shape unknown. Points table is a nice-to-have, so nothing depends on it. The adapter exposes it as `unknown` passthrough → validated by a lenient Zod schema, displayed only if it parses.

### 2.10 `GET /countries` — sample 12 · [SAMPLED] [URL-CONFIRMED]

```ts
interface RawCountry { id: string /* ISO-3166 alpha-2, lowercase */; name: string; genericFlag: string /* SVG */; }
```
249 rows → 10 hits to sync fully. Sync once, cache for 30 days. Used to attach flags to national teams by name (strip ` Women`, ` U19`, ` A` suffixes before lookup).

### 2.11 Per-match endpoints

Captured on 2026-11-01 from a finished match on the free plan. The files are `allapi/sample_*.json`, with the key removed. `match_info` and `match_scorecard` pass our schemas and normalizers unchanged.

| Endpoint | Status | Hits per call | What the sample showed |
|---|---|---|---|
| `match_info` | [SAMPLED] | 1 | Adds `tossWinner` (lowercase, e.g. `"australia"`), `tossChoice` and `matchWinner`. |
| `match_scorecard` | [SAMPLED] | **10** | `dismissal` uses words like `"catch"` and `"retired out"`, and is absent for not-out batters. `batsman`, `bowler` and `catcher` are objects that also carry `cricbuzz_id`. |
| `match_squad` | Empty sample | **10** | Returned `data: []` for a match with `hasSquad: false`, and still cost 10 hits. |
| `match_bbb` | [UNSAMPLED] | Unknown | Failed with `ERR: Not able to get BBB for match` on a match with `bbbEnabled: false`, and returned no `info` block. |

The ten-hit calls matter on this plan: a scorecard is a tenth of a day's budget, so `HIT_COST` in `cricapi.client.ts` reserves the true cost up front.

Logos: `img` links ask for `?w=48`, but the image host serves any width. We checked up to 512, so the player app asks for 128, 256 or 512 to keep posters sharp.

The rest of this table is from the provider's public catalogue. Each one is behind a provider **capability flag**: the adapter calls it, validates with a lenient Zod schema, and on failure degrades to the score-level data from §2.1/2.2.

| Endpoint | Gives us | Notes |
|---|---|---|
| `match_info?id=` | Same as `RawCurrentMatch` **plus** `tossWinner`, `tossChoice` (`"bat"\|"bowl"`), `matchWinner` | Needed for Toss market settlement and a clean winner. Confirmed by sample. |
| `match_squad?id=` | Per-match squads (may include playing XI) | Better pool for player markets than `series_squad`. |
| `match_scorecard?id=` | Per-innings batting (`batsman{id,name}`, `dismissal-text`, `r,b,4s,6s,sr`), bowling (`bowler{id,name}`, `o,m,r,w,nb,wd,eco`), extras, totals | Needed for scorecard tab, top-batsman/bowler, player-runs, opening partnership, fall of wickets. |
| `match_bbb?id=` | Ball-by-ball events | `bbbEnabled: false` on **every** sampled match. Probably a paid tier. Needed for commentary, last-6-balls, session/fancy, next-over, next-wicket, dismissal-method markets. |
| `match_points?id=` | Fantasy points | Not needed. |

**Still needed:** one real `match_bbb` response, from a match with `bbbEnabled: true`. Drop it into `allapi/` and the schema can be pinned to it.

---

## 3. Match status representation

The provider has **no status enum**. Status has to be derived from three inputs:

1. `matchStarted` / `matchEnded` booleans (reliable)
2. `ms` from `cricScore` (`fixture | live | result`)
3. `status` free text

| Internal status | Rule (first match wins) | Seen in samples? |
|---|---|---|
| `ABANDONED` | text `/abandon/i` | no — pattern assumed |
| `NO_RESULT` | text `/no result/i` | no |
| `COMPLETED` | `matchEnded` OR `ms==='result'` OR text `/won by\|match tied\|drawn/i` | yes: `"X won by 10 wkts"`, `"… (DLS method)"`, `"… - 15 overs game"`, `"Canada won by 58 runs"` |
| `RAIN_DELAY` | started && !ended && text `/rain\|wet outfield\|delayed\|bad light\|stumps\|lunch\|tea/i` | no |
| `INNINGS_BREAK` | started && !ended && text `/innings break/i`, OR first innings complete (all out / overs exhausted) and no second-innings entry yet | no |
| `TOSS` | started=false or score empty, text `/(opt\|elected\|chose) to (bat\|bowl\|field)/i` or `/won the toss/i` | no |
| `LIVE` | `matchStarted && !matchEnded` with `score[]`, or `ms==='live'` | no (no live match at capture time) |
| `UPCOMING` | `!matchStarted` / `ms==='fixture'` / text `/match starts at/i` | yes |

The `status` text also gives us **result details** (parsed by `parseResultText`):
- winner: `/^(.+?) won by/` → team name (resolved against `teams[]` case-insensitively)
- margin: `/by (\d+) (runs?\|wkts?\|wickets?)/` → `{ value, unit }`
- method: `/(DLS\|D\/L\|VJD) method/` → `dls: true`
- reduced overs: `/- (\d+) overs game/` → `scheduledOvers`
- tie / super over: `/tied/`, `/super over/` (assumed patterns, A-12)

---

## 4. ID linkage

```
Series.id ──(series_id)──▶ Match.id ──(id param)──▶ match_scorecard / match_bbb / match_squad
   │                          │
   │                          └─ teams[] (names only, NO ids) ──▶ Team (our key = normalized name)
   │
   └─(series_squad?id)──▶ teamName ──▶ players[].id ──▶ players_info?id ──▶ stats
```
- **Match id** is the same UUID across `currentMatches`, `matches`, `series_info.matchList` and (assumed) `cricScore`.
- **Player id** is the same UUID across `players`, `players_info`, `series_squad` and (assumed) scorecard/bbb.
- **Team** has no provider id. It links by name only, so normalization is critical (DATA_MAPPING §2).
- **Innings / Ball** have no provider ids. We key them as `(matchId, inningsNo)` and `(matchId, inningsNo, over, ballInOver, seq)`.

---

## 5. Odds

**The provider supplies no odds of any kind.** Every price is generated by our odds engine (`markets/odds`): pre-match strength model + in-play resources model + margin + liability shading. Details are in `docs/MARKET_RULES.md` (Phase 4).

---

## 6. Hit-budget strategy (consequence of §1.3)

Config: `CRICAPI_DAILY_HIT_LIMIT` (default 100), `CRICAPI_RESERVED_HITS` (default 15).

| Job | Endpoint | Cost | Cadence on free tier |
|---|---|---|---|
| Fixture sync | `matches` p1–p2 | 2 | every 6 h → 8/day |
| Series sync | `series` p1 | 1 | daily → 1/day |
| Countries | `countries` ×10 | 10 | once / 30 days |
| Squads | `series_squad` | 1 each | on demand, when a match with `hasSquad` gets markets; cached 24 h |
| Player stats | `players_info` | 1 each | on demand (compare page), cached 7 days |
| **Live change detector** | `cricScore` | 1 | adaptive: `interval = secondsLeftToday / liveBudgetLeft`, floor `LIVE_POLL_MIN_MS` |
| Live detail | `currentMatches` p1 | 1 | only when `cricScore` shows a delta |

Free tier ≈ 70 hits for live use → one live refresh every **~15–20 minutes**. That is far above the "stale after N seconds" threshold, so on the free tier the system will:
- treat **live** provider data as **pre-match + slow score updates** (pre-match markets close at the start; in-play markets are not auto-created);
- run the full in-play experience (ball-by-ball, auto-suspend, fancy markets, cash-out movement) through the **ReplayProvider**.

The cut-over is automatic. If `CRICAPI_DAILY_HIT_LIMIT` is raised (paid plan) so that the computed live interval ≤ `STALE_THRESHOLD_MS`, in-play markets switch on for live matches with no code change. Ball-level markets also need the `ballByBall` capability, i.e. a working `match_bbb`.

A token bucket in Redis (`provider:cricapi:budget:<yyyy-mm-dd>`) enforces the limit across processes, and every response's `info.hitsToday` re-syncs the counter.
