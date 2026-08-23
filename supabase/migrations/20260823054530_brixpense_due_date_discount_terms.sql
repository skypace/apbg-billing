-- ops.fn_due_date_from_terms read the FIRST number in the terms string, which
-- is wrong for every discount term: "2/10 Net 30" means 2% off if paid within
-- 10 days, otherwise net 30 — and taking the 2 made the bill due two days
-- after the invoice date, i.e. instantly and permanently overdue.
--
-- Found by testing the JS twin (netlify/functions/lib/due-date.mjs) against a
-- table of the terms that actually appear on invoices. Both sides now prefer
-- the number that FOLLOWS "net", falling back to the first number only when
-- there is no "net" at all ("15", "30 days").
create or replace function ops.fn_due_date_from_terms(p_date date, p_terms text)
returns date
language plpgsql
immutable
as $$
declare
  t text := lower(btrim(coalesce(p_terms, '')));
  n int;
begin
  if p_date is null or t = '' then return null; end if;

  -- Due on receipt / COD / prepaid: the invoice date IS the due date.
  if t ~ '(due on receipt|due upon receipt|receipt|^cod$|cash on delivery|prepaid|^due now)' then
    return p_date;
  end if;

  -- The term is the number after "net" when there is one; otherwise the only
  -- number present. This is what separates "2/10 Net 30" (due in 30) from a
  -- bare "15" (due in 15).
  n := coalesce(
    (regexp_match(t, 'net\s*(\d{1,3})'))[1]::int,
    (regexp_match(t, '(\d{1,3})'))[1]::int
  );

  -- End-of-month terms: "Net 30 EOM" is 30 days past the end of the invoice
  -- month. Bare "EOM" (n null → 0) is the end of the invoice month itself.
  if t ~ '(eom|end of month|prox)' then
    return (date_trunc('month', p_date)::date + interval '1 month'
            + make_interval(days => coalesce(n, 0)) - interval '1 day')::date;
  end if;

  if n is null then return null; end if;
  if n > 365 then return null; end if;   -- that is not a term, that is a typo
  return p_date + n;
exception when others then
  return null;
end;
$$;

-- Re-run the backfill: any row the buggy version already stamped with a
-- discount-derived date gets corrected, and rows it declined get a second
-- chance. Scoped the same way as the original — unposted, unpaid, and only
-- where the derivation actually differs from what is stored.
update ops.expense_requests r
   set due_date = ops.fn_due_date_from_terms(r.receipt_date, r.payment_terms),
       due_date_source = 'terms'
 where r.payment_terms is not null
   and r.receipt_date is not null
   and r.paid_at is null
   and r.qbo_bill_id is null
   and coalesce(r.due_date_source, 'terms') = 'terms'
   and ops.fn_due_date_from_terms(r.receipt_date, r.payment_terms) is not null
   and ops.fn_due_date_from_terms(r.receipt_date, r.payment_terms) is distinct from r.due_date;
