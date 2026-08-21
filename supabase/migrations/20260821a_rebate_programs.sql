-- ═════════════════════════════════════════════════════════════════════════════
-- 20260821a — Rebate Maker: contract rebate programs, rules, annual settlements
-- ═════════════════════════════════════════════════════════════════════════════
-- Per-customer rebate programs loaded from contract terms (first: the signed
-- APBG ↔ Chicken Coup, LLC master agreement — Starbird corporate outlets).
-- Volume comes from the QBO invoice mirror (ops.qbo_invoices/_lines, parent +
-- sub-customers); the annual run snapshots the calculation and creates a
-- Brixpense expense request (approved + as_bill) so the actual QBO posting /
-- rebate check stays behind the human "Post to QuickBooks" gate (2026-08-14
-- rule), exactly like sub-distributor fee settlements (20260820a).
--
-- Rule types (config knobs cover the contract's ambiguities instead of
-- hardcoding a reading):
--   volume_growth    — $X/unit where a store's YoY volume grew ≥ N%
--                      (basis: 'all' units or 'incremental' units only)
--   ordering_cadence — $X/unit for stores compliant with an ordering cadence
--                      (period_months, min_orders per window, grace_windows)
--   flat_per_unit    — $X/unit on every in-scope unit
--   tiered_volume    — chain-level tiers (retroactive or marginal)
--   fixed_per_store  — $X per active store per year (franchise outlet funding)
--
-- SECURITY: staff-only surface. Tables carry staff-only RLS; the RPCs gate
-- explicitly (calc: staff or service; settle/void: staff). These functions are
-- NEW — the 20260820b guard-wrapper generator does not cover them, so the
-- guards are inline. Do not remove them on a future CREATE OR REPLACE.

-- ── 1. Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.rebate_programs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT NOT NULL,            -- short slug used in settlement refs (RB-<code>-<year>)
  name                TEXT NOT NULL,
  qbo_customer_id     TEXT NOT NULL,            -- the chain PARENT customer; volume rolls up parent + subs
  qbo_vendor_id       TEXT,                     -- payee vendor for the rebate check (required to settle)
  pricing_contract_id UUID REFERENCES ops.pricing_contracts(id) ON DELETE SET NULL,
  -- Brixpense's entity vocabulary — flows straight onto the settlement bill
  -- (expense_requests.entity CHECK). 'brix' = Alameda Soda / Brix Beverage.
  entity              TEXT NOT NULL DEFAULT 'shared' CHECK (entity IN ('brix','freeflow','shared')),
  period_basis        TEXT NOT NULL DEFAULT 'calendar_year' CHECK (period_basis IN ('calendar_year')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  notes               TEXT,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rebate_programs_code_uq
  ON ops.rebate_programs (upper(code)) WHERE status <> 'ended';

CREATE TABLE IF NOT EXISTS ops.rebate_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    UUID NOT NULL REFERENCES ops.rebate_programs(id) ON DELETE CASCADE,
  rule_type     TEXT NOT NULL CHECK (rule_type IN
                  ('volume_growth','ordering_cadence','flat_per_unit','tiered_volume','fixed_per_store')),
  label         TEXT NOT NULL,
  amount        NUMERIC NOT NULL DEFAULT 0,     -- $/unit (per-unit types) or $/store (fixed_per_store); tiered uses config.tiers
  item_ids      TEXT[] NOT NULL DEFAULT '{}',   -- exact qbo item_ref_id matches
  item_patterns TEXT[] NOT NULL DEFAULT '{}',   -- ILIKE patterns on item_name (e.g. '3G%' = 3-gal BIBs)
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rebate_rules_program_idx ON ops.rebate_rules (program_id);

CREATE TABLE IF NOT EXISTS ops.rebate_settlements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id         UUID NOT NULL REFERENCES ops.rebate_programs(id) ON DELETE RESTRICT,
  period_year        INTEGER NOT NULL,
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  reference          TEXT NOT NULL,             -- RB-<code>-<year>
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  total_amount       NUMERIC NOT NULL DEFAULT 0,
  detail             JSONB,                     -- full per-store per-rule calc snapshot (the customer report)
  notes              TEXT,
  expense_request_id UUID,
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_by          UUID,
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT
);
-- One live settlement per program-year: the annual check can't double-run.
CREATE UNIQUE INDEX IF NOT EXISTS rebate_settlements_year_uq
  ON ops.rebate_settlements (program_id, period_year) WHERE status <> 'void';

