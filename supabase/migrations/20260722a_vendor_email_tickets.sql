-- Vendor email → Service Fusion ticket automation (Red Bull / Freshpet).
--
-- Inbound flow (no crons — fully event-driven):
--   vendor email → forwarded to a Resend receiving address on alamedapointbg.com
--   → Resend `email.received` webhook → netlify/functions/vendor-email-intake.mjs
--   → Claude parses the email → SF job created → send list notified.
-- Status flow:
--   Service Fusion job-status notification email → sf-status@alamedapointbg.com
--   → same webhook → job number + status parsed → send list notified.
--
-- Writer: vendor-email-intake (netlify-function, apbg-billing). Service-role
-- only — RLS enabled with no anon/authenticated policies.

create table if not exists ops.vendor_email_routes (
  id uuid primary key default gen_random_uuid(),
  inbox text not null unique,                    -- full receiving address, lowercase
  vendor_key text not null,                      -- 'redbull' | 'freshpet' | ...
  display_name text not null default '',
  sf_customer_name text,                         -- SF customer the job is created under.
                                                 -- NULL = intake records the email but
                                                 -- refuses to create the SF job.
  sf_job_category text,                          -- must already exist in SF Settings →
                                                 -- Job Categories (unknown names 422;
                                                 -- intake retries without it)
  sf_job_status_initial text not null default 'Unscheduled',
  send_list text[] not null default '{service@brixbev.com}',
  extraction_hints text,                         -- extra per-vendor parser instructions
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ops.vendor_email_tickets (
  id uuid primary key default gen_random_uuid(),
  route_id uuid references ops.vendor_email_routes(id),
  vendor_key text,
  resend_email_id text unique,                   -- dedup key: Resend inbound email id
  from_email text,
  to_email text,
  subject text,
  received_at timestamptz,
  raw_text text,
  parsed jsonb,
  sf_job_id text,
  sf_job_number text,
  sf_customer_name text,
  status text not null default 'received'
    check (status in ('received','needs_route_config','sf_created','sf_failed','ignored')),
  error text,
  last_sf_status text,
  last_status_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendor_email_tickets_sf_job_number_idx
  on ops.vendor_email_tickets (sf_job_number);
create index if not exists vendor_email_tickets_status_idx
  on ops.vendor_email_tickets (status);

create table if not exists ops.vendor_ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references ops.vendor_email_tickets(id) on delete cascade,
  sf_job_number text,
  sf_status text,
  source text not null default 'sf-notification-email',
  notified_to text[],
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists vendor_ticket_events_ticket_idx
  on ops.vendor_ticket_events (ticket_id);

alter table ops.vendor_email_routes enable row level security;
alter table ops.vendor_email_tickets enable row level security;
alter table ops.vendor_ticket_events enable row level security;

-- Seed the two live routes. sf_customer_name is deliberately NULL — set it to
-- the exact SF customer each vendor's jobs belong under before going live:
--   update ops.vendor_email_routes set sf_customer_name = '<EXACT SF NAME>'
--   where inbox = 'rbfreeflow@alamedapointbg.com';
insert into ops.vendor_email_routes
  (inbox, vendor_key, display_name, sf_job_category, extraction_hints)
values
  ('rbfreeflow@alamedapointbg.com', 'redbull', 'Red Bull / FreeFlow',
   'Service Call',
   'These are Red Bull dispatch/service emails. Pull the account/venue name and full street address, any Red Bull reference or dispatch number, the equipment involved (cooler, fridge, etc.), and the requested service or issue description.'),
  ('freshpet@alamedapointbg.com', 'freshpet', 'Freshpet',
   'Service Call',
   'These are Freshpet service emails. Pull the store/location name and number, full street address, any Freshpet work order or reference number, the fridge/equipment identifiers, and the requested service or issue description.')
on conflict (inbox) do nothing;
