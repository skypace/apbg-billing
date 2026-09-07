-- 20260907h — link the roster to QuickBooks payroll identities, once
--
-- ops.v_labour_day joins ops.team_members to ops.qbo_time_activities on
-- qbo_employee_id. Nothing populated it, because the column did not exist until
-- 20260907f — despite APBG-OPS's CLAUDE.md having claimed for months that
-- team_members "links names from QBO Payroll (qbo_employee_id)".
--
-- Matched on FIRST + LAST name only: QuickBooks Time carries middle initials the
-- roster does not ("Kyle W. McGee" vs "Kyle Mcgee", "Joaquin N. Onate" vs
-- "Joaquin Onate"). That is also exactly the comparison that breaks the first
-- time somebody is hired with one, which is why this runs ONCE and the id is
-- what everything reads from here on.
--
-- ⚠ ONLY WHERE THE MATCH IS UNAMBIGUOUS ON BOTH SIDES. A first+last pair
-- hitting two roster rows, or two QuickBooks employees, is left NULL and shows
-- as an unlinked person on the labour view — a visible gap somebody can fix,
-- rather than hours quietly costed against the wrong person's wage.
--
-- Live result: six of the nine people who filed time in the last 90 days match.
-- The other three (Christopher Fok, Joel Sanchez, Marc C Di Luca) are not on
-- the roster at all; that wants an operator's decision, not a guess. Christopher
-- Fok additionally carries NO cost rate in QuickBooks, so his hours land with
-- rate_source 'unknown' and a null labour cost rather than a plausible zero.

with qbo as (
  select distinct t.employee_qbo_id as qbo_id,
         lower(split_part(t.employee_name, ' ', 1)) as fst,
         lower(split_part(t.employee_name, ' ',
               array_length(string_to_array(t.employee_name, ' '), 1))) as lst
  from ops.qbo_time_activities t
  where t.employee_qbo_id is not null and coalesce(t.employee_name, '') <> ''
),
roster as (
  select tm.id,
         lower(split_part(tm.name, ' ', 1)) as fst,
         lower(split_part(tm.name, ' ',
               array_length(string_to_array(tm.name, ' '), 1))) as lst
  from ops.team_members tm
),
pairs as (
  select r.id, q.qbo_id from roster r join qbo q on q.fst = r.fst and q.lst = r.lst
),
unique_pairs as (
  select id, qbo_id from pairs
  where id     in (select id     from pairs group by id     having count(*) = 1)
    and qbo_id in (select qbo_id from pairs group by qbo_id having count(*) = 1)
)
update ops.team_members tm
   set qbo_employee_id = u.qbo_id
  from unique_pairs u
 where tm.id = u.id
   and tm.qbo_employee_id is distinct from u.qbo_id;

do $$
declare v_linked int;
begin
  select count(*) into v_linked from ops.team_members where qbo_employee_id is not null;
  raise notice '% roster rows linked to a QuickBooks employee', v_linked;
end $$;
