-- 20260602d_site_settings.sql
-- Generic key/value site settings, readable by any app (anon) so a flag set
-- here is visible everywhere; writes via service-role only.
-- First use: the maintenance flag / banner.

create table if not exists ops.site_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table ops.site_settings enable row level security;
drop policy if exists site_settings_read on ops.site_settings;
create policy site_settings_read on ops.site_settings for select to anon, authenticated using (true);

create or replace function ops.tg_site_settings_touch() returns trigger
  language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_site_settings_touch on ops.site_settings;
create trigger trg_site_settings_touch before update on ops.site_settings
  for each row execute function ops.tg_site_settings_touch();

-- Seed the maintenance flag (off by default).
insert into ops.site_settings (key, value) values
  ('maintenance', jsonb_build_object(
    'enabled', false,
    'title', '🛠️ System Maintenance',
    'message', 'This system is being updated — please check back later. Sky is on a vibe-code bender trying to make this system better. If it''s clogging your day, call or text him and tell him to turn off maintenance so you can get some work done.'
  ))
on conflict (key) do nothing;
