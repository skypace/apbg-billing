-- ============================================================================
-- Sub-distributors phase 2 — fee settlement, notification ledger, Melt-grade
-- agreement e-sign (scope + signature audit trail), QBO vendor link.
--
-- 1. FEE SETTLEMENT: consignment partners bill US a per-case delivery fee.
--    Depletions already snapshot fee_per_case/fee_amount; this adds
--    ops.sub_distributor_settlements (one row per distributor per period) and
--    ops.fn_distributor_settlement_create (STAFF): sweeps un-settled
--    fee-carrying depletions in a date range, stamps them, and creates a
--    Brixpense expense request (request_type='expense', status='approved',
--    as_bill=true, tag='Sub-Distributor') for the total — so the ACTUAL QBO
--    posting stays behind the existing human "Post to QuickBooks" gate
--    (2026-08-14 rule: nothing auto-posts). Requires the distributor's QBO
--    VENDOR link (new sub_distributors.qbo_vendor_id) so the bill lands on
--    the right vendor.
--
-- 2. NOTIFICATIONS: ops.sub_distributor_notifications is the dedup ledger for
--    netlify/functions/distributor-notify.mjs (15-min scheduled scan):
--    order_submitted → staff · order_fulfilled/transfer_shipped → partner ·
--    transfer received with discrepancy → staff · agreement_sent → partner
--    (sign link) · agreement_signed → staff + partner. UNIQUE(event_type,
--    ref_id) makes every send exactly-once. Service-role only.
--
-- 3. AGREEMENT E-SIGN hardening (the Melt store_order_approvals treatment):
--    agreements gain a SCOPE field (territory / accounts / products covered,
--    shown to the signer) and the sign RPC now records signer IP + user agent
--    from PostgREST's request.headers alongside the typed name + signature
--    PNG + timestamp.
--
-- Idempotent: re-running is safe.
-- ============================================================================


-- ── 1. Columns ───────────────────────────────────────────────────────────────
ALTER TABLE ops.sub_distributors
  ADD COLUMN IF NOT EXISTS qbo_vendor_id TEXT;   -- ops.qbo_vendors.qbo_vendor_id

ALTER TABLE ops.sub_distributor_agreements
  ADD COLUMN IF NOT EXISTS scope             TEXT,   -- territory / accounts / products covered
  ADD COLUMN IF NOT EXISTS signer_ip         TEXT,
  ADD COLUMN IF NOT EXISTS signer_user_agent TEXT;

ALTER TABLE ops.sub_distributor_depletions
  ADD COLUMN IF NOT EXISTS settlement_id UUID;


-- ── 2. Settlements ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.sub_distributor_settlements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_distributor_id UUID NOT NULL REFERENCES ops.sub_distributors(id) ON DELETE CASCADE,
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  depletion_count    INTEGER NOT NULL,
  total_cases        NUMERIC NOT NULL,
  total_fee          NUMERIC NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  expense_request_id UUID,          -- the Brixpense row awaiting "Post to QuickBooks"
  reference          TEXT,          -- SD-<code>-<YYYYMM(-n)> → QBO Bill.DocNumber
  notes              TEXT,
  created_by         UUID REFERENCES auth.users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_by          UUID REFERENCES auth.users(id),
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT,
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS sub_distributor_settlements_dist_idx
  ON ops.sub_distributor_settlements (sub_distributor_id, period_end DESC);

DO $$ BEGIN
  ALTER TABLE ops.sub_distributor_depletions
    ADD CONSTRAINT sub_distributor_depletions_settlement_fk
    FOREIGN KEY (settlement_id) REFERENCES ops.sub_distributor_settlements(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE ops.sub_distributor_settlements ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON ops.sub_distributor_settlements TO authenticated;
GRANT ALL ON ops.sub_distributor_settlements TO service_role;

DROP POLICY IF EXISTS sub_distributor_settlements_staff ON ops.sub_distributor_settlements;
CREATE POLICY sub_distributor_settlements_staff ON ops.sub_distributor_settlements
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
DROP POLICY IF EXISTS sub_distributor_settlements_member_select ON ops.sub_distributor_settlements;
CREATE POLICY sub_distributor_settlements_member_select ON ops.sub_distributor_settlements
  FOR SELECT TO authenticated USING (sub_distributor_id IN (SELECT ops.fn_my_distributor_ids()));


-- ── 3. Notification dedup ledger (service-role only) ─────────────────────────
CREATE TABLE IF NOT EXISTS ops.sub_distributor_notifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type         TEXT NOT NULL,
  ref_id             UUID NOT NULL,     -- the order / transfer / agreement id
  sub_distributor_id UUID,
  recipients         TEXT,
  status             TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error              TEXT,
  sent_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, ref_id)
);
ALTER TABLE ops.sub_distributor_notifications ENABLE ROW LEVEL SECURITY;
GRANT ALL ON ops.sub_distributor_notifications TO service_role;
-- No authenticated grants/policies on purpose: only distributor-notify.mjs
-- (service role) reads and writes this ledger.


