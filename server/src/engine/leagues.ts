import { randomInt } from 'node:crypto';
import type {
  DashboardCard,
  LeagueMarket,
  LeagueStatus,
  LeagueSummary,
  LeagueType,
  Market,
  Order,
  RankingRow,
} from '../../../shared/api-types';
import { tx } from '../db/db';
import { bus } from '../lib/bus';
import { now } from '../lib/time';
import {
  addLeagueTradingDays,
  closingMarketOf,
  isLeagueOpen,
  isLeagueTradingDay,
  leagueSessionBounds,
  leagueTradeDate,
  nextLeagueOpen,
  POST_CLOSE_FETCH_MS,
} from '../market/calendar';
import { getQuote } from '../market/quoteCache';
import { getSymbol } from '../market/symbols';
import { CUSTOM_MAX_DAYS, LEAGUE_DEFAULTS, OFFICIAL_JOIN_GRACE_MS, TYPE_DEFAULTS, roundMoney, typeDefaultsFor } from './fees';
import { EngineError } from './errors';
import { computeRankings, leagueAverages } from './ranking';
import { takeSnapshots } from './snapshots';
import {
  agentMarkets,
  getLeagueRow,
  getOrderRow,
  sql,
  toOrder,
  type AgentRow,
  type LeagueRow,
  type OrderRow,
  type ParticipantRow,
} from './store';

const MARKETS: LeagueMarket[] = ['KR', 'US', 'ALL'];
/** Official league name prefix per market: "KR 1주 리그 #3", "통합 1주 리그 #1". */
const MARKET_PREFIX: Record<LeagueMarket, string> = { KR: 'KR', US: 'US', ALL: '통합' };
const OFFICIAL_TYPES = ['3d', '1w', '1m'] as const;
type OfficialType = (typeof OFFICIAL_TYPES)[number];
const TYPE_LABELS: Record<OfficialType, string> = { '3d': '3일', '1w': '1주', '1m': '1개월' };
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_NAME_LENGTH = 40;
const RECENT_FINISHED_CARDS = 5;
const DAY_MS = 86_400_000;

export interface CreateLeagueInput {
  name: string;
  market: LeagueMarket;
  type: LeagueType;
  /** Trading days; required for `custom` (1..20), ignored for official types. */
  duration_days?: number;
  start_cash?: number;
  is_public: boolean;
  owner_id: number | null;
  /** Defaults to the next market open (ALL: the earlier of the next KR / US open). */
  start_at?: number;
  agent_ids?: number[];
}

export interface JoinAs {
  userId?: number;
  agentId?: number;
}

export interface LeagueFilter {
  status?: LeagueStatus;
  market?: LeagueMarket;
}

export const INVITE_CODE_LENGTH = 6;

function randomCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return code;
}

/** A code no unfinished league uses, so join-by-code resolves to exactly one league. */
function uniqueInviteCode(): string {
  const taken = sql("SELECT 1 FROM leagues WHERE invite_code = ? AND status <> 'finished'");
  let code = randomCode();
  while (taken.get(code) !== undefined) code = randomCode();
  return code;
}

function normalizeCode(code: string | undefined): string {
  return code?.trim().toUpperCase() ?? '';
}

function summarize(league: LeagueRow, viewerUserId: number | null): LeagueSummary {
  const counts = sql(
    `SELECT COUNT(*) AS total, COALESCE(SUM(agent_id IS NOT NULL), 0) AS ai FROM participants
     WHERE league_id = ? AND left_at IS NULL`,
  ).get(league.id) as { total: number; ai: number };
  const row =
    viewerUserId === null
      ? undefined
      : (sql('SELECT id, left_at FROM participants WHERE league_id = ? AND user_id = ?').get(league.id, viewerUserId) as
          | { id: number; left_at: number | null }
          | undefined);
  const mine = row && row.left_at === null ? row.id : undefined;
  return {
    id: league.id,
    name: league.name,
    type: league.type,
    market: league.market,
    currency: league.currency,
    status: league.status,
    start_at: league.start_at,
    end_at: league.end_at,
    start_cash: league.start_cash,
    decision_interval_min: league.decision_interval_min,
    max_orders_per_day: league.max_orders_per_day,
    fx_spread: league.fx_spread,
    participant_count: counts.total,
    ai_count: counts.ai,
    is_public: league.is_public === 1,
    joined: mine !== undefined,
    my_participant_id: mine ?? null,
    left: row !== undefined && row.left_at !== null,
  };
}

