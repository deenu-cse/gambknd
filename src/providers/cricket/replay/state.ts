import { deriveInnings } from '../derive.js';
import { emptyInnings } from '../normalizers/innings.js';
import type { BallEvent, Innings, MatchResult, MatchStatus, ProviderMatch } from '../types.js';
import type { ResolvedSession } from './sessions.js';

export interface ReplayView {
  match: ProviderMatch;
  /** Deliveries revealed so far, both innings, in order. */
  balls: BallEvent[];
}

export function replaySeriesId(seriesName: string | null): string | null {
  return seriesName ? `replay-series-${seriesName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : null;
}

function teamName(r: ResolvedSession, key: string): string {
  return r.script.teams.find((t) => t.key === key)?.name ?? key;
}

/** Builds the match exactly as a provider would report it at the session's current cursor. */
export function viewAt(r: ResolvedSession): ReplayView {
  const { session, script, synth, steps } = r;
  const revealed: [number, number] = [0, 0];
  let lastKind: string | null = null;
  for (let i = 0; i <= session.cursor && i < steps.length; i += 1) {
    const step = steps[i];
    if (!step) break;
    lastKind = step.kind;
    if (step.kind === 'BALL') revealed[step.innings - 1] = step.index + 1;
  }

  const names = new Map<string, string>();
  for (const xi of Object.values(synth.elevens)) for (const p of xi) names.set(p.playerId, p.name);

  const balls: BallEvent[] = [...synth.innings[0].slice(0, revealed[0]), ...synth.innings[1].slice(0, revealed[1])];
  const innings: Innings[] = [];
  ([0, 1] as const).forEach((idx) => {
    const count = revealed[idx];
    if (count === 0) return;
    const plan = script.plan[idx];
    const all = synth.innings[idx];
    const d = deriveInnings(all.slice(0, count), names);
    const inn = emptyInnings(idx + 1, plan.battingKey, plan.bowlingKey, false);
    Object.assign(inn, {
      runs: d.runs,
      wickets: d.wickets,
      balls: d.balls,
      extras: d.extras,
      batting: d.batting,
      bowling: d.bowling,
      fallOfWickets: d.fallOfWickets,
      isComplete: count >= all.length,
      target: plan.target,
      allottedBalls: script.scheduledOvers * 6,
    });
    innings.push(inn);
  });

  let status: MatchStatus;
  if (session.abandoned) status = 'ABANDONED';
  else if (session.cursor < 0) status = 'UPCOMING';
  else if (lastKind === 'END') status = 'COMPLETED';
  else if (session.status === 'paused' && session.pauseReason === 'rain') status = 'RAIN_DELAY';
  else if (lastKind === 'TOSS') status = 'TOSS';
  else if (lastKind === 'BREAK') status = 'INNINGS_BREAK';
  else status = 'LIVE';

  const tossText = `${teamName(r, script.toss.winnerKey)} won the toss and elected to ${script.toss.decision === 'BAT' ? 'bat' : 'bowl'}`;
  let statusText: string;
  switch (status) {
    case 'ABANDONED':
      statusText = 'Match abandoned';
      break;
    case 'UPCOMING':
      statusText = `Match starts at ${new Date(session.startAt).toUTCString().slice(5, 22)} GMT`;
      break;
    case 'COMPLETED':
      statusText = script.resultText;
      break;
    case 'RAIN_DELAY':
      statusText = 'Rain delay: play suspended';
      break;
    case 'INNINGS_BREAK':
      statusText = `Innings break: ${teamName(r, script.plan[1].battingKey)} need ${script.plan[1].target ?? 0} to win`;
      break;
    default: {
      const chase = innings[1];
      if (chase && chase.target !== null) {
        const need = Math.max(0, chase.target - chase.runs);
        statusText = `${teamName(r, chase.battingTeamKey)} need ${need} run${need === 1 ? '' : 's'} in ${Math.max(0, (chase.allottedBalls ?? 0) - chase.balls)} balls`;
      } else {
        statusText = tossText;
      }
    }
  }

  let result: MatchResult | null = null;
  if (status === 'COMPLETED') result = script.result;
  if (status === 'ABANDONED') result = { type: 'ABANDONED', winnerKey: null, margin: null, method: null, superOver: false, confident: true };

  return {
    balls,
    match: {
      providerId: session.providerId,
      source: 'replay',
      title: script.title,
      matchLabel: script.matchLabel,
      seriesProviderId: replaySeriesId(script.seriesName),
      seriesName: script.seriesName,
      format: script.format,
      scheduledOvers: script.scheduledOvers,
      teams: script.teams,
      venue: script.venue,
      startTime: new Date(session.startAt),
      startTimeConfirmed: true,
      status,
      statusText,
      toss: session.cursor >= 0 ? script.toss : null,
      innings,
      result,
      capabilities: { ballByBall: true, scorecard: true, toss: true, squads: true, playerStats: true },
    },
  };
}
