-- 20260909h — Picking up more tanks than the books say they hold.
--
-- Ask (Sky, 2026-09-09): "were picking up more than what their balance is
-- showing? if this happens you need to kick out an email that kicks off an
-- audit. says we have an issue here."
--
-- Yes, on 22 accounts, and the arithmetic says so plainly. Measured before
-- writing this, across all 343 QuickBooks customers with cylinder activity:
--
--     475 customer/gas rows        1,671 cylinders out
--      75 rows are NEGATIVE          248 units, at 67 customers
--
-- ⚠ THE 248 IS TWO COMPLETELY DIFFERENT PROBLEMS AND THEY MUST NOT BE
--   REPORTED AS ONE NUMBER. Which one it is decides who does what:
--
--     A. 52 rows / 48 customers / 126 units — NO BTRF ANCHOR AT ALL.
--        Never rent-billed for that gas, so the derivation has no printed
--        floor to count from: it starts at a synthetic zero and the first
--        pickup drives it negative. Nothing is missing from the yard. The
--        question is commercial — should this account be on the rental
--        programme for that gas — and a driver sent to count tanks would
--        find nothing wrong.
--
--     B. 23 rows / 22 customers / 122 units — WENT BELOW A PRINTED BALANCE.
--        This is the real one. We invoiced pickups for tanks the books had
--        already written off.
--
-- ⚠ AND FLEET-WIDE IT BALANCES, which is what rules out a systemic fault:
--   2,599 delivered against 2,670 picked up since the anchors, 2.7% apart.
--   This is concentrated in a handful of accounts, not a leak everywhere.
--
-- The mechanism, from the worst case. SCOMAS RESTAURANT was rent-billed for
-- TWO 20LB CO2 cylinders a month — $15 — every month through 2025 and into
-- 2026. On 2026-04-21 invoice 9989018592 recovered TWENTY-SIX of them, on two
-- separate PUCO8011 lines (16 and 10) in one visit, against one delivered.
-- You cannot pick up 26 tanks from a customer who has 2. So either those
-- tanks sat at Scoma's for years while we billed for two — under-billing the
-- rent by ~$180/month at one account — or a pickup was keyed twice. The
-- books cannot tell those apart. Only a physical count can, which is why the
-- output of this function is an AUDIT, not a correction.
--
-- ⚠ THE RENT ENGINE HIDES IT, and that is why nobody saw this. It runs the
--   same arithmetic, floors at zero, and DROPS THE LINE: Scoma's March rental
--   invoice carries a 20LB CO2 line reading "= New Balance: 1", and the
--   September one has no CO2 line at all. The billing goes quiet at exactly
--   the moment the balance is most wrong, so the signal has to come from
--   somewhere that is willing to print a negative.
--
-- ⚠ CLASSIFICATION AND THE ARITHMETIC ARE NOT RE-IMPLEMENTED. This calls the
--   same `orders.cylinder_label_from_item` / `_from_btrf` and reproduces
--   `ops.fn_customer_cylinders__i`'s anchor+deliveries-pickups rule exactly.
--   A detector that computed the balance its own way would eventually
--   disagree with the page an operator is looking at, and then nobody would
--   trust either. The regression test in brix-order pins the two together.

-- ⚠ Dropped rather than CREATE OR REPLACE: the RETURNS TABLE changed when the
--   first-breach columns were added, and Postgres will not replace a function
--   whose output columns move. Wrapper first — it depends on the inner.
drop function if exists ops.fn_cylinder_anomalies();
drop function if exists ops.fn_cylinder_anomalies__i();

