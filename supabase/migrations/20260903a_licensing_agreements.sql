-- ═════════════════════════════════════════════════════════════════════════════
-- 20260903a — Licensing agreements: the compounding fee is rate × cases made
-- ═════════════════════════════════════════════════════════════════════════════
-- AC Calderoni's fee for the syrup formula has been carried on every BOM as
-- item 1391 CANNING RUN FEE (SYRUP COMPOUNDING) — a flat $1,173.33 per run,
-- a Service line on the Calderoni PO that nobody could receive. Owner (Sky,
-- 2026-09-03): "the syrup compound isn't a receivable item, it's a calculation
-- that goes on its own tab called licensing agreements … a specific rate on
-- all [cases] that get made at Quantum … not on a PO but on a separate order
-- like a rebate would be … make it so I can adjust this number."
--
-- Model (mirrors 20260821a rebates — same RLS loop, same inline guards, same
-- expense_requests insert — but its OWN tables: a rebate keys on a customer
-- family and the invoice mirror; this keys on a vendor and on work orders):
--   licensing_programs   who we pay (vendor 1099), entity, month|quarter
--   licensing_rules      rate × basis (cases_produced by default), scope by formula
--   licensing_rule_rates append-only rate history (trigger-maintained)
--   licensing_accruals   ONE ROW PER WORK ORDER PER RULE, written at record_yield
--   licensing_settlements one non-void per (program, period) → Brixpense payable
--
-- ⚠ The accrual is written AT YIELD, not computed at settlement. A rebate
-- recomputes from invoices because its rate is fixed for the year; here the
-- rate is editable and runs land continuously, so computing at settle time
-- would silently reprice a run yielded three weeks earlier. The row carries
-- the rate in force on the yield date; a rate change is forward-only by
-- construction. It also lands in work_order_costs.detail (kind 'royalty') so
-- the per-case cost does not drop by $1,173/run when the BOM line leaves.
--
-- ⚠ The gallon line STAYS on the Calderoni PO (owner decision, same day) —
-- only 1391 comes off. Item 1391 is retired in production_items, NOT
-- deactivated in QuickBooks: it carries the Feb–Sep 2026 bill history.
--
-- ⚠ Staff-only surface. New functions carry INLINE guards (the 20260820b
-- generator does not cover them) — keep them on any CREATE OR REPLACE.
-- fn_wo_advance__i is edited as the INNER body; the wrapper is re-minted
-- only if absent.

BEGIN;

-- ── 1. Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ops.licensing_programs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL CHECK (length(code) BETWEEN 2 AND 10),  -- LIC-<CODE>-YYYYMM must fit bill_number (21)
  name          TEXT NOT NULL,
  qbo_vendor_id TEXT NOT NULL,                                        -- the licensor / payee
  entity        TEXT NOT NULL DEFAULT 'brix' CHECK (entity IN ('brix','freeflow','shared')),
  period_basis  TEXT NOT NULL DEFAULT 'month' CHECK (period_basis IN ('month','quarter')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  starts_on     DATE NOT NULL DEFAULT current_date,                   -- runs yielded before this never accrue
  notes         TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS licensing_programs_code_uq
  ON ops.licensing_programs (upper(code)) WHERE status <> 'ended';

CREATE TABLE IF NOT EXISTS ops.licensing_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id          UUID NOT NULL REFERENCES ops.licensing_programs(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,                                  -- printed on the Brixpense line
  basis               TEXT NOT NULL DEFAULT 'cases_produced'
                        CHECK (basis IN ('cases_produced','concentrate_gal_produced','finished_gal_produced')),
  rate                NUMERIC NOT NULL DEFAULT 0 CHECK (rate >= 0),   -- the CURRENT rate; history in licensing_rule_rates
  rate_unit           TEXT NOT NULL DEFAULT 'per case',               -- honest label: 'per case' | 'per raw gallon' …
  rate_effective_from DATE,                                           -- set alongside a rate change; NULL = today
  rate_note           TEXT,
  formula_ids         UUID[] NOT NULL DEFAULT '{}',                   -- empty = every flavour
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  sort                INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS licensing_rules_program_idx ON ops.licensing_rules (program_id);

CREATE TABLE IF NOT EXISTS ops.licensing_rule_rates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id        UUID NOT NULL REFERENCES ops.licensing_rules(id) ON DELETE CASCADE,
  rate           NUMERIC NOT NULL,
  rate_unit      TEXT NOT NULL,
  effective_from DATE NOT NULL DEFAULT current_date,
  note           TEXT,
  changed_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, effective_from)
);

CREATE TABLE IF NOT EXISTS ops.licensing_settlements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id         UUID NOT NULL REFERENCES ops.licensing_programs(id) ON DELETE RESTRICT,
  period_key         TEXT NOT NULL,                                   -- '2026-09' | '2026-Q3'
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  reference          TEXT NOT NULL,                                   -- LIC-<CODE>-YYYYMM | LIC-<CODE>-YYYYQn
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','void')),
  total_basis_qty    NUMERIC NOT NULL DEFAULT 0,
  total_amount       NUMERIC NOT NULL DEFAULT 0,
  detail             JSONB,                                           -- the per-run snapshot (vendor statement)
  notes              TEXT,
  expense_request_id UUID,
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_by          UUID,
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS licensing_settlements_period_uq
  ON ops.licensing_settlements (program_id, period_key) WHERE status <> 'void';

CREATE TABLE IF NOT EXISTS ops.licensing_accruals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id    UUID NOT NULL REFERENCES ops.licensing_programs(id) ON DELETE RESTRICT,
  rule_id       UUID NOT NULL REFERENCES ops.licensing_rules(id) ON DELETE RESTRICT,
  wo_id         UUID NOT NULL REFERENCES ops.work_orders(id) ON DELETE RESTRICT,
  basis_date    DATE NOT NULL,                                        -- yield date: decides the period
  basis         TEXT NOT NULL,
  basis_qty     NUMERIC NOT NULL,
  rate          NUMERIC NOT NULL,
  rate_unit     TEXT NOT NULL,
  amount        NUMERIC NOT NULL,
  snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb,                  -- batch code, flavour, cases, gal/case …
  settlement_id UUID REFERENCES ops.licensing_settlements(id) ON DELETE SET NULL,  -- NULL = unsettled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, wo_id)
);
CREATE INDEX IF NOT EXISTS licensing_accruals_open_idx
  ON ops.licensing_accruals (program_id, basis_date) WHERE settlement_id IS NULL;
CREATE INDEX IF NOT EXISTS licensing_accruals_settlement_idx ON ops.licensing_accruals (settlement_id);

