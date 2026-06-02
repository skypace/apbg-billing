-- 20260602c_resq_sf_links.sql
-- Phase 2 of ResQ <-> SF sync v2: move sync state out of the single Netlify
-- Blob ("wo-mapping") into queryable ops.* tables + an append-only audit trail.
--
-- This migration only CREATES the tables. The worker dual-writes into them each
-- run (blob stays the authoritative read source for now), so this is additive
-- and cannot break the live sync. A later phase cuts reads over and drops the
-- blob.

-- One row per ResQ work order <-> SF job link (replaces the wo-mapping blob).
create table if not exists ops.resq_sf_links (
  id                 bigint generated always as identity primary key,
  resq_wo_id         text unique not null,        -- the wo-mapping key (ResQ WO node id)
  resq_code          text,
  sf_job_id          text,
  sf_job_number      text,
  resq_status        text,
  sf_status          text,
  facility           text,
  customer_qbo_id    text,                         -- links to ops.sync_customers.qbo_customer_id
  customer_name      text,
  title              text,
  reconciled         boolean default false,
  sf_deleted         boolean default false,
  photos_sent        boolean default false,
  invoice_submitted  boolean default false,
  visit_completed    boolean default false,
  linked_existing    boolean default false,
  replaced_sf_job_id text,
  raw                jsonb,                         -- full map entry, forward-compat
  created_at         timestamptz default now(),
  last_sync_at       timestamptz,
  updated_at         timestamptz default now()
);
create index if not exists resq_sf_links_code_idx  on ops.resq_sf_links (resq_code);
create index if not exists resq_sf_links_sfjob_idx on ops.resq_sf_links (sf_job_id);

-- Append-only audit trail (replaces the dedupe-report / last-errors blobs).
create table if not exists ops.sync_events (
  id          bigint generated always as identity primary key,
  resq_wo_id  text,
  resq_code   text,
  sf_job_id   text,
  direction   text,                                -- 'resq->sf' | 'sf->resq' | 'system'
  action      text not null,                       -- created | updated | linked | relinked | cancelled_duplicate | error | ...
  ok          boolean default true,
  message     text,
  payload     jsonb,
  created_at  timestamptz default now()
);
create index if not exists sync_events_code_idx    on ops.sync_events (resq_code);
create index if not exists sync_events_created_idx on ops.sync_events (created_at desc);

-- RLS: anon/authenticated may read (dashboard); writes via service-role only.
alter table ops.resq_sf_links enable row level security;
alter table ops.sync_events  enable row level security;

drop policy if exists resq_sf_links_read on ops.resq_sf_links;
create policy resq_sf_links_read on ops.resq_sf_links for select to anon, authenticated using (true);

drop policy if exists sync_events_read on ops.sync_events;
create policy sync_events_read on ops.sync_events for select to anon, authenticated using (true);

-- keep resq_sf_links.updated_at fresh
create or replace function ops.tg_resq_sf_links_touch() returns trigger
  language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_resq_sf_links_touch on ops.resq_sf_links;
create trigger trg_resq_sf_links_touch before update on ops.resq_sf_links
  for each row execute function ops.tg_resq_sf_links_touch();
