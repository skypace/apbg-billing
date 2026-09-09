-- The sf_token check could not detect a dead SF token. Both of its rules were blind:
--
--   1. red on "refresh FAILING" reads v_sf.last_refresh_error_at — and NOTHING
--      writes that column. Every reference to it in the estate is this check
--      reading it, or the 20260704a migration that created it. The failure is
--      written to last_error by ops.sf_token_release_failed__i.
--
--   2. the 8h / 30h age rules read updated_at — which sf_token_release_failed__i
--      sets to NOW() on EVERY FAILURE. A token failing on each retry therefore
--      looks freshly written forever and can never age into yellow or red.
--
-- Live proof at the time of writing: the billing/Brixpense token's refresh token
-- was rejected by SF ("Invalid `refresh_token` parameter"), access expired at
-- 03:50 UTC, and ops.sync_health() reported sf_token GREEN.
--
-- This is the same failure as the 2026-06-29 → 07-24 silent outage, and the
-- check added on 07-24 to prevent a repeat was watching the wrong column.
--
-- last_error is a RELIABLE signal precisely because ops.sf_token_persist__i
-- clears it on every success — so a non-null last_error means "the most recent
-- refresh attempt failed and none has succeeded since".
--
-- Read-modify-write against the LIVE definition, per the 20260820b rule: the
-- body is patched by anchor and the migration RAISES if an anchor moved, rather
-- than pasting a body from an older copy and silently deleting somebody's check.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = 'fn_sync_health_core__i';

  if v_def is null then
    raise exception 'ops.fn_sync_health_core__i not found — refusing to guess';
  end if;

  -- (1) status: add the two rules that can actually see a dead token.
  if position('when v_sf.updated_at is null then ''red''' in v_def) = 0 then
    raise exception 'sf_token status anchor moved — inspect fn_sync_health_core__i by hand';
  end if;
  v_new := replace(v_def,
    'when v_sf.updated_at is null then ''red''',
    'when v_sf.updated_at is null then ''red''' || E'\n' ||
    '      -- the refresher clears last_error on success, so a non-null one means' || E'\n' ||
    '      -- the latest attempt failed. Expired access on top of that is an outage.' || E'\n' ||
    '      when v_sf.last_error is not null and coalesce(v_sf.access_expires_at, to_timestamp(0)) < now() then ''red''' || E'\n' ||
    '      when v_sf.last_error is not null then ''yellow''');

  -- (2) detail: quote the error that is actually recorded.
  if position('left(v_sf.last_refresh_error, 160)' in v_new) = 0 then
    raise exception 'sf_token detail anchor moved — inspect fn_sync_health_core__i by hand';
  end if;
  v_new := replace(v_new,
    'case when v_sf.last_refresh_error is not null and v_sf.last_refresh_error_at > coalesce(v_sf.updated_at, to_timestamp(0))',
    'case when v_sf.last_error is not null');
  v_new := replace(v_new, 'left(v_sf.last_refresh_error, 160)', 'left(v_sf.last_error, 160)');

  if v_new = v_def then
    raise exception 'patch produced no change — refusing to reapply an unchanged body';
  end if;

  execute v_new;
end $$;

-- ⚠ fn_sync_health_core is a GENERATED GUARD WRAPPER (20260820b). The body lives
-- in __i and that is what was edited; the wrapper is untouched and still asserts
-- ops.fn_assert_internal(). Verified below.
do $$
begin
  if position('fn_assert_internal' in (
       select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='ops' and p.proname='fn_sync_health_core')) = 0 then
    raise exception 'the guard wrapper lost its assert — do not leave this applied';
  end if;
end $$;
