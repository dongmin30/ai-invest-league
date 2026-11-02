import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LeagueDetail, LeagueMarket, LeaveLeagueResponse, Market, User } from '../../../../shared/api-types';
import { listAgents } from '../../agents/runner';
import {
  canViewLeague,
  countOpenOwnedLeagues,
  createLeague,
  getLeagueSummary,
  INVITE_CODE_LENGTH,
  joinLeague,
  joinLeagueByCode,
  leaveLeague,
  listLeagues,
  myDashboard,
} from '../../engine/leagues';
import { CUSTOM_MAX_DAYS } from '../../engine/fees';
import { computeRankings, leagueAverages } from '../../engine/ranking';
import { getEquitySeries } from '../../engine/snapshots';
import { getLeagueRow, type LeagueRow } from '../../engine/store';
import { now } from '../../lib/time';
import { requireUser } from '../auth';
import { badRequest, forbidden, notFound } from '../errors';
import { IdParams, LeagueMarketSchema, LeagueStatusSchema, optionalQuery } from '../validation';

const MAX_LEAGUE_AGENTS = 10;
/** Unfinished custom leagues one non-admin user may own at a time. */
export const MAX_OPEN_OWNED_LEAGUES = 3;
/** Per IP. */
const CREATE_RATE_LIMIT = { max: 10, timeWindow: '1 hour' };
/** Per IP; keeps invite codes from being guessed. */
const JOIN_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };
const START_CASH_RANGE: Record<LeagueMarket, { min: number; max: number; label: string }> = {
  KR: { min: 100_000, max: 10_000_000_000, label: '10만~100억원' },
  US: { min: 100, max: 10_000_000, label: '$100~$10,000,000' },
  ALL: { min: 100_000, max: 10_000_000_000, label: '10만~100억원' },
};

const ListQuery = z.object({
  status: optionalQuery(LeagueStatusSchema),
  market: optionalQuery(LeagueMarketSchema),
});

const CreateBody = z
  .object({
    name: z.string('리그 이름을 입력해 주세요.').trim().min(1, '리그 이름을 입력해 주세요.').max(40, '리그 이름은 40자 이하여야 합니다.'),
    market: LeagueMarketSchema,
    duration_days: z
      .number('리그 기간을 입력해 주세요.')
      .int(`리그 기간은 1~${CUSTOM_MAX_DAYS} 거래일이어야 합니다.`)
      .min(1, `리그 기간은 1~${CUSTOM_MAX_DAYS} 거래일이어야 합니다.`)
      .max(CUSTOM_MAX_DAYS, `리그 기간은 1~${CUSTOM_MAX_DAYS} 거래일이어야 합니다.`),
    start_cash: z.number().positive('시작 자금은 0보다 커야 합니다.').optional(),
    agent_ids: z.array(z.number().int().positive()).max(MAX_LEAGUE_AGENTS, `AI는 최대 ${MAX_LEAGUE_AGENTS}명까지 초대할 수 있습니다.`),
    is_public: z.boolean(),
    start_now: z.boolean(),
  })
  .superRefine((body, ctx) => {
    if (body.start_cash === undefined) return;
    const range = START_CASH_RANGE[body.market];
    if (body.start_cash < range.min || body.start_cash > range.max) {
      ctx.addIssue({ code: 'custom', path: ['start_cash'], message: `시작 자금은 ${range.label} 사이여야 합니다.` });
    }
  });

const INVITE_CODE_FORMAT = new RegExp(`^[A-Z0-9]{${INVITE_CODE_LENGTH}}$`);
const JoinBody = z.object({ invite_code: optionalQuery(z.string().max(20)) }).default({});
const JoinByCodeBody = z.object({
  invite_code: z
    .string('초대 코드를 입력해 주세요.')
    .trim()
    .length(INVITE_CODE_LENGTH, `초대 코드는 ${INVITE_CODE_LENGTH}자입니다.`),
});

/**
 * Every invited agent must exist, be enabled and trade the league's market (ALL: both KR and
 * US). LLM agents cost API credit on every decision, so only admins may invite them into
 * custom leagues.
 */
function checkAgents(agentIds: number[], market: LeagueMarket, user: User): void {
  const agents = new Map(listAgents().map((a) => [a.id, a]));
  const needed: Market[] = market === 'ALL' ? ['KR', 'US'] : [market];
  for (const id of agentIds) {
    const agent = agents.get(id);
    if (!agent) throw badRequest('bad_agent', '존재하지 않는 에이전트입니다.');
    if (!agent.enabled) throw badRequest('agent_disabled', `${agent.name}은(는) 현재 사용할 수 없습니다.`);
    if (!needed.every((m) => agent.markets.includes(m))) {
      throw badRequest('bad_agent', `${agent.name}은(는) 이 시장에 참가할 수 없습니다.`);
    }
    if (agent.provider !== 'rule' && user.role !== 'admin') {
      throw forbidden(`LLM 에이전트(${agent.name})는 관리자만 커스텀 리그에 초대할 수 있습니다.`);
    }
  }
}

