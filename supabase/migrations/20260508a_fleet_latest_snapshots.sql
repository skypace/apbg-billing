-- ops.fleet_latest_snapshots
-- ---------------------------
-- One row per vehicle holding its most-recent telemetry snapshot from the
-- Unity (Powerfleet / FleetComplete) GraphQL API. Refreshed every 5 minutes
-- by sync-fleetcomplete (mode=latest). Drives the Fleet live-map page.
--
-- Why a separate table from fleet_trips: this is "where is each truck right
-- now" state. fleet_trips is "what trips happened in the past." Different
-- access pattern (one-row-per-vehicle, frequent overwrites) and different
-- read pattern (whole table on every map render).
--
-- Source: getLatestSnapshots(vehicleIds: [UUID!]!) → [CommonFormat]. We
-- write a flat subset of fields (gps + ignition + driver) since the page
-- only needs map-pin essentials. Add columns later if richer state is
-- needed (CAN-bus, fuel level, etc.).

CREATE TABLE IF NOT EXISTS ops.fleet_latest_snapshots (
  fc_asset_id        text PRIMARY KEY REFERENCES ops.fleet_vehicles(fc_asset_id) ON DELETE CASCADE,
  -- snapshot_at: timestamp on the snapshot itself (vehicle clock, UTC).
  -- fetched_at:  when sync-fleetcomplete wrote this row.
  -- staleness  = now() - snapshot_at  (driver lost coverage / device offline)
  -- freshness  = now() - fetched_at   (sync function lagging)
  snapshot_at        timestamptz NOT NULL,
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  -- gps state false = GPS not yet locked. Coordinates may still be present
  -- but stale/zero — the UI should treat false as "no fix."
  gps_fix            boolean,
  latitude           double precision,
  longitude          double precision,
  heading_deg        numeric,
  speed_kmh          numeric,
  ignition_on        boolean,
  fc_driver_id       text
);

COMMENT ON TABLE ops.fleet_latest_snapshots IS
  'Most-recent Unity getLatestSnapshots reading per vehicle. Refreshed every 5 min by sync-fleetcomplete (mode=latest). Powers the Fleet live-map page.';

-- Read path: the SPA reads the whole table (~9 rows) on each map render.
-- Anon read is fine — pure telemetry, no PII. Authenticated users get the
-- same view as anon (we keep it open for the public dashboard if it ever
-- gets one), but RLS still gates writes to service_role only.
ALTER TABLE ops.fleet_latest_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fleet_latest_snapshots_read ON ops.fleet_latest_snapshots;
CREATE POLICY fleet_latest_snapshots_read
  ON ops.fleet_latest_snapshots
  FOR SELECT
  TO authenticated
  USING (true);

-- Make the columns explicitly readable by anon for the dashboard page.
GRANT SELECT ON ops.fleet_latest_snapshots TO anon, authenticated;
