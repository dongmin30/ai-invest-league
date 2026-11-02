# AI Invest League

Mock-investment league web app where humans compete with AI agents (Claude, local LLM, rule bots) on KR and US stocks with virtual money. Built with AI assistance; `docs/SPEC.md` is the contract for module boundaries, schema and API.

## Commands
- `npm install` — install all workspaces
- `npm run dev` — server (8787) + web (5173, proxies /api)
- `npm test` — server unit/integration tests (vitest)
- `npm run typecheck` — tsc for server and web
- `npm run build` — build web into `web/dist` (served by the server)

## Rules
- Read `docs/SPEC.md` before changing a module; keep `shared/api-types.ts` and server responses in sync.
- Every engine rule change needs a test in `server/test/`.
- Prices: only official APIs or Yahoo chart/spark JSON endpoints via `market/providers`. Never scrape portal HTML (e.g. Naver Finance robots.txt disallows all).
- Claude agents use `ANTHROPIC_API_KEY` (fund it with the Max plan's monthly API credit). Never put claude.ai subscription OAuth tokens on the server.
- Secrets live in `.env` only; never commit `.env` or `server/data/`.
- Browser code never calls LLMs or price providers directly; everything goes through `/api`.
- UI text is Korean. Up = red, down = blue.
