-- 20260818e — front-door visitor sign-in kiosk. Applied live 2026-08-18.
--
-- A visitor cannot log in, so the kiosk page is public and its two writes go
-- through service-role Netlify functions (visitor-signin / visitor-signout).
-- Nothing here is reachable with the anon key. Staff read and manage the log
-- from /compliance → Visitors.
--
-- The on-site list (signed_out_at is null) is the evacuation head-count, which
-- is the real reason this exists rather than a paper book at the door.

create table if not exists ops.visitor_visits (
  id uuid primary key default gen_random_uuid(),
  badge_number    text not null unique,
  signed_in_at    timestamptz not null default now(),
  signed_out_at   timestamptz,
  signed_out_by   text,
  full_name       text not null,
  email           text,
  phone           text,
  company         text,
  visitor_type    text not null default 'visitor'
                    check (visitor_type in ('visitor','contractor','vendor','inspector','driver','interview','other')),
  visit_purpose   text,
  host_name       text,
  host_email      text,
  vehicle         text,
  areas           text,
  agreement_version text not null,
  signature_data  text not null,
  photo_path      text,
  notified_at     timestamptz,
  notify_error    text,
  user_agent      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists visitor_visits_onsite_idx on ops.visitor_visits (signed_in_at desc) where signed_out_at is null;
create index if not exists visitor_visits_day_idx on ops.visitor_visits (signed_in_at desc);

create table if not exists ops.visitor_settings (
  id int primary key default 1 check (id = 1),
  hosts jsonb not null default '[]'::jsonb,
  notify_emails jsonb not null default '[]'::jsonb,
  require_photo boolean not null default true,
  agreement_version text not null default '1.0 (2026-08-18)',
  facility_label text not null default 'Hangar 200 · 1951 Monarch St, Suite 200, Alameda CA 94501',
  updated_at timestamptz not null default now()
);
insert into ops.visitor_settings (id, hosts, notify_emails)
values (1,
  '[{"name":"Sky Pace","email":"skypace@brixbev.com"},{"name":"Anthony Sloan","email":"asloan@brixbev.com"},{"name":"Front office","email":"service@brixbev.com"}]'::jsonb,
  '["service@brixbev.com"]'::jsonb)
on conflict (id) do nothing;

alter table ops.visitor_visits enable row level security;
alter table ops.visitor_settings enable row level security;

create policy visitor_visits_staff_all on ops.visitor_visits
  for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());
create policy visitor_settings_staff_all on ops.visitor_settings
  for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());

create trigger visitor_visits_touch before update on ops.visitor_visits
  for each row execute function ops.tg_compliance_touch();
create trigger visitor_settings_touch before update on ops.visitor_settings
  for each row execute function ops.tg_compliance_touch();

-- Badge photos are personal data: private bucket, staff read, service-role write.
insert into storage.buckets (id, name, public) values ('visitor-photos','visitor-photos', false)
  on conflict (id) do nothing;
create policy visitor_photos_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'visitor-photos' and ops.fn_is_staff());
create policy visitor_photos_staff_delete on storage.objects for delete to authenticated
  using (bucket_id = 'visitor-photos' and ops.fn_is_staff());