/** The league if it exists and the user may see it; private leagues are a 404 for outsiders. */
export function loadVisibleLeague(user: User, leagueId: number): LeagueRow {
  const league = getLeagueRow(leagueId);
  if (!league || (user.role !== 'admin' && !canViewLeague(league, user.id))) {
    throw notFound('리그를 찾을 수 없습니다.');
  }
  return league;
}

export async function leagueRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/dashboard', async (req) => myDashboard(requireUser(req).id));

  app.get('/leagues', async (req) => {
    const user = requireUser(req);
    return listLeagues(user.id, ListQuery.parse(req.query));
  });

  app.post('/leagues', { config: { rateLimit: CREATE_RATE_LIMIT } }, async (req) => {
    const user = requireUser(req);
    const body = CreateBody.parse(req.body);
    const agentIds = [...new Set(body.agent_ids)];
    checkAgents(agentIds, body.market, user);
    if (user.role !== 'admin' && countOpenOwnedLeagues(user.id) >= MAX_OPEN_OWNED_LEAGUES) {
      throw badRequest('league_limit', `진행 중이거나 모집 중인 커스텀 리그는 최대 ${MAX_OPEN_OWNED_LEAGUES}개까지 만들 수 있습니다.`);
    }
    return createLeague({
      name: body.name,
      market: body.market,
      type: 'custom',
      duration_days: body.duration_days,
      start_cash: body.start_cash,
      is_public: body.is_public,
      owner_id: user.id,
      start_at: body.start_now ? now() : undefined,
      agent_ids: agentIds,
    });
  });

  app.post('/leagues/:id/join', { config: { rateLimit: JOIN_RATE_LIMIT } }, async (req) => {
    const user = requireUser(req);
    const { id } = IdParams.parse(req.params);
    const { invite_code } = JoinBody.parse(req.body ?? {});
    // Like every other route, a private league the user cannot view is a 404 unless the request
    // carries a well-formed invite code; only then does a wrong code say bad_invite.
    const league = getLeagueRow(id);
    if (!league) throw notFound('리그를 찾을 수 없습니다.');
    if (user.role !== 'admin' && !canViewLeague(league, user.id)) {
      const given = invite_code?.trim().toUpperCase() ?? '';
      if (!INVITE_CODE_FORMAT.test(given)) throw notFound('리그를 찾을 수 없습니다.');
      if (given !== league.invite_code) throw badRequest('bad_invite', '초대 코드가 올바르지 않습니다.');
    }
    return { participant_id: joinLeague(id, { userId: user.id }, invite_code) };
  });

  // Private leagues are invisible to outsiders, so an invite resolves the league from the code alone.
  app.post('/leagues/join-by-code', { config: { rateLimit: JOIN_RATE_LIMIT } }, async (req) => {
    const user = requireUser(req);
    const { invite_code } = JoinByCodeBody.parse(req.body);
    return joinLeagueByCode(user.id, invite_code);
  });

  app.post('/leagues/:id/leave', async (req): Promise<LeaveLeagueResponse> => {
    const user = requireUser(req);
    const { id } = IdParams.parse(req.params);
    loadVisibleLeague(user, id);
    return { ok: true, ...leaveLeague(id, user.id) };
  });

  app.get('/leagues/:id/invite', async (req): Promise<{ invite_code: string | null }> => {
    const user = requireUser(req);
    const { id } = IdParams.parse(req.params);
    const league = loadVisibleLeague(user, id);
    if (user.role !== 'admin' && league.owner_id !== user.id) {
      throw forbidden('초대 코드는 리그를 만든 사람만 볼 수 있습니다.');
    }
    return { invite_code: league.invite_code };
  });

  app.get('/leagues/:id', async (req): Promise<LeagueDetail> => {
    const user = requireUser(req);
    const { id } = IdParams.parse(req.params);
    loadVisibleLeague(user, id);
    const league = getLeagueSummary(id, user.id)!;
    const rankings = computeRankings(id);
    return { league, rankings, ...leagueAverages(id, rankings) };
  });

  app.get('/leagues/:id/equity', async (req) => {
    const user = requireUser(req);
    const { id } = IdParams.parse(req.params);
    loadVisibleLeague(user, id);
    const league = getLeagueSummary(id, user.id)!;
    return getEquitySeries(id, league.my_participant_id);
  });
}
