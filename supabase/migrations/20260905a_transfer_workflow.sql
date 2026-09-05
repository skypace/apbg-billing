-- A transfer is a PROCESS now, not just a row.
--
-- Sky (2026-09-04): "can you make a system when we do transfers where i can
-- print pull tickets for the load being tranferred and create a real inventory
-- transfer process where the order gets put in, an email gets sent to
-- service@brixbev.com to make the order for the transfer, with all the details
-- and the pick ticket, and it makes a ticket in service fusion thats just a
-- UNSCHEDULED - Brix Beverage Sampling customer ticket that says Product
-- Transfer Ticket type. The ticket numbre (Service fusion) gets entered on the
-- email. The receiving branch gets a notification via email as well… Then the
-- tech works the ticket and completes the ticket. The ticket tells them how
-- many cases of what to build on the notes or tasks section 20 cases of XXXXX
-- Then once the ticket is completed, an email comes back to schedule the
-- transfer for delivery. Then it asks for the shippng and BOL information.
-- once thats entrerd it kicks off another email with all details, pallets, etc
-- with a link to receive the product when it gets to the transfer location,
-- that link will be one time link."
--
-- ⚠ THE WORKFLOW IS A SEPARATE COLUMN FROM `status`, deliberately.
--   inventory_transfers.status is the LEDGER state — draft / in_transit /
--   received / void — and moving it MOVES STOCK. workflow_status is paperwork:
--   who has been told, what Service Fusion knows, whether the load is built.
--   Collapsing the two would let an email step post an inventory movement, and
--   would make "the tech hasn't finished picking" indistinguishable from "the
--   stock has not left the building". They advance together only where the
--   process genuinely says so (schedule → ship, receive → received).
--
--   requested  — pull ticket raised, SF ticket created, ops + receiving told
--   built      — the SF ticket is complete; the load is picked and waiting
--   scheduled  — shipping and BOL entered; SHIPPED, and the one-time receive
--                link has gone to the receiving branch
--   (then the ordinary `received` status closes it)
--
-- ⚠ THE RECEIVE LINK IS A CREDENTIAL and is treated as one: 32 random bytes of
--   which only the sha256 is stored, so no later read of this table — a backup,
--   a widened grant, a support session — yields a working link. It expires, it
--   is scoped to ONE transfer, and it can do exactly ONE thing: move that
--   transfer from in_transit to received. It can never create, void, or touch
--   another transfer. Single use is enforced by a CONDITIONAL UPDATE
--   (`receive_token_used_at is null`), not by a check-then-write, so two clicks
--   racing cannot both win. Same posture as the NDA signing link and the
--   visitor kiosk: a public page that can do one thing.

-- 1 ── settings (one row; edit without a deploy) -----------------------------------------
create table if not exists ops.transfer_workflow_settings (
  id                boolean primary key default true check (id),
  enabled           boolean not null default true,
  -- ⚠ This must be the SF customer's name EXACTLY. Service Fusion matches jobs
  --   by customer_name and rejects anything else with a 422 — brix-order lost
  --   every order for a fortnight to this in its session 1.94. The snapshot in
  --   ops.sf_customer_snapshot spells it "BRIX BEVERAGE - SAMPLING"
  --   (id 28919989), which is not how anyone says it out loud.
  sf_customer_name  text not null default 'BRIX BEVERAGE - SAMPLING',
  sf_job_category   text not null default 'Product Transfer Ticket',
  sf_job_status     text not null default 'Unscheduled',
  ops_email         text not null default 'service@brixbev.com',
  cc_emails         text[] not null default '{}',
  receive_link_days int  not null default 21 check (receive_link_days between 1 and 120),
  updated_at        timestamptz not null default now()
);
insert into ops.transfer_workflow_settings (id) values (true) on conflict (id) do nothing;

alter table ops.transfer_workflow_settings enable row level security;
drop policy if exists transfer_workflow_settings_staff on ops.transfer_workflow_settings;
create policy transfer_workflow_settings_staff on ops.transfer_workflow_settings
  for all to authenticated using (ops.fn_is_staff()) with check (ops.fn_is_staff());
