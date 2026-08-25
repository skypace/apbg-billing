-- ============================================================================
-- Brixpense AP hardening: a watcher for the inbox, a duplicate guard, due
-- dates + aging, and 1099 tracking.
--
-- Four independent sections; each is idempotent and none depends on another.
--
-- ⚠ Section 1 modifies ops.fn_sync_health_extra. It does NOT paste a body:
--   it reads the LIVE definition at apply time and inserts one line, so a
--   check another session added in the meantime cannot be silently deleted
--   the way one was on 2026-08-21. If the anchor it looks for has moved, it
--   raises rather than guessing.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. AP INBOX WATCHER
--
-- The AP inbox is EVENT-driven (a Resend webhook), not a cron, so "no run in N
-- hours" means nothing here — a quiet day is a quiet day, and colouring on it
-- would flap exactly the way the sf_token check did before 2026-08-06. What is
-- genuinely broken is an email we ACCEPTED and then failed to finish: the
-- webhook recorded the row, the background function never completed it, and a
-- real vendor invoice sits in a table nobody opens.
--
-- Yellow counts only UNRESOLVED held mail — a row a human dismissed goes to
-- 'ignored' and stops counting, so the light is clearable rather than a
-- permanent amber that everyone learns to ignore.
-- ---------------------------------------------------------------------------
create or replace function ops.fn_ap_inbox_health()
returns table(check_name text, status text, last_event_at timestamptz,
              age_seconds int, detail text)
language plpgsql
security definer
set search_path to 'ops','public'
as $$
declare
  v_last_mail    timestamptz;
  v_stuck        int;
  v_stuck_oldest timestamptz;
  v_held         int;
  v_drafted_24h  int;
  v_run_at       timestamptz;
  v_run_status   text;
  v_run_err      text;
  v_total        int;
begin
  select count(*), max(b.received_at) into v_total, v_last_mail
    from ops.bill_email_intake b;

  -- Accepted but never finished. 30 minutes is generous for a background
  -- function that normally lands in seconds; past it, the hand-off died.
  select count(*), min(b.received_at) into v_stuck, v_stuck_oldest
    from ops.bill_email_intake b
   where b.status in ('received','processing')
     and b.received_at < now() - interval '30 minutes';

  select count(*) into v_held
    from ops.bill_email_intake b
   where b.status in ('no_attachment','attachment_fetch_failed','ocr_failed','failed')
     and b.expense_request_id is null
     and b.received_at > now() - interval '30 days';

  select count(*) into v_drafted_24h
    from ops.bill_email_intake b
   where b.status = 'drafted'
     and b.received_at > now() - interval '24 hours';

  select s.completed_at, s.status, s.error_message
    into v_run_at, v_run_status, v_run_err
    from ops.sync_log s
   where s.source = 'brixpense' and s.sync_type = 'ap_inbox'
   order by s.completed_at desc nulls last
   limit 1;

  check_name    := 'ap_inbox';
  last_event_at := greatest(v_last_mail, v_run_at);
  age_seconds   := extract(epoch from (now() - last_event_at))::int;

  if v_total = 0 then
    -- Nothing has ever arrived. That is either "nobody has emailed a bill yet"
    -- or "the Resend webhook was never pointed here", and Postgres cannot tell
    -- those apart — so it is stated, not coloured. Only a real email proves it.
    status := 'green';
    detail := 'no bills emailed to the AP inbox yet — if mail WAS sent, check the Resend webhook + RESEND_AP_INBOX_SECRET (Brixpense → Vendor Inbox → Check the intake)';
  elsif v_stuck > 0 then
    status := 'red';
    detail := v_stuck || ' emailed bill(s) accepted but never processed (oldest '
      || greatest(0, extract(epoch from (now()-v_stuck_oldest))::int/60)
      || 'm ago) — the background processor is not finishing them. Retry from the Vendor Inbox.';
  elsif v_run_status = 'error' and v_run_at > now() - interval '24 hours' then
    status := 'red';
    detail := 'AP inbox processor errored: ' || coalesce(left(v_run_err,140),'');
  elsif v_held > 0 then
    status := 'yellow';
    detail := v_held || ' emailed bill(s) could not be read (no attachment / fetch or OCR failed) and are still waiting in the Vendor Inbox — fix or dismiss them there';
  else
    status := 'green';
    detail := v_drafted_24h || ' bill(s) drafted in the last 24h; last email '
      || case when v_last_mail is null then 'never'
              else greatest(0, extract(epoch from (now()-v_last_mail))::int/3600) || 'h ago' end;
  end if;
  return next;
