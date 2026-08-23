-- Baseline snapshot of Service Fusion customers + their communication settings,
-- diffed by the SF Changes report (netlify/functions/sf-changes-report-background.mjs).
-- Applied live to gfsdpwiqzshhexkofiif on 2026-07-15 via Supabase MCP.
create table if not exists ops.sf_customer_snapshot (
  sf_customer_id text primary key,
  customer_name text,
  comms jsonb not null default '[]'::jsonb, -- [{contact, email, types:"CONF,STATUS,..."}]
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  removed_at timestamptz -- stamped when the customer disappears from SF (deleted or archived)
);
alter table ops.sf_customer_snapshot enable row level security;
-- service-role only (no anon/authenticated policies)