-- ── 2. RLS + grants (staff-only both directions; the 20260821a loop) ────────

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['licensing_programs','licensing_rules','licensing_rule_rates','licensing_accruals','licensing_settlements'] LOOP
    EXECUTE format('ALTER TABLE ops.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ops.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON ops.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON ops.%I', t || '_staff', t);
    EXECUTE format(
      'CREATE POLICY %I ON ops.%I FOR ALL USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff())',
      t || '_staff', t);
  END LOOP;
END $$;

-- ── 3. Rate history trigger ──────────────────────────────────────────────────
-- Every insert, and every change to rate / rate_unit, appends a history row
-- effective from rate_effective_from (or today). Same-day re-edit overwrites
-- that day's row (a typo fixed within the hour is not two rates).

CREATE OR REPLACE FUNCTION ops.tg_licensing_rule_rate_history() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.rate = OLD.rate AND NEW.rate_unit = OLD.rate_unit
     AND NEW.rate_effective_from IS NOT DISTINCT FROM OLD.rate_effective_from THEN
    RETURN NEW;
  END IF;
  INSERT INTO ops.licensing_rule_rates (rule_id, rate, rate_unit, effective_from, note, changed_by)
  VALUES (NEW.id, NEW.rate, NEW.rate_unit, COALESCE(NEW.rate_effective_from, current_date), NEW.rate_note, auth.uid())
  ON CONFLICT (rule_id, effective_from) DO UPDATE
    SET rate = EXCLUDED.rate, rate_unit = EXCLUDED.rate_unit, note = EXCLUDED.note,
        changed_by = EXCLUDED.changed_by, created_at = now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS licensing_rules_rate_history ON ops.licensing_rules;
CREATE TRIGGER licensing_rules_rate_history
  AFTER INSERT OR UPDATE OF rate, rate_unit, rate_effective_from ON ops.licensing_rules
  FOR EACH ROW EXECUTE FUNCTION ops.tg_licensing_rule_rate_history();

-- ── 4. Period helpers (pure) ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ops.fn_licensing_period_key(p_basis TEXT, p_date DATE) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_basis = 'quarter'
              THEN to_char(p_date, 'YYYY') || '-Q' || extract(quarter FROM p_date)::int
              ELSE to_char(p_date, 'YYYY-MM') END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_licensing_period_bounds(p_basis TEXT, p_key TEXT)