end;
$$;

revoke execute on function ops.fn_ap_inbox_health() from public, anon;
grant execute on function ops.fn_ap_inbox_health() to authenticated, service_role;

-- Wire it into ops.fn_sync_health_extra() — which ops.sync_health() calls, and
-- which the 15-min health-alert cron emails on red/yellow.
--
-- Read-modify-write against the LIVE definition rather than pasting a body.
-- Three sessions have now added checks to this function and one of them lost
-- somebody's monitor by rebuilding it from an older copy; a migration that
-- reads what is actually deployed and inserts one line cannot do that, and
-- raises loudly instead of guessing if the shape has moved.
do $do$
declare
  v_src text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';

  if v_src is null then
    raise exception 'ops.fn_sync_health_extra() not found — refusing to invent one';
  end if;

  if position('fn_ap_inbox_health' in v_src) > 0 then
    raise notice 'ap_inbox check already wired into fn_sync_health_extra — leaving it alone';
    return;
  end if;

  v_new := replace(
    v_src,
    'return query select * from ops.fn_mirror_freshness();',
    'return query select * from ops.fn_mirror_freshness();'
      || E'\n\n  -- AP bill inbox: emailed vendor invoices (bills@).'
      || E'\n  return query select * from ops.fn_ap_inbox_health();'
  );

  if v_new = v_src then
    raise exception 'could not find the fn_mirror_freshness anchor in fn_sync_health_extra — add the ap_inbox check by hand rather than guessing';
  end if;

  execute v_new;
end
$do$;


-- ---------------------------------------------------------------------------
-- 2. DUPLICATE-BILL GUARD
--
-- Until now the only dedup anywhere in this pipeline was on the Resend email
-- id, which catches a webhook replay and nothing else. The duplicate that
-- actually costs money is the same invoice arriving twice by different roads:
-- the vendor emails it AND someone photographs it, or a vendor re-sends
-- "just in case", or a Service Fusion expense and an emailed bill describe one
-- purchase. Every one of those has a different email id.
--
-- Deliberately NOT a unique constraint. A hard constraint on (vendor,
-- bill_number) would reject the legitimate cases too — a corrected re-issue, a
-- vendor who restarts numbering each year, an OCR misread that a human is
-- about to fix — and a pipeline that throws on insert loses the document. The
-- rule here is the same one the rest of this app uses: hold it, say why, and
-- let a human decide. A visible pile beats a silent rejection.
-- ---------------------------------------------------------------------------
alter table ops.expense_requests
  add column if not exists duplicate_of uuid references ops.expense_requests(id) on delete set null,
  add column if not exists duplicate_reason text,
  add column if not exists duplicate_checked_at timestamptz,
  add column if not exists duplicate_cleared_by text;

comment on column ops.expense_requests.duplicate_of is
  'Set when this row looks like a re-entry of another expense. Advisory only — never blocks a save; posting to QuickBooks asks for confirmation. Cleared by a human via duplicate_cleared_by.';

create index if not exists expense_requests_duplicate_of_idx
  on ops.expense_requests (duplicate_of) where duplicate_of is not null;

-- Matching key. Vendor names arrive off OCR'd PDFs, from Service Fusion, and
-- from humans typing, so they must be compared loosely: case, punctuation,
-- and the corporate suffixes that appear on an invoice header but not in
-- anybody's vendor list.
create or replace function ops.fn_norm_vendor(p text)
returns text
language sql
immutable
as $$
  select nullif(
    btrim(regexp_replace(
      regexp_replace(lower(coalesce(p,'')), '\y(inc|llc|l\.l\.c|ltd|co|corp|corporation|company|the)\y', ' ', 'g'),
      '[^a-z0-9]+', ' ', 'g')),
    '');
