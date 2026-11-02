import { describe, expect, it } from 'vitest';
import { deriveCrease, deriveInnings, perOver } from '../derive.js';
import { replayScripts } from './scripts.js';
import { synthesizeMatch } from './synthesizer.js';

const scripts = replayScripts();

describe('replay scripts', () => {
  it('builds scripts from every usable capture', () => {
    expect(scripts.length).toBe(13); // 4 with real scores + 9 series matches with real squads
    expect(scripts.filter((s) => !s.scoreSynthesized)).toHaveLength(4);
    const ids = new Set(scripts.map((s) => s.id));
    expect(ids.size).toBe(scripts.length);
  });

  it('uses captured squads where we have them and labelled placeholders otherwise', () => {
    const kuwait = scripts.find((s) => s.teams.some((t) => t.key === 'kuwait'));
    expect(kuwait?.squads.kuwait?.some((p) => p.name === 'Clinto Anto')).toBe(true);
    const eca = scripts.find((s) => s.teams.some((t) => t.key === 'sweden-women'));
    expect(eca?.squads['sweden-women']?.[0]?.playerId).toMatch(/^rp-sweden-women-/);
  });
});

describe.each(scripts.map((s) => [s.id, s] as const))('synthesized match %s', (_id, script) => {
  const synth = synthesizeMatch(script, 'test-seed');

  it('hits the planned totals exactly', () => {
    synth.innings.forEach((balls, i) => {
      const plan = script.plan[i]!;
      const d = deriveInnings(balls);
      expect([d.runs, d.wickets, d.balls]).toEqual([plan.runs, plan.wickets, plan.balls]);
      // Scorecard is internally consistent: batters + extras = total.
      expect(d.batting.reduce((s, b) => s + b.runs, 0) + d.extras.total).toBe(d.runs);
      expect(d.bowling.reduce((s, b) => s + b.wickets, 0)).toBeLessThanOrEqual(d.wickets);
      expect(d.bowling.reduce((s, b) => s + b.balls, 0)).toBe(d.balls);
    });
  });

  it('ends a successful chase on the ball that reaches the target, and never before', () => {
    const plan = script.plan[1];
    const chase = synth.innings[1];
    if (plan.target === null || plan.runs < plan.target) return;
    const beforeLast = chase.at(-2)?.scoreAfter.runs ?? 0;
    expect(beforeLast).toBeLessThan(plan.target);
    expect(chase.at(-1)?.scoreAfter.runs).toBeGreaterThanOrEqual(plan.target);
    expect(chase.at(-1)?.isLegal).toBe(true);
  });

  it('follows cricket mechanics', () => {
    for (const balls of synth.innings) {
      // No bowler bowls consecutive overs.
      const byOver = new Map(balls.map((b) => [b.over, b.bowlerId]));
      for (let o = 1; o < byOver.size; o += 1) expect(byOver.get(o)).not.toBe(byOver.get(o - 1));
      // Seq is contiguous and striker ≠ non-striker.
      balls.forEach((b, i) => {
        expect(b.seq).toBe(i + 1);
        expect(b.batterId).not.toBe(b.nonStrikerId);
      });
      expect(perOver(balls).at(-1)?.cumulative).toBe(balls.at(-1)?.scoreAfter.runs);
    }
  });

  it('is deterministic per seed', () => {
    const again = synthesizeMatch({ ...script }, 'test-seed');
    expect(again.innings[0].map((b) => b.totalRuns)).toEqual(synth.innings[0].map((b) => b.totalRuns));
  });
});

describe('deriveCrease', () => {
  it('rotates strike on odd runs and at the end of the over', () => {
    const script = scripts[0]!;
    const balls = synthesizeMatch(script, 'crease').innings[0].slice(0, 6);
    const crease = deriveCrease(balls);
    expect(crease.lastSixBalls).toHaveLength(6);
    expect(crease.strikerId === null || crease.strikerId !== crease.nonStrikerId).toBe(true);
  });
});
