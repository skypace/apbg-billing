-- Email-digest schedule + send log. Cron job calls digest-email
-- hourly; the function decides which subscriptions are due.
-- Applied to live DB on 2026-05-03.

CREATE TABLE IF NOT EXISTS ops.digest_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  recipients  text[] NOT NULL,
  frequency   text   NOT NULL DEFAULT 'weekly',
  day_of_week int    NOT NULL DEFAULT 1,
  hour_utc    int    NOT NULL DEFAULT 14,
  sections    text[] NOT NULL DEFAULT ARRAY['inactive','top_movers']::text[],
  is_active   boolean NOT NULL DEFAULT true,
  last_sent_at timestamptz,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.digest_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid REFERENCES ops.digest_subscriptions(id) ON DELETE SET NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  recipients      text[],
  subject         text,
  status          text NOT NULL,
  error           text,
  preview         text
);

ALTER TABLE ops.digest_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.digest_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS digest_subs_read ON ops.digest_subscriptions;
DROP POLICY IF EXISTS digest_subs_write ON ops.digest_subscriptions;
CREATE POLICY digest_subs_read ON ops.digest_subscriptions FOR SELECT TO authenticated USING (true);
CREATE POLICY digest_subs_write ON ops.digest_subscriptions FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.digest_subscriptions TO authenticated;

DROP POLICY IF EXISTS digest_log_read ON ops.digest_log;
CREATE POLICY digest_log_read ON ops.digest_log FOR SELECT TO authenticated USING (true);
GRANT SELECT ON ops.digest_log TO authenticated;
GRANT ALL ON ops.digest_log TO service_role;

-- pg_cron schedule applied via cron.schedule('digest-email-hourly', '0 * * * *', ...)
-- which POSTs to /functions/v1/digest-email with mode=scheduled.
