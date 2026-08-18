-- 20260818c — mirror the official notices onto our own site.
--
-- The Posting board runs on a break-room monitor. Pointing an iframe at
-- dol.gov / dir.ca.gov does not work: those hosts refuse to be framed, some sit
-- behind bot protection, and a screen that has to come up every morning should
-- not depend on a third-party site being reachable. So each notice's PDF was
-- downloaded from its official source_url and committed to
-- apbg-billing public/postings/, served at /billing/postings/<file>.
--
-- house-*.pdf are the two notices the EMPLOYER issues rather than an agency:
-- the Labor Code 6404.5 No Smoking sign (no state-issued poster exists) and our
-- completed version of the Cal/OSHA S-500 Emergency Phone Numbers fill-in form.
--
-- Deliberately left without a mirror:
--   · IWC Wage Order — which of Order 1 / 7 / 9 applies is still open with DLSE,
--     and posting the wrong one is worse than posting none.
--   · Notice of Workers' Compensation Carrier and Coverage — the form comes from
--     AmTrust / Embroker and must name the current carrier.
--
-- Applied live 2026-08-18.

alter table ops.compliance_postings
  add column if not exists mirror_path text;

comment on column ops.compliance_postings.mirror_path is
  'Filename under apbg-billing public/postings/, served at /billing/postings/<file>. Our own mirror of the notice so the Posting board renders the real document on a monitor without depending on the agency site being frameable or reachable. Official copies are downloaded from source_url; house-*.pdf are notices the employer issues itself.';

-- The per-row mirror_path assignments were applied live against the seeded
-- titles from 20260818a; see that migration for the row set.