function insertParticipant(league: LeagueRow, who: JoinAs): number {
  return Number(
    sql('INSERT INTO participants (league_id, user_id, agent_id, cash, joined_at) VALUES (?, ?, ?, ?, ?)').run(
      league.id,
      who.userId ?? null,
      who.agentId ?? null,
      league.start_cash,
      now(),
    ).lastInsertRowid,
  );
}

function isJoined(leagueId: number, who: JoinAs): boolean {
  const row =
    who.userId !== undefined
      ? sql('SELECT 1 FROM participants WHERE league_id = ? AND user_id = ?').get(leagueId, who.userId)
      : sql('SELECT 1 FROM participants WHERE league_id = ? AND agent_id = ?').get(leagueId, who.agentId);
  return row !== undefined;
}

function agentExists(agentId: number): boolean {
  return sql('SELECT 1 FROM agents WHERE id = ?').get(agentId) !== undefined;
}

/**
 * Creates a league. `end_at` is the close of the last trading day; trading days are counted
 * from start_at when the market is open then, otherwise from the next open. ALL (통합) leagues
 * count unified days (KR session + the following US session, see addLeagueTradingDays). The
 * owner (if any) and the given agents are joined immediately.
 */
export function createLeague(input: CreateLeagueInput): LeagueSummary {
  const name = input.name?.trim() ?? '';
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new EngineError('bad_name', `리그 이름은 1~${MAX_NAME_LENGTH}자여야 합니다.`);
  }
  if (!MARKETS.includes(input.market)) throw new EngineError('bad_market', '시장은 KR, US 또는 ALL(통합)이어야 합니다.');
  if (!(input.type in TYPE_DEFAULTS)) throw new EngineError('bad_type', '리그 유형이 올바르지 않습니다.');

  const typeDefaults = typeDefaultsFor(input.type, input.market);
  const days = typeDefaults.trading_days ?? input.duration_days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > CUSTOM_MAX_DAYS) {
    throw new EngineError('bad_duration', `리그 기간은 1~${CUSTOM_MAX_DAYS} 거래일이어야 합니다.`);
  }
  const marketDefaults = LEAGUE_DEFAULTS[input.market];
  const startCash = roundMoney(marketDefaults.currency, input.start_cash ?? marketDefaults.start_cash);
  if (!Number.isFinite(startCash) || startCash <= 0) {
    throw new EngineError('bad_start_cash', '시작 자금은 0보다 커야 합니다.');
  }

  const at = now();
  const startAt = input.start_at ?? nextLeagueOpen(input.market, at);
  const countFrom = isLeagueOpen(input.market, startAt) ? startAt : nextLeagueOpen(input.market, startAt);
  const endAt = addLeagueTradingDays(input.market, countFrom, days);
  const agentIds = [...new Set(input.agent_ids ?? [])];

  return tx(() => {
    for (const id of agentIds) {
      if (!agentExists(id)) throw new EngineError('bad_agent', '존재하지 않는 에이전트입니다.');
    }
    const id = Number(
      sql(
        `INSERT INTO leagues (name, type, market, currency, status, start_at, end_at, start_cash, decision_interval_min,
                              max_orders_per_day, fee_rate, tax_rate, fx_spread, is_public, invite_code, owner_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        name,
        input.type,
        input.market,
        marketDefaults.currency,
        startAt <= at ? 'active' : 'recruiting',
        startAt,
        endAt,
        startCash,
        typeDefaults.decision_interval_min,
        typeDefaults.max_orders_per_day,
        marketDefaults.fee_rate,
        marketDefaults.tax_rate,
        marketDefaults.fx_spread,
        input.is_public ? 1 : 0,
        input.is_public ? null : uniqueInviteCode(),
        input.owner_id,
        at,
      ).lastInsertRowid,
    );
    const league = getLeagueRow(id)!;
    if (input.owner_id !== null) insertParticipant(league, { userId: input.owner_id });
    for (const agentId of agentIds) insertParticipant(league, { agentId });
    return summarize(league, input.owner_id);
  });
}

/**
 * Whether a league still accepts participants: while recruiting; while active for custom
 * leagues; and for official leagues during the first OFFICIAL_JOIN_GRACE_MS after start, so
 * a league that started while the market was open can still be joined.
 */
export function isJoinable(league: LeagueRow, at: number = now()): boolean {
  if (league.status === 'recruiting') return true;
  if (league.status !== 'active' || at >= league.end_at) return false;
  return league.type === 'custom' || at < league.start_at + OFFICIAL_JOIN_GRACE_MS;
}

/** Public leagues are visible to everyone; private ones to their owner and (non-left) participants. */
export function canViewLeague(league: LeagueRow, userId: number): boolean {
  return (
    league.is_public === 1 ||
    league.owner_id === userId ||
    sql('SELECT 1 FROM participants WHERE league_id = ? AND user_id = ? AND left_at IS NULL').get(league.id, userId) !==
      undefined
  );
}

/**
 * Joins a user or an agent while the league is joinable (see isJoinable).
 * Private leagues require the invite code for users.
 */
export function joinLeague(leagueId: number, who: JoinAs, inviteCode?: string): number {
  if ((who.userId === undefined) === (who.agentId === undefined)) {
    throw new EngineError('bad_participant', '사용자 또는 에이전트 중 하나만 지정해야 합니다.');
  }
  return tx(() => {
    const league = getLeagueRow(leagueId);
    if (!league) throw new EngineError('not_found', '리그를 찾을 수 없습니다.');
    if (!isJoinable(league)) throw new EngineError('league_closed', '참가할 수 없는 리그입니다.');
    if (who.agentId !== undefined && !agentExists(who.agentId)) {
      throw new EngineError('bad_agent', '존재하지 않는 에이전트입니다.');
    }
    if (
      who.userId !== undefined &&
      sql('SELECT 1 FROM participants WHERE league_id = ? AND user_id = ? AND left_at IS NOT NULL').get(leagueId, who.userId) !==
        undefined
    ) {
      throw new EngineError('left_league', '진행 중에 나간 리그에는 다시 참가할 수 없습니다.');
    }
    if (isJoined(leagueId, who)) throw new EngineError('already_joined', '이미 참가한 리그입니다.');
    if (who.userId !== undefined && league.is_public === 0) {
      const given = normalizeCode(inviteCode);
      if (!given || given !== league.invite_code) throw new EngineError('bad_invite', '초대 코드가 올바르지 않습니다.');
    }
    return insertParticipant(league, who);
  });
}

/**
 * Joins the private league an invite code belongs to, so an invited user needs neither the
 * league id nor visibility of the league beforehand.
 */
export function joinLeagueByCode(userId: number, code: string): { league_id: number; participant_id: number } {
  const given = normalizeCode(code);
  const league =
    given.length === INVITE_CODE_LENGTH
      ? (sql(
          `SELECT * FROM leagues WHERE invite_code = ? AND is_public = 0
           ORDER BY status = 'finished', id DESC LIMIT 1`,
        ).get(given) as LeagueRow | undefined)
      : undefined;
  if (!league) throw new EngineError('bad_invite', '초대 코드가 올바르지 않습니다.');
  return { league_id: league.id, participant_id: joinLeague(league.id, { userId }, given) };
}

/**
 * Custom leagues the user owns that have not finished yet and that the owner still takes part
 * in: a league the owner left (removed while recruiting, forfeited while active) no longer
 * counts, so leaving frees a slot. Creation stays bounded by the per-IP rate limit.
 */
export function countOpenOwnedLeagues(ownerId: number): number {
  return sql(
    `SELECT COUNT(*) FROM leagues l
     WHERE l.owner_id = ? AND l.status <> 'finished'
       AND EXISTS (SELECT 1 FROM participants p WHERE p.league_id = l.id AND p.user_id = l.owner_id AND p.left_at IS NULL)`,
  )
    .pluck()
    .get(ownerId) as number;
}

export interface LeaveResult {
  /** true for an active league (forfeit: participant kept and marked left), false for recruiting (participant removed). */
  forfeited: boolean;
}

/**
 * A user leaves a league. Recruiting: the participant (and anything attached) is deleted, so
 * the user may join again. Active (before end_at): forfeit — pending orders are canceled,
 * the participant is marked `left_at` and drops out of rankings, averages, snapshots, the
 * dashboard and league visibility; holdings are left as they are, and the user cannot rejoin.
 * Finished leagues (or active ones past end_at, awaiting the closing print) cannot be left.
 */
export function leaveLeague(leagueId: number, userId: number): LeaveResult {
  const result = tx(() => {
    const league = getLeagueRow(leagueId);
    if (!league) throw new EngineError('not_found', '리그를 찾을 수 없습니다.');
    if (league.status === 'finished' || (league.status === 'active' && now() >= league.end_at)) {
      throw new EngineError('league_finished', '종료된 리그에서는 나갈 수 없습니다.');
    }
    const participant = sql('SELECT * FROM participants WHERE league_id = ? AND user_id = ? AND left_at IS NULL').get(
      leagueId,
      userId,
    ) as ParticipantRow | undefined;
    if (!participant) throw new EngineError('not_joined', '참가 중인 리그가 아닙니다.');

    if (league.status === 'recruiting') {
      for (const table of ['orders', 'holdings', 'snapshots', 'decision_logs']) {
        sql(`DELETE FROM ${table} WHERE participant_id = ?`).run(participant.id);
      }
      sql('DELETE FROM participants WHERE id = ?').run(participant.id);
      return { forfeited: false, canceled: [] as Order[] };
    }

    const pending = sql("SELECT id FROM orders WHERE participant_id = ? AND status = 'pending'")
      .pluck()
      .all(participant.id) as number[];
    const cancel = sql("UPDATE orders SET status = 'canceled', reject_reason = ? WHERE id = ?");
    for (const id of pending) cancel.run('리그에서 나가 취소되었습니다.', id);
    sql('UPDATE participants SET left_at = ? WHERE id = ?').run(now(), participant.id);
    return { forfeited: true, canceled: pending.map((id) => toOrder(getOrderRow(id)!)) };
  });
  for (const order of result.canceled) {
    bus.emit('order', { league_id: leagueId, participant_id: order.participant_id, order });
  }
  bus.emit('rankings', { league_id: leagueId, rankings: computeRankings(leagueId) });
  return { forfeited: result.forfeited };
}

/** Public leagues plus every league the viewer joined. Active first, then recruiting, then finished. */
export function listLeagues(viewerUserId: number | null, filter: LeagueFilter = {}): LeagueSummary[] {
  const rows = sql(
    `SELECT * FROM leagues
     WHERE (is_public = 1 OR id IN (SELECT league_id FROM participants WHERE user_id = ? AND left_at IS NULL))
       AND (? IS NULL OR status = ?)
       AND (? IS NULL OR market = ?)
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'recruiting' THEN 1 ELSE 2 END,
              CASE WHEN status = 'finished' THEN -end_at ELSE start_at END,
              id
     LIMIT 200`,
  ).all(viewerUserId, filter.status ?? null, filter.status ?? null, filter.market ?? null, filter.market ?? null) as LeagueRow[];
  return rows.map((l) => summarize(l, viewerUserId));
}

export function getLeagueSummary(id: number, viewerUserId: number | null): LeagueSummary | null {
  const league = getLeagueRow(id);
  return league ? summarize(league, viewerUserId) : null;
}

// ---- official leagues ----

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Session open of the first trading day on or after `date` (ALL: unified day, KR open or else US open). */
function openOnOrAfter(market: LeagueMarket, date: string): number {
  let d = date;
  while (!isLeagueTradingDay(market, d)) d = shiftDate(d, 1);
  return leagueSessionBounds(market, d).open;
}

/**
 * Next scheduled official start strictly after `from`: 3d on Monday or Thursday, 1w on
 * Monday, 1m on the first trading day of the next month. A holiday moves the start to the
 * following trading day.
 */
export function nextScheduledStart(market: LeagueMarket, type: OfficialType, from: number): number {
  const today = leagueTradeDate(market, from);
  if (type === '1m') {
    const [y, m] = today.split('-').map(Number) as [number, number];
    const first = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return openOnOrAfter(market, first);
  }
  const days = type === '3d' ? [1, 4] : [1];
  for (let i = 0; i < 21; i++) {
    const date = shiftDate(today, i);
    if (!days.includes(weekday(date))) continue;
    const open = openOnOrAfter(market, date);
    if (open > from) return open;
  }
  throw new Error(`No ${type} slot found after ${new Date(from).toISOString()}`);
}

function officialLeagues(market: LeagueMarket, type: OfficialType): LeagueRow[] {
  return sql(
    "SELECT * FROM leagues WHERE owner_id IS NULL AND type = ? AND market = ? AND status <> 'finished' ORDER BY start_at",
  ).all(type, market) as LeagueRow[];
}

/** Enabled agents that trade `market` (ALL: both KR and US). */
function enabledAgentsFor(market: LeagueMarket): number[] {
  const needed: Market[] = market === 'ALL' ? ['KR', 'US'] : [market];
  const agents = sql('SELECT * FROM agents WHERE enabled = 1 ORDER BY id').all() as AgentRow[];
  return agents.filter((a) => needed.every((m) => agentMarkets(a).includes(m))).map((a) => a.id);
}

function createOfficial(market: LeagueMarket, type: OfficialType, startAt: number, agentIds: number[]): LeagueSummary {
  const seq =
    (sql('SELECT COUNT(*) FROM leagues WHERE owner_id IS NULL AND type = ? AND market = ?').pluck().get(type, market) as number) + 1;
  return createLeague({
    name: `${MARKET_PREFIX[market]} ${TYPE_LABELS[type]} 리그 #${seq}`,
    market,
    type,
    is_public: true,
    owner_id: null,
    start_at: startAt,
    agent_ids: agentIds,
  });
}

/**
 * Keeps every market × official type running: if nothing is active or recruiting, the
 * first league starts at the next open; while one is active, the next one is scheduled per
 * nextScheduledStart() and recruits until then. Enabled agents for the market are joined
 * to new and recruiting official leagues. Returns the leagues it created.
 */
export function ensureOfficialLeagues(): LeagueSummary[] {
  const created: LeagueSummary[] = [];
  tx(() => {
    for (const market of MARKETS) {
      const agentIds = enabledAgentsFor(market);
      for (const type of OFFICIAL_TYPES) {
        let leagues = officialLeagues(market, type);
        if (leagues.length === 0) {
          created.push(createOfficial(market, type, nextLeagueOpen(market, now()), agentIds));
          leagues = officialLeagues(market, type);
        }
        if (!leagues.some((l) => l.status === 'recruiting')) {
          created.push(createOfficial(market, type, nextScheduledStart(market, type, now()), agentIds));
          leagues = officialLeagues(market, type);
        }
        for (const league of leagues.filter((l) => l.status === 'recruiting')) {
          for (const agentId of agentIds) {
            if (!isJoined(league.id, { agentId })) insertParticipant(league, { agentId });
          }
        }
      }
    }
  });
  return created;
}

// ---- lifecycle ----

/**
 * Finishes an active league: cancels pending orders, takes the final snapshot, freezes
 * standings into final_rank / final_return. No-op for leagues that are not active.
 */
export function finishLeague(leagueId: number): void {
  const result = tx(() => {
    const league = getLeagueRow(leagueId);
    if (!league || league.status !== 'active') return null;
    const pending = sql(
      `SELECT o.* FROM orders o JOIN participants p ON p.id = o.participant_id
       WHERE p.league_id = ? AND o.status = 'pending'`,
    ).all(leagueId) as OrderRow[];
    const cancel = sql("UPDATE orders SET status = 'canceled', reject_reason = ? WHERE id = ?");
    for (const o of pending) cancel.run('리그 종료로 취소되었습니다.', o.id);
    takeSnapshots(leagueId);
    sql("UPDATE leagues SET status = 'finished' WHERE id = ?").run(leagueId);
    const rankings = computeRankings(leagueId);
    const store = sql('UPDATE participants SET final_rank = ?, final_return = ? WHERE id = ?');
    for (const r of rankings) store.run(r.rank, r.return_rate, r.participant_id);
    const canceled: Order[] = pending.map((o) => toOrder(getOrderRow(o.id)!));
    return { rankings, canceled };
  });
  if (!result) return;
  for (const order of result.canceled) {
    bus.emit('order', { league_id: leagueId, participant_id: order.participant_id, order });
  }
  bus.emit('rankings', { league_id: leagueId, rankings: result.rankings });
}

/**
 * Whether every symbol held or with a pending order in the league has a cached quote stamped
 * at or after `closeAt`, i.e. the closing prints are in: the valuation will not use pre-close
 * prices and orders placed before the close have had their chance to fill at the close.
 * Holdings of participants who left are ignored (they are no longer valued). With `market`,
 * only symbols of that market count (an ALL league at the US close ignores KR symbols, whose
 * last quotes are from the KR session).
 */
export function hasClosingQuotes(leagueId: number, closeAt: number, market?: Market): boolean {
  const symbols = sql(
    `SELECT h.symbol FROM holdings h JOIN participants p ON p.id = h.participant_id
     WHERE p.league_id = ? AND h.quantity > 0 AND p.left_at IS NULL
     UNION
     SELECT o.symbol FROM orders o JOIN participants p ON p.id = o.participant_id
     WHERE p.league_id = ? AND o.status = 'pending'`,
  )
    .pluck()
    .all(leagueId, leagueId) as string[];
  return symbols
    .filter((symbol) => market === undefined || getSymbol(symbol)?.market === market)
    .every((symbol) => (getQuote(symbol)?.ts ?? -Infinity) >= closeAt);
}

/**
 * recruiting → active at start_at; active → finished once end_at has passed and the closing
 * quotes of every held or pending-order symbol are in (see hasClosingQuotes), or
 * POST_CLOSE_FETCH_MS after end_at at the latest (delayed or halted symbols then keep their
 * last price). Returns the changed ids.
 */
export function updateLeagueStatuses(): { activated: number[]; finished: number[] } {
  const at = now();
  const activated = sql("SELECT id FROM leagues WHERE status = 'recruiting' AND start_at <= ?").pluck().all(at) as number[];
  if (activated.length > 0) {
    sql("UPDATE leagues SET status = 'active' WHERE status = 'recruiting' AND start_at <= ?").run(at);
  }
  const ended = sql("SELECT * FROM leagues WHERE status = 'active' AND end_at <= ?").all(at) as LeagueRow[];
  const finished = ended
    .filter((l) => at >= l.end_at + POST_CLOSE_FETCH_MS || hasClosingQuotes(l.id, l.end_at, closingMarketOf(l)))
    .map((l) => l.id);
  for (const id of finished) finishLeague(id);
  return { activated, finished };
}

// ---- dashboard ----

const STATUS_ORDER: Record<LeagueStatus, number> = { active: 0, recruiting: 1, finished: 2 };

/** One card per joined league: every unfinished league plus the most recently finished ones. */
export function myDashboard(userId: number): DashboardCard[] {
  const leagues = sql(
    `SELECT l.* FROM leagues l JOIN participants p ON p.league_id = l.id
     WHERE p.user_id = ? AND p.left_at IS NULL ORDER BY l.end_at DESC`,
  ).all(userId) as LeagueRow[];
  const shown = [
    ...leagues.filter((l) => l.status !== 'finished'),
    ...leagues.filter((l) => l.status === 'finished').slice(0, RECENT_FINISHED_CARDS),
  ].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.status === 'finished' ? b.end_at - a.end_at : a.status === 'recruiting' ? a.start_at - b.start_at : a.end_at - b.end_at),
  );

  const at = now();
  return shown.map((league) => {
    const summary = summarize(league, userId);
    const rankings = computeRankings(league.id);
    const me = rankings.find((r) => r.participant_id === summary.my_participant_id);
    const bestAi = rankings
      .filter((r) => r.kind === 'ai')
      .reduce<RankingRow | undefined>((best, r) => (!best || r.return_rate > best.return_rate ? r : best), undefined);
    const averages = leagueAverages(league.id, rankings);
    const target = league.status === 'recruiting' ? league.start_at : league.end_at;
    return {
      league: summary,
      my_rank: me?.rank ?? null,
      my_return_rate: me?.return_rate ?? 0,
      participant_count: summary.participant_count,
      remaining_ms: league.status === 'finished' ? 0 : Math.max(0, target - at),
      best_ai_name: bestAi?.display_name ?? null,
      best_ai_return: bestAi?.return_rate ?? null,
      human_avg_return: averages.human_avg_return,
      ai_avg_return: averages.ai_avg_return,
    };
  });
}