grant select, insert, update on ops.transfer_workflow_settings to authenticated;

-- 2 ── the receiving branch needs an address to be told at ------------------------------
alter table ops.inventory_locations add column if not exists contact_email text;
comment on column ops.inventory_locations.contact_email is
  'Where a transfer INTO this location is announced. Empty falls back to the ops address on transfer_workflow_settings — a notification is never silently dropped.';

-- 3 ── the workflow itself ---------------------------------------------------------------
alter table ops.inventory_transfers
  add column if not exists workflow_status text not null default 'none'
    check (workflow_status in ('none','requested','built','scheduled')),
  add column if not exists sf_job_id   text,
  add column if not exists sf_job_number text,
  add column if not exists sf_job_status text,
  add column if not exists sf_error    text,
  add column if not exists requested_at timestamptz,
  add column if not exists requested_by uuid,
  add column if not exists built_at    timestamptz,
  add column if not exists scheduled_at timestamptz,
  add column if not exists receive_token_hash text,
  add column if not exists receive_token_expires_at timestamptz,
  add column if not exists receive_token_used_at timestamptz,
  add column if not exists receive_link_sent_at timestamptz,
  add column if not exists received_note text;

comment on column ops.inventory_transfers.workflow_status is
  'Paperwork state, NOT the ledger state. `status` says where the stock is; this says how far the process has got. Never move stock from here.';
comment on column ops.inventory_transfers.receive_token_hash is
  'sha256 of the one-time receive link. The raw token exists once, in the email. A read of this column cannot be turned back into a working link.';

-- A token is looked up by its hash on a public request, so it wants an index,
-- and only rows that HAVE one are worth indexing.
create index if not exists inventory_transfers_receive_token_idx
  on ops.inventory_transfers (receive_token_hash) where receive_token_hash is not null;
create index if not exists inventory_transfers_workflow_idx
  on ops.inventory_transfers (workflow_status) where workflow_status <> 'none';

-- 4 ── seed the two branch addresses we know ---------------------------------------------
-- Only fills blanks; a hand-entered address always wins.
update ops.inventory_locations set contact_email = 'service@brixbev.com'
 where code = 'BRIX-WAREHOUSE' and coalesce(contact_email, '') = '';

-- 5 ── the send log has to know the new document ------------------------------------------
-- Otherwise a pull-ticket email would SEND and then fail to log, which is the
-- same silence the 2026-09-04 build-failure fix was about. The allow-list is
-- kept rather than dropped: it is what stops a typo'd kind orphaning a row.
alter table ops.production_doc_sends drop constraint if exists production_doc_sends_doc_kind_check;
alter table ops.production_doc_sends add constraint production_doc_sends_doc_kind_check
  check (doc_kind = any (array['po','bol','batch_sheet','pull_ticket']));

-- 6 ── the watcher --------------------------------------------------------------------------
-- This repo's rule: no pipeline without a watcher, in the SAME change.
--
-- ⚠ NOT a heartbeat. The workflow is event-driven — a person presses a button —
--   so a quiet week is a quiet week, and colouring on silence would flap the
--   way sf_token did before 2026-08-06. What it watches is a transfer we
--   ACCEPTED and then failed to finish: a Service Fusion ticket that never got
--   made (red — the office has a pull ticket and the tech has nothing to work),
--   a completion check that errored (red), a load requested three days ago and
--   still not built (amber), and a shipment nobody has received in a fortnight
--   (amber — stock sitting in transit on the books).
create or replace function ops.fn_transfer_workflow_health()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds int, detail text)
language plpgsql
security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  v_sf_failed  int;
  v_stale      int;
  v_unreceived int;
  v_poll_at    timestamptz;
  v_poll_status text;
  v_poll_err   text;
  v_last       timestamptz;
  v_enabled    boolean;
  v_parts      text[] := '{}';
