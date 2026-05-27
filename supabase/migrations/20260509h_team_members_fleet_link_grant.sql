-- Grant authenticated users the ability to update team_members.fleet_driver_id
-- so the Settings → Fleet Drivers tab can map FC drivers to team members.
--
-- We don't want to grant full UPDATE on team_members (that table is owned
-- by the apbg-ops Staff Roster page, which uses a service-role gateway).
-- Column-level UPDATE on just fleet_driver_id is the minimum surface.
--
-- Also drop the orphaned ops.fleet_drivers.staff_id column added in
-- 20260509g — kpi_daily already keys on team_members.id, and the
-- team_members.fleet_driver_id column is the canonical home for this
-- linkage. Less drift this way.

ALTER TABLE ops.fleet_drivers DROP COLUMN IF EXISTS staff_id;

DROP POLICY IF EXISTS team_members_update_fleet_link ON ops.team_members;
CREATE POLICY team_members_update_fleet_link
  ON ops.team_members FOR UPDATE
  TO authenticated
  USING (true) WITH CHECK (true);

GRANT UPDATE (fleet_driver_id) ON ops.team_members TO authenticated;
