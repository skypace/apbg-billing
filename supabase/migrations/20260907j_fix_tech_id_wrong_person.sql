-- 20260907j — 82 mirrored jobs were attributed to the WRONG PERSON
--
-- sync-sf resolved a Service Fusion tech to a roster row with
--
--   .or("name.ilike.%<first>%,name.ilike.%<last>%").limit(1)
--
-- EITHER name part matches, the first row wins, and there is no ORDER BY — so
-- the answer was both wrong and non-deterministic. Measured live 2026-09-07:
--
--   service_jobs   Anthony VanRenselaar  42 rows -> Anthony Sloan
--   service_jobs   Origins Craft Soda Co 18 rows -> Marco
--   delivery_stops Origins Craft Soda Co 15 rows -> Marco
--   delivery_stops Anthony VanRenselaar   4 rows -> Anthony Sloan
--   service_jobs   Eric VanRenselaar      2 rows -> Anthony VanRenselaar
--   service_jobs   Marco Di Luca          1 row  -> Marco
--
-- A first-name collision, a surname collision, and a DISTRIBUTOR mapped onto a
-- member of staff.
--
-- ⚠ Nothing reads these id columns today — every KPI in APBG-OPS groups on
-- `tech_name` / `driver_name` with an exact string match, so this was a
-- landmine, not a live wound. It is precisely the landmine an id-based join
-- steps on, which is how it was found: the labour-cost work needs
-- person -> job attribution, and the obvious join would have charged Anthony
-- VanRenselaar's 42 jobs to Anthony Sloan.
--
-- The writer is fixed in sync-sf v36 (exact, unambiguous, or NULL — the same
-- rule 20260907h used for qbo_employee_id). This corrects the rows already on
-- file. Names are NOT touched; only the ids.
--
-- Idempotent: only rows that disagree with the exact match are written, so a
-- second run changes nothing. It raises rather than writes if any row is left
-- pointing at a roster row whose name is not the stored name.

-- The exact, unambiguous match. A name held by two roster rows resolves to
-- NULL: ambiguity is a question, not a coin flip.
create or replace function ops.fn_roster_id_for_name(p_name text)
returns bigint
language sql
stable
as $$
  select case when count(*) = 1 then min(tm.id) else null end
  from ops.team_members tm
  where lower(btrim(tm.name)) = lower(btrim(p_name))
$$;

update ops.service_jobs sj
   set tech_id = ops.fn_roster_id_for_name(sj.tech_name)
 where sj.tech_id is distinct from ops.fn_roster_id_for_name(sj.tech_name);

update ops.delivery_stops ds
   set driver_id = ops.fn_roster_id_for_name(ds.driver_name)
 where ds.driver_id is distinct from ops.fn_roster_id_for_name(ds.driver_name);

update ops.reman_jobs rj
   set tech_id = ops.fn_roster_id_for_name(rj.tech_name)
 where rj.tech_id is distinct from ops.fn_roster_id_for_name(rj.tech_name);

do $$
declare v_bad int;
begin
  select
    (select count(*) from ops.service_jobs sj join ops.team_members tm on tm.id = sj.tech_id
      where lower(btrim(tm.name)) <> lower(btrim(coalesce(sj.tech_name, ''))))
  + (select count(*) from ops.delivery_stops ds join ops.team_members tm on tm.id = ds.driver_id
      where lower(btrim(tm.name)) <> lower(btrim(coalesce(ds.driver_name, ''))))
  + (select count(*) from ops.reman_jobs rj join ops.team_members tm on tm.id = rj.tech_id
      where lower(btrim(tm.name)) <> lower(btrim(coalesce(rj.tech_name, ''))))
  into v_bad;

  if v_bad > 0 then
    raise exception 'tech_id repair left % row(s) pointing at a roster row whose name is not the stored name', v_bad;
  end if;
end $$;

comment on function ops.fn_roster_id_for_name(text) is
  'Exact, unambiguous roster lookup by full name; NULL when the name matches no row or more than one. Used by 20260907j and available to any future job -> person join. Never widen this to a fuzzy match: a wrong id is a silent lie where a NULL is a visible gap.';
