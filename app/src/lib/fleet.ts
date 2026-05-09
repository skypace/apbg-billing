import { sbq } from './rpc';

// Vehicle metadata (slow-changing — synced hourly with sync-fleetcomplete?mode=vehicles).
export interface FleetVehicle {
  fc_asset_id: string;
  vehicle_name: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  license_plate: string | null;
  vin: string | null;
  status: string | null;
}

// Latest telemetry per vehicle (refreshed every 5 min by the
// fleetcomplete-latest-snapshots cron). One row per vehicle.
export interface FleetLatestSnapshot {
  fc_asset_id: string;
  snapshot_at: string;       // vehicle clock, ISO8601
  fetched_at:  string;       // when the syncer wrote this row
  gps_fix:     boolean | null;
  latitude:    number | null;
  longitude:   number | null;
  heading_deg: number | null;
  speed_kmh:   number | string | null;  // numeric column → may come back as string
  ignition_on: boolean | null;
  fc_driver_id: string | null;
}

// Joined view used by the live-map page. Matches a vehicle to its latest snap.
export interface FleetMapRow extends FleetVehicle {
  snap: FleetLatestSnapshot | null;
}

export async function fetchFleetMapRows(): Promise<FleetMapRow[]> {
  const [vehicles, snaps] = await Promise.all([
    sbq<FleetVehicle>('fleet_vehicles', 'select=fc_asset_id,vehicle_name,make,model,year,license_plate,vin,status'),
    sbq<FleetLatestSnapshot>('fleet_latest_snapshots', 'select=*'),
  ]);
  const byId = new Map<string, FleetLatestSnapshot>();
  for (const s of snaps) byId.set(s.fc_asset_id, s);
  return vehicles.map((v) => ({ ...v, snap: byId.get(v.fc_asset_id) ?? null }));
}