-- ── 4. Settlement RPC (STAFF) ─────────────────────────────────────────────────
-- Sweeps un-settled fee-carrying depletions in [p_period_start, p_period_end],
-- stamps them, and creates the Brixpense expense request the human posts from.
CREATE OR REPLACE FUNCTION ops.fn_distributor_settlement_create(
  p_sub_distributor_id UUID,
  p_period_start       DATE,
  p_period_end         DATE,
  p_notes              TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_sub     ops.sub_distributors%ROWTYPE;
  v_vendor  TEXT;
  v_count   INTEGER;
  v_cases   NUMERIC;
  v_fee     NUMERIC;
  v_id      UUID;
  v_ref     TEXT;
  v_er_id   UUID;
  v_lines   JSONB;
  v_email   TEXT := auth.jwt()->>'email';
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RAISE EXCEPTION 'invalid period';
  END IF;
  SELECT * INTO v_sub FROM ops.sub_distributors WHERE id = p_sub_distributor_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'sub-distributor not found'; END IF;
  IF v_sub.qbo_vendor_id IS NULL THEN
    RAISE EXCEPTION 'link the distributor''s QBO vendor first (Overview tab) — the settlement bill needs a vendor';
  END IF;
  SELECT display_name INTO v_vendor FROM ops.qbo_vendors WHERE qbo_vendor_id = v_sub.qbo_vendor_id;
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'linked QBO vendor % not found in the mirror', v_sub.qbo_vendor_id;
  END IF;

  -- Lock the candidate depletions so two settlements can't claim the same rows.
  PERFORM 1 FROM ops.sub_distributor_depletions d
   WHERE d.sub_distributor_id = p_sub_distributor_id
     AND d.settlement_id IS NULL AND d.fee_amount IS NOT NULL
     AND d.delivered_date BETWEEN p_period_start AND p_period_end
   FOR UPDATE;

  SELECT count(*), COALESCE(sum(cases),0), COALESCE(sum(fee_amount),0)
    INTO v_count, v_cases, v_fee
  FROM ops.sub_distributor_depletions d
  WHERE d.sub_distributor_id = p_sub_distributor_id
    AND d.settlement_id IS NULL AND d.fee_amount IS NOT NULL
    AND d.delivered_date BETWEEN p_period_start AND p_period_end;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'no un-settled fee-carrying depletions between % and %', p_period_start, p_period_end;
  END IF;

  v_ref := 'SD-' || v_sub.code || '-' || to_char(p_period_end, 'YYYYMM');
  IF EXISTS (SELECT 1 FROM ops.sub_distributor_settlements WHERE reference = v_ref AND status <> 'void') THEN
    v_ref := v_ref || '-' || to_char(now(), 'DD');
  END IF;

  INSERT INTO ops.sub_distributor_settlements (
    sub_distributor_id, period_start, period_end,
    depletion_count, total_cases, total_fee, reference, notes, created_by
  ) VALUES (
    p_sub_distributor_id, p_period_start, p_period_end,
    v_count, v_cases, v_fee, v_ref, p_notes, auth.uid()
  ) RETURNING id INTO v_id;

  UPDATE ops.sub_distributor_depletions
     SET settlement_id = v_id
   WHERE sub_distributor_id = p_sub_distributor_id
     AND settlement_id IS NULL AND fee_amount IS NOT NULL
     AND delivered_date BETWEEN p_period_start AND p_period_end;

  -- Per-account breakdown as Brixpense line items.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'description', COALESCE(a.account_name, 'Unassigned account')
             || ' · ' || l.cases || ' cases',
           'amount', l.fee)), '[]'::jsonb)
    INTO v_lines
  FROM (
    SELECT d.account_id, sum(d.cases) AS cases, sum(d.fee_amount) AS fee
    FROM ops.sub_distributor_depletions d
    WHERE d.settlement_id = v_id
    GROUP BY d.account_id
  ) l
  LEFT JOIN ops.sub_distributor_accounts a ON a.id = l.account_id;

  -- The Brixpense expense request: approved + as_bill, so the row shows a
  -- "Post to QuickBooks" button in the creator's Brixpense pending list —
  -- posting stays a deliberate human click (2026-08-14 gate).
  INSERT INTO ops.expense_requests (
    request_type, status, vendor_name, total_amount, receipt_date,
    tag, as_bill, auto_approved, memo, description, line_items,
    bill_number, entity, submitted_by, submitter_email, submitter_name,
    approved_at
  ) VALUES (
    'expense', 'approved', v_vendor, round(v_fee, 2), p_period_end,
    'Sub-Distributor', TRUE, TRUE,
    'Sub-distributor delivery-fee settlement ' || v_ref,
    v_sub.name || ' consignment delivery fees · ' || p_period_start || ' → ' || p_period_end
      || ' · ' || v_cases || ' cases across ' || v_count || ' depletion lines',
    v_lines, left(v_ref, 21), 'shared',
    auth.uid(), v_email, COALESCE(v_email, 'Refractor Sub-Distributors'),
    now()
  ) RETURNING id INTO v_er_id;

  UPDATE ops.sub_distributor_settlements SET expense_request_id = v_er_id WHERE id = v_id;

  RETURN jsonb_build_object(
    'settlement_id', v_id, 'reference', v_ref, 'depletions', v_count,
    'total_cases', v_cases, 'total_fee', round(v_fee, 2),
    'expense_request_id', v_er_id, 'vendor', v_vendor
  );