-- ── 2. RLS + grants (staff-only both directions) ────────────────────────────
-- Rebate terms and payouts are contract-sensitive: brix-order customer,
-- vendor, and distributor logins on the shared project must see nothing.

ALTER TABLE ops.rebate_programs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.rebate_rules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.rebate_settlements ENABLE ROW LEVEL SECURITY;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['rebate_programs','rebate_rules','rebate_settlements'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ops.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON ops.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON ops.%I', t || '_staff', t);
    EXECUTE format(
      'CREATE POLICY %I ON ops.%I FOR ALL USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff())',
      t || '_staff', t);
  END LOOP;
END $$;

-- ── 3. Line-scope matcher ────────────────────────────────────────────────────
-- A line is in scope when it matches an explicit item id OR an item-name
-- pattern. Both empty = matches nothing (the UI warns), so a half-configured
-- rule can never silently sweep the whole catalog.

CREATE OR REPLACE FUNCTION ops.fn_rebate_line_match(
  p_item_ref_id TEXT, p_item_name TEXT, p_ids TEXT[], p_patterns TEXT[]
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT (COALESCE(array_length(p_ids, 1), 0) > 0 AND p_item_ref_id = ANY (p_ids))
      OR (COALESCE(array_length(p_patterns, 1), 0) > 0
          AND EXISTS (SELECT 1 FROM unnest(p_patterns) pat WHERE p_item_name ILIKE pat));
$$;
REVOKE ALL ON FUNCTION ops.fn_rebate_line_match(TEXT, TEXT, TEXT[], TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_rebate_line_match(TEXT, TEXT, TEXT[], TEXT[]) TO authenticated, service_role;

-- ── 4. The calculator ────────────────────────────────────────────────────────
-- Pure read: computes the program's rebate for one calendar year from the QBO
-- mirror and returns the full per-store per-rule breakdown. Used for the live
-- YTD accrual view AND (by fn_rebate_settlement_create) for the annual run —
-- one code path, so the preview can never disagree with the check.
-- Volume = Invoices minus CreditMemos (returns net out).

CREATE OR REPLACE FUNCTION ops.fn_rebate_calculate(
  p_program_id UUID,
  p_year       INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_prog        ops.rebate_programs%ROWTYPE;
  v_rule        ops.rebate_rules%ROWTYPE;
  v_start       DATE; v_end DATE; v_pstart DATE; v_pend DATE;
  v_rules       JSONB := '[]'::jsonb;
  v_stores      JSONB;
  v_rule_total  NUMERIC;
  v_grand       NUMERIC := 0;
  v_growth_min  NUMERIC; v_basis TEXT;
  v_months      INTEGER; v_min_orders INTEGER; v_grace INTEGER; v_orders_scope TEXT;
  v_windows     INTEGER;
  v_min_units   NUMERIC;
  v_tiers       JSONB; v_retro BOOLEAN;
  v_total_units NUMERIC; v_rate NUMERIC; v_band NUMERIC; v_next NUMERIC; v_i INTEGER;
BEGIN
  -- Inline guard (NEW function — not covered by the 20260820b generator).
  IF auth.role() = 'authenticated' AND NOT ops.fn_is_staff() THEN
    RAISE EXCEPTION 'This function requires a staff account' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_prog FROM ops.rebate_programs WHERE id = p_program_id;
  IF v_prog.id IS NULL THEN RAISE EXCEPTION 'rebate program not found'; END IF;
  IF p_year IS NULL OR p_year < 2020 OR p_year > 2100 THEN RAISE EXCEPTION 'invalid year'; END IF;

  v_start  := make_date(p_year, 1, 1);      v_end  := make_date(p_year, 12, 31);
  v_pstart := make_date(p_year - 1, 1, 1);  v_pend := make_date(p_year - 1, 12, 31);
  -- In-year preview: compare YTD against the SAME window of the prior year
  -- (a full-prior-year baseline would read every store as negative growth
  -- until December). A completed year runs the full Jan–Dec comparison.
  IF p_year = extract(year FROM current_date)::int THEN
    v_end  := current_date;
    v_pend := (current_date - INTERVAL '1 year')::date;
  END IF;

  -- The chain family: the parent + its direct sub-customers.
  CREATE TEMP TABLE IF NOT EXISTS _rb_family (cid TEXT PRIMARY KEY, cname TEXT) ON COMMIT DROP;
  DELETE FROM _rb_family;
  INSERT INTO _rb_family
    SELECT qbo_customer_id, display_name FROM ops.qbo_customers
     WHERE qbo_customer_id = v_prog.qbo_customer_id OR parent_ref_id = v_prog.qbo_customer_id;

  FOR v_rule IN
    SELECT * FROM ops.rebate_rules
     WHERE program_id = p_program_id AND active
     ORDER BY sort, created_at
  LOOP
    v_stores := '[]'::jsonb; v_rule_total := 0;

    IF v_rule.rule_type = 'volume_growth' THEN
      v_growth_min := COALESCE((v_rule.config->>'growth_pct_min')::numeric, 5);
      v_basis      := COALESCE(v_rule.config->>'basis', 'all');  -- 'all' | 'incremental'
      SELECT COALESCE(jsonb_agg(s ORDER BY s->>'store'), '[]'::jsonb),
             COALESCE(sum((s->>'amount')::numeric), 0)
        INTO v_stores, v_rule_total
      FROM (
        SELECT jsonb_build_object(
          'store', f.cname, 'qbo_customer_id', f.cid,
          'cur_units', COALESCE(cur.units, 0), 'prior_units', COALESCE(pri.units, 0),
          'growth_pct', CASE WHEN COALESCE(pri.units, 0) > 0
            THEN round((COALESCE(cur.units, 0) - pri.units) / pri.units * 100, 1) END,
          'qualified', q.ok,
          'reason', CASE WHEN COALESCE(pri.units, 0) <= 0 THEN 'no prior-year baseline'
                         WHEN NOT q.ok THEN 'growth below ' || v_growth_min || '%' END,
          'payable_units', CASE WHEN q.ok THEN
              CASE WHEN v_basis = 'incremental' THEN COALESCE(cur.units,0) - pri.units
                   ELSE COALESCE(cur.units, 0) END ELSE 0 END,
          'amount', round(CASE WHEN q.ok THEN
              CASE WHEN v_basis = 'incremental' THEN COALESCE(cur.units,0) - pri.units
                   ELSE COALESCE(cur.units, 0) END * v_rule.amount ELSE 0 END, 2)
        ) AS s
        FROM _rb_family f
        LEFT JOIN LATERAL (
          SELECT sum(CASE WHEN i.txn_type = 'CreditMemo' THEN -l.quantity ELSE l.quantity END) units
          FROM ops.qbo_invoice_lines l JOIN ops.qbo_invoices i ON i.id = l.invoice_id
          WHERE i.customer_ref_id = f.cid AND i.txn_type IN ('Invoice','CreditMemo')
            AND i.txn_date BETWEEN v_start AND v_end AND l.quantity IS NOT NULL
            AND ops.fn_rebate_line_match(l.item_ref_id, l.item_name, v_rule.item_ids, v_rule.item_patterns)
        ) cur ON TRUE
        LEFT JOIN LATERAL (
          SELECT sum(CASE WHEN i.txn_type = 'CreditMemo' THEN -l.quantity ELSE l.quantity END) units
          FROM ops.qbo_invoice_lines l JOIN ops.qbo_invoices i ON i.id = l.invoice_id
          WHERE i.customer_ref_id = f.cid AND i.txn_type IN ('Invoice','CreditMemo')
            AND i.txn_date BETWEEN v_pstart AND v_pend AND l.quantity IS NOT NULL
            AND ops.fn_rebate_line_match(l.item_ref_id, l.item_name, v_rule.item_ids, v_rule.item_patterns)
        ) pri ON TRUE
        CROSS JOIN LATERAL (
          SELECT COALESCE(pri.units, 0) > 0
             AND COALESCE(cur.units, 0) >= pri.units * (1 + v_growth_min / 100) AS ok
        ) q
        WHERE COALESCE(cur.units, 0) <> 0 OR COALESCE(pri.units, 0) <> 0
      ) rows;

    ELSIF v_rule.rule_type = 'ordering_cadence' THEN
      v_months      := GREATEST(COALESCE((v_rule.config->>'period_months')::int, 2), 1);
      v_min_orders  := GREATEST(COALESCE((v_rule.config->>'min_orders')::int, 1), 1);
      v_grace       := GREATEST(COALESCE((v_rule.config->>'grace_windows')::int, 0), 0);
      v_orders_scope := COALESCE(v_rule.config->>'orders_scope', 'any');  -- 'any' | 'in_scope'
      -- Only windows that have STARTED count — an in-year preview must not
      -- mark future ordering windows as missed.
      v_windows     := LEAST(ceil(12.0 / v_months),
                             floor((extract(month FROM v_end) - 1) / v_months) + 1)::int;
      SELECT COALESCE(jsonb_agg(s ORDER BY s->>'store'), '[]'::jsonb),
             COALESCE(sum((s->>'amount')::numeric), 0)
        INTO v_stores, v_rule_total
      FROM (
        SELECT jsonb_build_object(
          'store', f.cname, 'qbo_customer_id', f.cid,
          'cur_units', COALESCE(cur.units, 0),
          'windows_met', COALESCE(w.met, 0), 'windows_total', v_windows,
          'qualified', q.ok,
          'reason', CASE WHEN NOT q.ok THEN
            (v_windows - COALESCE(w.met, 0)) || ' of ' || v_windows || ' ordering windows missed' END,
          'payable_units', CASE WHEN q.ok THEN COALESCE(cur.units, 0) ELSE 0 END,
          'amount', round(CASE WHEN q.ok THEN COALESCE(cur.units, 0) * v_rule.amount ELSE 0 END, 2)
        ) AS s
        FROM _rb_family f
        LEFT JOIN LATERAL (
          SELECT sum(CASE WHEN i.txn_type = 'CreditMemo' THEN -l.quantity ELSE l.quantity END) units
          FROM ops.qbo_invoice_lines l JOIN ops.qbo_invoices i ON i.id = l.invoice_id
          WHERE i.customer_ref_id = f.cid AND i.txn_type IN ('Invoice','CreditMemo')
            AND i.txn_date BETWEEN v_start AND v_end AND l.quantity IS NOT NULL
            AND ops.fn_rebate_line_match(l.item_ref_id, l.item_name, v_rule.item_ids, v_rule.item_patterns)
        ) cur ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*) AS met FROM (
            SELECT floor((extract(month FROM i.txn_date) - 1) / v_months) AS w
            FROM ops.qbo_invoices i
            WHERE i.customer_ref_id = f.cid AND i.txn_type = 'Invoice'
              AND i.txn_date BETWEEN v_start AND v_end
              AND (v_orders_scope <> 'in_scope' OR EXISTS (
                SELECT 1 FROM ops.qbo_invoice_lines l WHERE l.invoice_id = i.id
                  AND ops.fn_rebate_line_match(l.item_ref_id, l.item_name, v_rule.item_ids, v_rule.item_patterns)))
            GROUP BY 1 HAVING count(DISTINCT i.id) >= v_min_orders
          ) ww
        ) w ON TRUE
        CROSS JOIN LATERAL (
          SELECT (v_windows - COALESCE(w.met, 0)) <= v_grace AND COALESCE(cur.units, 0) > 0 AS ok
        ) q
        WHERE COALESCE(cur.units, 0) <> 0
      ) rows;

    ELSIF v_rule.rule_type = 'flat_per_unit' THEN
      SELECT COALESCE(jsonb_agg(s ORDER BY s->>'store'), '[]'::jsonb),
             COALESCE(sum((s->>'amount')::numeric), 0)
        INTO v_stores, v_rule_total
      FROM (
        SELECT jsonb_build_object(
          'store', f.cname, 'qbo_customer_id', f.cid,
          'cur_units', cur.units, 'qualified', TRUE,
          'payable_units', cur.units, 'amount', round(cur.units * v_rule.amount, 2)
        ) AS s
        FROM _rb_family f
        JOIN LATERAL (
          SELECT sum(CASE WHEN i.txn_type = 'CreditMemo' THEN -l.quantity ELSE l.quantity END) units
          FROM ops.qbo_invoice_lines l JOIN ops.qbo_invoices i ON i.id = l.invoice_id
          WHERE i.customer_ref_id = f.cid AND i.txn_type IN ('Invoice','CreditMemo')
            AND i.txn_date BETWEEN v_start AND v_end AND l.quantity IS NOT NULL
            AND ops.fn_rebate_line_match(l.item_ref_id, l.item_name, v_rule.item_ids, v_rule.item_patterns)
        ) cur ON cur.units IS NOT NULL AND cur.units <> 0
      ) rows;

    ELSIF v_rule.rule_type = 'tiered_volume' THEN
      -- Chain-level: total in-scope units across the family, priced by tiers
      -- [{min_units, amount_per_unit}] sorted ascending. retroactive=true pays
      -- the reached tier's rate on ALL units; false pays each band marginally.
      v_tiers := COALESCE(v_rule.config->'tiers', '[]'::jsonb);
      v_retro := COALESCE((v_rule.config->>'retroactive')::boolean, TRUE);
      SELECT COALESCE(sum(CASE WHEN i.txn_type = 'CreditMemo' THEN -l.quantity ELSE l.quantity END), 0)
        INTO v_total_units
      FROM ops.qbo_invoice_lines l JOIN ops.qbo_invoices i ON i.id = l.invoice_id
      WHERE i.customer_ref_id IN (SELECT cid FROM _rb_family)
        AND i.txn_type IN ('Invoice','CreditMemo')
        AND i.txn_date BETWEEN v_start AND v_end AND l.quantity IS NOT NULL
        AND ops.fn_rebate_line_match(l.item_ref_id, l.item_name, v_rule.item_ids, v_rule.item_patterns);
      v_rule_total := 0; v_rate := NULL;
      IF v_retro THEN
        SELECT (t->>'amount_per_unit')::numeric INTO v_rate
        FROM jsonb_array_elements(v_tiers) t
        WHERE (t->>'min_units')::numeric <= v_total_units
        ORDER BY (t->>'min_units')::numeric DESC LIMIT 1;
        v_rule_total := round(COALESCE(v_rate, 0) * v_total_units, 2);
      ELSE
        FOR v_i IN 0 .. jsonb_array_length(v_tiers) - 1 LOOP
          v_band := (v_tiers->v_i->>'min_units')::numeric;
          v_next := CASE WHEN v_i + 1 < jsonb_array_length(v_tiers)
                         THEN (v_tiers->(v_i+1)->>'min_units')::numeric ELSE NULL END;
          IF v_total_units > v_band THEN
            v_rule_total := v_rule_total +
              (LEAST(v_total_units, COALESCE(v_next, v_total_units)) - v_band)
              * (v_tiers->v_i->>'amount_per_unit')::numeric;
          END IF;
        END LOOP;
        v_rule_total := round(v_rule_total, 2);
      END IF;
      v_stores := jsonb_build_array(jsonb_build_object(
        'store', 'Chain total', 'cur_units', v_total_units, 'qualified', v_rule_total > 0,
        'payable_units', v_total_units, 'amount', v_rule_total,
        'rate', v_rate, 'retroactive', v_retro));

    ELSIF v_rule.rule_type = 'fixed_per_store' THEN
      v_min_units := COALESCE((v_rule.config->>'min_units')::numeric, 1);
      SELECT COALESCE(jsonb_agg(s ORDER BY s->>'store'), '[]'::jsonb),
             COALESCE(sum((s->>'amount')::numeric), 0)
        INTO v_stores, v_rule_total
      FROM (
        SELECT jsonb_build_object(
          'store', f.cname, 'qbo_customer_id', f.cid,
          'cur_units', cur.units, 'qualified', TRUE,
          'payable_units', NULL, 'amount', v_rule.amount
        ) AS s
        FROM _rb_family f
        JOIN LATERAL (
          SELECT sum(CASE WHEN i.txn_type = 'CreditMemo' THEN -l.quantity ELSE l.quantity END) units
          FROM ops.qbo_invoice_lines l JOIN ops.qbo_invoices i ON i.id = l.invoice_id
          WHERE i.customer_ref_id = f.cid AND i.txn_type IN ('Invoice','CreditMemo')
            AND i.txn_date BETWEEN v_start AND v_end AND l.quantity IS NOT NULL
            AND ops.fn_rebate_line_match(l.item_ref_id, l.item_name, v_rule.item_ids, v_rule.item_patterns)
        ) cur ON cur.units >= v_min_units
      ) rows;
    END IF;

    v_grand := v_grand + COALESCE(v_rule_total, 0);
    v_rules := v_rules || jsonb_build_object(
      'rule_id', v_rule.id, 'rule_type', v_rule.rule_type, 'label', v_rule.label,
      'amount', v_rule.amount, 'config', v_rule.config,
      'item_ids', to_jsonb(v_rule.item_ids), 'item_patterns', to_jsonb(v_rule.item_patterns),
      'total', round(COALESCE(v_rule_total, 0), 2), 'stores', v_stores);
  END LOOP;

  RETURN jsonb_build_object(
    'program_id', v_prog.id, 'program', v_prog.name, 'code', v_prog.code,
    'qbo_customer_id', v_prog.qbo_customer_id, 'year', p_year,
    'period_start', v_start, 'period_end', v_end,
    'stores_in_family', (SELECT count(*) FROM _rb_family),
    'rules', v_rules, 'grand_total', round(v_grand, 2),
    'calculated_at', now());
END; $$;

REVOKE ALL ON FUNCTION ops.fn_rebate_calculate(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_rebate_calculate(UUID, INTEGER) TO authenticated, service_role;

-- ── 5. Annual settlement (STAFF) ─────────────────────────────────────────────
-- Runs the calculator, snapshots the result, and creates the Brixpense bill
-- (approved + as_bill) — the rebate check posts to QBO only when a human
-- clicks "Post to QuickBooks" in Brixpense. Idempotent per program-year.

CREATE OR REPLACE FUNCTION ops.fn_rebate_settlement_create(
  p_program_id UUID,
  p_year       INTEGER,
  p_notes      TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_prog   ops.rebate_programs%ROWTYPE;
  v_vendor TEXT;
  v_calc   JSONB;
  v_total  NUMERIC;
  v_ref    TEXT;
  v_id     UUID;
  v_er_id  UUID;
  v_lines  JSONB;
  v_email  TEXT := auth.jwt()->>'email';
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  SELECT * INTO v_prog FROM ops.rebate_programs WHERE id = p_program_id FOR UPDATE;
  IF v_prog.id IS NULL THEN RAISE EXCEPTION 'rebate program not found'; END IF;
  IF v_prog.qbo_vendor_id IS NULL THEN
    RAISE EXCEPTION 'link the program''s QBO vendor first — the rebate check needs a payee';
  END IF;
  SELECT display_name INTO v_vendor FROM ops.qbo_vendors WHERE qbo_vendor_id = v_prog.qbo_vendor_id;
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'linked QBO vendor % not found in the mirror', v_prog.qbo_vendor_id;
  END IF;
  IF EXISTS (SELECT 1 FROM ops.rebate_settlements
              WHERE program_id = p_program_id AND period_year = p_year AND status <> 'void') THEN
    RAISE EXCEPTION 'a settlement for % already exists for % — void it first to re-run', v_prog.code, p_year;
  END IF;

  v_calc  := ops.fn_rebate_calculate(p_program_id, p_year);
  v_total := (v_calc->>'grand_total')::numeric;
  IF COALESCE(v_total, 0) <= 0 THEN
    RAISE EXCEPTION 'calculated rebate for % is $0 — nothing to settle', p_year;
  END IF;

  v_ref := 'RB-' || upper(v_prog.code) || '-' || p_year;

  INSERT INTO ops.rebate_settlements (
    program_id, period_year, period_start, period_end, reference,
    total_amount, detail, notes, created_by
  ) VALUES (
    p_program_id, p_year, make_date(p_year,1,1), make_date(p_year,12,31), v_ref,
    v_total, v_calc, p_notes, auth.uid()
  ) RETURNING id INTO v_id;

  -- One Brixpense line per rebate rule.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'description', r->>'label' || ' · '
             || (SELECT count(*) FROM jsonb_array_elements(r->'stores') s
                  WHERE (s->>'qualified')::boolean AND COALESCE((s->>'amount')::numeric,0) > 0)
             || ' qualifying stores',
           'amount', (r->>'total')::numeric)), '[]'::jsonb)
    INTO v_lines
  FROM jsonb_array_elements(v_calc->'rules') r
  WHERE COALESCE((r->>'total')::numeric, 0) > 0;

  INSERT INTO ops.expense_requests (
    request_type, status, vendor_name, total_amount, receipt_date,
    tag, as_bill, auto_approved, memo, description, line_items,
    bill_number, entity, submitted_by, submitter_email, submitter_name,
    approved_at
  ) VALUES (
    'expense', 'approved', v_vendor, round(v_total, 2), make_date(p_year, 12, 31),
    'Rebate', TRUE, TRUE,
    'Contract rebate settlement ' || v_ref,
    v_prog.name || ' · calendar year ' || p_year || ' rebate per contract terms',
    v_lines, left(v_ref, 21), v_prog.entity,
    auth.uid(), v_email, COALESCE(v_email, 'Refractor Rebates'),
    now()
  ) RETURNING id INTO v_er_id;

  UPDATE ops.rebate_settlements SET expense_request_id = v_er_id WHERE id = v_id;

  RETURN jsonb_build_object(
    'settlement_id', v_id, 'reference', v_ref, 'year', p_year,
    'total_amount', round(v_total, 2), 'expense_request_id', v_er_id,
    'vendor', v_vendor);
END; $$;

REVOKE ALL ON FUNCTION ops.fn_rebate_settlement_create(UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_rebate_settlement_create(UUID, INTEGER, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION ops.fn_rebate_settlement_void(
  p_settlement_id UUID,
  p_reason        TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_st ops.rebate_settlements%ROWTYPE;
  v_er ops.expense_requests%ROWTYPE;
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  SELECT * INTO v_st FROM ops.rebate_settlements WHERE id = p_settlement_id FOR UPDATE;
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
  UPDATE ops.rebate_settlements
     SET status = 'void', voided_by = auth.uid(), voided_at = now(), void_reason = p_reason
   WHERE id = p_settlement_id;
END; $$;

REVOKE ALL ON FUNCTION ops.fn_rebate_settlement_void(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_rebate_settlement_void(UUID, TEXT) TO authenticated, service_role;

-- ── 6. Seed: Starbird corporate program per the signed master agreement ──────
-- APBG ↔ Chicken Coup, LLC "Exclusive Marketing, Beverage, and Equipment
-- Services Agreement", signed 2025-08-25 (36-month term). Rebates run
-- calendar-year Jan–Dec; report to the customer by Jan 31; check within 30
-- days of their approval. BIB volume = 3-gallon BIBs ('3G%' item names).
-- Two contract ambiguities are seeded as explicit knobs (flip in the UI):
--   growth basis 'all' (pays on all units once a store qualifies) vs
--   'incremental'; cadence read as ≥1 order per 2-month window.

DO $$
DECLARE v_pid UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM ops.rebate_programs WHERE upper(code) = 'STARBIRD') THEN RETURN; END IF;

  INSERT INTO ops.rebate_programs (code, name, qbo_customer_id, qbo_vendor_id, entity, notes)
  VALUES ('STARBIRD', 'Starbird corporate rebate program', '730', '1922', 'brix',
    'Per the APBG–Chicken Coup, LLC master agreement signed 2025-08-25 (36-month term; corporate outlets). '
    || 'Calendar-year rebates; data report to customer by Jan 31; check within 30 days of approval. '
    || 'Franchise outlets are governed by Exhibit C (same two rebates + $3,400/outlet/yr funding) — '
    || 'add a separate FRANCHISE program when franchise outlets come online.')
  RETURNING id INTO v_pid;

  INSERT INTO ops.rebate_rules (program_id, rule_type, label, amount, item_patterns, config, sort) VALUES
    (v_pid, 'volume_growth',
     '5% YoY BIB volume growth — $2.50/unit (per store)',
     2.50, ARRAY['3G%'],
     '{"growth_pct_min": 5, "basis": "all"}'::jsonb, 1),
    (v_pid, 'ordering_cadence',
     'Bi-monthly ordering recapture — $0.50/BIB unit',
     0.50, ARRAY['3G%'],
     '{"period_months": 2, "min_orders": 1, "grace_windows": 0, "orders_scope": "any"}'::jsonb, 2);
END $$;
