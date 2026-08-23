-- Amendment to the duplicate guard, driven by what the live data said.
--
-- Replaying the amount+window rule over every expense we hold produced three
-- clusters, and only one of them was a real duplicate:
--
--   ARTURO SANTIAGO  $375.00  2026-08-11  2 rows, 1 job  → REAL (QBO bills
--                                                          173048 + 173049,
--                                                          the pair already
--                                                          recorded on 08-14)
--   DESERT BEVERAGE  $133.90  2026-08-13  2 rows, 2 jobs → two distinct calls
--   ERIC SERRANO     $170.00  2026-07-27  2 rows, 2 jobs → two distinct calls
--
-- A flat-rate contractor bills the same number over and over, so "same vendor,
-- same amount, same week" is a weak signal on its own — but a DIFFERENT job
-- number is a strong negative, and both of the false positives carried one.
-- Adding the discriminator turns 1-of-3 useful into 3-of-3, which is the
-- difference between a flag people read and a flag people learn to dismiss.
--
-- Only applied when BOTH rows have a job number. A missing job number proves
-- nothing and must not be read as agreement.
create or replace function ops.fn_bill_duplicate_candidates(
  p_vendor      text,
  p_bill_number text,
  p_amount      numeric,
  p_date        date,
  p_exclude     uuid default null,
  p_job_number  text default null
)
returns table(
  id uuid, match_kind text, vendor_name text, bill_number text,
  total_amount numeric, receipt_date date, status text,
  qbo_bill_id text, qbo_purchase_id text, tag text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'ops','public'
as $$
begin
  perform ops.fn_assert_staff_or_service();
  return query
  with me as (
    select ops.fn_norm_vendor(p_vendor)           as v,
           ops.fn_norm_bill_number(p_bill_number) as b,
           p_amount                               as amt,
           coalesce(p_date, current_date)         as dt,
           nullif(btrim(coalesce(p_job_number,'')), '') as job
  )
  select r.id,
         case when me.b is not null
                   and ops.fn_norm_bill_number(r.bill_number) = me.b then 'exact'
              else 'likely' end as match_kind,
         r.vendor_name, r.bill_number, r.total_amount, r.receipt_date, r.status,
         r.qbo_bill_id, r.qbo_purchase_id, r.tag, r.created_at
    from ops.expense_requests r, me
   where r.archived_at is null
     and (p_exclude is null or r.id <> p_exclude)
     and me.v is not null
     and ops.fn_norm_vendor(r.vendor_name) = me.v
     and (
          -- Same vendor, same invoice number. Same invoice.
          (me.b is not null and ops.fn_norm_bill_number(r.bill_number) = me.b)
          -- Same vendor, same amount, same fortnight, nothing to tell them
          -- apart — unless the job numbers say they ARE different work.
       or (me.b is null
           and me.amt is not null and me.amt > 0
           and r.total_amount = me.amt
           and r.receipt_date between me.dt - 10 and me.dt + 10
           and not (me.job is not null
                    and nullif(btrim(coalesce(r.job_number,'')), '') is not null
                    and btrim(r.job_number) <> me.job))
     )
   order by (case when me.b is not null
                       and ops.fn_norm_bill_number(r.bill_number) = me.b then 0 else 1 end),
            r.created_at desc
   limit 20;
end;
$$;

-- The 5-arg signature is gone (replaced by the 6-arg one with a defaulted
-- p_job_number, so existing 5-arg calls still resolve). Drop the stale one so
-- the two cannot both exist and make the call ambiguous.
drop function if exists ops.fn_bill_duplicate_candidates(text,text,numeric,date,uuid);

revoke execute on function ops.fn_bill_duplicate_candidates(text,text,numeric,date,uuid,text) from public, anon;
grant execute on function ops.fn_bill_duplicate_candidates(text,text,numeric,date,uuid,text) to authenticated, service_role;
