-- The invoice is hunter green, and Origins' copy emails itself.
--
-- (1) ACCENT. The self-billed invoice was inheriting production_settings.doc_accent
-- (#dc2626), which is the Melt red every OTHER document in this repo wears — POs,
-- BOLs, batching sheets. Those are ours; this one is the SUPPLIER'S, and it already
-- carries no brand marks for the same reason. Its colour belongs to the profile, so
-- a second self-billing supplier can look different without touching the renderer
-- or disturbing the red on our own paperwork.
alter table ops.self_billing_profiles
  add column if not exists accent_hex text not null default '#355E3B'
    check (accent_hex ~* '^#[0-9a-f]{6}$');

comment on column ops.self_billing_profiles.accent_hex is
  'Accent for this supplier''s invoice. Hunter green by default — deliberately NOT '
  'production_settings.doc_accent, which is the red our own documents wear.';

-- (2) AUTO-SEND. Shipped false so the first invoices could be looked at before any
-- reached a partner. Sky asked for the email in the original request and again on
-- review, so Origins goes hands-off: raise, attach, stamp the bill number, send.
-- ⚠ This is the one step that reaches OUTSIDE the company and cannot be recalled.
-- Turning it back off is this same column on Settings → Organization.
update ops.self_billing_profiles
   set auto_send = true, updated_at = now()
 where code = 'ORIGINS';
