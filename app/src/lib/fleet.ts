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

// ---------- drivers ----------

export interface FleetDriver {
  fc_person_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  employee_id: string | null;
  is_user: boolean;
}

export async function fetchFleetDrivers(): Promise<FleetDriver[]> {
  return sbq<FleetDriver>(
    'fleet_drivers',
    'select=fc_person_id,first_name,last_name,email,employee_id,is_user&order=last_name.asc.nullslast,first_name.asc',
  );
}

// ---------- trips ----------

export interface FleetTrip {
  fc_trip_id: string;
  fc_asset_id: string | null;
  fc_driver_id: string | null;
  trip_date: string;
  start_time: string;
  end_time: string;
  distance_miles: number | string | null;
  drive_time_min: number | string | null;
  idle_time_min: number | string | null;
  max_speed_mph: number | string | null;
  avg_speed_mph: number | string | null;
  hard_brakes: number | null;
  hard_accels: number | null;
  speed_violations: number | null;
}

export async function fetchRecentTrips(days = 7): Promise<FleetTrip[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return sbq<FleetTrip>(
    'fleet_trips',
    'select=fc_trip_id,fc_asset_id,fc_driver_id,trip_date,start_time,end_time,distance_miles,drive_time_min,idle_time_min,max_speed_mph,avg_speed_mph,hard_brakes,hard_accels,speed_violations&start_time=gte.' + since + '&order=start_time.desc',
  );
}

// ---------- driver events ----------

export interface FleetDriverEvent {
  id: number;
  fc_asset_id: string;
  fc_driver_id: string | null;
  event_type: string;
  event_at: string;
  speed_kmh: number | string | null;
  latitude: number | null;
  longitude: number | null;
}

export async function fetchRecentDriverEvents(days = 7): Promise<FleetDriverEvent[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return sbq<FleetDriverEvent>(
    'fleet_driver_events',
    'select=id,fc_asset_id,fc_driver_id,event_type,event_at,speed_kmh,latitude,longitude&event_at=gte.' + since + '&order=event_at.desc',
  );
}

// ---------- geofence count ----------

export async function fetchGeofenceCount(): Promise<number> {
  // PostgREST count via Prefer: count=exact; sbq doesn't expose that, so
  // just pull ids and len them. Geofence row count is bounded (≤ few hundred).
  const rows = await sbq<{ fc_geofence_id: string }>('fleet_geofences', 'select=fc_geofence_id');
  return rows.length;
}

// ---------- stop visits (auto-geofence from QBO customers) ----------

export interface FleetStopVisit {
  id: number;
  fc_asset_id: string;
  fc_driver_id: string | null;
  qbo_customer_id: string | null;
  arrival_time: string;
  departure_time: string | null;
  dwell_minutes: number | string | null;
  vehicle_lat: number | null;
  vehicle_lon: number | null;
  distance_m: number | string | null;
}

export interface QboCustomerLite {
  qbo_customer_id: string;
  display_name: string | null;
}

export async function fetchRecentStopVisits(days = 7): Promise<FleetStopVisit[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return sbq<FleetStopVisit>(
    'fleet_stop_visits',
    'select=id,fc_asset_id,fc_driver_id,qbo_customer_id,arrival_time,departure_time,dwell_minutes,vehicle_lat,vehicle_lon,distance_m&arrival_time=gte.' + since + '&order=arrival_time.desc',
  );
}

export async function fetchCustomerNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const filter = 'qbo_customer_id=in.(' + ids.map((s) => '"' + s + '"').join(',') + ')';
  const rows = await sbq<QboCustomerLite>('qbo_customers', 'select=qbo_customer_id,display_name&' + filter);
  for (const r of rows) {
    if (r.qbo_customer_id) out.set(r.qbo_customer_id, r.display_name ?? '');
  }
  return out;
}

export interface GeocodeStats {
  ok: number;
  not_found: number;
  attempted: number;
}

export async function fetchGeocodeStats(): Promise<GeocodeStats> {
  const [ok, nf, att] = await Promise.all([
    sbq<{ qbo_customer_id: string }>('qbo_customers', 'select=qbo_customer_id&geocode_status=eq.ok'),
    sbq<{ qbo_customer_id: string }>('qbo_customers', 'select=qbo_customer_id&geocode_status=eq.not_found'),
    sbq<{ qbo_customer_id: string }>('qbo_customers', 'select=qbo_customer_id&geocoded_at=not.is.null'),
  ]);
  return { ok: ok.length, not_found: nf.length, attempted: att.length };
}
