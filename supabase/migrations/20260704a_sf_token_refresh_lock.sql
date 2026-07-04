-- Service Fusion OAuth refresh hardening.
--
-- Service Fusion refresh tokens rotate. If two scheduled jobs refresh from the
-- same stale token at the same time, one can invalidate the other and the next
-- cron wave becomes a string of "SF token fail 400" errors. Add a tiny shared
-- lease on ops.sf_token_cache so Edge and Netlify callers use one refresh owner.

DO $$
BEGIN
  IF to_regclass('ops.sf_token_cache') IS NOT NULL THEN
    ALTER TABLE ops.sf_token_cache
      ADD COLUMN IF NOT EXISTS refresh_locked_until timestamptz,
      ADD COLUMN IF NOT EXISTS refresh_lock_owner text,
      ADD COLUMN IF NOT EXISTS last_refresh_error text,
      ADD COLUMN IF NOT EXISTS last_refresh_error_at timestamptz;

    COMMENT ON COLUMN ops.sf_token_cache.refresh_locked_until IS
      'Short-lived lease used to prevent concurrent Service Fusion refresh-token rotation.';
    COMMENT ON COLUMN ops.sf_token_cache.refresh_lock_owner IS
      'Best-effort owner id for the current Service Fusion token refresh lease.';
    COMMENT ON COLUMN ops.sf_token_cache.last_refresh_error IS
      'Sanitized last Service Fusion token refresh error for health/debugging.';
    COMMENT ON COLUMN ops.sf_token_cache.last_refresh_error_at IS
      'Timestamp for last_refresh_error.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION ops.fn_sf_token_claim_refresh(
  p_owner text,
  p_lock_seconds int DEFAULT 45
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, public
AS $$
DECLARE
  v_claimed boolean := false;
  v_owner text := NULLIF(p_owner, '');
  v_seconds int := GREATEST(COALESCE(p_lock_seconds, 45), 10);
BEGIN
  IF to_regclass('ops.sf_token_cache') IS NULL OR v_owner IS NULL THEN
    RETURN false;
  END IF;

  UPDATE ops.sf_token_cache
     SET refresh_locked_until = now() + make_interval(secs => v_seconds),
         refresh_lock_owner = v_owner
   WHERE id = 1
     AND (
       refresh_locked_until IS NULL
       OR refresh_locked_until < now()
       OR refresh_lock_owner = v_owner
     )
   RETURNING true INTO v_claimed;

  RETURN COALESCE(v_claimed, false);
END $$;

CREATE OR REPLACE FUNCTION ops.fn_sf_token_release_refresh(p_owner text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, public
AS $$
DECLARE
  v_owner text := NULLIF(p_owner, '');
BEGIN
  IF to_regclass('ops.sf_token_cache') IS NULL THEN
    RETURN;
  END IF;

  UPDATE ops.sf_token_cache
     SET refresh_locked_until = NULL,
         refresh_lock_owner = NULL
   WHERE id = 1
     AND (
       refresh_locked_until < now()
       OR (v_owner IS NOT NULL AND refresh_lock_owner = v_owner)
     );
END $$;

GRANT EXECUTE ON FUNCTION ops.fn_sf_token_claim_refresh(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION ops.fn_sf_token_release_refresh(text) TO service_role;
