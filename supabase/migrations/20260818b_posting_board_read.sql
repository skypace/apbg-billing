-- 20260818b — the posting board is for EMPLOYEES, so employees must be able to
-- read it. Required workplace notices are public by law; the whole point of
-- posting them is that every worker can read them. Writes stay staff-only via
-- the existing compliance_postings_staff_all / compliance_docs_* policies.
-- Applied live 2026-08-18.

create policy compliance_postings_read_authenticated
  on ops.compliance_postings for select to authenticated using (true);

-- Same reasoning for the posted copies we upload. Scoped to postings/* only —
-- everything else in compliance-docs (insurance limits, audit corrective
-- actions, SDS) stays behind ops.fn_is_staff().
create policy compliance_docs_postings_read
  on storage.objects for select to authenticated
  using (bucket_id = 'compliance-docs' and (storage.foldername(name))[1] = 'postings');
