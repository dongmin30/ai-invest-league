import type {
  AgentDetail,
  AgentInfo,
  CreateLeagueRequest,
  DashboardCard,
  DecisionLog,
  EquitySeries,
  FxQuote,
  LeagueDetail,
  LeagueMarket,
  LeagueStatus,
  LeagueSummary,
  LeaveLeagueResponse,
  Market,
  MarketStatus,
  Order,
  OrderStatus,
  PlaceOrderRequest,
  Portfolio,
  SymbolRow,
  User,
} from '@shared/api-types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface HealthResponse {
  ok: true;
  provider: 'yahoo' | 'kis' | 'sim';
  time: number;
}

export interface JoinByCodeResponse {
  league_id: number;
  participant_id: number;
}

export interface IntradayResponse {
  symbol: string;
  points: { ts: number; price: number }[];
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Called whenever an authenticated request comes back 401 (session expired or missing). */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

const FALLBACK_MESSAGES: Record<number, string> = {
  400: '요청이 올바르지 않습니다.',
  401: '로그인이 필요합니다.',
  403: '권한이 없습니다.',
  404: '찾을 수 없습니다.',
  429: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /** Skip the global 401 handler (used by the session probe and login forms). */
  silent401?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  const url = `/api${path}${qs ? `?${qs}` : ''}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', '서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.');
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const body = (payload ?? {}) as Partial<{ error: string; message: string }>;
    const error = new ApiError(
      res.status,
      body.error ?? `http_${res.status}`,
      body.message ?? FALLBACK_MESSAGES[res.status] ?? `서버 오류가 발생했습니다. (${res.status})`,
    );
    if (res.status === 401 && !opts.silent401) unauthorizedListeners.forEach((l) => l());
    throw error;
  }
  return payload as T;
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  register: (body: { email: string; password: string; nickname: string }) =>
    request<{ user: User }>('/auth/register', { method: 'POST', body, silent401: true }),
  login: (body: { email: string; password: string }) =>
    request<{ user: User }>('/auth/login', { method: 'POST', body, silent401: true }),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST', silent401: true }),
  me: () => request<{ user: User }>('/auth/me', { silent401: true }),

  dashboard: () => request<DashboardCard[]>('/me/dashboard'),

  listLeagues: (filter: { status?: LeagueStatus; market?: LeagueMarket } = {}) =>
    request<LeagueSummary[]>('/leagues', { query: filter }),
  createLeague: (body: CreateLeagueRequest) =>
    request<LeagueSummary>('/leagues', { method: 'POST', body }),
  joinLeague: (leagueId: number, inviteCode?: string) =>
    request<{ participant_id: number }>(`/leagues/${leagueId}/join`, {
      method: 'POST',
      body: inviteCode ? { invite_code: inviteCode } : {},
    }),
  joinLeagueByCode: (inviteCode: string) =>
    request<JoinByCodeResponse>('/leagues/join-by-code', { method: 'POST', body: { invite_code: inviteCode } }),
  leaveLeague: (leagueId: number) => request<LeaveLeagueResponse>(`/leagues/${leagueId}/leave`, { method: 'POST' }),
  leagueInvite: (leagueId: number) => request<{ invite_code: string | null }>(`/leagues/${leagueId}/invite`),
  league: (leagueId: number) => request<LeagueDetail>(`/leagues/${leagueId}`),
  leagueEquity: (leagueId: number) => request<EquitySeries[]>(`/leagues/${leagueId}/equity`),

  portfolio: (participantId: number) => request<Portfolio>(`/participants/${participantId}/portfolio`),
  orders: (participantId: number, status?: OrderStatus) =>
    request<Order[]>(`/participants/${participantId}/orders`, { query: { status } }),
  placeOrder: (participantId: number, body: PlaceOrderRequest) =>
    request<Order>(`/participants/${participantId}/orders`, { method: 'POST', body }),
  cancelOrder: (orderId: number) => request<Order>(`/orders/${orderId}`, { method: 'DELETE' }),

  symbols: (market: LeagueMarket) => request<SymbolRow[]>(`/market/${market}/symbols`), // ALL: both pools
  marketStatus: (market: Market) => request<MarketStatus>(`/market/${market}/status`),
  fx: () => request<FxQuote | null>('/market/fx'), // USD/KRW mid; null before the first fetch
  intraday: (symbol: string) =>
    request<IntradayResponse>(`/market/quote/${encodeURIComponent(symbol)}/intraday`),

  agents: () => request<AgentInfo[]>('/agents'),
  agent: (agentId: number) => request<AgentDetail>(`/agents/${agentId}`),

  adminRunAgent: (agentId: number, leagueId: number) =>
    request<DecisionLog>(`/admin/agents/${agentId}/run`, { method: 'POST', body: { league_id: leagueId } }),
  adminCollect: () => request<{ count: number }>('/admin/collect', { method: 'POST' }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '알 수 없는 오류가 발생했습니다.';
}