RETURNS TABLE (period_start DATE, period_end DATE, ref_suffix TEXT)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_y INT; v_m INT; v_q INT;
BEGIN
  IF p_basis = 'quarter' THEN
    IF p_key !~ '^\d{4}-Q[1-4]$' THEN RAISE EXCEPTION 'period key % must look like 2026-Q3', p_key; END IF;
    v_y := left(p_key, 4)::int; v_q := right(p_key, 1)::int;
    period_start := make_date(v_y, (v_q - 1) * 3 + 1, 1);
    period_end   := (period_start + INTERVAL '3 months' - INTERVAL '1 day')::date;
    ref_suffix   := v_y::text || 'Q' || v_q;
  ELSE
    IF p_key !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'period key % must look like 2026-09', p_key; END IF;
    v_y := left(p_key, 4)::int; v_m := right(p_key, 2)::int;
    period_start := make_date(v_y, v_m, 1);
    period_end   := (period_start + INTERVAL '1 month' - INTERVAL '1 day')::date;
    ref_suffix   := to_char(period_start, 'YYYYMM');
  END IF;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION ops.fn_licensing_period_key(TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION ops.fn_licensing_period_bounds(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_licensing_period_key(TEXT, DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION ops.fn_licensing_period_bounds(TEXT, TEXT) TO authenticated, service_role;

-- ── 5. The accrual: one row per work order per rule, at yield ───────────────
-- Called by fn_wo_advance__i(record_yield) with the yield just recorded (the
-- WO row is updated AFTER this runs, hence the parameters), and by the
-- backfill. Idempotent on (rule, wo); a row already inside a settlement is
-- never touched — that money has been billed.

CREATE OR REPLACE FUNCTION ops.fn_licensing_accrue_wo(
  p_wo_id      UUID,
  p_yield_qty  NUMERIC DEFAULT NULL,
  p_yield_date DATE    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_wo        ops.work_orders%ROWTYPE;
  v_bom       ops.product_bom%ROWTYPE;
  v_formula   ops.product_formulas%ROWTYPE;
  v_item_name TEXT;
  v_qty       NUMERIC;
  v_date      DATE;
  v_basis     JSONB;
  v_conc_gpc  NUMERIC;   -- concentrate gal / case
  v_gal_gpc   NUMERIC;   -- finished gal / case
  v_rule      RECORD;
  v_rate      NUMERIC; v_unit TEXT;
  v_basis_qty NUMERIC; v_amount NUMERIC;
  v_snapshot  JSONB;
  v_row       ops.licensing_accruals%ROWTYPE;
  v_out       JSONB := '[]'::jsonb;
BEGIN
  IF auth.role() = 'authenticated' AND NOT ops.fn_is_staff() THEN
    RAISE EXCEPTION 'This function requires a staff account' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_wo FROM ops.work_orders WHERE id = p_wo_id;
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  v_qty  := COALESCE(p_yield_qty, v_wo.qty_produced_actual);
  IF v_qty IS NULL OR v_qty <= 0 THEN RETURN '[]'::jsonb; END IF;
  v_date := COALESCE(p_yield_date, v_wo.yield_recorded_at::date, current_date);

  SELECT * INTO v_bom FROM ops.product_bom WHERE id = v_wo.bom_id;
  IF v_bom.formula_id IS NOT NULL THEN
    SELECT * INTO v_formula FROM ops.product_formulas WHERE id = v_bom.formula_id;
  END IF;
  SELECT name INTO v_item_name FROM ops.qbo_items WHERE qbo_item_id = v_wo.finished_qbo_item_id;

  -- Gallon bases need the formula's dilution; a BOM without one simply has
  -- no gallon basis (the rule is skipped, not guessed).
  BEGIN
    v_basis    := ops.fn_formula_batch_basis(v_wo.bom_id);
    v_conc_gpc := (v_basis ->> 'concentrate_gal_per_case')::numeric;
    v_gal_gpc  := (v_basis ->> 'gal_per_case')::numeric;
  EXCEPTION WHEN OTHERS THEN
    v_conc_gpc := NULL; v_gal_gpc := NULL;
  END;

  FOR v_rule IN
    SELECT r.*, p.code AS program_code, p.name AS program_name, p.starts_on
      FROM ops.licensing_rules r
      JOIN ops.licensing_programs p ON p.id = r.program_id
     WHERE r.active AND p.status = 'active'
       AND p.starts_on <= v_date
       AND (cardinality(r.formula_ids) = 0
            OR (v_bom.formula_id IS NOT NULL AND v_bom.formula_id = ANY (r.formula_ids)))
     ORDER BY p.code, r.sort, r.created_at
  LOOP
    v_basis_qty := CASE v_rule.basis
      WHEN 'cases_produced'          THEN v_qty
      WHEN 'concentrate_gal_produced' THEN v_qty * v_conc_gpc
      WHEN 'finished_gal_produced'    THEN v_qty * v_gal_gpc
    END;
    IF v_basis_qty IS NULL THEN CONTINUE; END IF;   -- gallon basis on a BOM with no formula

    -- The rate in force on the yield date (history), else the rule's current rate.
    SELECT h.rate, h.rate_unit INTO v_rate, v_unit
      FROM ops.licensing_rule_rates h
     WHERE h.rule_id = v_rule.id AND h.effective_from <= v_date
     ORDER BY h.effective_from DESC LIMIT 1;
    IF v_rate IS NULL THEN v_rate := v_rule.rate; v_unit := v_rule.rate_unit; END IF;

    v_amount   := round(v_basis_qty * v_rate, 2);
    v_snapshot := jsonb_build_object(
      'batch_code', v_wo.batch_code,
      'formula_id', v_bom.formula_id,
      'flavour', COALESCE(v_formula.name, v_bom.name),
      'finished_item', v_item_name,
      'finished_qbo_item_id', v_wo.finished_qbo_item_id,
      'cases', v_qty,
      'concentrate_gal_per_case', v_conc_gpc,
      'gal_per_case', v_gal_gpc,
      'program', v_rule.program_name,
      'program_code', v_rule.program_code,
      'label', v_rule.label);

    INSERT INTO ops.licensing_accruals AS a (
      program_id, rule_id, wo_id, basis_date, basis, basis_qty, rate, rate_unit, amount, snapshot)
    VALUES (v_rule.program_id, v_rule.id, p_wo_id, v_date, v_rule.basis, v_basis_qty, v_rate, v_unit, v_amount, v_snapshot)
    ON CONFLICT (rule_id, wo_id) DO UPDATE
      SET basis_date = EXCLUDED.basis_date, basis = EXCLUDED.basis, basis_qty = EXCLUDED.basis_qty,
          rate = EXCLUDED.rate, rate_unit = EXCLUDED.rate_unit, amount = EXCLUDED.amount,
          snapshot = EXCLUDED.snapshot, updated_at = now()
      WHERE a.settlement_id IS NULL
    RETURNING * INTO v_row;

    IF v_row.id IS NOT NULL THEN
      v_out := v_out || jsonb_build_object(
        'accrual_id', v_row.id, 'program_id', v_row.program_id, 'program', v_rule.program_name,
        'rule_id', v_row.rule_id, 'label', v_rule.label, 'basis', v_row.basis,
        'basis_qty', v_row.basis_qty, 'rate', v_row.rate, 'rate_unit', v_row.rate_unit,
        'amount', v_row.amount, 'basis_date', v_row.basis_date);
    END IF;
    v_row := NULL;
  END LOOP;

  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION ops.fn_licensing_accrue_wo(UUID, NUMERIC, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_licensing_accrue_wo(UUID, NUMERIC, DATE) TO authenticated, service_role;

-- ── 6. The live view for the tab ─────────────────────────────────────────────
-- Accrued rows in the window (settled AND unsettled, each saying which), the
-- runs in production that have not yielded yet, and the totals.

CREATE OR REPLACE FUNCTION ops.fn_licensing_calculate(
  p_program_id   UUID,
  p_period_start DATE,
  p_period_end   DATE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_prog    ops.licensing_programs%ROWTYPE;
  v_vendor  TEXT;
  v_rules   JSONB := '[]'::jsonb;
  v_rule    RECORD;
  v_rows    JSONB; v_total NUMERIC; v_qty NUMERIC; v_unsettled NUMERIC;
  v_grand   NUMERIC := 0; v_grand_unsettled NUMERIC := 0;
  v_pending JSONB; v_settled JSONB;
BEGIN
  IF auth.role() = 'authenticated' AND NOT ops.fn_is_staff() THEN
    RAISE EXCEPTION 'This function requires a staff account' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_prog FROM ops.licensing_programs WHERE id = p_program_id;
  IF v_prog.id IS NULL THEN RAISE EXCEPTION 'licensing program not found'; END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RAISE EXCEPTION 'invalid period';
  END IF;
  SELECT display_name INTO v_vendor FROM ops.qbo_vendors WHERE qbo_vendor_id = v_prog.qbo_vendor_id;

  FOR v_rule IN
    SELECT * FROM ops.licensing_rules WHERE program_id = p_program_id ORDER BY sort, created_at
  LOOP
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'accrual_id', a.id, 'wo_id', a.wo_id,
             'batch_code', a.snapshot->>'batch_code', 'flavour', a.snapshot->>'flavour',
             'finished_item', a.snapshot->>'finished_item',
             'basis_date', a.basis_date, 'cases', (a.snapshot->>'cases')::numeric,
             'concentrate_gal_per_case', (a.snapshot->>'concentrate_gal_per_case')::numeric,
             'basis_qty', a.basis_qty, 'rate', a.rate, 'rate_unit', a.rate_unit, 'amount', a.amount,
             'wo_status', w.status,
             'settlement_id', a.settlement_id, 'settlement_reference', s.reference
           ) ORDER BY a.basis_date, a.snapshot->>'batch_code'), '[]'::jsonb),
           COALESCE(sum(a.amount), 0), COALESCE(sum(a.basis_qty), 0),
           COALESCE(sum(a.amount) FILTER (WHERE a.settlement_id IS NULL), 0)
      INTO v_rows, v_total, v_qty, v_unsettled
      FROM ops.licensing_accruals a
      JOIN ops.work_orders w ON w.id = a.wo_id
      LEFT JOIN ops.licensing_settlements s ON s.id = a.settlement_id
     WHERE a.rule_id = v_rule.id AND a.basis_date BETWEEN p_period_start AND p_period_end;

    v_grand := v_grand + v_total; v_grand_unsettled := v_grand_unsettled + v_unsettled;
    v_rules := v_rules || jsonb_build_object(
      'rule_id', v_rule.id, 'label', v_rule.label, 'basis', v_rule.basis,
      'current_rate', v_rule.rate, 'rate_unit', v_rule.rate_unit, 'active', v_rule.active,
      'work_orders', v_rows, 'total_basis_qty', v_qty,
      'total', round(v_total, 2), 'unsettled_total', round(v_unsettled, 2));
  END LOOP;

  -- Runs under way that will accrue when their yield is recorded.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'wo_id', w.id, 'batch_code', w.batch_code, 'status', w.status,
           'flavour', COALESCE(f.name, b.name), 'qty_to_produce', w.qty_to_produce,
           'production_started_at', w.production_started_at
         ) ORDER BY w.created_at), '[]'::jsonb)
    INTO v_pending
    FROM ops.work_orders w
    JOIN ops.product_bom b ON b.id = w.bom_id
    LEFT JOIN ops.product_formulas f ON f.id = b.formula_id
   WHERE w.status IN ('ordered','at_copacker','in_production')
     AND w.created_at::date >= v_prog.starts_on;

  SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
           'settlement_id', s.id, 'reference', s.reference, 'period_key', s.period_key,
           'total_amount', s.total_amount, 'status', s.status)), '[]'::jsonb)
    INTO v_settled
    FROM ops.licensing_accruals a JOIN ops.licensing_settlements s ON s.id = a.settlement_id
   WHERE a.program_id = p_program_id AND a.basis_date BETWEEN p_period_start AND p_period_end;

  RETURN jsonb_build_object(
    'program_id', v_prog.id, 'code', v_prog.code, 'program', v_prog.name,
    'vendor_id', v_prog.qbo_vendor_id, 'vendor_name', v_vendor,
    'period_start', p_period_start, 'period_end', p_period_end,
    'period_key', ops.fn_licensing_period_key(v_prog.period_basis, p_period_start),
    'period_ended', p_period_end < current_date,
    'rules', v_rules, 'pending', v_pending, 'already_settled', v_settled,
    'grand_total', round(v_grand, 2), 'unsettled_total', round(v_grand_unsettled, 2),
    'calculated_at', now());
