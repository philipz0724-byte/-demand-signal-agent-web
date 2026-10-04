# AgentCoverage

A public experiment in **agent-native service discovery**.

AgentCoverage exposes one focused capability: `coverage_check`. An AI agent supplies a research task plus entities it has already found; the service searches for likely omissions and reports additions, known gaps, and search saturation.

The experiment is intentionally designed around a funnel:

`discovery -> capability read -> free preview -> pricing intent -> (later) payment`

Phase 1 does **not** claim mathematical completeness of the open web and does **not** charge real money. The proposed full-check price is shown only to measure commercial intent.

## Routes

- `/` human-readable landing page and preview
- `/agent` machine-oriented capability description
- `/dashboard` experiment status
- `/llms.txt` LLM-readable service summary
- `/.well-known/ai-catalog.json` experimental agent discovery catalog
- `/agent-capability.json` compact machine manifest

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Environment

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```

Supabase Edge Function secrets:

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.5
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Never expose `OPENAI_API_KEY` or the Supabase service-role key in the frontend.

## Supabase

1. Apply `supabase/migrations/001_agent_coverage.sql`.
2. Deploy `supabase/functions/log-agent-event`.
3. Deploy `supabase/functions/coverage-preview`.
4. Set the Edge Function secrets above.

`coverage-preview` uses the OpenAI Responses API with hosted web search when `OPENAI_API_KEY` is configured. The model is configurable through `OPENAI_MODEL`.

## Experiment events

- `landing_view`
- `capability_read`
- `preview_requested`
- `pricing_requested`

The public frontend sends analytics through `log-agent-event`; the service-role key remains server-side.

## Deployment

This is a Vite SPA. `vercel.json` rewrites human routes to `index.html` while allowing static discovery files under `public/` to be served directly.

## What success means

The first meaningful milestone is not revenue. It is an unfamiliar agent or agent-mediated user reaching the service organically and progressing from capability discovery to a real preview. The next milestone is a pricing-intent event. Only then should real machine payment be added.
