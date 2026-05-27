-- Tighten RLS on classification + settings tables: read stays open
-- (anon role can still call SECURITY DEFINER RPCs), but writes now
-- require an authenticated session.
-- Applied to live DB on 2026-05-03.

DROP POLICY IF EXISTS channels_read  ON ops.channels;
DROP POLICY IF EXISTS channels_write ON ops.channels;
CREATE POLICY channels_read  ON ops.channels FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY channels_write ON ops.channels FOR ALL    TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.channels TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.channels TO authenticated;

DROP POLICY IF EXISTS segments_read  ON ops.segments;
DROP POLICY IF EXISTS segments_write ON ops.segments;
CREATE POLICY segments_read  ON ops.segments FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY segments_write ON ops.segments FOR ALL    TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.segments TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.segments TO authenticated;

DROP POLICY IF EXISTS category_segments_read  ON ops.category_segments;
DROP POLICY IF EXISTS category_segments_write ON ops.category_segments;
CREATE POLICY category_segments_read  ON ops.category_segments FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY category_segments_write ON ops.category_segments FOR ALL    TO authenticated USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE ON ops.category_segments FROM anon;

DROP POLICY IF EXISTS item_segments_read  ON ops.item_segments;
DROP POLICY IF EXISTS item_segments_write ON ops.item_segments;
CREATE POLICY item_segments_read  ON ops.item_segments FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY item_segments_write ON ops.item_segments FOR ALL    TO authenticated USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE ON ops.item_segments FROM anon;

DROP POLICY IF EXISTS expense_buckets_read  ON ops.expense_buckets;
DROP POLICY IF EXISTS expense_buckets_write ON ops.expense_buckets;
CREATE POLICY expense_buckets_read  ON ops.expense_buckets FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY expense_buckets_write ON ops.expense_buckets FOR ALL    TO authenticated USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE ON ops.expense_buckets FROM anon;

DROP POLICY IF EXISTS customer_channels_read  ON ops.customer_channels;
DROP POLICY IF EXISTS customer_channels_write ON ops.customer_channels;
CREATE POLICY customer_channels_read  ON ops.customer_channels FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY customer_channels_write ON ops.customer_channels FOR ALL    TO authenticated USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE ON ops.customer_channels FROM anon;

REVOKE EXECUTE ON FUNCTION ops.fn_set_account_bucket(text, text, text)             FROM anon;
REVOKE EXECUTE ON FUNCTION ops.fn_set_category_segment(text, text, text)           FROM anon;
REVOKE EXECUTE ON FUNCTION ops.fn_set_item_segment(text, text, text)               FROM anon;
REVOKE EXECUTE ON FUNCTION ops.fn_set_customer_channels(text, text[], text, text)  FROM anon;
