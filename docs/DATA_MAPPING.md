# Data Mapping — Provider → Internal Domain

All mapping happens in `src/providers/cricket/normalizers/*`. Each normalizer is a pure function from a validated raw type (Zod-parsed, see API_CONTRACT) to an internal type. **Only internal types ever leave the provider layer.** Clients never see raw payloads, the API key, or provider image placeholders.

Conventions:
- `providerRef = { provider: 'cricapi', id: string }`: we keep our own ObjectIds and store provider ids as mappings, so we can swap providers later.
- Every normalized document carries `source: 'live' | 'replay'` and `lastSyncedAt`.
- `→ derived` means we compute the value; the provider doesn't send it.

---

## 1. Series

| Internal `Series` | Provider source | Rule |
|---|---|---|
| `providerRef.id` | `series[].id`, `series_info.info.id` | as-is |
| `name` | `name` | trim |
| `startDate` (Date, UTC) | `startDate` / `startdate` | ISO → parse; `"Mar 11"` → infer year (A-04) |
| `endDate` (Date, UTC) | `endDate` / `enddate` | always `"Mon DD"` → year = start year, +1 if month < start month |
| `fixtureCounts` `{odi,t20,test,total}` | `odi,t20,test,matches` | as-is |
| `squadsAnnounced` | `squads` | as-is |
| `isShadow` | — | derived: `matches===0 && startDate has no year` (A-09) |
| `gender` | — | derived: `/women/i` on name |

## 2. Team

The provider has **no team ids**, so we build a stable key from the name.

| Internal `Team` | Source | Rule |
|---|---|---|
| `key` (unique) | `teams[]`, `teamInfo[].name`, `cricScore.t1/t2`, `series_squad[].teamName` | `normalizeTeamKey(name)`: lowercase, trim, collapse spaces, strip `[XXX]` suffix → `"bulgaria women"` |
| `name` | first non-lowercase spelling we see | prefer `teamInfo.name`, then `teams[]` |
| `shortName` | `teamInfo.shortname`, `cricScore` `[GAM]`, `series_squad.shortname` | first available; else derived: initials of words, max 4 chars, + `W` for women (A-06) |
| `logoUrl` | `teamInfo.img`, `t1img`, `series_squad.img` | placeholder `h.cricapi.com/img/icon512.png` → `null` |
| `countryCode` | `countries` | match `name` minus ` Women`/` U19`/` A`/` XI` against country name → ISO2 |
| `flagUrl` | `countries.genericFlag` | via `countryCode` |
| `isPlaceholder` | — | `key === 'tbc'` → never create markets for TBC teams |

## 3. Match

| Internal `Match` | Source | Rule |
|---|---|---|
| `providerRef.id` | `id` | as-is (same across all match endpoints) |
| `seriesId` | `series_id` → our Series `_id` | lookup; `cricScore` only has a series **name**, so match by normalized name or leave unchanged |
| `title` | `name` | as-is |
| `matchLabel` | `name` | derived: segment between team part and series part, e.g. `"2nd Match"`, `"Final"`, `"Qualifier (2v3)"` |
| `teams` `[homeKey, awayKey]` | `teams[]` | normalized keys, **order from `teams[]` (not teamInfo)** |
| `venue` `{name, city}` | `venue` | split on first comma: `"Bayuemas Oval, Kuala Lumpur"` |
| `format` | `matchType` + `name` | `'T10'` if name/series matches `/\bT10\b/i`; else `t20→T20`, `odi→ODI`, `test→TEST`; `''` → infer from series counts, then name, else `T20` (A-13) |
| `scheduledOvers` | format, status text | T10=10, T20=20, ODI=50, TEST=null; overridden by `"- N overs game"` |
| `startTime` | `dateTimeGMT` | parse as UTC |
| `startTimeConfirmed` | `dateTimeGMT` | `false` when time part is `00:00:00` (A-03) |
| `status` | `matchStarted`, `matchEnded`, `ms`, `status` | `deriveMatchStatus()`, rules in API_CONTRACT §3 |
| `statusText` | `status` | as-is (display only, never used for money decisions on its own) |
| `toss` `{winnerKey, decision}` | `match_info.tossWinner/tossChoice` [UNSAMPLED]; fallback: parse status text `"X opt to bowl"` | `decision: 'BAT' \| 'BOWL'` |
| `innings[]` | `score[]` | see §3.2 |
| `currentState` | latest innings + bbb | see §3.3 |
| `result` | `status` text, `match_info.matchWinner` | `parseResultText()` → `{ type: 'WIN'\|'TIE'\|'NO_RESULT'\|'ABANDONED'\|'DRAW', winnerKey?, margin?: {value, unit:'RUNS'\|'WICKETS'}, method?: 'DLS', superOver?: boolean }` |
| `capabilities` | `bbbEnabled`, `hasSquad`, `fantasyEnabled` | `{ ballByBall, squad, scorecard }`: drives which markets can be created/settled |
| `bettingEnabled` | — | admin toggle (default true, false for TBC teams) |
| `lastSyncedAt`, `dataStaleAt` | — | set by poller |

