-- Auto-geofencing from QBO customer addresses.
-- ----------------------------------------------
-- Step 1: extend qbo_customers with geocoded lat/lon so we can match
-- vehicle stops against real customer locations without manual portal
-- geofence config.
-- Step 2: add stop endpoints (start_lat/lon, end_lat/lon) to fleet_trips
-- so the trip writer can drive stop attribution.
-- Step 3: create ops.fleet_stop_visits, the matched stop-at-customer table.

-- ---- qbo_customers: geocoding columns --------------------------------

ALTER TABLE ops.qbo_customers
  ADD COLUMN IF NOT EXISTS lat                double precision,
  ADD COLUMN IF NOT EXISTS lon                double precision,
  ADD COLUMN IF NOT EXISTS geocoded_at        timestamptz,
  -- 'ok' | 'not_found' | 'error' | 'no_address'. NULL = never tried.
  ADD COLUMN IF NOT EXISTS geocode_status     text,
  -- 'nominatim' | 'manual' | 'mapbox' | etc.
  ADD COLUMN IF NOT EXISTS geocode_provider   text,
  ADD COLUMN IF NOT EXISTS geocode_error      text;

CREATE INDEX IF NOT EXISTS qbo_customers_geo_idx
  ON ops.qbo_customers(lat, lon)
  WHERE lat IS NOT NULL AND lon IS NOT NULL;

COMMENT ON COLUMN ops.qbo_customers.lat IS
  'Decimal degrees latitude. Populated by the geocode-customers edge function from bill_addr_line1+city+state+postal. NULL if address is missing or geocoder failed.';
COMMENT ON COLUMN ops.qbo_customers.lon IS
  'Decimal degrees longitude (negative in the western hemisphere). Same source as lat.';

-- ---- fleet_trips: trip endpoints --------------------------------------

ALTER TABLE ops.fleet_trips
  ADD COLUMN IF NOT EXISTS start_lat double precision,
  ADD COLUMN IF NOT EXISTS start_lon double precision,
  ADD COLUMN IF NOT EXISTS end_lat   double precision,
  ADD COLUMN IF NOT EXISTS end_lon   double precision;

COMMENT ON COLUMN ops.fleet_trips.end_lat IS
  'Trip-end latitude (last GPS-locked snapshot of the ignition cycle). Drives stop-attribution lookups against qbo_customers.';

-- ---- ops.fleet_stop_visits --------------------------------------------
-- One row per matched parking event at a customer (end-of-trip GPS within
-- the match radius of a geocoded customer). Idempotent on
-- (fc_asset_id, arrival_time) — re-running mode=trips on the same window
-- updates dwell + departure as more data lands.

CREATE TABLE IF NOT EXISTS ops.fleet_stop_visits (
  id                bigserial PRIMARY KEY,
  fc_asset_id       text NOT NULL REFERENCES ops.fleet_vehicles(fc_asset_id) ON DELETE CASCADE,
  fc_driver_id      text,
  qbo_customer_id   text REFERENCES ops.qbo_customers(qbo_customer_id) ON DELETE SET NULL,
  arrival_time      timestamptz NOT NULL,
  departure_time    timestamptz,
  dwell_minutes     numeric,
  -- Lat/lon of where the truck actually parked (may differ from the
  -- customer's geocoded coords by up to the match radius).
  vehicle_lat       double precision,
  vehicle_lon       double precision,
  -- Distance in meters from the truck's parked spot to the customer's
  -- geocoded location. Useful for tuning the match radius.
  distance_m        numeric,
  CONSTRAINT fleet_stop_visits_uniq UNIQUE (fc_asset_id, arrival_time)
);

CREATE INDEX IF NOT EXISTS fleet_stop_visits_arrival_idx
  ON ops.fleet_stop_visits(arrival_time DESC);
CREATE INDEX IF NOT EXISTS fleet_stop_visits_customer_idx
  ON ops.fleet_stop_visits(qbo_customer_id, arrival_time DESC);

COMMENT ON TABLE ops.fleet_stop_visits IS
  'Matched stop visits — vehicle parked near a geocoded customer. Written by sync-fleetcomplete (mode=trips) after trip reconstruction. Cross-reference with delivery_stops / service_jobs to flag ghost stops and over-servicing.';

ALTER TABLE ops.fleet_stop_visits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fleet_stop_visits_read ON ops.fleet_stop_visits;
CREATE POLICY fleet_stop_visits_read
  ON ops.fleet_stop_visits FOR SELECT TO authenticated USING (true);
GRANT SELECT ON ops.fleet_stop_visits TO anon, authenticated;