END; $$;

GRANT EXECUTE ON FUNCTION ops.fn_distributor_settlement_create(UUID, DATE, DATE, TEXT) TO authenticated;

-- Void a settlement that hasn't reached QuickBooks: releases its depletions
-- and archives the linked (still-unposted) Brixpense request.
CREATE OR REPLACE FUNCTION ops.fn_distributor_settlement_void(
  p_settlement_id UUID,
  p_reason        TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_st ops.sub_distributor_settlements%ROWTYPE;
  v_er ops.expense_requests%ROWTYPE;
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  SELECT * INTO v_st FROM ops.sub_distributor_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF v_st.id IS NULL THEN RAISE EXCEPTION 'settlement not found'; END IF;
  IF v_st.status = 'void' THEN RETURN; END IF;
  IF v_st.expense_request_id IS NOT NULL THEN
    SELECT * INTO v_er FROM ops.expense_requests WHERE id = v_st.expense_request_id;
    IF v_er.id IS NOT NULL AND (v_er.qbo_bill_id IS NOT NULL OR v_er.status = 'posted') THEN
      RAISE EXCEPTION 'settlement % already posted to QuickBooks (bill %) — handle it in QBO, not here',
        v_st.reference, v_er.qbo_bill_id;
    END IF;
    UPDATE ops.expense_requests
       SET archived_at = now(), archived_by = auth.uid()
     WHERE id = v_st.expense_request_id;
  END IF;
  UPDATE ops.sub_distributor_depletions SET settlement_id = NULL WHERE settlement_id = p_settlement_id;
  UPDATE ops.sub_distributor_settlements
     SET status = 'void', voided_by = auth.uid(), voided_at = now(), void_reason = p_reason
   WHERE id = p_settlement_id;
END; $$;

GRANT EXECUTE ON FUNCTION ops.fn_distributor_settlement_void(UUID, TEXT) TO authenticated;


-- ── 5. Sign RPC: capture IP + user agent (Melt-style audit trail) ───────────
CREATE OR REPLACE FUNCTION ops.fn_distributor_sign_agreement(
  p_agreement_id   UUID,
  p_signer_name    TEXT,
  p_signature_data TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_ag   ops.sub_distributor_agreements%ROWTYPE;
  v_hdrs JSONB;
BEGIN
  SELECT * INTO v_ag FROM ops.sub_distributor_agreements WHERE id = p_agreement_id FOR UPDATE;
  IF v_ag.id IS NULL THEN RAISE EXCEPTION 'agreement not found'; END IF;
  IF NOT ops.fn_is_distributor_member(v_ag.sub_distributor_id) THEN
    RAISE EXCEPTION 'not a member of this distributor';
  END IF;
  IF v_ag.status <> 'sent' THEN
    RAISE EXCEPTION 'agreement is %, only sent agreements can be signed', v_ag.status;
  END IF;
  IF p_signer_name IS NULL OR btrim(p_signer_name) = '' THEN
    RAISE EXCEPTION 'signer name is required';
  END IF;

  BEGIN
    v_hdrs := COALESCE(current_setting('request.headers', TRUE), '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN v_hdrs := '{}'::jsonb;
  END;

  UPDATE ops.sub_distributor_agreements
     SET status = 'signed', signed_at = now(),
         signer_name = p_signer_name,
         signer_email = auth.jwt()->>'email',
         signer_user_id = auth.uid(),
         signature_data = p_signature_data,
         signer_ip = NULLIF(btrim(split_part(COALESCE(v_hdrs->>'x-forwarded-for',''), ',', 1)), ''),
         signer_user_agent = left(v_hdrs->>'user-agent', 400)
   WHERE id = p_agreement_id;
END; $$;

GRANT EXECUTE ON FUNCTION ops.fn_distributor_sign_agreement(UUID, TEXT, TEXT) TO authenticated;