### 3.1 Overs notation → balls
`oversToBalls(5.5) = 35`, `oversToBalls(20) = 120`, `oversToBalls(13.3) = 81`. We store **`balls` (int)** internally and format back to `"13.3"` for display. A fractional digit > 5 is a data error → log a warning and clamp.

### 3.2 Innings
```ts
interface Innings {
  number: number;          // match innings index 1..4 (array order of score[])
  battingTeamKey: string;  // resolved — see below
  bowlingTeamKey: string;
  runs: number;            // score.r
  wickets: number;         // score.w
  balls: number;           // oversToBalls(score.o)
  isComplete: boolean;     // derived: wickets===10 || balls===scheduledOvers*6 || a later innings exists || match ended
  target?: number;         // derived for chasing innings: previous innings runs + 1 (DLS target unknown → flag dlsAffected)
  extras?, batting[], bowling[], fallOfWickets[]   // from match_scorecard when available
}
```
**Batting team resolution** (handles the `inning` label quirks):
1. Strip the trailing `Inning N`, lowercase, trim.
2. If the label has no comma → it is one team key. Done.
3. If it has a comma → candidates = both teams; remove the team that already batted in an earlier innings with the same `N`. One candidate left → done.
4. Still ambiguous (Test follow-on) → use the scorecard; if no scorecard, alternate from the previous innings and set `battingTeamInferred: true`.

Verified against all 4 two-innings samples in `apiresult.js` (ECA W ×4): every case resolves correctly by step 3.

### 3.3 Live state (`currentState`, also cached in Redis `match:<id>:state`)
| Field | Live (score-level) | Live (with bbb) / Replay |
|---|---|---|
| `score`, `wickets`, `balls` | current innings | same |
| `runRate` (×100 int) | → derived `runs*600/balls` | same |
| `requiredRunRate` (×100 int) | → derived from target & balls left | same |
| `target` | → derived | same |
| `striker`, `nonStriker`, `bowler` | — not available | from ball events |
| `partnership {runs, balls}` | — | derived from balls since last wicket |
| `lastSixBalls` | — | from ball events |
| `winProbability` | → derived (odds engine fair prob.) | same |

Fields not available stay `null`, and the UI hides those widgets rather than faking them.

## 4. BallEvent (from `match_bbb` [UNSAMPLED] or ReplayProvider)

