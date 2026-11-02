import type { Request, Response } from 'express';
import { parseOrThrow } from '../../middleware/validate.js';
import { sendOk } from '../../utils/http.js';
import { getSettings } from '../settings/settings.service.js';
import { commentaryQuery, limitQuery, listMatchesQuery, playerSearchQuery } from './matches.schema.js';
import * as matches from './matches.service.js';
import { ensureSquads, getPlayer, searchPlayers } from './players.service.js';

const id = (req: Request): string => String(req.params.id);

export async function list(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(listMatchesQuery, req.query);
  // Nothing updates real fixtures in replay mode, so they would sit frozen on the home page.
  const source = q.source ?? ((await getSettings()).providerMode === 'replay' ? 'replay' : undefined);
  const rows = await matches.listMatches({
    bucket: q.bucket,
    limit: q.limit,
    ...(source ? { source } : {}),
    ...(q.seriesId ? { seriesId: q.seriesId } : {}),
    ...(q.team ? { teamKey: q.team } : {}),
  });
  sendOk(res, rows, { pageSize: q.limit });
}

export async function detail(req: Request, res: Response): Promise<void> {
  sendOk(res, await matches.getMatch(id(req)));
}

export async function scorecard(req: Request, res: Response): Promise<void> {
  sendOk(res, await matches.getScorecard(id(req)));
}

export async function commentary(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(commentaryQuery, req.query);
  const [innings, seq] = q.cursor ? q.cursor.split(':').map(Number) : [];
  const page = await matches.getCommentary(id(req), {
    limit: q.limit,
    ...(innings !== undefined ? { innings } : {}),
    ...(seq !== undefined ? { beforeSeq: seq } : {}),
  });
  sendOk(res, page.items, { nextCursor: page.nextCursor });
}

export async function overs(req: Request, res: Response): Promise<void> {
  sendOk(res, await matches.getOvers(id(req)));
}

export async function squads(req: Request, res: Response): Promise<void> {
  sendOk(res, await ensureSquads(id(req)));
}

export async function seriesList(req: Request, res: Response): Promise<void> {
  sendOk(res, await matches.listSeries(parseOrThrow(limitQuery, req.query).limit));
}

export async function seriesDetail(req: Request, res: Response): Promise<void> {
  sendOk(res, await matches.getSeriesDetail(id(req)));
}

export async function team(req: Request, res: Response): Promise<void> {
  sendOk(res, await matches.getTeam(String(req.params.key)));
}

export async function player(req: Request, res: Response): Promise<void> {
  sendOk(res, await getPlayer(String(req.params.pid)));
}

export async function playerSearch(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(playerSearchQuery, req.query);
  sendOk(res, await searchPlayers(q.q, q.limit));
}

export async function teamSearch(req: Request, res: Response): Promise<void> {
  const q = parseOrThrow(playerSearchQuery, req.query);
  sendOk(res, await matches.searchTeams(q.q, q.limit));
}