END $$;
REVOKE ALL ON FUNCTION ops.fn_licensing_calculate(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_licensing_calculate(UUID, DATE, DATE) TO authenticated, service_role;

-- Re-price UNSETTLED accruals in a window from the rate history (a rate
-- typo, or a rate change back-dated before it was entered). Settled rows
-- never move — that money has been billed.
CREATE OR REPLACE FUNCTION ops.fn_licensing_recompute(
  p_program_id UUID, p_period_start DATE, p_period_end DATE
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_n INTEGER := 0;
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  WITH priced AS (
    SELECT a.id,
           COALESCE((SELECT h.rate FROM ops.licensing_rule_rates h
                      WHERE h.rule_id = a.rule_id AND h.effective_from <= a.basis_date
                      ORDER BY h.effective_from DESC LIMIT 1), r.rate) AS rate,
           COALESCE((SELECT h.rate_unit FROM ops.licensing_rule_rates h
                      WHERE h.rule_id = a.rule_id AND h.effective_from <= a.basis_date
                      ORDER BY h.effective_from DESC LIMIT 1), r.rate_unit) AS rate_unit
      FROM ops.licensing_accruals a JOIN ops.licensing_rules r ON r.id = a.rule_id
     WHERE a.program_id = p_program_id AND a.settlement_id IS NULL
       AND a.basis_date BETWEEN p_period_start AND p_period_end
  ), upd AS (
    UPDATE ops.licensing_accruals a
       SET rate = p.rate, rate_unit = p.rate_unit, amount = round(a.basis_qty * p.rate, 2), updated_at = now()
      FROM priced p WHERE p.id = a.id AND (a.rate <> p.rate OR a.rate_unit <> p.rate_unit)
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM upd;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION ops.fn_licensing_recompute(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_licensing_recompute(UUID, DATE, DATE) TO authenticated, service_role;

-- Backfill: accrue every yielded work order on/after the program's start
-- that has no row yet (a program added after runs were made).
CREATE OR REPLACE FUNCTION ops.fn_licensing_backfill(p_program_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_prog ops.licensing_programs%ROWTYPE; v_wo RECORD; v_before INT; v_after INT;
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  SELECT * INTO v_prog FROM ops.licensing_programs WHERE id = p_program_id;
  IF v_prog.id IS NULL THEN RAISE EXCEPTION 'licensing program not found'; END IF;
  SELECT count(*) INTO v_before FROM ops.licensing_accruals WHERE program_id = p_program_id;
  FOR v_wo IN
    SELECT id, qty_produced_actual, yield_recorded_at::date AS d
      FROM ops.work_orders
     WHERE qty_produced_actual IS NOT NULL AND status <> 'void'
       AND yield_recorded_at::date >= v_prog.starts_on
  LOOP
    PERFORM ops.fn_licensing_accrue_wo(v_wo.id, v_wo.qty_produced_actual, v_wo.d);
  END LOOP;
  SELECT count(*) INTO v_after FROM ops.licensing_accruals WHERE program_id = p_program_id;
  RETURN v_after - v_before;
END $$;
REVOKE ALL ON FUNCTION ops.fn_licensing_backfill(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_licensing_backfill(UUID) TO authenticated, service_role;

-- ── 7. Settlement (STAFF): a finished period → one Brixpense payable ────────
-- Sums the unsettled accruals in the period, snapshots the detail, stamps the
-- rows, and inserts the expense request (approved + as_bill). The check posts
-- to QuickBooks only when a human clicks "Post to QuickBooks" in Brixpense
-- (the 2026-08-14 rule). Refused for a period that has not ended — a run can
-- still yield on the 30th.

CREATE OR REPLACE FUNCTION ops.fn_licensing_settlement_create(
  p_program_id UUID,
  p_period_key TEXT,
  p_notes      TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_prog   ops.licensing_programs%ROWTYPE;
  v_vendor TEXT;
  v_b      RECORD;
  v_ref    TEXT;
  v_id     UUID; v_er_id UUID;
  v_total  NUMERIC; v_qty NUMERIC; v_runs INT;
  v_calc   JSONB; v_lines JSONB;
  v_email  TEXT := auth.jwt()->>'email';
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  SELECT * INTO v_prog FROM ops.licensing_programs WHERE id = p_program_id FOR UPDATE;
  IF v_prog.id IS NULL THEN RAISE EXCEPTION 'licensing program not found'; END IF;
  SELECT display_name INTO v_vendor FROM ops.qbo_vendors WHERE qbo_vendor_id = v_prog.qbo_vendor_id;
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'linked QBO vendor % not found in the mirror — pull vendors from QBO first', v_prog.qbo_vendor_id;
  END IF;
  SELECT * INTO v_b FROM ops.fn_licensing_period_bounds(v_prog.period_basis, p_period_key);
  IF v_b.period_end >= current_date THEN
    RAISE EXCEPTION 'period % has not finished — a run can still yield in it; settle it on or after %',
      p_period_key, (v_b.period_end + 1);
  END IF;
  IF EXISTS (SELECT 1 FROM ops.licensing_settlements
              WHERE program_id = p_program_id AND period_key = p_period_key AND status <> 'void') THEN
    RAISE EXCEPTION 'a settlement for % already exists for % — void it first to re-run', v_prog.code, p_period_key;
  END IF;

  SELECT COALESCE(sum(amount), 0), COALESCE(sum(basis_qty), 0), count(DISTINCT wo_id)
    INTO v_total, v_qty, v_runs
    FROM ops.licensing_accruals
   WHERE program_id = p_program_id AND settlement_id IS NULL
     AND basis_date BETWEEN v_b.period_start AND v_b.period_end;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'nothing unsettled accrued for % in % — nothing to settle', v_prog.code, p_period_key;
  END IF;

  v_ref := 'LIC-' || upper(v_prog.code) || '-' || v_b.ref_suffix;

  INSERT INTO ops.licensing_settlements (
    program_id, period_key, period_start, period_end, reference,
    total_basis_qty, total_amount, notes, created_by
  ) VALUES (
    p_program_id, p_period_key, v_b.period_start, v_b.period_end, v_ref,
    v_qty, round(v_total, 2), p_notes, auth.uid()
  ) RETURNING id INTO v_id;

  UPDATE ops.licensing_accruals SET settlement_id = v_id, updated_at = now()
   WHERE program_id = p_program_id AND settlement_id IS NULL
     AND basis_date BETWEEN v_b.period_start AND v_b.period_end;

  -- The snapshot is taken AFTER stamping so every row names this settlement.
  v_calc := ops.fn_licensing_calculate(p_program_id, v_b.period_start, v_b.period_end);
  UPDATE ops.licensing_settlements SET detail = v_calc WHERE id = v_id;

  -- One Brixpense line per (rule, rate) so a mid-period rate change reads as
  -- two lines rather than a blended number nobody can check.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'description', g.label || ' · ' || trim(to_char(g.qty, 'FM999,999,990.##')) || ' × $'
                          || trim(to_char(g.rate, 'FM999,990.00##')) || ' ' || g.rate_unit
                          || ' · ' || g.n || ' run' || CASE WHEN g.n = 1 THEN '' ELSE 's' END,
           'amount', round(g.amt, 2)) ORDER BY g.sort, g.rate), '[]'::jsonb)
    INTO v_lines
    FROM (
      SELECT r.label, r.sort, a.rate, a.rate_unit, sum(a.basis_qty) AS qty, sum(a.amount) AS amt, count(*) AS n
        FROM ops.licensing_accruals a JOIN ops.licensing_rules r ON r.id = a.rule_id
       WHERE a.settlement_id = v_id
       GROUP BY r.label, r.sort, a.rate, a.rate_unit
    ) g;

  INSERT INTO ops.expense_requests (
    request_type, status, vendor_name, total_amount, receipt_date,
    tag, as_bill, auto_approved, memo, description, line_items,
    bill_number, entity, submitted_by, submitter_email, submitter_name,
    approved_at
  ) VALUES (
    'expense', 'approved', v_vendor, round(v_total, 2), v_b.period_end,
    'Licensing', TRUE, TRUE,
    'Licensing royalty settlement ' || v_ref,
    v_prog.name || ' · ' || p_period_key || ' · ' || v_runs || ' production run'
      || CASE WHEN v_runs = 1 THEN '' ELSE 's' END || ' at the co-packer',
    v_lines, left(v_ref, 21), v_prog.entity,
    auth.uid(), v_email, COALESCE(v_email, 'Refractor Licensing'),
    now()
  ) RETURNING id INTO v_er_id;

  UPDATE ops.licensing_settlements SET expense_request_id = v_er_id WHERE id = v_id;

  RETURN jsonb_build_object(
    'settlement_id', v_id, 'reference', v_ref, 'period_key', p_period_key,
    'total_basis_qty', v_qty, 'total_amount', round(v_total, 2), 'runs', v_runs,
    'expense_request_id', v_er_id, 'vendor', v_vendor);
END $$;
REVOKE ALL ON FUNCTION ops.fn_licensing_settlement_create(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_licensing_settlement_create(UUID, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION ops.fn_licensing_settlement_void(
  p_settlement_id UUID,
  p_reason        TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_st ops.licensing_settlements%ROWTYPE; v_er ops.expense_requests%ROWTYPE;
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  SELECT * INTO v_st FROM ops.licensing_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF v_st.id IS NULL THEN RAISE EXCEPTION 'settlement not found'; END IF;
  IF v_st.status = 'void' THEN RETURN; END IF;
  IF v_st.expense_request_id IS NOT NULL THEN
    SELECT * INTO v_er FROM ops.expense_requests WHERE id = v_st.expense_request_id;
    IF v_er.id IS NOT NULL AND (v_er.qbo_bill_id IS NOT NULL OR v_er.status = 'posted') THEN
      RAISE EXCEPTION 'settlement % already posted to QuickBooks (bill %) — handle it in QBO, not here',
        v_st.reference, v_er.qbo_bill_id;
    END IF;
    UPDATE ops.expense_requests SET archived_at = now(), archived_by = auth.uid()
     WHERE id = v_st.expense_request_id;
  END IF;
  -- Release the runs so a re-run of the period picks them up again.
  UPDATE ops.licensing_accruals SET settlement_id = NULL, updated_at = now() WHERE settlement_id = p_settlement_id;
  UPDATE ops.licensing_settlements
     SET status = 'void', voided_by = auth.uid(), voided_at = now(), void_reason = p_reason
   WHERE id = p_settlement_id;
END $$;
REVOKE ALL ON FUNCTION ops.fn_licensing_settlement_void(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_licensing_settlement_void(UUID, TEXT) TO authenticated, service_role;

-- ── 8. Item 1391 comes off the BOM; the program that replaces it is seeded ──
-- Retired in the purchased-item master, NOT deactivated in QuickBooks (it
-- carries the Feb–Sep 2026 bill history — the 20260902u rule).

DELETE FROM ops.product_bom_lines WHERE component_qbo_item_id = '1391';

UPDATE ops.production_items
   SET active = FALSE,
       cost_note = 'Retired 2026-09-03: the flat per-run compounding fee is replaced by the Licensing royalty (Production → Licensing, rate × cases produced, accrued at yield). Do not put this line back on a BOM.',
       updated_at = now()
 WHERE qbo_item_id = '1391';

DO $$
DECLARE v_pid UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM ops.licensing_programs WHERE upper(code) = 'CALDERONI') THEN RETURN; END IF;
  INSERT INTO ops.licensing_programs (code, name, qbo_vendor_id, entity, period_basis, starts_on, notes)
  VALUES ('CALDERONI', 'AC Calderoni syrup licensing', '1099', 'brix', 'month', current_date,
    'Replaces the flat CANNING RUN FEE (SYRUP COMPOUNDING), item 1391, that rode every BOM at $1,173.33 per run. '
    || 'Rate seeded from the owner (Sky, 2026-09-03) as $0.50 per case of finished soda made at Quantum — CONFIRM against the agreement before the first settlement. '
    || 'Settled monthly into a Brixpense payable; the check posts from Brixpense.')
  RETURNING id INTO v_pid;
  INSERT INTO ops.licensing_rules (program_id, label, basis, rate, rate_unit, rate_effective_from, rate_note, sort)
  VALUES (v_pid, 'Syrup licensing royalty — per case produced at Quantum', 'cases_produced', 0.50, 'per case', current_date,
          'seeded 2026-09-03 from the owner — confirm against the agreement', 1);
END $$;

-- The Brixpense tag dropdown learns the word (expense_requests.tag is free text;
-- this only affects the picker).
UPDATE ops.expense_settings
   SET value = value || '["Licensing"]'::jsonb
 WHERE key = 'tags' AND jsonb_typeof(value) = 'array' AND NOT (value ? 'Licensing');

-- ── 9. fn_wo_advance__i: accrue the royalty at record_yield ──────────────────
-- The INNER body (20260820b rule): the live definition after this change,
-- verbatim (pg_get_functiondef; md5 of the body b3e38c1e616bd160778b5f95b3bb0f5b).
-- Two additions over 20260902t: the v_royalty declarations and the accrual
-- block ahead of v_total_cost. ⚠ The 20260902t FILE carried comments the
-- applied function did not; this file matches what is live. The wrapper is
-- re-minted only if absent.

CREATE OR REPLACE FUNCTION ops.fn_wo_advance__i(p_wo_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'pg_temp'
AS $function$
DECLARE
  v_wo               ops.work_orders%ROWTYPE;
  v_actor            UUID := auth.uid();
  v_yield_qty        NUMERIC;
  v_copack_fee       NUMERIC;
  v_freight          NUMERIC;
  v_other            NUMERIC;
  v_components_cost  NUMERIC := 0;
  v_services_cost    NUMERIC := 0;
  v_fees_cost        NUMERIC := 0;
  v_total_cost       NUMERIC;
  v_unit_cost        NUMERIC;
  v_detail           JSONB := '[]'::jsonb;
  v_runs             NUMERIC;
  v_bom              ops.product_bom%ROWTYPE;
  v_transfer_id      UUID;
  v_bol              TEXT;
  v_po               RECORD;
  v_per_case         NUMERIC;
  v_per_can          NUMERIC;
  v_per_oz           NUMERIC;
  v_per_gal          NUMERIC;
  v_yield_pct        NUMERIC;
  v_lines            JSONB;
  v_lot_count        INTEGER;
  v_royalty          JSONB := '[]'::jsonb;   -- 20260903a: licensing accruals written at yield
  v_royalty_cost     NUMERIC := 0;
BEGIN
  SELECT * INTO v_wo FROM ops.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'work order not found'; END IF;
  SELECT * INTO v_bom FROM ops.product_bom WHERE id = v_wo.bom_id;

  IF p_action = 'materials_at_copacker' THEN
    IF v_wo.status <> 'ordered' THEN
      RAISE EXCEPTION 'work order is %, expected ordered', v_wo.status;
    END IF;
    UPDATE ops.work_orders
       SET status = 'at_copacker', materials_at_copacker_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    VALUES (p_wo_id, 'materials_at_copacker', v_wo.status, 'at_copacker',
            'Raw materials at co-packer', v_actor);
    RETURN;
  END IF;

  IF p_action = 'start_production' THEN
    IF v_wo.status NOT IN ('ordered','at_copacker') THEN
      RAISE EXCEPTION 'work order is %, expected ordered/at_copacker', v_wo.status;
    END IF;

    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty,
      from_location_id, to_location_id, unit_cost,
      source_doc_type, source_doc_id, source_doc_line_id,
      occurred_at, created_by, notes
    )
    SELECT
      'production_consume', m.component_qbo_item_id, m.required_qty,
      v_wo.copacker_location_id, NULL,
      COALESCE(pl.unit_cost, m.unit_cost_est),
      'work_order', p_wo_id, m.id,
      now(), v_actor,
      'WO consume · ' || v_wo.batch_code
    FROM ops.work_order_materials m
    LEFT JOIN ops.purchase_order_lines pl ON pl.id = m.po_line_id
    WHERE m.wo_id = p_wo_id;

    UPDATE ops.work_orders
       SET status = 'in_production', production_started_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    VALUES (p_wo_id, 'start_production', v_wo.status, 'in_production',
            'Production started at co-packer (raw materials consumed)', v_actor);
    RETURN;
  END IF;

  IF p_action = 'record_yield' THEN
    IF v_wo.status <> 'in_production' THEN
      RAISE EXCEPTION 'work order is %, expected in_production', v_wo.status;
    END IF;
    v_yield_qty := NULLIF(p_payload ->> 'actual_yield_qty', '')::numeric;
    IF v_yield_qty IS NULL OR v_yield_qty <= 0 THEN
      RAISE EXCEPTION 'actual_yield_qty must be > 0';
    END IF;
    v_copack_fee := COALESCE(NULLIF(p_payload ->> 'copack_fee', '')::numeric, 0);
    v_freight    := COALESCE(NULLIF(p_payload ->> 'freight_cost', '')::numeric, 0);
    v_other      := COALESCE(NULLIF(p_payload ->> 'other_cost', '')::numeric, 0);
    v_runs       := v_wo.qty_to_produce / v_bom.yield_qty;

    SELECT
      COALESCE(sum(m.required_qty * COALESCE(pl.unit_cost, m.unit_cost_est, 0)), 0),
      COALESCE(jsonb_agg(jsonb_build_object(
        'kind', 'component',
        'label', COALESCE(m.item_name, m.component_qbo_item_id),
        'qbo_item_id', m.component_qbo_item_id,
        'qty', m.required_qty,
        'uom', m.uom,
        'unit_cost', COALESCE(pl.unit_cost, m.unit_cost_est),
        'extended_cost', m.required_qty * COALESCE(pl.unit_cost, m.unit_cost_est, 0),
        'notes', m.notes
      ) ORDER BY m.sort_order), '[]'::jsonb)
    INTO v_components_cost, v_detail
    FROM ops.work_order_materials m
    LEFT JOIN ops.purchase_order_lines pl ON pl.id = m.po_line_id
    WHERE m.wo_id = p_wo_id;

    SELECT
      COALESCE(sum(l.qty_per * v_runs * COALESCE(l.default_cost, 0)), 0),
      v_detail || COALESCE(jsonb_agg(jsonb_build_object(
        'kind', 'service',
        'label', l.service_label,
        'qty', l.qty_per * v_runs,
        'unit_cost', l.default_cost,
        'extended_cost', l.qty_per * v_runs * COALESCE(l.default_cost, 0),
        'notes', l.notes
      ) ORDER BY l.sort_order), '[]'::jsonb)
    INTO v_services_cost, v_detail
    FROM ops.product_bom_lines l
    WHERE l.bom_id = v_wo.bom_id AND l.line_type = 'service';

    v_fees_cost := v_copack_fee + v_freight + v_other;
    IF v_copack_fee > 0 THEN
      v_detail := v_detail || jsonb_build_object('kind','landed_cost','label','Co-pack fee','qty',1,'unit_cost',v_copack_fee,'extended_cost',v_copack_fee,'notes',NULL);
    END IF;
    IF v_freight > 0 THEN
      v_detail := v_detail || jsonb_build_object('kind','landed_cost','label','Freight','qty',1,'unit_cost',v_freight,'extended_cost',v_freight,'notes',NULL);
    END IF;
    IF v_other > 0 THEN
      v_detail := v_detail || jsonb_build_object('kind','landed_cost','label','Other landed cost','qty',1,'unit_cost',v_other,'extended_cost',v_other,'notes',NULL);
    END IF;

    -- Licensing royalty (20260903a). The compounding fee that used to ride the
    -- BOM as item 1391 (flat, per run) is now rate × final cases produced,
    -- accrued here so (a) the per-case cost does not silently drop when the
    -- BOM line leaves, and (b) the accrual is stamped with the rate in force
    -- on the yield date — a later rate change never reprices a run already
    -- made. Nothing is posted anywhere: the accrual is settled per period from
    -- the Licensing tab. The yield qty/date are passed in because this runs
    -- BEFORE the UPDATE that writes qty_produced_actual below.
    v_royalty := ops.fn_licensing_accrue_wo(
      p_wo_id, v_yield_qty,
      COALESCE(NULLIF(p_payload ->> 'yield_date','')::date, current_date));
    SELECT COALESCE(sum((r->>'amount')::numeric), 0) INTO v_royalty_cost
      FROM jsonb_array_elements(v_royalty) r;
    IF v_royalty_cost <> 0 THEN
      v_fees_cost := v_fees_cost + v_royalty_cost;
      SELECT v_detail || COALESCE(jsonb_agg(jsonb_build_object(
               'kind', 'royalty',
               'label', r->>'label',
               'qty', (r->>'basis_qty')::numeric,
               'uom', r->>'rate_unit',
               'unit_cost', (r->>'rate')::numeric,
               'extended_cost', (r->>'amount')::numeric,
               'notes', r->>'program')), '[]'::jsonb)
        INTO v_detail
        FROM jsonb_array_elements(v_royalty) r;
    END IF;

    v_total_cost := v_components_cost + v_services_cost + v_fees_cost;
    v_unit_cost  := v_total_cost / v_yield_qty;
    v_yield_pct  := CASE WHEN COALESCE(v_wo.expected_units, 0) > 0
                         THEN round(100.0 * v_yield_qty / v_wo.expected_units, 2) END;

    IF COALESCE(v_bom.cans_per_case, 0) > 0 AND COALESCE(v_bom.oz_per_can, 0) > 0 THEN
      v_per_case := v_unit_cost;
      v_per_can  := v_unit_cost / v_bom.cans_per_case;
      v_per_oz   := v_per_can / v_bom.oz_per_can;
      v_per_gal  := v_total_cost / (v_yield_qty * v_bom.cans_per_case * v_bom.oz_per_can / 128.0);
    END IF;

    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty,
      from_location_id, to_location_id, unit_cost,
      source_doc_type, source_doc_id,
      occurred_at, created_by, notes
    ) VALUES (
      'production_yield', v_wo.finished_qbo_item_id, v_yield_qty,
      NULL, v_wo.copacker_location_id, v_unit_cost,
      'work_order', p_wo_id,
      COALESCE(NULLIF(p_payload ->> 'yield_date','')::date::timestamptz, now()), v_actor,
      'WO yield · ' || v_wo.batch_code
    );

    INSERT INTO ops.work_order_costs (
      wo_id, components_cost, services_cost, total_cost, unit_cost,
      qty_produced, per_case, per_can, per_oz, per_gal_finished,
      actual_yield_pct, yield_loss_dollars, detail, computed_at
    ) VALUES (
      p_wo_id, v_components_cost, v_services_cost + v_fees_cost, v_total_cost, v_unit_cost,
      v_yield_qty, v_per_case, v_per_can, v_per_oz, v_per_gal,
      v_yield_pct,
      CASE WHEN COALESCE(v_wo.expected_units,0) > v_yield_qty
           THEN (v_wo.expected_units - v_yield_qty) * v_unit_cost END,
      v_detail, now()
    )
    ON CONFLICT (wo_id) DO UPDATE SET
      components_cost = EXCLUDED.components_cost,
      services_cost   = EXCLUDED.services_cost,
      total_cost      = EXCLUDED.total_cost,
      unit_cost       = EXCLUDED.unit_cost,
      qty_produced    = EXCLUDED.qty_produced,
      per_case        = EXCLUDED.per_case,
      per_can         = EXCLUDED.per_can,
      per_oz          = EXCLUDED.per_oz,
      per_gal_finished = EXCLUDED.per_gal_finished,
      actual_yield_pct = EXCLUDED.actual_yield_pct,
      yield_loss_dollars = EXCLUDED.yield_loss_dollars,
      detail          = EXCLUDED.detail,
      computed_at     = now();

    UPDATE ops.work_orders
       SET status = 'yield_recorded',
           qty_produced_actual = v_yield_qty,
           actual_yield_qty = v_yield_qty,
           yield_pct = v_yield_pct,
           yield_recorded_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
    VALUES (p_wo_id, 'record_yield', v_wo.status, 'yield_recorded',
            'Yield recorded: ' || v_yield_qty || ' units'
              || COALESCE(' (' || v_yield_pct || '% of plan)', ''),
            p_payload - 'lots', v_actor);

    IF p_payload ? 'lots' AND jsonb_typeof(p_payload -> 'lots') = 'array' AND jsonb_array_length(p_payload -> 'lots') > 0 THEN
      PERFORM ops.fn_wo_set_lots__i(p_wo_id, p_payload -> 'lots');
    END IF;
    RETURN;
  END IF;

  IF p_action = 'ship' THEN
    IF v_wo.status <> 'yield_recorded' THEN
      RAISE EXCEPTION 'work order is %, expected yield_recorded', v_wo.status;
    END IF;

    IF p_payload ? 'lots' AND jsonb_typeof(p_payload -> 'lots') = 'array' THEN
      PERFORM ops.fn_wo_set_lots__i(p_wo_id, p_payload -> 'lots');
    END IF;

    SELECT unit_cost INTO v_unit_cost FROM ops.work_order_costs WHERE wo_id = p_wo_id;

    SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object(
             'qbo_item_id', v_wo.finished_qbo_item_id,
             'qty', wl.qty,
             'unit_cost', v_unit_cost,
             'lot_code', wl.lot_code,
             'born_on_date', wl.born_on_date,
             'best_by_date', wl.best_by_date,
             'notes', 'Finished goods · WO ' || v_wo.batch_code || ' · lot ' || wl.lot_code
           ) ORDER BY wl.sort_order), '[]'::jsonb)
      INTO v_lot_count, v_lines
      FROM ops.work_order_lots wl WHERE wl.wo_id = p_wo_id;
    IF v_lot_count = 0 THEN
      v_lines := jsonb_build_array(jsonb_build_object(
        'qbo_item_id', v_wo.finished_qbo_item_id,
        'qty', v_wo.qty_produced_actual,
        'unit_cost', v_unit_cost,
        'notes', 'Finished goods · WO ' || v_wo.batch_code
      ));
    END IF;

    v_transfer_id := ops.fn_create_transfer(
      v_wo.copacker_location_id,
      v_wo.destination_location_id,
      v_lines,
      NULLIF(p_payload ->> 'carrier', ''),
      NULLIF(p_payload ->> 'tracking', ''),
      'Work order ' || v_wo.batch_code || ' — finished goods return',
      NULLIF(p_payload ->> 'pro_number', ''),
      NULLIF(p_payload ->> 'freight_terms', ''),
      NULLIF(p_payload ->> 'total_weight_lbs', '')::numeric,
      NULLIF(p_payload ->> 'total_pallets', '')::numeric,
      NULL::numeric,
      NULLIF(p_payload ->> 'special_instructions', '')
    );
    PERFORM ops.fn_ship_transfer(
      v_transfer_id,
      NULLIF(p_payload ->> 'ship_date','')::date,
      NULLIF(p_payload ->> 'shipper_signature_name','')::text
    );

    SELECT bol_number INTO v_bol FROM ops.inventory_transfers WHERE id = v_transfer_id;

    UPDATE ops.work_orders
       SET status = 'in_transit',
           transfer_id = v_transfer_id,
           ship_carrier = NULLIF(p_payload ->> 'carrier', ''),
           ship_tracking = NULLIF(p_payload ->> 'tracking', ''),
           ship_bol_number = v_bol,
           shipped_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
    VALUES (p_wo_id, 'ship', v_wo.status, 'in_transit',
            'Shipped from co-packer · BOL ' || v_bol
              || CASE WHEN v_lot_count > 0 THEN ' · ' || v_lot_count || ' lot(s)' ELSE '' END,
            p_payload - 'lots', v_actor);
    RETURN;
  END IF;

  IF p_action = 'receive' THEN
    IF v_wo.status <> 'in_transit' THEN
      RAISE EXCEPTION 'work order is %, expected in_transit', v_wo.status;
    END IF;
    IF v_wo.transfer_id IS NULL THEN
      RAISE EXCEPTION 'work order has no shipping transfer';
    END IF;
    PERFORM ops.fn_receive_transfer(
      v_wo.transfer_id,
      NULLIF(p_payload ->> 'received_date','')::date,
      NULLIF(p_payload ->> 'receiver_signature_name','')::text
    );

    UPDATE ops.work_orders
       SET status = 'received', received_at = now()
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    VALUES (p_wo_id, 'receive', v_wo.status, 'received',
            'Finished goods received into inventory', v_actor);
    RETURN;
  END IF;

  IF p_action = 'close' THEN
    IF v_wo.status <> 'received' THEN
      RAISE EXCEPTION 'work order is %, expected received', v_wo.status;
    END IF;
    UPDATE ops.work_orders
       SET status = 'closed', closed_at = now(), closed_by = v_actor
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, created_by)
    VALUES (p_wo_id, 'close', v_wo.status, 'closed', 'Work order closed', v_actor);
    RETURN;
  END IF;

  IF p_action = 'void' THEN
    IF v_wo.status NOT IN ('draft','ordered','at_copacker') THEN
      RAISE EXCEPTION 'work order is %, can only void before production starts', v_wo.status;
    END IF;
    FOR v_po IN
      SELECT p.id, p.po_number, p.status,
             EXISTS (SELECT 1 FROM ops.purchase_order_lines pl
                      WHERE pl.po_id = p.id AND pl.qty_received > 0) AS has_receipts
        FROM ops.purchase_orders p
        WHERE p.work_order_id = p_wo_id AND p.status NOT IN ('void','closed')
    LOOP
      IF v_po.has_receipts THEN
        RAISE EXCEPTION 'PO % has receipts — close it out before voiding this work order', v_po.po_number;
      END IF;
      UPDATE ops.purchase_orders
         SET status = 'void', voided_at = now(), voided_by = v_actor,
             void_reason = 'Work order ' || v_wo.batch_code || ' voided'
       WHERE id = v_po.id;
    END LOOP;

    UPDATE ops.work_orders
       SET status = 'void', voided_at = now(), voided_by = v_actor,
           void_reason = NULLIF(p_payload ->> 'reason', '')
     WHERE id = p_wo_id;
    INSERT INTO ops.work_order_events (wo_id, event_type, from_status, to_status, note, payload, created_by)
    VALUES (p_wo_id, 'void', v_wo.status, 'void',
            COALESCE(NULLIF(p_payload ->> 'reason',''), 'Voided'), p_payload, v_actor);
    RETURN;
  END IF;

  RAISE EXCEPTION 'unknown action %', p_action;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'ops' AND p.proname = 'fn_wo_advance'
       AND p.prosrc LIKE '%fn_wo_advance__i%'
  ) THEN
    EXECUTE $w$
      CREATE OR REPLACE FUNCTION ops.fn_wo_advance(p_wo_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
       RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
      AS $function$-- GENERATED GUARD WRAPPER (20260903a) — the real body lives in ops.fn_wo_advance__i. Edit THAT.
      BEGIN PERFORM ops.fn_assert_internal(); PERFORM ops.fn_wo_advance__i($1, $2, $3); END$function$
    $w$;
  END IF;
END $$;
REVOKE ALL ON FUNCTION ops.fn_wo_advance__i(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_wo_advance(uuid, text, jsonb) TO authenticated, service_role;

COMMIT;
