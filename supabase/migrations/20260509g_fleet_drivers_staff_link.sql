-- Manual linkage: ops.fleet_drivers.staff_id → ops.staff.staff_id.
--
-- ops.staff has no email column (and the QBO Employees sync that would
-- populate one isn't this codebase's owner), so the cleanest reliable
-- linkage between Unity drivers and the APBG roster is a manual mapping.
-- A new "Fleet Drivers" tab in Settings exposes this column for editing.
--
-- Once populated, downstream views (kpi_daily GPS counts, dwell mismatch)
-- can join trips/stops to staff via this column.

ALTER TABLE ops.fleet_drivers
  ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES ops.staff(staff_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fleet_drivers_staff_idx
  ON ops.fleet_drivers(staff_id)
  WHERE staff_id IS NOT NULL;

COMMENT ON COLUMN ops.fleet_drivers.staff_id IS
  'Manual linkage to ops.staff. Set in the Settings → Fleet Drivers tab. Used by kpi_daily GPS counts + dwell mismatch.';

-- Allow authenticated users to update fleet_drivers (for the settings UI)
-- but only the staff_id column. The roster columns (first_name, etc.) are
-- still managed by sync-fleetcomplete (mode=people) — that runs as
-- service_role and bypasses RLS, so we don't have to mention it here.
DROP POLICY IF EXISTS fleet_drivers_update_staff ON ops.fleet_drivers;
CREATE POLICY fleet_drivers_update_staff
  ON ops.fleet_drivers FOR UPDATE
  TO authenticated
  USING (true) WITH CHECK (true);
GRANT UPDATE (staff_id) ON ops.fleet_drivers TO authenticated;
