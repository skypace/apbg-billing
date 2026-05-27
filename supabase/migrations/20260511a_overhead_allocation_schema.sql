-- Workstream B Phase 1: Overhead allocation schema.
--
-- Two tables + one read RPC. Per-row allocation math runs in the app
-- so the UI can swap allocation basis without a DB round-trip.
--
-- overhead_pools         - named monthly overhead buckets, optional per-entity.
-- overhead_overrides     - per-dim share overrides (manual share or exclusion).
-- fn_overhead_total      - prorates monthly_amount across a date window.

CREATE TABLE IF NOT EXISTS ops.overhead_pools (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  entity          TEXT NULL,
  monthly_amount  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  basis           TEXT NOT NULL DEFAULT 'revenue'
                  CHECK (basis IN ('revenue', 'unit_volume', 'sku_equal_share', 'margin_contribution')),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to    DATE NULL,
  notes           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS overhead_pools_active_idx
  ON ops.overhead_pools (active, effective_from, effective_to);

CREATE TABLE IF NOT EXISTS ops.overhead_overrides (
  id          BIGSERIAL PRIMARY KEY,
  pool_id     BIGINT NOT NULL REFERENCES ops.overhead_pools(id) ON DELETE CASCADE,
  dim         TEXT NOT NULL
              CHECK (dim IN ('item', 'category', 'customer', 'channel', 'segment', 'entity')),
  dim_label   TEXT NOT NULL,
  share_pct   NUMERIC(8, 4) NULL,
  exclude     BOOLEAN NOT NULL DEFAULT FALSE,
  notes       TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pool_id, dim, dim_label)
);

CREATE INDEX IF NOT EXISTS overhead_overrides_pool_idx
  ON ops.overhead_overrides (pool_id, dim);

-- RLS - mirrors the channels / item_sets pattern.
ALTER TABLE ops.overhead_pools     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.overhead_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS overhead_pools_read      ON ops.overhead_pools;
DROP POLICY IF EXISTS overhead_pools_write     ON ops.overhead_pools;
DROP POLICY IF EXISTS overhead_overrides_read  ON ops.overhead_overrides;
DROP POLICY IF EXISTS overhead_overrides_write ON ops.overhead_overrides;

CREATE POLICY overhead_pools_read      ON ops.overhead_pools     FOR SELECT TO anon, authenticated USING (TRUE);
CREATE POLICY overhead_pools_write     ON ops.overhead_pools     FOR ALL    TO authenticated      USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY overhead_overrides_read  ON ops.overhead_overrides FOR SELECT TO anon, authenticated USING (TRUE);
CREATE POLICY overhead_overrides_write ON ops.overhead_overrides FOR ALL    TO authenticated      USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.overhead_pools, ops.overhead_overrides TO authenticated;
GRANT SELECT ON ops.overhead_pools, ops.overhead_overrides TO anon;
GRANT USAGE ON SEQUENCE ops.overhead_pools_id_seq, ops.overhead_overrides_id_seq TO authenticated;

-- fn_overhead_total(start, end, entity)
-- Returns per-pool prorated total for the window. Front-end multiplies pool_total
-- by each row's share (revenue / qty / sku-equal / margin) to get per-row overhead.
-- Days-prorated by 30.4375 (avg days/month) so partial months work cleanly.
CREATE OR REPLACE FUNCTION ops.fn_overhead_total(
  p_start  DATE,
  p_end    DATE,
  p_entity TEXT DEFAULT NULL
)
RETURNS TABLE (
  pool_id        BIGINT,
  pool_name      TEXT,
  basis          TEXT,
  entity         TEXT,
  monthly_amount NUMERIC,
  pool_total     NUMERIC,
  months         NUMERIC
)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = ops, public
AS $$
  SELECT
    p.id        AS pool_id,
    p.name      AS pool_name,
    p.basis,
    p.entity,
    p.monthly_amount,
    ROUND(
      p.monthly_amount *
        GREATEST(0, (LEAST(p_end, COALESCE(p.effective_to, p_end))
                      - GREATEST(p_start, p.effective_from)
                      + 1)::NUMERIC
                     / 30.4375),
      2
    ) AS pool_total,
    ROUND(
      GREATEST(0, (LEAST(p_end, COALESCE(p.effective_to, p_end))
                    - GREATEST(p_start, p.effective_from)
                    + 1)::NUMERIC / 30.4375),
      4
    ) AS months
  FROM ops.overhead_pools p
  WHERE p.active
    AND p.effective_from <= p_end
    AND (p.effective_to IS NULL OR p.effective_to >= p_start)
    AND (p_entity IS NULL OR p.entity IS NULL OR p.entity = p_entity);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_overhead_total(DATE, DATE, TEXT) TO authenticated;
