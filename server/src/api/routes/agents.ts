import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findAgentParticipant, getAgentDetail, isDecisionRunning, listAgents, runDecision } from '../../agents/runner';
import { listOfficialSeries, setOfficialSeriesEnabled } from '../../engine/leagues';
import { matchOrders } from '../../engine/matcher';
import { getLeagueRow } from '../../engine/store';
import type { Collector } from '../../market/collector';
import { requireAdmin, requireUser } from '../auth';
import { ApiHttpError, badRequest, notFound } from '../errors';
import { IdParams } from '../validation';

const RunBody = z.object({ league_id: z.number('league_id가 필요합니다.').int().positive() });
const SeriesParams = z.object({
  market: z.enum(['KR', 'US', 'ALL'], '시장은 KR, US, ALL 중 하나여야 합니다.'),
  type: z.enum(['3d', '1w', '1m'], '리그 종류는 3d, 1w, 1m 중 하나여야 합니다.'),
});
const SeriesBody = z.object({ enabled: z.boolean('enabled(true/false)가 필요합니다.') });

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/agents', async (req) => {
    requireUser(req);
    return listAgents();
  });

  app.get('/agents/:id', async (req) => {
    const user = requireUser(req);
    const detail = getAgentDetail(IdParams.parse(req.params).id, user.role === 'admin' ? undefined : user.id);
    if (!detail) throw notFound('에이전트를 찾을 수 없습니다.');
    return detail;
  });
}

export interface AdminRouteOptions {
  /** Called for every forced collection; returns the collector to tick. */
  collector: () => Collector;
}

export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions): Promise<void> {
  app.post('/admin/agents/:id/run', async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const { league_id } = RunBody.parse(req.body);
    const agent = listAgents().find((a) => a.id === id);
    if (!agent) throw notFound('에이전트를 찾을 수 없습니다.');
    if (!agent.enabled) throw badRequest('agent_disabled', `${agent.name}은(는) 비활성 상태입니다: ${agent.disabled_reason ?? ''}`);
    const participantId = findAgentParticipant(id, league_id);
    if (participantId === null) throw notFound('이 리그에 참가한 에이전트가 아닙니다.');
    // Same rule as runDueAgents: a recruiting league may still be deleted while the model is thinking.
    if (getLeagueRow(league_id)?.status !== 'active') {
      throw badRequest('league_inactive', '진행 중인 리그에서만 판단을 실행할 수 있습니다.');
    }
    if (isDecisionRunning(participantId)) {
      throw new ApiHttpError(409, 'agent_busy', '이 에이전트는 이미 판단 중입니다. 잠시 후 다시 시도해 주세요.');
    }
    return runDecision(participantId);
  });

  app.get('/admin/official-series', async (req) => {
    requireAdmin(req);
    return listOfficialSeries();
  });

  // Off ends the series' active league now and deletes its recruiting one; on schedules the next league.
  app.put('/admin/official-series/:market/:type', async (req) => {
    requireAdmin(req);
    const { market, type } = SeriesParams.parse(req.params);
    const { enabled } = SeriesBody.parse(req.body);
    return setOfficialSeriesEnabled(market, type, enabled);
  });

  app.post('/admin/collect', async (req) => {
    requireAdmin(req);
    const quotes = await opts.collector().tick();
    matchOrders(quotes);
    return { count: quotes.length };
  });
}
