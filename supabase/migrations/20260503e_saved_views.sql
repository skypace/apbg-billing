-- Per-user saved analytical views with optional sharing.
-- Applied to live DB on 2026-05-03.

CREATE TABLE IF NOT EXISTS ops.saved_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  is_shared   boolean NOT NULL DEFAULT false,
  config      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_views_user   ON ops.saved_views(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_views_shared ON ops.saved_views(is_shared) WHERE is_shared;

ALTER TABLE ops.saved_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS saved_views_read   ON ops.saved_views;
DROP POLICY IF EXISTS saved_views_write  ON ops.saved_views;
DROP POLICY IF EXISTS saved_views_modify ON ops.saved_views;
DROP POLICY IF EXISTS saved_views_delete ON ops.saved_views;

CREATE POLICY saved_views_read   ON ops.saved_views FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_shared);
CREATE POLICY saved_views_write  ON ops.saved_views FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY saved_views_modify ON ops.saved_views FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY saved_views_delete ON ops.saved_views FOR DELETE TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.saved_views TO authenticated;
