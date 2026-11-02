# Market Rules

Plain-language rules for every market the engine creates. Settlement (Phase 6) implements exactly these. Tokens are play tokens with no cash value.

## General
- **Odds** are decimal, stored ×100 (`185` = 1.85), always on the standard ladder and clamped to 1.01–100.
- **Lines** are fixed when a market is created (e.g. `145.5`). Prices move with the game; the line never does, so every bet on a market shares one line. A line market whose line has already been passed closes (the Over/Yes side has won).
- **Margin** is applied proportionally: implied probabilities sum to 1 + margin. Defaults are per type in Settings (match winner 5%, toss 5%, innings total 6%, sessions / next over / fall of wicket / player runs / opening partnership 8%, dismissal method 10%, top batsman/bowler 15%). Admins can override them per market.
- **Liability shading**: when the house's worst-case loss on one selection passes 50% of the market's max liability, that selection is shortened (by up to 15% of its probability) and the others lengthen.
- **States**: `PENDING → OPEN ⇄ SUSPENDED → CLOSED → SETTLED`, or `VOID` from any unsettled state.
- **Automatic suspension** of in-play markets happens:
  - on **every delivery**, with reason `BALL`, `WICKET` or `BOUNDARY`. The market reopens after the reopen delay (default 3 s; ×1.5 after a wicket). A newer delivery restarts the wait.
  - on DRS/review (`REVIEW`), rain or delay (`RAIN`), and provider data older than the stale threshold (`STALE`, default 30 s).
  - when the model can't price (`NO_PRICE`).
  - when one selection is above 97% (`ONE_SIDED`).
  - when an admin switches betting off for the match (`BETTING_DISABLED`).
  - An **admin suspension** (`ADMIN`) is sticky: only an admin can lift it.
- **Bet delay**: in-play bets wait `betDelayMs` (default 4 s) before acceptance and are re-checked against the market then (Phase 5). Pre-match bets are accepted instantly.
- **Match finished**: every remaining market closes. Abandoned / no result: see each market below.

## Main
| Market | Selections | Open | Closes | Settles | Void when |
|---|---|---|---|---|---|
| Match Winner | both teams (+ Draw in Tests) | pre-match and in-play | match end | on the official result. A tie decided by Super Over goes to the Super Over winner. | Abandoned, no result, or a tie with no Super Over (stakes refunded) |
| Toss Winner | both teams | pre-match | when the toss is known | toss winner | the toss doesn't happen |

## Innings
| Market | Line | Opens | Closes | Settles on | Void when |
|---|---|---|---|---|---|
| Innings Total Runs | projected total at creation | innings 1 pre-match; innings 2 once innings 1 ends | innings end | final innings total. A completed chase counts its actual total. | the innings is reduced by rain before it is completed, or the match is abandoned |
| Overs 1–N Runs (sessions: T20 6/10/15/20, T10 3/6, ODI 10–50) | expected runs to the end of over N | with the innings | when over N (the session's last) starts | Yes if runs at end of over N ≥ line + 0.5. If the innings is completed earlier (all out or chase won), its final total counts. | the session's overs are not bowled because of rain/reduction or abandonment |
| Over K Runs (next over) | expected runs in that over | between overs | first delivery of that over | all runs in the over, including extras | the over is not completed and the innings did not end (rain) |

## Wickets
| Market | Opens | Closes | Settles on | Void when |
|---|---|---|---|---|
| Fall of Nth Wicket (runs O/U) | after wicket N−1 (wicket 1 from the first ball) | when wicket N falls | team total when wicket N falls. If it never falls, the innings' final total. | the innings is reduced or abandoned before wicket N with the line not yet passed |
| Method of Nth Dismissal: Caught / Bowled / LBW / Run Out / Other (stumped, hit wicket, retired out, obstructing…) | with Fall of Nth Wicket | when wicket N falls | how wicket N fell | wicket N never falls |

## Players
| Market | Opens | Closes | Settles on | Void when |
|---|---|---|---|---|
| Top Batsman (per team) | pre-match, from the squad | first ball | most runs for that team. Ties are a dead heat: stake ÷ number tied, at full odds. | the player takes no part in the match (not in any batting/bowling line) |
| Top Bowler (per team) | pre-match | first ball | most wickets. Ties are broken by fewest runs conceded, then a dead heat. | as above, or no wickets fall |
| Player Runs O/U (top three in each order) | when the batter is at the crease | dismissal, innings end, or line passed | the batter's final runs in that innings. Retired not out counts as their score. | the innings is abandoned with the line not passed |

## Specials
| Market | Opens | Closes | Settles on | Void when |
|---|---|---|---|---|
| Highest Opening Partnership | pre-match | when decided | higher first-wicket stand (or innings total if no wicket falls). Equal stands are a dead heat. | either innings isn't completed |

## Custom markets
Admins can create markets with hand-set odds. The engine suspends and closes them like any other but never reprices them. They settle manually, with a reason that goes into the audit log.

## Resettlement
If an official result is corrected, an admin can resettle a market. Every affected bet's previous settlement is reversed with ledger entries, then settled again. A user's balance can go temporarily negative if a reversed payout was already spent. The full trail is kept in the audit log.
