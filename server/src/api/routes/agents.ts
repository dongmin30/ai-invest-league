import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findAgentParticipant, getAgentDetail, isDecisionRunning, listAgents, runDecision } from '../../agents/runner';
import { matchOrders } from '../../engine/matcher';
import type { Collector } from '../../market/collector';
import { requireAdmin, requireUser } from '../auth';
import { ApiHttpError, badRequest, notFound } from '../errors';
import { IdParams } from '../validation';

const RunBody = z.object({ league_id: z.number('league_id가 필요합니다.').int().positive() });

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
    if (isDecisionRunning(participantId)) {
      throw new ApiHttpError(409, 'agent_busy', '이 에이전트는 이미 판단 중입니다. 잠시 후 다시 시도해 주세요.');
    }
    return runDecision(participantId);
  });

  app.post('/admin/collect', async (req) => {
    requireAdmin(req);
    const quotes = await opts.collector().tick();
    matchOrders(quotes);
    return { count: quotes.length };
  });
}
