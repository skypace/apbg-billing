-- 20260826f_spend_report.sql
-- Spend reporting: what are we spending, where, and what's growing.
--
-- Source is the QBO expense mirror (ops.qbo_expense_lines) — the COMPLETE
-- spend picture including bills keyed straight into QuickBooks, not just what
-- flowed through Brixpense. Same source and same VendorCredit sign convention
-- as ops.fn_1099_candidates (a credit reduces what we paid).
--
-- Two read-only RPCs, called from the Brixpense Spending page with the
-- caller's own JWT. Both carry the staff guard INLINE (`fn_assert_staff_or_
-- service`) — the 20260820b rule: a NEW SECURITY DEFINER function is guarded
-- in its own body, never left to the generator, and spend by vendor is
-- exactly the data the shared-project hardening exists to protect.
--
-- Caveat stated where it will be read: the mirror is ACCRUAL-dated (txn_date)
-- and refreshed daily by sync-qbo, so "this month" moves as bills get keyed,
-- and a mis-dated bill (there is a 2028 Purchase in the mirror today) lands
-- in whatever month it claims. This is a trends report, not a P&L — the P&L
-- is QuickBooks' to print.

-- ── the report: monthly series + by-vendor + by-GL-account, one round trip ───
create or replace function ops.fn_spend_report(p_months int default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'ops','public'
as $$
declare
  v_months     int  := least(greatest(coalesce(p_months, 12), 3), 36);
  v_this_month date := date_trunc('month', current_date)::date;
  v_start      date;
  v_end        date := (date_trunc('month', current_date) + interval '1 month')::date;
  v_prev_start date;
  v_out        jsonb;
begin
  perform ops.fn_assert_staff_or_service();

  v_start      := (v_this_month - make_interval(months => v_months - 1))::date;
  v_prev_start := (v_start - make_interval(months => v_months))::date;

  with lines as (
    select date_trunc('month', l.txn_date)::date as m,
           coalesce(nullif(btrim(l.vendor_name), ''), '(no vendor)')   as vendor,
           -- Item-based lines carry item_name, not account_name — without the
           -- fallback, $5M+ of item-based spend lumps into one '(no account)'.
           coalesce(nullif(btrim(l.account_name), ''), nullif(btrim(l.item_name), ''), '(uncategorized)') as account,
           case when l.qbo_txn_type = 'VendorCredit' then -l.amount else l.amount end as amt
      from ops.qbo_expense_lines l
     where l.txn_date >= v_start and l.txn_date < v_end
  ),
  prev_vendor as (
    select coalesce(nullif(btrim(l.vendor_name), ''), '(no vendor)') as vendor,
           sum(case when l.qbo_txn_type = 'VendorCredit' then -l.amount else l.amount end) as total
      from ops.qbo_expense_lines l
     where l.txn_date >= v_prev_start and l.txn_date < v_start
     group by 1
  ),
  prev_account as (
    select coalesce(nullif(btrim(l.account_name), ''), nullif(btrim(l.item_name), ''), '(uncategorized)') as account,
           sum(case when l.qbo_txn_type = 'VendorCredit' then -l.amount else l.amount end) as total
      from ops.qbo_expense_lines l
     where l.txn_date >= v_prev_start and l.txn_date < v_start
     group by 1
  ),
  cal as (
    select (v_start + make_interval(months => g))::date as m
      from generate_series(0, v_months - 1) g
  ),
  monthly as (
    select c.m, coalesce(sum(l.amt), 0)::numeric(14,2) as total
      from cal c left join lines l on l.m = c.m
     group by c.m
  ),
  vend_month as (
    select vendor, m, sum(amt)::numeric(14,2) as mt, count(*) as n
      from lines group by vendor, m
  ),
  vend as (
    select vendor,
           sum(mt)::numeric(14,2)  as total,
           sum(n)                  as txn_count,
           jsonb_object_agg(to_char(m, 'YYYY-MM'), mt) as by_month
      from vend_month group by vendor
  ),
  acct_month as (
    select account, m, sum(amt)::numeric(14,2) as mt, count(*) as n
      from lines group by account, m
  ),
  acct as (
    select account,
           sum(mt)::numeric(14,2)  as total,
           sum(n)                  as txn_count,
           jsonb_object_agg(to_char(m, 'YYYY-MM'), mt) as by_month
      from acct_month group by account
  )
  select jsonb_build_object(
    'months', (select jsonb_agg(to_char(c.m, 'YYYY-MM') order by c.m) from cal c),
    'monthly', (select jsonb_agg(jsonb_build_object(
                  'month', to_char(mo.m, 'YYYY-MM'), 'total', mo.total) order by mo.m)
                from monthly mo),
    'by_vendor', (select coalesce(jsonb_agg(jsonb_build_object(
                    'name', v.vendor,
                    'total', v.total,
                    'txn_count', v.txn_count,
                    'prev_total', coalesce(pv.total, 0)::numeric(14,2),
                    'by_month', v.by_month) order by v.total desc), '[]'::jsonb)
                  from vend v left join prev_vendor pv on pv.vendor = v.vendor),
    'by_account', (select coalesce(jsonb_agg(jsonb_build_object(
                    'name', a.account,
                    'total', a.total,
                    'txn_count', a.txn_count,
                    'prev_total', coalesce(pa.total, 0)::numeric(14,2),
                    'by_month', a.by_month) order by a.total desc), '[]'::jsonb)
                  from acct a left join prev_account pa on pa.account = a.account),
    'totals', jsonb_build_object(
      'window_total', (select coalesce(sum(mo.total), 0)::numeric(14,2) from monthly mo),
      'prev_window_total', (select coalesce(sum(pv.total), 0)::numeric(14,2) from prev_vendor pv),
      'this_month', (select mo.total from monthly mo where mo.m = v_this_month),
      'last_month', (select mo.total from monthly mo where mo.m = (v_this_month - interval '1 month')::date)
    ),
    'window', jsonb_build_object('start', v_start, 'months', v_months)
  ) into v_out;

  return v_out;
end $$;

revoke execute on function ops.fn_spend_report(int) from public, anon;
grant execute on function ops.fn_spend_report(int) to authenticated, service_role;

-- ── the drill: one vendor's recent mirror lines ("why did this triple?") ──────
create or replace function ops.fn_spend_vendor_detail(p_vendor text, p_months int default 12)
returns table(
  txn_date date,
  qbo_txn_type text,
  qbo_txn_id text,
  account_name text,
  description text,
  amount numeric
)
language plpgsql
stable
security definer
set search_path to 'ops','public'
as $$
declare
  v_months int  := least(greatest(coalesce(p_months, 12), 3), 36);
  v_start  date := (date_trunc('month', current_date) - make_interval(months => v_months - 1))::date;
begin
  perform ops.fn_assert_staff_or_service();

  return query
  select l.txn_date, l.qbo_txn_type, l.qbo_txn_id,
         coalesce(nullif(btrim(l.account_name), ''), nullif(btrim(l.item_name), '')) as account_name,
         l.description,
         (case when l.qbo_txn_type = 'VendorCredit' then -l.amount else l.amount end)::numeric(14,2)
    from ops.qbo_expense_lines l
   where coalesce(nullif(btrim(l.vendor_name), ''), '(no vendor)') = p_vendor
     and l.txn_date >= v_start
   order by l.txn_date desc, l.id desc
   limit 100;
end $$;

revoke execute on function ops.fn_spend_vendor_detail(text, int) from public, anon;
grant execute on function ops.fn_spend_vendor_detail(text, int) to authenticated, service_role;
