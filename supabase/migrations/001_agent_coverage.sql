create extension if not exists pgcrypto;

create table if not exists public.agent_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  session_id text,
  event_type text not null,
  path text,
  user_agent text,
  ip_hash text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists agent_events_created_at_idx on public.agent_events (created_at desc);
create index if not exists agent_events_event_type_idx on public.agent_events (event_type);

alter table public.agent_events enable row level security;

-- No public insert/select policies on purpose. Events are written by the
-- log-agent-event Edge Function using the service-role key.
