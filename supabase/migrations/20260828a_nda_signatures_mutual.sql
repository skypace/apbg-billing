-- 20260828a — a real company signature on our NDAs, and a mutual variant.
--
-- Three things, all in service of one idea: the executed PDF should look like a
-- document two parties signed, and it should say the right thing about who owes
-- what to whom.
--
--   1. ops.nda_signatories — the officers who sign for us, each with their
--      signature drawn once and kept. Until now the Company block carried a
--      typed name and an empty rule; the counterparty signed properly and we
--      did not, which is a poor look on our own paper.
--   2. nda_agreements.company_signature_data — the signature SNAPSHOTTED onto
--      the agreement at send time, exactly like body_source. Re-drawing your
--      signature must never change a document somebody has already signed.
--   3. mutual — an NDA where both sides disclose reads differently in the
--      preamble, in the obligations and on the signature page. The flag is
--      snapshotted onto the agreement rather than derived from the template
--      code, so a renamed or re-coded template cannot retroactively change how
--      an executed agreement reads.

create table if not exists ops.nda_signatories (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,                -- as it should print on the agreement
  title          text,
  email          text,                         -- the staff login this belongs to
  signature_data text,                         -- PNG data URL, drawn or uploaded
  active         boolean not null default true,
  notes          text,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists nda_signatories_email_idx
  on ops.nda_signatories (lower(email)) where email is not null and active;

create trigger nda_signatories_touch before update on ops.nda_signatories
  for each row execute function ops.tg_compliance_touch();

-- GRANTs next to the policies: Postgres checks privileges before RLS, and a
-- policy without a grant is a dead button (ops.visitor_visits, 20260825a).
grant select, insert, update on ops.nda_signatories to authenticated;
grant all on ops.nda_signatories to service_role;

alter table ops.nda_signatories enable row level security;
drop policy if exists nda_signatories_staff on ops.nda_signatories;
create policy nda_signatories_staff on ops.nda_signatories
  for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());

-- The signature as it appeared when THIS agreement went out.
alter table ops.nda_agreements
  add column if not exists company_signature_data text,
  add column if not exists company_signatory_id   uuid references ops.nda_signatories(id),
  add column if not exists mutual                 boolean not null default false;

-- Which flavour a template is, so the renderers do not have to guess from a code.
alter table ops.nda_templates
  add column if not exists mutual boolean not null default false;

-- A sender link carries its issuer's choices: who countersigns, and which
-- agreement the delegate is allowed to send. A null template_code means they
-- pick; a set one pins them to that flavour.
alter table ops.nda_sender_links
  add column if not exists company_signatory_id uuid references ops.nda_signatories(id),
  add column if not exists template_code        text;

-- Freeze the new executed fields too. Read from the LIVE definition and add to
-- it — never rebuild this from a copy in an older migration.
create or replace function ops.tg_nda_freeze_signed()
returns trigger language plpgsql as $$
begin
  if old.status = 'signed' then
    if new.body_source is distinct from old.body_source
    or new.signature_data is distinct from old.signature_data
    or new.company_signature_data is distinct from old.company_signature_data
    or new.mutual is distinct from old.mutual
    or new.typed_name is distinct from old.typed_name
    or new.signed_at is distinct from old.signed_at
    or new.effective_date is distinct from old.effective_date
    or new.recipient_legal_name is distinct from old.recipient_legal_name
    or new.signer_name is distinct from old.signer_name
    or new.status is distinct from old.status then
      raise exception 'NDA % is signed — its executed terms cannot be altered', old.agreement_number;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
