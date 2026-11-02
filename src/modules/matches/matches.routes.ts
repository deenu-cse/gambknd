import { Router } from 'express';
import { createLimiter } from '../../middleware/rateLimit.js';
import * as c from './matches.controller.js';
import * as markets from '../markets/markets.controller.js';

/** Public read API. Data is normalized and served from Mongo/Redis; clients never reach the provider. */
export function createMatchesRouter(): Router {
  const r = Router();
  r.get('/matches', c.list);
  r.get('/matches/:id', c.detail);
  r.get('/matches/:id/scorecard', c.scorecard);
  r.get('/matches/:id/commentary', c.commentary);
  r.get('/matches/:id/overs', c.overs);
  r.get('/matches/:id/markets', markets.listForMatch);
  r.get('/markets/featured', markets.featured);
  r.get('/markets/:id', markets.getOne);
  // Squads and player stats may trigger a (budgeted) provider call on a cache miss.
  const providerBacked = createLimiter({ name: 'provider-backed', windowMs: 60_000, limit: 30 });
  r.get('/matches/:id/squads', providerBacked, c.squads);
  r.get('/series', c.seriesList);
  r.get('/series/:id', c.seriesDetail);
  r.get('/teams', c.teamSearch);
  r.get('/teams/:key', c.team);
  r.get('/players', c.playerSearch);
  r.get('/players/:pid', providerBacked, c.player);
  return r;
}
