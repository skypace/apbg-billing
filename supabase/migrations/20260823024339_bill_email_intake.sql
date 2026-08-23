-- AP bill inbox: bills@alamedapointbg.com -> OCR -> Brixpense bill draft.
--
-- ops.bill_email_intake is the document-of-record for EVERY email that hits
-- the AP inbox, including the ones that fail. A failure has to be visible and
-- re-runnable: an email that silently produced nothing is exactly how the
-- current bills@ address ended up looking wired when nothing read it.

create table if not exists ops.bill_email_intake (
  id                 uuid primary key default gen_random_uuid(),
  resend_email_id    text unique,
  message_id         text,
  inbox              text not null,
  from_email         text,
  from_name          text,
  subject            text,
  received_at        timestamptz not null default now(),
  raw_text           text,
  attachment_count   integer not null default 0,
  -- received | processing | drafted | no_attachment | attachment_fetch_failed
  -- | ocr_failed | sender_rejected | ignored | failed
  status             text not null default 'received',
  status_detail      text,
  diagnostics        text,
  ocr_result         jsonb,
  expense_request_id uuid references ops.expense_requests(id) on delete set null,
  storage_path       text,
  file_name          text,
  file_type          text,
  notified_at        timestamptz,
  processed_at       timestamptz,
  reprocess_count    integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists bill_email_intake_status_idx
  on ops.bill_email_intake (status, received_at desc);
create index if not exists bill_email_intake_request_idx
  on ops.bill_email_intake (expense_request_id);

-- updated_at trigger (same helper the other ops tables use)
drop trigger if exists bill_email_intake_touch on ops.bill_email_intake;
create trigger bill_email_intake_touch
  before update on ops.bill_email_intake
  for each row execute function ops.touch_updated_at();

alter table ops.bill_email_intake enable row level security;

-- Staff read the queue in Brixpense; only service-role writes (the intake
-- function and the background processor). Same posture as the SF expense rows.
drop policy if exists bill_email_intake_select_staff on ops.bill_email_intake;
create policy bill_email_intake_select_staff
  on ops.bill_email_intake for select
  to authenticated
  using (ops.fn_is_staff());

grant select on ops.bill_email_intake to authenticated;
grant all    on ops.bill_email_intake to service_role;

-- Config lives with the rest of Brixpense's settings.
-- allow_senders empty = accept from anyone (vendors mail us directly);
-- block_senders is the escape hatch for a noisy sender.
insert into ops.expense_settings (key, value)
values ('ap_inbox', jsonb_build_object(
  'enabled',        true,
  'inbox',          'bills@alamedapointbg.com',
  'notify',         jsonb_build_array('service@brixbev.com'),
  'allow_senders',  jsonb_build_array(),
  'block_senders',  jsonb_build_array(),
  'ack_sender',     true
))
on conflict (key) do nothing;

-- "AP Inbox" joins the tag vocabulary so the queue filters like SF expenses do.
update ops.expense_settings
   set value = (
     select jsonb_agg(distinct t)
       from jsonb_array_elements(value || jsonb_build_array('"AP Inbox"'::jsonb)) t
   )
 where key = 'tags'
   and not (value @> '["AP Inbox"]'::jsonb);
