-- 20260826a — electronic NDAs for vendors, co-packers and labs.
--
-- Staff send a link; the recipient fills in their own company details, reads
-- the agreement, types their name and signs on the page. On signature the
-- agreement is executed, rendered to PDF, and filed in the compliance vault
-- against the party — so the NDA lives where every other piece of compliance
-- paper lives instead of in someone's inbox.
--
-- Two rules are load-bearing here and are enforced by the shape of the tables:
--
--  1. THE SIGNED TEXT IS SNAPSHOTTED ONTO THE AGREEMENT (`body_source`).
--     Templates are editable, and they should be — terms change. But editing a
--     template must never change what somebody already signed, and a signature
--     that points at mutable text is not evidence of anything. Every render
--     of a signed agreement (screen, PDF, re-download years later) comes from
--     the row's own snapshot, never from the template.
--
--  2. A SIGNED ROW IS IMMUTABLE. Enforced by trigger, not by convention.
--
-- Token model is the vendor-onboarding one: 32 random bytes, base64url, and
-- only the sha256 HASH is stored — the raw token exists solely inside the
-- emailed link, so a database read can never mint a signing link. No cron and
-- no background pipeline here (staff resend by hand), so there is nothing new
-- for ops.sync_health() to watch.

-- ── 1. Templates ────────────────────────────────────────────────────────────
create table if not exists ops.nda_templates (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  version     text not null,
  title       text not null,
  subtitle    text,
  -- The agreement text in the light markup that lib/nda-doc.mjs parses. ONE
  -- source for the on-screen document and the PDF, so the two cannot drift.
  body_source text not null,
  active      boolean not null default true,
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (code, version)
);
create unique index if not exists nda_templates_active_code_idx
  on ops.nda_templates (code) where active;