$$;

-- Bill numbers get the same treatment for a narrower reason: "INV-0042",
-- "inv 0042" and "0042" are one invoice, and which of those we hold depends on
-- whether a human typed it or Claude read it off a PDF.
create or replace function ops.fn_norm_bill_number(p text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(lower(coalesce(p,'')), '[^a-z0-9]', '', 'g'), '');
$$;

create index if not exists expense_requests_dupe_lookup_idx
  on ops.expense_requests (ops.fn_norm_vendor(vendor_name), receipt_date)
  where archived_at is null;

-- Two rules, and they are deliberately different in confidence:
--   exact  — same vendor + same bill number. That is the same invoice, and the
--            only innocent explanation is a corrected re-issue.
--   likely — same vendor + same amount within a 10-day window and no bill
--            number to separate them. Common enough to be worth a look, weak
--            enough that it must never auto-reject.
-- A row with NO amount and NO bill number matches nothing: unknown is not zero,
-- the same rule the bill-rule amount bounds follow.
-- Guard is INLINE (new function — NOT generator-wrapped; keep the guard on any
-- edit). It returns other people's vendors and amounts, so it is staff-or-
-- service, matching the rest of the expense surface.
create or replace function ops.fn_bill_duplicate_candidates(
  p_vendor      text,
  p_bill_number text,
  p_amount      numeric,
  p_date        date,
  p_exclude     uuid default null
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
    select ops.fn_norm_vendor(p_vendor)          as v,
           ops.fn_norm_bill_number(p_bill_number) as b,
           p_amount                               as amt,
           coalesce(p_date, current_date)         as dt
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
          (me.b is not null and ops.fn_norm_bill_number(r.bill_number) = me.b)
       or (me.b is null
           and me.amt is not null and me.amt > 0
           and r.total_amount = me.amt
           and r.receipt_date between me.dt - 10 and me.dt + 10)
     )
   order by (case when me.b is not null
                       and ops.fn_norm_bill_number(r.bill_number) = me.b then 0 else 1 end),
            r.created_at desc
   limit 20;
end;
$$;

