import fs from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { config } from '../config';
import { now } from '../lib/time';
import { createCollector, type Collector } from '../market/collector';
import { getProvider } from '../market/index';
import { authRoutes, readSession } from './auth';
import { ApiHttpError, errorHandler } from './errors';
import { adminRoutes, agentRoutes } from './routes/agents';
import { leagueRoutes } from './routes/leagues';
import { marketRoutes } from './routes/market';
import { participantRoutes } from './routes/participants';
import { streamRoutes } from './routes/stream';

export interface BuildAppOptions {
  logger?: boolean;
  /** Collector used by POST /api/admin/collect; defaults to one over the configured provider. */
  collector?: Collector;
  /** Directory of the built web app; defaults to config.webDistDir. Served only if it has index.html. */
  webDistDir?: string;
}

// Recharts sets inline styles; LLM-written text (market_view, reasons) is rendered as text only.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/** Paths whose last segment has an extension are files; a missing file is a 404, not the SPA shell. */
const looksLikeFile = (url: string) => /\.[a-z0-9]+$/i.test(url.split('?')[0]!.split('/').pop() ?? '');

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Typed up front: a union-typed trustProxy otherwise steers Fastify's overloads to http2.
  const serverOptions: FastifyServerOptions = { logger: opts.logger ?? false, trustProxy: config.trustProxy };
  const app = Fastify(serverOptions);
  const streams = new Set<() => void>();

  app.setErrorHandler(errorHandler);
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
  });
  app.decorateRequest('authUser', null);

  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    cookie: { cookieName: 'token', signed: false },
  });
  await app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: () =>
      new ApiHttpError(429, 'rate_limited', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'),
  });

  // SSE connections never end on their own; close them first so app.close() does not hang.
  app.addHook('preClose', async () => {
    for (const close of [...streams]) close();
  });

  await app.register(
    async (api) => {
      api.addHook('preHandler', async (req) => {
        req.authUser = readSession(app, req);
      });

      api.get('/health', async () => ({ ok: true, provider: getProvider().name, time: now() }));
      await api.register(authRoutes);
      await api.register(leagueRoutes);
      await api.register(participantRoutes);
      await api.register(marketRoutes);
      await api.register(agentRoutes);
      await api.register(adminRoutes, { collector: () => opts.collector ?? createCollector(getProvider()) });
      await api.register(streamRoutes, { streams });
    },
    { prefix: '/api' },
  );

  const webDistDir = opts.webDistDir ?? config.webDistDir;
  const serveWeb = fs.existsSync(path.join(webDistDir, 'index.html'));
  if (serveWeb) await app.register(fastifyStatic, { root: webDistDir });

  app.setNotFoundHandler(async (req, reply) => {
    const isApi = req.url === '/api' || req.url.startsWith('/api/');
    if (serveWeb && !isApi && (req.method === 'GET' || req.method === 'HEAD') && !looksLikeFile(req.url)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: '요청한 경로를 찾을 수 없습니다.' });
  });

  return app;
}
