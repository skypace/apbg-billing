-- 20260827a — delegated NDA sender links.
--
-- A named person gets a personal link that lets them send our NDA without a hub
-- login. Useful for a rep in the field or an assistant who has no account.
--
-- ⚠ THIS LINK IS A CREDENTIAL. Anyone holding it can send Brix-branded email to
-- any address, which is a phishing tool with our domain on it. Every constraint
-- below exists because of that, and none of them should be relaxed casually:
--
--   · It belongs to a NAMED PERSON. There is no shared link.
--   · It can only SEND. It cannot list, open, revoke or download anyone else's
--     agreement — the send endpoint is a different function from nda-admin and
--     simply has no code for those things.
--   · It sees only what it created, and only the company name and status.
--   · It is rate limited on a rolling 24 hours, so a leaked link cannot be used
--     to blast mail before anybody notices.
--   · Every send emails compliance out of band, so the audit trail is somewhere
--     other than the app the abuser would be using.
--   · It expires, and it can be revoked instantly.
--
-- The link carries a FIXED company signer chosen by the staff member who issued
-- it. That is the point, not an oversight: the delegate is dispatching a
-- document an officer has already executed, not signing on the company's behalf.

create table if not exists ops.nda_sender_links (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,                 -- what this link is for, e.g. "Trade shows — Marco"
  person_name  text not null,                 -- who holds it. Never blank: a link nobody owns is a shared secret.
  person_email text not null,                 -- gets a copy of everything sent through it

  -- Who the agreements it sends are countersigned by. Set by the issuer.
  company_signer_name  text not null,
  company_signer_title text,

  -- Optional defaults so a rep does not have to type the same purpose each time.
  default_purpose  text,
  default_services jsonb not null default '[]'::jsonb,

  token_hash   text not null unique,          -- sha256; the raw token lives only in the link
  expires_at   timestamptz not null,
  max_per_day  int not null default 5 check (max_per_day between 1 and 50),

  sends_count  int not null default 0,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   text,

  notes        text,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists nda_sender_links_live_idx
  on ops.nda_sender_links (created_at desc) where revoked_at is null;

-- Which link sent an agreement. Null = sent by a signed-in staff member.
alter table ops.nda_agreements
  add column if not exists sender_link_id uuid references ops.nda_sender_links(id);
create index if not exists nda_agreements_sender_link_idx
  on ops.nda_agreements (sender_link_id, created_at desc);

create trigger nda_sender_links_touch before update on ops.nda_sender_links
  for each row execute function ops.tg_compliance_touch();

-- GRANTs next to the policies — Postgres checks privileges before RLS, and a
-- policy without a grant is a dead button (ops.visitor_visits, 20260825a).
grant select, insert, update on ops.nda_sender_links to authenticated;
grant all on ops.nda_sender_links to service_role;

alter table ops.nda_sender_links enable row level security;

-- Staff only. The token hash is harmless to read, but the row says who is
-- authorised to send in our name, which is not for every login on this shared
-- project. Nothing for anon: the send endpoint reaches this table through the
-- service role, keyed by a hash the holder cannot read.
drop policy if exists nda_sender_links_staff on ops.nda_sender_links;
create policy nda_sender_links_staff on ops.nda_sender_links
  for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());

-- How many agreements a link has sent in the last rolling 24 hours. Rolling
-- rather than per calendar day, so a leaked link cannot send its whole quota at
-- 23:59 and the same again a minute later.
create or replace function ops.fn_nda_link_sends_24h(p_link_id uuid)
returns int language sql stable security definer set search_path to 'ops' as $$
  select count(*)::int from ops.nda_agreements
   where sender_link_id = p_link_id and created_at > now() - interval '24 hours';
$$;
revoke execute on function ops.fn_nda_link_sends_24h(uuid) from public, anon;
grant execute on function ops.fn_nda_link_sends_24h(uuid) to service_role, authenticated;