revoke execute on function ops.fn_bill_duplicate_candidates(text,text,numeric,date,uuid) from public, anon;
grant execute on function ops.fn_bill_duplicate_candidates(text,text,numeric,date,uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. DUE DATES + AP AGING
--
-- expense_requests had no due date at all — which meant Brixpense could hold an
-- unpaid vendor bill indefinitely with nothing anywhere saying it was late.
-- QuickBooks knows, once the bill is posted; the whole point of the inbox is
-- the window BEFORE that, where the bill is ours and invisible.
--
-- due_date is stored, not derived at read time, because the two ways we learn
-- it disagree and both are legitimate: the invoice PRINTS a due date, or it
-- prints terms and we compute one. A stored value records which we had.
-- ---------------------------------------------------------------------------
alter table ops.expense_requests
  add column if not exists due_date date,
  add column if not exists payment_terms text,
  add column if not exists due_date_source text;

comment on column ops.expense_requests.due_date_source is
  'printed | terms | manual — how we came to this due date. A printed date always wins over one computed from terms.';

create index if not exists expense_requests_due_idx
  on ops.expense_requests (due_date)
  where due_date is not null and archived_at is null and paid_at is null;

-- Terms → a date. Handles what actually appears on the invoices we receive;
-- anything it does not recognise returns null rather than a guess, because a
-- wrong due date is worse than none (it turns a real overdue bill green).
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

  -- End-of-month terms: net 30 EOM = end of the month AFTER the invoice month.
  if t ~ '(eom|end of month|prox)' then
    n := coalesce((regexp_match(t, '(\d{1,3})'))[1]::int, 0);
    return (date_trunc('month', p_date)::date + interval '1 month'
            + make_interval(days => n) - interval '1 day')::date;
  end if;

  -- Net N / N days / plain "30".
  n := (regexp_match(t, '(\d{1,3})'))[1]::int;
  if n is null then return null; end if;
  if n > 365 then return null; end if;   -- that is not a term, that is a typo
  return p_date + n;
exception when others then
  return null;
end;
$$;

-- Backfill: bills we already hold that carry terms but no due date. Only
-- unposted, unpaid rows — a posted bill's schedule belongs to QuickBooks now,
-- and rewriting history here would just disagree with it.
update ops.expense_requests r
   set due_date = ops.fn_due_date_from_terms(r.receipt_date, r.payment_terms),
       due_date_source = 'terms'
 where r.due_date is null
   and r.payment_terms is not null
   and r.receipt_date is not null
   and r.paid_at is null
   and r.qbo_bill_id is null
   and ops.fn_due_date_from_terms(r.receipt_date, r.payment_terms) is not null;

-- Aging over what Brixpense still owes. security_invoker so the caller's RLS
-- decides what they can see — this is the same rule the expense book totals
-- view follows, and it is what keeps a non-staff owner from reading the whole
-- company's payables through a view.
create or replace view ops.v_ap_aging
with (security_invoker = true) as
select
  r.id,
  r.vendor_name,
  r.bill_number,
  r.total_amount,
  r.receipt_date,
  r.due_date,
  r.payment_terms,
  r.status,
  r.tag,
  r.entity,
  r.department,
  r.manager_email,
  r.submitter_email,
  r.qbo_bill_id,
  (r.qbo_bill_id is not null) as posted,
  case when r.due_date is null then null
       else (current_date - r.due_date) end as days_overdue,
  case
    when r.due_date is null                        then 'no due date'
    when r.due_date >= current_date                then 'current'
    when current_date - r.due_date <= 30           then '1-30'
    when current_date - r.due_date <= 60           then '31-60'
    when current_date - r.due_date <= 90           then '61-90'
    else '90+'
  end as aging_bucket
from ops.expense_requests r
where r.archived_at is null
  and r.paid_at is null
  and r.as_bill is true
  and r.request_type = 'expense'
  and r.status not in ('denied','cancelled');

comment on view ops.v_ap_aging is
  'Unpaid vendor bills held in Brixpense, bucketed by days past due. Covers the window before a bill reaches QuickBooks as well as after — a posted-but-unpaid bill stays here until paid_at is stamped.';

grant select on ops.v_ap_aging to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. 1099 / W-9
--
-- ops.vendors already had w9_status and ein_last4 and nothing read either. The
-- thing that makes them worth reading is timing: chasing a missing W-9 in
-- January, from a contractor who finished in March and stopped answering, is
-- the worst version of this job. Knowing in August which vendors have crossed
-- $600 and have no W-9 on file makes it a two-minute email.
--
-- ⚠ This produces a CANDIDATE LIST, not a filing. QuickBooks' own 1099 module
--   is the source of truth for the forms, and it is right to be: 1099 is CASH
--   basis, and our mirror carries Bills at accrual, so a bill entered in
--   December and paid in January lands in the wrong year here. The report says
--   so out loud rather than implying a total anyone would file on.
-- ---------------------------------------------------------------------------
alter table ops.vendors
  add column if not exists tax_classification text,
  add column if not exists is_1099 boolean,
  add column if not exists tin_type text,
  add column if not exists w9_received_at date,
  add column if not exists backup_withholding boolean not null default false,
  add column if not exists tax_address jsonb;

comment on column ops.vendors.is_1099 is
  'Explicit override. NULL means "derive from tax_classification" — corporations are exempt except for legal and medical services, which is a judgement about what the vendor DOES and cannot be read off a W-9 checkbox.';
comment on column ops.vendors.tax_classification is
  'W-9 line 3: individual | sole_prop | partnership | c_corp | s_corp | llc_c | llc_s | llc_p | trust | other';
comment on column ops.vendors.backup_withholding is
  'True when the vendor struck certification 2 on the W-9, or the IRS sent a B-notice. 24% withholding applies.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'vendors_tax_classification_chk') then
    alter table ops.vendors add constraint vendors_tax_classification_chk
      check (tax_classification is null or tax_classification in
        ('individual','sole_prop','partnership','c_corp','s_corp','llc_c','llc_s','llc_p','trust','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vendors_tin_type_chk') then
    alter table ops.vendors add constraint vendors_tin_type_chk
      check (tin_type is null or tin_type in ('ein','ssn'));
  end if;
end $$;

-- Whether a vendor gets a 1099, when nobody has decided by hand. Corporations
-- are exempt; everyone else is reportable. An explicit is_1099 always wins,
-- because the exemption has carve-outs (attorneys, medical) that no column
-- here can see.
create or replace function ops.fn_vendor_is_1099(p_is_1099 boolean, p_class text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    p_is_1099,
    case
      when p_class is null then null
      when p_class in ('c_corp','s_corp','llc_c','llc_s') then false
      else true
    end
  );
$$;

-- Year-end candidates. Reads the QBO expense mirror (Bills, Purchases, less
-- VendorCredits) rather than our own expense_requests, because the mirror is
-- everything we spent — including the bills keyed straight into QuickBooks that
-- never touched Brixpense. Matching is by vendor NAME, which is what the mirror
-- carries; the ops.vendors join is best-effort and a miss just means no W-9
-- status is known, which is itself the answer worth seeing.
create or replace function ops.fn_1099_candidates(
  p_year int default null,
  p_threshold numeric default 600
)
returns table(
  vendor_name text,
  paid_total numeric,
  txn_count bigint,
  first_txn date,
  last_txn date,
  qbo_vendor_id text,
  vendor_id uuid,
  w9_status text,
  w9_received_at date,
  tax_classification text,
  ein_last4 text,
  backup_withholding boolean,
  reportable boolean,
  over_threshold boolean,
  needs_w9 boolean
)
language plpgsql
stable
security definer
set search_path to 'ops','public'
as $$
declare
  v_year int := coalesce(p_year, extract(year from current_date)::int);
begin
  perform ops.fn_assert_staff_or_service();

  return query
  with spend as (
    select l.vendor_name as name,
           -- A VendorCredit reduces what we paid them.
           sum(case when l.qbo_txn_type = 'VendorCredit' then -l.amount else l.amount end) as total,
           count(*) as n,
           min(l.txn_date) as lo,
           max(l.txn_date) as hi
      from ops.qbo_expense_lines l
     where l.txn_date >= make_date(v_year, 1, 1)
       and l.txn_date <  make_date(v_year + 1, 1, 1)
       and coalesce(btrim(l.vendor_name), '') <> ''
     group by l.vendor_name
  )
  select
    s.name,
    round(s.total, 2),
    s.n,
    s.lo,
    s.hi,
    qv.qbo_vendor_id,
    v.id,
    v.w9_status,
    v.w9_received_at,
    v.tax_classification,
    v.ein_last4,
    coalesce(v.backup_withholding, false),
    ops.fn_vendor_is_1099(v.is_1099, v.tax_classification),
    (s.total >= p_threshold),
    -- The actionable column: over the threshold, not known to be exempt, and
    -- no W-9 on file. NULL reportable (nobody has classified them) counts as
    -- needing one — an unknown vendor is exactly who you want to ask.
    (s.total >= p_threshold
     and coalesce(ops.fn_vendor_is_1099(v.is_1099, v.tax_classification), true)
     and coalesce(v.w9_status, 'missing') <> 'on_file')
  from spend s
  left join ops.qbo_vendors qv
         on lower(btrim(qv.display_name)) = lower(btrim(s.name))
  left join ops.vendors v
         on v.archived_at is null
        and (v.qbo_vendor_id = qv.qbo_vendor_id
             or ops.fn_norm_vendor(v.display_name) = ops.fn_norm_vendor(s.name))
  where s.total > 0
  order by s.total desc;
end;
$$;

revoke execute on function ops.fn_vendor_is_1099(boolean,text) from public, anon;
revoke execute on function ops.fn_1099_candidates(int,numeric) from public, anon;
grant execute on function ops.fn_vendor_is_1099(boolean,text) to authenticated, service_role;
grant execute on function ops.fn_1099_candidates(int,numeric) to authenticated, service_role;