| Internal `BallEvent` | Notes |
|---|---|
| `matchId`, `innings` | |
| `over` (0-based), `ballInOver` (1..6 legal count), `seq` (monotonic incl. extras) | unique index `(matchId, innings, seq)` |
| `batterId`, `nonStrikerId`, `bowlerId` | provider player ids → our Player `_id` |
| `runsBat`, `extras {wides, noBalls, byes, legByes, penalty}`, `totalRuns` | ints |
| `isLegal` | false for wide / no-ball |
| `wicket? {kind: 'CAUGHT'\|'BOWLED'\|'LBW'\|'RUN_OUT'\|'STUMPED'\|'HIT_WICKET'\|'OTHER', playerOutId, fielderId?}` | `kind` maps to the Method-of-Dismissal market (caught/bowled/LBW/run out/other) |
| `isBoundary` (4/6) | triggers immediate market suspension |
| `commentary` | provider text, or a generated sentence in replay |
| `scoreAfter {runs, wickets, balls}` | snapshot for fancy-market settlement |
| `occurredAt` | |

## 5. Player

| Internal `Player` | Source | Rule |
|---|---|---|
| `providerRef.id` | `players[].id`, `players_info.id`, `series_squad...players[].id` | as-is |
| `name`, `country` | same | trim |
| `role` | `role` | enum `BATTER \| WK_BATTER \| BOWLER \| BAT_ALLROUNDER \| BOWL_ALLROUNDER \| UNKNOWN` (`"--"`/missing → UNKNOWN) |
| `battingStyle` | `"Right Handed Bat"` → `RHB`, `"Left Handed Bat"` → `LHB` | |
| `bowlingStyle` | raw string kept + `bowlingType` derived: `PACE` (fast/medium) \| `SPIN` (orthodox/offbreak/legbreak/chinaman) | |
| `imageUrl` | `playerImg` | placeholder → `null` |
| `placeOfBirth`, `dateOfBirth` | | `"--"` → `null` |
| `stats` | `players_info.stats[]` | pivot (§5.1) |
| `teamKeys[]` | `series_squad.teamName` | a player can belong to multiple teams (country + franchise) |

### 5.1 Stats pivot
`[{fn:'batting', matchtype:'t20', stat:' runs ', value:' 0 '}, ...]` →
```ts
interface PlayerStats {
  batting: Partial<Record<'TEST'|'ODI'|'T20', { matches; innings; runs; ballsFaced; highScore; highScoreNotOut; average100; strikeRate100; notOuts; fours; sixes; fifties; hundreds; doubleHundreds }>>;
  bowling: Partial<Record<'TEST'|'ODI'|'T20', { matches; innings; balls; runs; wickets; average100; economy100; strikeRate100; bestInnings: {w,r}|null; bestMatch: {w,r}|null; fiveW; tenW }>>;
}
```
Decimal stats (avg, sr, econ) are stored as **ints ×100** (e.g. `"27.45"` → `2745`), in line with the no-floats rule. `"-/-"` → `null`. `"45*"` → `highScore: 45, highScoreNotOut: true`.

## 6. Country
`countries[]` → `{ code: id.toUpperCase(), name, flagUrl: genericFlag }`. Used only to decorate teams.

## 7. What the replay provider produces
`ReplayProvider` implements the same `CricketProvider` interface and emits the **same internal types**. Source data:
1. Real matches from the `apiresult.js` captures (final `score[]`, teams, venue, result text), extracted into `src/providers/cricket/fixtures/*.json` with the API key removed.
2. Real squads from the `series_squad` capture for player names/ids where the teams match. For teams without a captured squad we generate placeholder XIs with deterministic synthetic ids (`replay-<team>-<n>`), clearly marked `source: 'replay'`.
3. A **seeded ball-by-ball synthesizer** (`replay/synthesizer.ts`). It generates a legal ball sequence that **ends exactly at the real final score** (e.g. Bulgaria W 98/9 in 20.0, Sweden W 99/0 in 5.5), including extras, boundaries and wickets with dismissal kinds, and a chase that stops when the target is passed. Same seed → same match, so tests can assert exact outcomes.
4. Any real `match_bbb` recordings you drop into `fixtures/recorded/` are replayed verbatim instead of synthesized.

Speed is configurable (`REPLAY_BALL_INTERVAL_MS`, or `npm run replay -- --match <id> --speed 5`) and the admin can control it at runtime (start/pause/speed).
