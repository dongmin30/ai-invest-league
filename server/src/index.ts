// config.ts loads .env (dotenv) on import, so it must be evaluated before anything reads process.env.
import { config } from './config';
import { seedAgents } from './agents/seed';
import { buildApp } from './api/app';
import { db, migrate } from './db/db';
import { ensureOfficialLeagues } from './engine/leagues';
import { createCollector } from './market/collector';
import { loadStoredFx } from './market/fx';
import { getProvider } from './market/index';
import { startScheduler, type Scheduler } from './scheduler';

async function main(): Promise<void> {
  migrate();
  // The last stored USD/KRW (stale until the first fetch) so ALL leagues value and accept US orders after a restart.
  loadStoredFx();
  await seedAgents();

  const collector = createCollector(getProvider());
  collector.loadDailyBars().catch((err) => console.error('[server] initial daily bars failed:', err));

  ensureOfficialLeagues();

  const app = await buildApp({ logger: false, collector });
  await app.listen({ port: config.port });
  console.log(
    `[server] listening on http://localhost:${config.port} (provider: ${getProvider().name}` +
      `${config.simAlwaysOpen ? ', SIM_ALWAYS_OPEN' : ''})`,
  );

  const scheduler: Scheduler = startScheduler({ collector });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    const force = setTimeout(() => {
      console.error('[server] shutdown timed out; exiting');
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      await scheduler.stop();
      await app.close();
      db.close();
      process.exit(0);
    } catch (err) {
      console.error('[server] shutdown failed:', err);
      process.exit(1);
    }
  };
  process.on('SIGINT', (s) => void shutdown(s));
  process.on('SIGTERM', (s) => void shutdown(s));
}

process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err);
});

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
