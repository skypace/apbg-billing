-- Channel taxonomy + customer cache + many-to-many channel assignments.
-- Applied to live DB on 2026-05-02.

CREATE TABLE IF NOT EXISTS ops.channels (
  channel_code text PRIMARY KEY,
  label        text NOT NULL,
  sort_order   int  NOT NULL DEFAULT 100,
  is_active    boolean NOT NULL DEFAULT true
);

INSERT INTO ops.channels (channel_code, label, sort_order) VALUES
  ('regional_chain_qsr',         'Regional Chain QSR',           10),
  ('chain_qsr',                  'Chain QSR',                    20),
  ('small_format_qsr',           'Small Format QSR',             30),
  ('chain_grocery',              'Chain Grocery',                40),
  ('independent_grocery',        'Independent Grocery',          50),
  ('independent_bar_club',       'Independent Bar / Club',       60),
  ('national',                   'National',                     70),
  ('independent_foodservice',    'Independent Foodservice',      80),
  ('airport_workplace_catering', 'Airport / Workplace / Catering', 90),
  ('vending',                    'Vending',                      100)
ON CONFLICT (channel_code) DO UPDATE SET label=EXCLUDED.label, sort_order=EXCLUDED.sort_order;

ALTER TABLE ops.channels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channels_read ON ops.channels;
CREATE POLICY channels_read ON ops.channels FOR SELECT USING (true);
GRANT SELECT ON ops.channels TO anon, authenticated;
GRANT ALL    ON ops.channels TO service_role;

CREATE TABLE IF NOT EXISTS ops.qbo_customers (
  qbo_customer_id    text PRIMARY KEY,
  display_name       text,
  fully_qualified_name text,
  parent_ref_id      text,
  is_sub_customer    boolean DEFAULT false,
  active             boolean DEFAULT true,
  customer_type_ref_id text,
  customer_type_name text,
  email              text,
  phone              text,
  bill_addr_line1    text,
  bill_addr_city     text,
  bill_addr_state    text,
  bill_addr_postal   text,
  ship_addr_city     text,
  ship_addr_state    text,
  notes              text,
  qbo_updated_at     timestamptz,
  synced_at          timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qbo_customers_name   ON ops.qbo_customers(display_name);
CREATE INDEX IF NOT EXISTS idx_qbo_customers_active ON ops.qbo_customers(active);

ALTER TABLE ops.qbo_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qbo_customers_read ON ops.qbo_customers;
CREATE POLICY qbo_customers_read ON ops.qbo_customers FOR SELECT USING (true);
GRANT SELECT ON ops.qbo_customers TO anon, authenticated;
GRANT ALL    ON ops.qbo_customers TO service_role;

CREATE TABLE IF NOT EXISTS ops.customer_channels (
  qbo_customer_id text NOT NULL REFERENCES ops.qbo_customers(qbo_customer_id) ON DELETE CASCADE,
  channel_code    text NOT NULL REFERENCES ops.channels(channel_code) ON DELETE RESTRICT,
  is_primary      boolean NOT NULL DEFAULT false,
  notes           text,
  set_by          text,
  set_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (qbo_customer_id, channel_code)
);
CREATE INDEX IF NOT EXISTS idx_customer_channels_channel ON ops.customer_channels(channel_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_channels_one_primary
  ON ops.customer_channels(qbo_customer_id) WHERE is_primary;

ALTER TABLE ops.customer_channels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_channels_read  ON ops.customer_channels;
DROP POLICY IF EXISTS customer_channels_write ON ops.customer_channels;
CREATE POLICY customer_channels_read  ON ops.customer_channels FOR SELECT USING (true);
CREATE POLICY customer_channels_write ON ops.customer_channels FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.customer_channels TO anon, authenticated;
GRANT ALL ON ops.customer_channels TO service_role;