-- ---------------------------------------------------------------------------
-- The sweep. No gate — the wrapper below carries it.
-- ---------------------------------------------------------------------------
create or replace function ops.fn_cylinder_anomalies__i()
returns table (
  qbo_customer_id      text,
  customer_name        text,
  label                text,
  on_hand              integer,
  cause                text,
  balance_at_btrf      integer,
  btrf_doc_number      text,
  btrf_date            date,
  deliveries_since     integer,
  pickups_since        integer,
  first_doc_number     text,
  first_date           date,
  first_picked_up      integer,
  first_balance_before integer,
  worst_doc_number     text,
  worst_date           date,
  worst_picked_up      integer,
  worst_balance_before integer,
  breach_count         integer,
  last_activity        date,
  unit_price           numeric,
  unbilled_rent        numeric
)
language sql
stable
security definer
set search_path to 'ops', 'orders', 'public', 'pg_temp'
as $fn$
  with anchors as materialized (
    -- The most recent BTRF-* rental line per (customer, gas), and the balance
    -- it printed. Identical rule to fn_customer_cylinders__i.
    select qid, label, doc_number, txn_date, bal, price
    from (
      select
        i.customer_ref_id as qid,
        orders.cylinder_label_from_btrf(l.description, l.item_name) as label,
        i.doc_number,
        i.txn_date,
        (regexp_match(l.description, 'New Balance:\s*(-?\d+)'))[1]::int as bal,
        l.unit_price::numeric as price,
        row_number() over (
          partition by i.customer_ref_id,
                       orders.cylinder_label_from_btrf(l.description, l.item_name)
          order by i.txn_date desc, l.line_num
        ) as rn
      from ops.qbo_invoices i
      join ops.qbo_invoice_lines l on l.invoice_id = i.id
      where i.doc_number ilike 'BTRF-%'
        and orders.cylinder_label_from_btrf(l.description, l.item_name) is not null
    ) ranked
    where rn = 1
  ),
  -- One row per (customer, gas, INVOICE). Aggregating per invoice is
  -- load-bearing: Scoma's 26-tank recovery is TWO PUCO8011 lines on one
  -- document, and per-line it would read as two smaller events.
  moves as materialized (
    select
      i.customer_ref_id as qid,
      orders.cylinder_label_from_item(l.item_name) as label,
      i.id  as inv_id,
      i.doc_number,
      i.txn_date,
      sum(case when l.item_name ~* '^PU' then 0 else coalesce(l.quantity, 0) end)::int as delivered,
      sum(case when l.item_name ~* '^PU' then coalesce(l.quantity, 0) else 0 end)::int as picked_up
    from ops.qbo_invoices i
    join ops.qbo_invoice_lines l on l.invoice_id = i.id
    where i.doc_number not ilike 'BTRF-%'
      and orders.cylinder_label_from_item(l.item_name) is not null
    group by 1, 2, 3, 4, 5
  ),
  -- Walk the ledger forward from the anchor so the BREACH can be named, not
  -- just the end state. "You are at -37" is not actionable; "invoice 9989018592
  -- on 21 Apr took 26 when the books showed 3" is.
  seq as (
    select
      m.qid, m.label, m.doc_number, m.txn_date, m.picked_up,
      coalesce(a.bal, 0)
        + coalesce(sum(m.delivered - m.picked_up) over w_prior, 0) as bal_before,
      coalesce(a.bal, 0)
        + sum(m.delivered - m.picked_up) over w_incl as bal_after
    from moves m
    left join anchors a on a.qid = m.qid and a.label = m.label
    where a.txn_date is null or m.txn_date > a.txn_date
    window
      w_incl  as (partition by m.qid, m.label order by m.txn_date, m.inv_id
                  rows between unbounded preceding and current row),
      w_prior as (partition by m.qid, m.label order by m.txn_date, m.inv_id
                  rows between unbounded preceding and 1 preceding)
  ),
  -- ⚠ "WORST" CANNOT MEAN THE LOWEST BALANCE. Once an account is under water
  --   every later pickup drives it lower, so the deepest trough is simply the
  --   most recent movement and says nothing about the cause. The first cut of
  --   this named a 6-tank pickup at Scoma's in July over the 26-tank recovery
  --   in April that actually broke it.
  --
  --   Two facts are worth naming and they are different questions:
  --     first_breach  — the invoice that took the count from level to negative
  --                     ("when did this start")
  --     worst_overdraw— the invoice that took the most beyond what the books
  --                     held ("what is the biggest single discrepancy")
  --   For Scoma's those are the same document, which is what makes it obvious.
  breaches as (
    select
      qid, label,
      count(*) filter (where bal_after < 0)::int as breach_count,
      (array_agg(doc_number order by txn_date, doc_number)
         filter (where bal_after < 0 and bal_before >= 0))[1]  as first_doc_number,
      (array_agg(txn_date   order by txn_date, doc_number)
         filter (where bal_after < 0 and bal_before >= 0))[1]  as first_date,
      (array_agg(picked_up  order by txn_date, doc_number)
         filter (where bal_after < 0 and bal_before >= 0))[1]  as first_picked_up,
      (array_agg(bal_before order by txn_date, doc_number)
         filter (where bal_after < 0 and bal_before >= 0))[1]  as first_balance_before,
      (array_agg(doc_number order by (picked_up - greatest(bal_before, 0)) desc, txn_date))[1] as worst_doc_number,
      (array_agg(txn_date   order by (picked_up - greatest(bal_before, 0)) desc, txn_date))[1] as worst_date,
      (array_agg(picked_up  order by (picked_up - greatest(bal_before, 0)) desc, txn_date))[1] as worst_picked_up,
      (array_agg(bal_before order by (picked_up - greatest(bal_before, 0)) desc, txn_date))[1] as worst_balance_before
    from seq
    where picked_up > 0
    group by qid, label
    having count(*) filter (where bal_after < 0) > 0
  ),
  totals as (
    select
      coalesce(a.qid, m.qid)     as qid,
      coalesce(a.label, m.label) as label,
      coalesce(a.bal, 0)         as balance_at_btrf,
      a.doc_number, a.txn_date as btrf_date, a.price,
      coalesce(sum(m.delivered)  filter (where a.txn_date is null or m.txn_date > a.txn_date), 0)::int as deliveries_since,
      coalesce(sum(m.picked_up)  filter (where a.txn_date is null or m.txn_date > a.txn_date), 0)::int as pickups_since,
      max(m.txn_date) as last_activity
    from anchors a
    full outer join moves m on m.qid = a.qid and m.label = a.label
    group by 1, 2, 3, 4, 5, 6
  )
  select
    t.qid,
    c.display_name,
    t.label,
    (t.balance_at_btrf + t.deliveries_since - t.pickups_since)::int as on_hand,
    case when t.doc_number is null
         then 'no_anchor'                 -- A: never rent-billed for this gas
         else 'below_printed_balance'     -- B: went under a real printed count
    end as cause,
    t.balance_at_btrf,
    t.doc_number,
    t.btrf_date,
    t.deliveries_since,
    t.pickups_since,
    b.first_doc_number,
    b.first_date,
    b.first_picked_up,
    b.first_balance_before,
    b.worst_doc_number,
    b.worst_date,
    b.worst_picked_up,
    b.worst_balance_before,
    coalesce(b.breach_count, 0),
    t.last_activity,
    coalesce(qi.unit_price::numeric, t.price, 0) as unit_price,
    -- What the monthly rent WOULD be if the shortfall is real tanks standing
    -- at the site. Deliberately not called a loss: it is only owed if the
    -- count confirms the tanks are there, which is the whole point of the audit.
    round(abs(least(t.balance_at_btrf + t.deliveries_since - t.pickups_since, 0))
          * coalesce(qi.unit_price::numeric, t.price, 0), 2) as unbilled_rent
  from totals t
  join ops.qbo_customers c on c.qbo_customer_id = t.qid
  left join breaches b on b.qid = t.qid and b.label = t.label
  left join ops.qbo_items qi
    on qi.active = true
   and qi.name = case t.label
         when '20LB CO2' then '1000TRF-C'
         when '10LB CO2' then '1000TRF-S'
         when '5LB CO2'  then '1000TRF-S'
         when '50LB CO2' then '1000TRF-C 50LB'
         when 'Mix gas'  then '1000TRF-B'
         when 'Nitrogen' then '1000TRF-N'
       end
  where (t.balance_at_btrf + t.deliveries_since - t.pickups_since) < 0
  order by (t.balance_at_btrf + t.deliveries_since - t.pickups_since) asc, c.display_name;
$fn$;

revoke all on function ops.fn_cylinder_anomalies__i() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The staff door.
-- ---------------------------------------------------------------------------
create or replace function ops.fn_cylinder_anomalies()
returns table (
  qbo_customer_id      text,
  customer_name        text,
  label                text,
  on_hand              integer,
  cause                text,
  balance_at_btrf      integer,
  btrf_doc_number      text,
  btrf_date            date,
  deliveries_since     integer,
  pickups_since        integer,
  first_doc_number     text,
  first_date           date,
  first_picked_up      integer,
  first_balance_before integer,
  worst_doc_number     text,
  worst_date           date,
  worst_picked_up      integer,
  worst_balance_before integer,
  breach_count         integer,
  last_activity        date,
  unit_price           numeric,
  unbilled_rent        numeric
)
language plpgsql
stable
security definer
set search_path to 'ops', 'orders', 'public', 'pg_temp'
as $fn$
begin
  if not ops.fn_is_staff() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query select * from ops.fn_cylinder_anomalies__i();
end;
$fn$;

revoke all on function ops.fn_cylinder_anomalies() from public, anon;
grant execute on function ops.fn_cylinder_anomalies() to authenticated, service_role;
