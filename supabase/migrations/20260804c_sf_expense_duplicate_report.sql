-- 20260804c — ops.fn_sf_expense_duplicates() (applied live 2026-08-04).
--
-- The SF→Brixpense sync was broken from 2026-06 to 2026-08-04 (SF's epoch date
-- gate — see 20260804a). While it was down, vendor bills that should have flowed
-- SF -> Brixpense -> QBO were entered into QuickBooks BY HAND. Now that the
-- backfill is running those same expenses land as Brixpense drafts, and the
-- daily sf-expense-autopost would book each one as a SECOND QBO bill.
--
-- This finds them BEFORE autopost runs. For every unposted SF draft it looks for
-- an existing QBO Bill/Purchase/VendorCredit with the same amount near the same
-- date, per line AND per transaction total (a hand-entered bill is often one txn
-- whose total matches while no single line does).
--
-- Read-only. It decides nothing — a human archives the confirmed duplicates.
--
-- Matching is deliberately fuzzy on vendor (SF free-texts `purchased_from`, so
-- "Pro Mechanical Services" has to match QBO's "PRO MECHANICAL SERVICE") and
-- deliberately strict on amount, because amount is the one field both sides
-- agree on to the cent. Two tiers:
--   exact  — amount matches AND vendor tokens overlap, within the date window
--   amount — amount matches only; vendor did NOT. A prompt to look, not a verdict.
-- Expect false positives in the 'amount' tier: round numbers recur across
-- vendors. That is the intended bias — a missed duplicate costs a double payment,
-- a false positive costs ten seconds of reading.
create or replace function ops.fn_sf_expense_duplicates(p_days int default 45)
returns table (
  draft_id        uuid,
  receipt_date    date,
  vendor_name     text,
  amount          numeric,
  job_number      text,
  customer_name   text,
  confidence      text,
  qbo_txn_type    text,
  qbo_txn_id      text,
  qbo_vendor      text,
  qbo_txn_date    date,
  qbo_amount      numeric,
  qbo_description text,
  day_gap         int
)
language sql
stable
security definer
set search_path to 'ops','public'
as $$
  with drafts as (
    select r.id, r.receipt_date, r.vendor_name, r.total_amount, r.job_number, r.customer_name,
           (select array_agg(t) from unnest(
              string_to_array(
                regexp_replace(lower(coalesce(r.vendor_name,'')), '[^a-z0-9 ]+', ' ', 'g'),
              ' ')) t
            where length(t) >= 3 and t not in ('llc','inc','the','and','corp','company')
           ) as toks
      from ops.expense_requests r
     where r.tag = 'Service Fusion'
       and r.request_type = 'expense'
       and r.status = 'draft'
       and r.qbo_bill_id is null
       and r.archived_at is null
       and r.total_amount is not null
       and r.total_amount <> 0
  ),
  qbo as (
    select l.qbo_txn_type, l.qbo_txn_id, l.vendor_name, l.txn_date, l.amount, l.description,
           (select array_agg(t) from unnest(
              string_to_array(
                regexp_replace(lower(coalesce(l.vendor_name,'')), '[^a-z0-9 ]+', ' ', 'g'),
              ' ')) t
            where length(t) >= 3 and t not in ('llc','inc','the','and','corp','company')
           ) as toks
      from ops.qbo_expense_lines l
     where l.amount is not null and l.amount <> 0
  ),
  qbo_txn as (
    select q.qbo_txn_type, q.qbo_txn_id, min(q.vendor_name) as vendor_name,
           min(q.txn_date) as txn_date, sum(q.amount) as amount,
           'txn total (' || count(*) || ' lines)' as description,
           min(q.toks::text)::text as tok_text
      from qbo q group by q.qbo_txn_type, q.qbo_txn_id
  ),
  candidates as (
    select d.id, d.receipt_date, d.vendor_name, d.total_amount, d.job_number, d.customer_name,
           q.qbo_txn_type, q.qbo_txn_id, q.vendor_name as qbo_vendor, q.txn_date, q.amount,
           q.description, abs(d.receipt_date - q.txn_date) as gap,
           (d.toks && q.toks) as vendor_hit
      from drafts d
      join qbo q
        on round(q.amount, 2) = round(d.total_amount, 2)
       and q.txn_date between d.receipt_date - p_days and d.receipt_date + p_days
    union all
    select d.id, d.receipt_date, d.vendor_name, d.total_amount, d.job_number, d.customer_name,
           t.qbo_txn_type, t.qbo_txn_id, t.vendor_name, t.txn_date, t.amount,
           t.description, abs(d.receipt_date - t.txn_date) as gap,
           (d.toks && string_to_array(translate(coalesce(t.tok_text,''),'{}"',''), ',')) as vendor_hit
      from drafts d
      join qbo_txn t
        on round(t.amount, 2) = round(d.total_amount, 2)
       and t.txn_date between d.receipt_date - p_days and d.receipt_date + p_days
  )
  select distinct on (c.id, c.qbo_txn_type, c.qbo_txn_id)
         c.id, c.receipt_date, c.vendor_name, c.total_amount, c.job_number, c.customer_name,
         case when c.vendor_hit then 'exact' else 'amount' end as confidence,
         c.qbo_txn_type, c.qbo_txn_id, c.qbo_vendor, c.txn_date, c.amount, c.description,
         c.gap::int
    from candidates c
   order by c.id, c.qbo_txn_type, c.qbo_txn_id, c.vendor_hit desc, c.gap;
$$;

comment on function ops.fn_sf_expense_duplicates(int) is
  'Pending SF expense drafts that already look like a QBO Bill/Purchase. Run BEFORE '
  'the daily sf-expense-autopost so a hand-entered bill is not booked twice. '
  'confidence=exact means vendor AND amount matched; amount means amount only — look, do not assume.';

grant execute on function ops.fn_sf_expense_duplicates(int) to service_role;