begin
  select s.enabled into v_enabled from ops.transfer_workflow_settings s where s.id;

  select count(*) into v_sf_failed from ops.inventory_transfers t
   where t.workflow_status = 'requested' and t.sf_error is not null and t.status = 'draft';
  select count(*) into v_stale from ops.inventory_transfers t
   where t.workflow_status = 'requested' and t.status = 'draft'
     and t.requested_at < now() - interval '3 days';
  select count(*) into v_unreceived from ops.inventory_transfers t
   where t.status = 'in_transit' and t.receive_link_sent_at is not null
     and t.receive_token_used_at is null
     and t.receive_link_sent_at < now() - interval '14 days';

  select s.completed_at, s.status, s.error_message into v_poll_at, v_poll_status, v_poll_err
    from ops.sync_log s
   where s.source = 'inventory' and s.sync_type = 'transfer_sf_poll'
   order by s.completed_at desc nulls last limit 1;

  select max(t.updated_at) into v_last from ops.inventory_transfers t where t.workflow_status <> 'none';

  check_name := 'transfer_workflow';
  last_event_at := greatest(coalesce(v_last, 'epoch'::timestamptz), coalesce(v_poll_at, 'epoch'::timestamptz));
  if last_event_at = 'epoch'::timestamptz then last_event_at := null; end if;
  age_seconds := coalesce(extract(epoch from (now() - last_event_at))::int, null);

  if v_enabled is null then
    status := 'red';
    detail := 'transfer_workflow_settings row missing — the transfer process cannot run';
    return next; return;
  end if;
  if not v_enabled then
    status := 'green';
    detail := 'the transfer workflow is switched off in settings';
    return next; return;
  end if;

  if v_sf_failed > 0 then v_parts := v_parts || format('%s transfer(s) have NO Service Fusion ticket — the office cannot build them (see sf_error on the row)', v_sf_failed); end if;
  if v_poll_status = 'error' and v_poll_at > now() - interval '24 hours' then
    v_parts := v_parts || format('the Service Fusion completion check errored: %s', left(coalesce(v_poll_err, ''), 140));
  end if;
  if v_stale > 0 then v_parts := v_parts || format('%s transfer(s) requested over 3 days ago and still not built', v_stale); end if;
  if v_unreceived > 0 then v_parts := v_parts || format('%s shipped transfer(s) still not received after 14 days', v_unreceived); end if;

  status := case
    when v_sf_failed > 0 then 'red'
    when v_poll_status = 'error' and v_poll_at > now() - interval '24 hours' then 'red'
    when v_stale > 0 or v_unreceived > 0 then 'yellow'
    else 'green' end;

  detail := case
    when array_length(v_parts, 1) is null then 'transfer process healthy — nothing stuck'
    else array_to_string(v_parts, ' · ') end;
  return next;
end;
$$;
revoke all on function ops.fn_transfer_workflow_health() from public, anon;
grant execute on function ops.fn_transfer_workflow_health() to authenticated, service_role;

-- ⚠ Wired into ops.fn_sync_health_extra() by an ANCHOR-CHECKED read-modify-write
--   of the LIVE definition, never by re-declaring it from a copy. On 2026-08-21
--   a parallel rebuild from an older migration silently DELETED the
--   distributor_notify monitor. The anchor must match exactly once, and the
--   whole thing no-ops if the check is already wired.
do $mig$
declare
  src text; n int;
  anchor text := '  -- Bills paid in QuickBooks outside Brixpense.' || E'\n'
              || '  return query select * from ops.fn_bill_paid_sync_health();';
  repl text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'ops' and p.proname = 'fn_sync_health_extra';
  if src is null then raise exception 'fn_sync_health_extra not found'; end if;
  if position('fn_transfer_workflow_health' in src) > 0 then return; end if;

  n := (length(src) - length(replace(src, anchor, ''))) / nullif(length(anchor), 0);
  if n <> 1 then raise exception 'anchor matched % times, expected 1', n; end if;

  repl := anchor || E'\n\n'
       || '  -- The transfer process: a Service Fusion ticket that never got made,' || E'\n'
       || '  -- a load nobody built, a shipment nobody received.' || E'\n'
       || '  return query select * from ops.fn_transfer_workflow_health();';
  src := replace(src, anchor, repl);
  execute src;
end
$mig$;
