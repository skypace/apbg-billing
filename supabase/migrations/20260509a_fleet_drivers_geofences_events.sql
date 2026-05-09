-- Fleet operations buildout: drivers + geofences + driver-event extraction
-- ------------------------------------------------------------------------
-- Adds the supporting tables for safety scorecards (Tier 4) and prepares
-- the table shape for geofence-based stop attribution (Tier 2). The actual
-- trip + event extraction logic lives in sync-fleetcomplete (mode=trips).

-- ---- ops.fleet_drivers ------------------------------------------------
-- Mirrors Unity's getPeople() for the people who are isDriver=true. We
-- store both Unity's UUID and the optional employeeId so trip rows can
-- attribute by either path. ops.staff is the canonical APBG roster — link
-- by email (case-insensitive) at read time, not in this table, since the
-- ops.staff schema may change independently.

CREATE TABLE IF NOT EXISTS ops.fleet_drivers (
  fc_person_id  uuid PRIMARY KEY,
  first_name    text,
  last_name     text,
  email         text,
  phone         text,
  employee_id   text,           -- Unity-portal employeeId (optional, e.g. BX22)
  is_driver     boolean NOT NULL DEFAULT true,
  is_user       boolean NOT NULL DEFAULT false,
  fleet_id      text,
  synced_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.fleet_drivers IS
  'Drivers from Unity getPeople (isDriver=true rows). Refreshed hourly by sync-fleetcomplete (mode=people). Links to ops.staff by email at read time.';

ALTER TABLE ops.fleet_drivers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fleet_drivers_read ON ops.fleet_drivers;
CREATE POLICY fleet_drivers_read ON ops.fleet_drivers
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON ops.fleet_drivers TO anon, authenticated;

-- ---- ops.fleet_geofences ----------------------------------------------
-- Mirrors Unity's getGeofences. geojson is stored as jsonb so the live-map
-- can render polygons directly. type/color/description are display hints
-- from the Unity portal.
--
-- Today (2026-05-09) Sky has 0 geofences defined. The killer Tier-2 use
-- case is one geofence per Melt store; the moment any are defined in the
-- Unity portal, this sync starts populating + the stop-attribution logic
-- (separate migration when added) wakes up.

CREATE TABLE IF NOT EXISTS ops.fleet_geofences (
  fc_geofence_id uuid PRIMARY KEY,
  name           text,
  description    text,
  type           text,
  color          text,
  geojson        jsonb,
  fleet_id       text,
  synced_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.fleet_geofences IS
  'Geofences from Unity getGeofences. Refreshed hourly by sync-fleetcomplete (mode=geofences). Define them in the Powerfleet portal (one per Melt store / depot / fuel station) to enable stop attribution.';

ALTER TABLE ops.fleet_geofences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fleet_geofences_read ON ops.fleet_geofences;
CREATE POLICY fleet_geofences_read ON ops.fleet_geofences
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON ops.fleet_geofences TO anon, authenticated;

-- ---- ops.fleet_driver_events ------------------------------------------
-- One row per driverBehaviour event surfaced in a snapshot. The trip-sync
-- pulls these out of the same getSnapshots window it uses to reconstruct
-- trips. Used by the safety scorecard.
--
-- event_type is the Unity DriverBehaviourType enum verbatim — we store
-- the upstream string rather than a local enum so new event types don't
-- require a schema change.

CREATE TABLE IF NOT EXISTS ops.fleet_driver_events (
  id              bigserial PRIMARY KEY,
  fc_asset_id     text NOT NULL REFERENCES ops.fleet_vehicles(fc_asset_id) ON DELETE CASCADE,
  fc_driver_id    text,
  event_type      text NOT NULL,
  event_value     numeric,
  event_at        timestamptz NOT NULL,
  latitude        double precision,
  longitude       double precision,
  speed_kmh       numeric,
  -- Idempotency: one row per (vehicle, timestamp, event_type). Re-running
  -- the trip sync over the same window is a no-op.
  CONSTRAINT fleet_driver_events_uniq UNIQUE (fc_asset_id, event_at, event_type)
);

CREATE INDEX IF NOT EXISTS fleet_driver_events_at_idx
  ON ops.fleet_driver_events(event_at DESC);
CREATE INDEX IF NOT EXISTS fleet_driver_events_driver_idx
  ON ops.fleet_driver_events(fc_driver_id, event_at DESC);

COMMENT ON TABLE ops.fleet_driver_events IS
  'Per-event driverBehaviour records (HARSH_BRAKING, HARSH_ACCELERATION, MAX_SPEED_EXCEEDED, etc.) extracted from getSnapshots by sync-fleetcomplete (mode=trips). Drives the safety scorecard.';

ALTER TABLE ops.fleet_driver_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fleet_driver_events_read ON ops.fleet_driver_events;
CREATE POLICY fleet_driver_events_read ON ops.fleet_driver_events
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON ops.fleet_driver_events TO anon, authenticated;
