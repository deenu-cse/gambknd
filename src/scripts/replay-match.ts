/**
 * Starts a simulated live match.
 *   npm run replay -- --list
 *   npm run replay -- --match <scriptId> [--speed <secondsPerBall>] [--start-in <seconds>]
 * The worker (`npm run worker`) plays it out; open the match in the app to watch.
 */
import { parseArgs } from 'node:util';
import { closeRedis } from '../config/redis.js';
import { getReplayStore } from '../providers/cricket/index.js';
import { replayScripts } from '../providers/cricket/replay/scripts.js';

function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean', default: false },
      match: { type: 'string' },
      speed: { type: 'string', default: '20' },
      'start-in': { type: 'string', default: '0' },
    },
  });
  const scripts = replayScripts();
  if (values.list || !values.match) {
    print('Replayable matches:\n');
    for (const s of scripts) print(`  ${s.id.padEnd(48)} ${s.teams.map((t) => t.shortName).join(' v ')}  ${s.resultText}${s.scoreSynthesized ? '  (totals synthesized)' : ''}`);
    print('\nUsage: npm run replay -- --match <id> --speed <secondsPerBall> [--start-in <seconds>]');
    return;
  }
  const script = scripts.find((s) => s.id === values.match);
  if (!script) throw new Error(`Unknown match "${values.match}". Run with --list.`);
  const speed = Number(values.speed);
  const startIn = Number(values['start-in']);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 60) throw new Error('--speed must be 0.25–60 seconds per ball');
  if (!Number.isInteger(startIn) || startIn < 0) throw new Error('--start-in must be a whole number of seconds');

  const store = getReplayStore();
  const session = await store.create({ scriptId: script.id, intervalMs: Math.round(speed * 1000), startInSec: startIn });
  if (startIn === 0) await store.control(session.id, 'start');
  print(`Replay ${session.id} created for ${script.title}`);
  print(`  one ball every ${speed}s, ${startIn === 0 ? 'starting now' : `starting in ${startIn}s (pre-match markets open until then)`}`);
  print('  make sure the worker is running: npm run worker');
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void closeRedis());