-- ── 2. Agreements ───────────────────────────────────────────────────────────
create table if not exists ops.nda_agreements (
  id                 uuid primary key default gen_random_uuid(),
  agreement_number   text not null unique,          -- NDA-YYYY-###
  status             text not null default 'sent'
                       check (status in ('sent','viewed','signed','declined','revoked')),

  template_id        uuid references ops.nda_templates(id),
  template_code      text not null,
  template_version   text not null,
  title              text not null,
  subtitle           text,
  body_source        text not null,                 -- SNAPSHOT — see rule 1 above

  -- Who we sent it to (what staff know before the recipient fills it in)
  recipient_company  text not null,
  recipient_email    text not null,
  recipient_contact  text,

  -- What the recipient fills in on the page
  recipient_legal_name  text,
  recipient_entity_type text,                       -- corporation / LLC / partnership / sole prop
  recipient_state       text,                       -- state of organization
  recipient_address     text,
  signer_name           text,
  signer_title          text,
  signer_email          text,
  signer_phone          text,

  -- The "use" — why they are getting our formulations at all
  purpose_scope      text,
  services           jsonb not null default '[]'::jsonb,

  -- Company side: pre-executed by the staff member who sends it. This is our
  -- paper on our terms; the assent we are collecting is the recipient's.
  company_signer_name  text not null,
  company_signer_title text,
  company_signed_at    timestamptz not null default now(),

  -- Execution
  effective_date     date,                          -- the date they sign
  signed_at          timestamptz,
  typed_name         text,                          -- ESIGN: their typed intent to sign
  signature_data     text,                          -- drawn signature, PNG data URL
  signer_ip          text,
  signer_user_agent  text,
  consent_esign      boolean not null default false,
  declined_at        timestamptz,
  decline_reason     text,
  revoked_at         timestamptz,
  revoked_by         text,

  -- The link
  token_hash         text not null unique,
  expires_at         timestamptz not null,
  sent_at            timestamptz not null default now(),
  sent_to            text,
  resent_count       int not null default 0,
  viewed_at          timestamptz,

  -- Filing
  pdf_path           text,                          -- compliance-docs bucket
  insured_party_id   uuid references ops.insured_parties(id),
  document_id        uuid references ops.compliance_documents(id),

  notes              text,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists nda_agreements_status_idx on ops.nda_agreements (status, sent_at desc);
create index if not exists nda_agreements_party_idx  on ops.nda_agreements (insured_party_id);

-- ── 3. Exhibit A — the disclosure and sample log ────────────────────────────
-- The agreement itself says this log is for evidentiary convenience and that
-- failing to log an item does not remove its protection. It lives here so it
-- is an actual running record rather than a blank table in a PDF.
create table if not exists ops.nda_disclosure_log (
  id            uuid primary key default gen_random_uuid(),
  agreement_id  uuid not null references ops.nda_agreements(id) on delete cascade,
  disclosed_on  date not null default current_date,
  description   text not null,
  format        text,                               -- sample / document / electronic / verbal
  delivered_by  text,
  quantity      text,
  created_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists nda_disclosure_log_agreement_idx
  on ops.nda_disclosure_log (agreement_id, disclosed_on desc);

-- ── 4. A signed agreement is immutable ──────────────────────────────────────
-- Filing columns (the PDF path, the vault link) are still allowed to land
-- after signature — that is the same execution event finishing. Everything
-- else about a signed row is frozen, including the text that was signed.
create or replace function ops.tg_nda_freeze_signed()
returns trigger language plpgsql as $$
begin
  if old.status = 'signed' then
    if new.body_source     is distinct from old.body_source
    or new.signature_data  is distinct from old.signature_data
    or new.typed_name      is distinct from old.typed_name
    or new.signed_at       is distinct from old.signed_at
    or new.effective_date  is distinct from old.effective_date
    or new.recipient_legal_name is distinct from old.recipient_legal_name
    or new.signer_name     is distinct from old.signer_name
    or new.status          is distinct from old.status then
      raise exception 'NDA % is signed — its executed terms cannot be altered', old.agreement_number;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists nda_agreements_freeze on ops.nda_agreements;
create trigger nda_agreements_freeze before update on ops.nda_agreements
  for each row execute function ops.tg_nda_freeze_signed();

create trigger nda_templates_touch before update on ops.nda_templates
  for each row execute function ops.tg_compliance_touch();

-- ── 5. Grants + RLS ─────────────────────────────────────────────────────────
-- GRANTs are written next to the policies on purpose: Postgres checks table
-- privileges BEFORE RLS, so a policy without a grant is a dead button. That is
-- exactly what happened to ops.visitor_visits (fixed in 20260825a).
grant select, insert, update on ops.nda_templates      to authenticated;
grant select, update          on ops.nda_agreements    to authenticated;
grant select, insert, delete  on ops.nda_disclosure_log to authenticated;
grant all on ops.nda_templates, ops.nda_agreements, ops.nda_disclosure_log to service_role;

alter table ops.nda_templates      enable row level security;
alter table ops.nda_agreements     enable row level security;
alter table ops.nda_disclosure_log enable row level security;

-- Staff only, both directions. An NDA names a counterparty, the scope of work
-- we are discussing with them, and our own signer — none of which belongs to
-- every authenticated login on this shared Supabase project.
drop policy if exists nda_templates_staff on ops.nda_templates;
create policy nda_templates_staff on ops.nda_templates
  for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());

drop policy if exists nda_agreements_staff on ops.nda_agreements;
create policy nda_agreements_staff on ops.nda_agreements
  for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());

drop policy if exists nda_disclosure_log_staff on ops.nda_disclosure_log;
create policy nda_disclosure_log_staff on ops.nda_disclosure_log
  for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());

-- Nothing for anon: the signing page is public but reaches the row only
-- through the service-role function, keyed by a token hash it cannot read.

-- ── 6. Numbering ────────────────────────────────────────────────────────────
create sequence if not exists ops.nda_number_seq;
create or replace function ops.fn_next_nda_number()
returns text language sql security definer set search_path to 'ops' as $$
  select 'NDA-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('ops.nda_number_seq')::text, 3, '0');
$$;
revoke execute on function ops.fn_next_nda_number() from public, anon;
grant execute on function ops.fn_next_nda_number() to service_role;

-- ── 7. The vault gets a 'legal' category ────────────────────────────────────
-- An executed NDA is not insurance, a permit, or "other". Filing it as other
-- buries it, and category is how staff actually find things in the vault.
alter table ops.compliance_documents drop constraint if exists compliance_documents_category_check;
alter table ops.compliance_documents add constraint compliance_documents_category_check
  check (category in ('insurance','permit','food_safety','safety','tax','legal','other'));
