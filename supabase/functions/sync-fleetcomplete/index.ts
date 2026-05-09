// Supabase Edge Function: sync-fleetcomplete
// ------------------------------------------
// Pulls fleet data from the Unity (Powerfleet / FleetComplete) GraphQL
// API at https://api.fleetcomplete.com/graphql and upserts into the
// ops.fleet_* tables.
//
// Auth flow (per Unity docs):
//   1. POST /login/token  with form-encoded username + password
//      → { access_token, refresh_token, ... }    access_token = 5 min
//   2. POST /login/refresh with form-encoded refreshToken
//      → { access_token, refresh_token }          refresh_token = 12 hr
//   3. POST /graphql with headers:
//      Authorization: Bearer <access_token>
//      userId:        <UUID from /login/userinfo>
//
// Rate limiting: GraphQL allows ONE active request per user. Calls are
// strictly sequential; on 429 we back off and retry once.
//
// Secrets (set via Supabase secrets / dashboard):
//   FC_USERNAME       Unity portal username (skypace@brixbev.com)
//   FC_PASSWORD       Unity portal password
//
// Public state in DB (ops.fc_token_cache singleton row id=1):
//   api_token / refresh_token / *_expires_at — rotated each run
//   account_id (user UUID) — sent as the `userId` header on /graphql
//   fleet_id   — Unity fleet UUID (informational; we use account_id)
//   base_url   — defaults to https://api.fleetcomplete.com/
//
// Status of resource syncs (verified against the live schema 2026-05-08):
//   getVehicles    IMPLEMENTED  via getVehicles { vin id name assignedGroups{...} assignedDevices{...} }
//   syncTrips      STUBBED      — getSnapshots(vehicleId, from, to) works and returns CommonFormat
//                                 records. Building fleet_trips rows requires reconstructing trips
//                                 from event-driven snapshots (group by ignition.engineStatus
//                                 transitions, sum haversine distance, max gps.speed). See the
//                                 syncTrips comment for the concrete plan.
//   syncFuel       NOT POSSIBLE — Unity GraphQL has no fuel-transaction API. Only per-snapshot
//                                 CAN-bus fuel level / fuel rate (CommonFormat.canBus.canFuel*,
//                                 CommonFormat.fuel.*). For $-denominated fuel transactions we
//                                 need a separate fuel-card integration (Wex / Fleetcor / Voyager).
//   syncMaintenance BLOCKED     — only path is getWrappedReport(reportId='maintenance-schedule').
//                                 Every call to getWrappedReport returns
//                                 {"error":"php-exception","message":"Something went wrong"}
//                                 regardless of input shape (verified 2026-05-08 with empty
//                                 input, full input matching getWrappedReportInputs schema, and
//                                 explicit period/asset_uuids/timezone/working_hours). The other
//                                 query types (getVehicles / getSnapshots / getPeople / etc.)
//                                 work — the report engine itself is the problem. Needs Powerfleet
//                                 support ticket: "getWrappedReport returns generic php-exception
//                                 for all reportIds". Until that's fixed, no maintenance data.
//
// Schema discovery cheat sheet (use via direct GraphQL, not GraphiQL — GraphiQL has been
// flaky for us):
//   Top-level queries:  getVehicles, getActiveVehicles, getVehicleById, getPeople, getPersonById,
//                       getGeofences, getSnapshots, getLatestSnapshots, getWrappedReport,
//                       getWrappedReportInputs, getGroups, getDriverAssignments, ...
//   CommonFormat fields: vehicleId, timestamp, locationTimestamp, locationTimeZone,
//                        gps{state,latitude,longitude,direction,altitude,speed},
//                        ignition{engineStatus},
//                        driver{driverId,iButton,oneWire,rfidIButton,...},
//                        canBus{canDistance,canDeltaDistance,canFuelUsed,canFuelRate,
//                               engineRunTime,engineIdleTime,...},
//                        fuel{fuel,rawFuel,fuelLevel,totalFuelEconomy,fuelTankSize},
//                        driverBehaviour{driverBehaviourType,driverBehaviourValue},
//                        misc{power,vehicleBusType}.
//   Speeds are km/h, distances are km — convert to mph/miles before writing fleet_trips.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------- env / config ----------

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FC_USERNAME = Deno.env.get('FC_USERNAME');
const FC_PASSWORD = Deno.env.get('FC_PASSWORD');

const FC_BASE = 'https://api.fleetcomplete.com';
const ACCESS_TTL_MS = 5 * 60 * 1000;          // access_token: 5 min
const REFRESH_TTL_MS = 12 * 60 * 60 * 1000;   // refresh_token: 12 hr
const EXP_BUFFER_MS = 30_000;                 // refresh 30s before actual expiry

const sb = createClient(SB_URL, SB_SERVICE_KEY, { db: { schema: 'ops' } });

// ---------- token cache ----------

interface TokenCache {
  api_token: string | null;
  refresh_token: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  account_id: string | null;
  fleet_id: string | null;
  base_url: string | null;
}

async function loadCache(): Promise<TokenCache> {
  const { data, error } = await sb.from('fc_token_cache').select('*').eq('id', 1).single();
  if (error) throw new Error('fc_token_cache load: ' + error.message);
  return data as TokenCache;
}

async function saveCache(patch: Partial<TokenCache>) {
  const { error } = await sb
    .from('fc_token_cache')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) throw new Error('fc_token_cache save: ' + error.message);
}

// ---------- auth ----------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function loginWithPassword(): Promise<TokenResponse> {
  if (!FC_USERNAME || !FC_PASSWORD) {
    throw new Error('FC_USERNAME and FC_PASSWORD env vars are required');
  }
  const form = new FormData();
  form.append('username', FC_USERNAME);
  form.append('password', FC_PASSWORD);
  const res = await fetch(FC_BASE + '/login/token', { method: 'POST', body: form });
  if (!res.ok) throw new Error('login/token: ' + res.status + ' ' + (await res.text()));
  const j = await res.json() as TokenResponse;
  if (!j.access_token) throw new Error('login/token: no access_token in response');
  return j;
}

async function refreshAccess(refreshToken: string): Promise<TokenResponse> {
  const form = new FormData();
  form.append('refreshToken', refreshToken);
  const res = await fetch(FC_BASE + '/login/refresh', { method: 'POST', body: form });
  if (!res.ok) throw new Error('login/refresh: ' + res.status + ' ' + (await res.text()));
  const j = await res.json() as TokenResponse;
  if (!j.access_token) throw new Error('login/refresh: no access_token in response');
  return j;
}

async function fetchUserId(accessToken: string): Promise<string> {
  const res = await fetch(FC_BASE + '/login/userinfo', {
    headers: { 'Authorization': 'Bearer ' + accessToken },
  });
  if (!res.ok) throw new Error('login/userinfo: ' + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('login/userinfo: empty');
  // If the user has multiple userIds, the docs say the user must choose.
  // For now: pick the first. Add explicit selection if APBG ever has multiples.
  return arr[0].userId;
}

async function ensureToken(): Promise<{ accessToken: string; userId: string }> {
  const cache = await loadCache();
  const now = Date.now();
  const accessExp = cache.access_token_expires_at ? Date.parse(cache.access_token_expires_at) : 0;
  const refreshExp = cache.refresh_token_expires_at ? Date.parse(cache.refresh_token_expires_at) : 0;

  // Cache hit: token still valid + we know our userId.
  if (cache.api_token && cache.account_id && accessExp - now > EXP_BUFFER_MS) {
    return { accessToken: cache.api_token, userId: cache.account_id };
  }

  // Try refresh first.
  if (cache.refresh_token && refreshExp - now > EXP_BUFFER_MS) {
    try {
      const t = await refreshAccess(cache.refresh_token);
      const userId = cache.account_id ?? (await fetchUserId(t.access_token));
      await saveCache({
        api_token: t.access_token,
        refresh_token: t.refresh_token ?? cache.refresh_token,
        access_token_expires_at: new Date(now + ACCESS_TTL_MS).toISOString(),
        // Only bump refresh_token_expires_at if we got a new refresh token.
        ...(t.refresh_token && t.refresh_token !== cache.refresh_token
          ? { refresh_token_expires_at: new Date(now + REFRESH_TTL_MS).toISOString() }
          : {}),
        account_id: userId,
      });
      return { accessToken: t.access_token, userId };
    } catch (err) {
      console.warn('refresh failed, falling back to full login:', (err as Error).message);
    }
  }

  // Full login.
  const t = await loginWithPassword();
  const userId = cache.account_id ?? (await fetchUserId(t.access_token));
  await saveCache({
    api_token: t.access_token,
    refresh_token: t.refresh_token ?? null,
    access_token_expires_at: new Date(now + ACCESS_TTL_MS).toISOString(),
    refresh_token_expires_at: t.refresh_token ? new Date(now + REFRESH_TTL_MS).toISOString() : null,
    account_id: userId,
  });
  return { accessToken: t.access_token, userId };
}

// ---------- GraphQL client ----------

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

// Sleep helper for the 429 backoff.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function graphql<T>(
  query: string,
  ctx: { accessToken: string; userId: string },
  attempt = 1,
): Promise<T> {
  const res = await fetch(FC_BASE + '/graphql', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + ctx.accessToken,
      'userId': ctx.userId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (res.status === 429) {
    if (attempt >= 2) throw new Error('graphql: rate-limited (HTTP 429) after retry');
    await sleep(2000);
    return graphql<T>(query, ctx, attempt + 1);
  }
  if (!res.ok) throw new Error('graphql: ' + res.status + ' ' + (await res.text()));

  const j = await res.json() as GraphQLResponse<T>;
  if (j.errors?.length) throw new Error('graphql errors: ' + j.errors.map((e) => e.message).join('; '));
  if (!j.data) throw new Error('graphql: empty response');
  return j.data;
}

// ---------- vehicles sync ----------

interface FcVehicle {
  vin: string | null;
  id: string;
  name: string | null;
  licensePlate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  assignedGroups?: { id: string; description: string | null; name: string | null; fleetId: string; externalId: string | null }[];
  assignedDevices?: { id: string; serial: string | null; phoneNumber: string | null }[];
}

// NOTE: Vehicle.latestData (and its odometer / engineHours / fuel children) is
// the obvious source for current odometer, but its resolver is broken on
// Unity's side: any selection under latestData triggers
//   "Invalid timestamp, ISO8601 format expected: 2023-08-01T00:00:00Z"
// repeated once per vehicle (verified 2026-05-08, fleet of 9). The bug fires
// even when `timestamp` is not in the selection set, so we cannot use this
// path. Workarounds for current odometer:
//   (a) getLatestSnapshots(vehicleIds: [UUID]) → CommonFormat.canBus.canDistance
//       (cumulative km from CAN-bus; not all vehicles expose CAN data).
//   (b) Sum CommonFormat.canBus.canDeltaDistance across getSnapshots over a
//       sliding window, applied as a delta to the previous odometer reading.
// Tracked alongside the wrapped-report bug for the Powerfleet support ticket.
const VEHICLES_QUERY = `{
  getVehicles {
    vin
    id
    name
    licensePlate
    make
    model
    year
    assignedGroups { id description name fleetId externalId }
    assignedDevices { id serial phoneNumber }
  }
}`;

async function syncVehicles(ctx: { accessToken: string; userId: string }) {
  const data = await graphql<{ getVehicles: FcVehicle[] }>(VEHICLES_QUERY, ctx);
  const vehicles = data.getVehicles ?? [];
  const now = new Date().toISOString();

  const rows = vehicles.map((v) => ({
    fc_asset_id:   v.id,
    vehicle_name:  v.name,
    vin:           v.vin,
    license_plate: v.licensePlate,
    make:          v.make,
    model:         v.model,
    year:          v.year,
    status:        'active' as const,
    synced_at:     now,
  }));

  if (rows.length === 0) return { count: 0 };

  const { error } = await sb
    .from('fleet_vehicles')
    .upsert(rows, { onConflict: 'fc_asset_id' });
  if (error) throw new Error('fleet_vehicles upsert: ' + error.message);

  return { count: rows.length };
}

// ---------- latest-snapshot sync (live-map state) ----------

interface FcLatestSnapshot {
  vehicleId: string;
  timestamp: string;
  locationTimestamp: string | null;
  gps: {
    state: boolean | null;
    latitude: number | null;
    longitude: number | null;
    direction: number | null;
    speed: number | null;
  } | null;
  ignition: { engineStatus: boolean | null } | null;
  driver: { driverId: string | null } | null;
}

const LATEST_QUERY = `query Latest($ids: [UUID!]!) {
  getLatestSnapshots(vehicleIds: $ids) {
    vehicleId
    timestamp
    locationTimestamp
    gps      { state latitude longitude direction speed }
    ignition { engineStatus }
    driver   { driverId }
  }
}`;

async function syncLatest(ctx: { accessToken: string; userId: string }) {
  // Pull vehicle UUIDs from our own table — we always sync vehicles first
  // when mode=all so this list is fresh.
  const { data: vehicles, error: vErr } = await sb
    .from('fleet_vehicles')
    .select('fc_asset_id');
  if (vErr) throw new Error('fleet_vehicles read: ' + vErr.message);
  const ids = (vehicles ?? []).map((v) => v.fc_asset_id).filter(Boolean);
  if (ids.length === 0) return { count: 0, note: 'no vehicles in fleet_vehicles yet' };

  // graphql() helper takes a query string only; pass the variables inline
  // by interpolating ids as a JSON literal. Cheaper than extending the
  // helper to accept variables for this single call.
  const res = await fetch(FC_BASE + '/graphql', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + ctx.accessToken,
      'userId': ctx.userId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: LATEST_QUERY, variables: { ids } }),
  });
  if (!res.ok) throw new Error('graphql(latest): ' + res.status + ' ' + (await res.text()));
  const j = await res.json() as { data?: { getLatestSnapshots: FcLatestSnapshot[] }; errors?: { message: string }[] };
  if (j.errors?.length) throw new Error('graphql(latest) errors: ' + j.errors.map((e) => e.message).join('; '));
  const snapshots = j.data?.getLatestSnapshots ?? [];

  const now = new Date().toISOString();
  const rows = snapshots.map((s) => ({
    fc_asset_id:  s.vehicleId,
    snapshot_at:  s.timestamp,
    fetched_at:   now,
    gps_fix:      s.gps?.state ?? null,
    latitude:     s.gps?.latitude ?? null,
    longitude:    s.gps?.longitude ?? null,
    heading_deg:  s.gps?.direction ?? null,
    speed_kmh:    s.gps?.speed ?? null,
    ignition_on:  s.ignition?.engineStatus ?? null,
    fc_driver_id: s.driver?.driverId ?? null,
  }));

  if (rows.length === 0) return { count: 0 };

  const { error } = await sb
    .from('fleet_latest_snapshots')
    .upsert(rows, { onConflict: 'fc_asset_id' });
  if (error) throw new Error('fleet_latest_snapshots upsert: ' + error.message);

  return { count: rows.length };
}

// ---------- people / drivers sync ----------

interface FcPerson {
  id: string;
  isDriver: boolean;
  isUser: boolean;
  fleetId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  employeeId: string | null;
}

const PEOPLE_QUERY = `{
  getPeople {
    id isDriver isUser fleetId
    firstName lastName email phone employeeId
  }
}`;

async function syncPeople(ctx: { accessToken: string; userId: string }) {
  const data = await graphql<{ getPeople: FcPerson[] }>(PEOPLE_QUERY, ctx);
  const all = data.getPeople ?? [];
  // Only persist drivers — admin users / system entries don't belong in the roster.
  const drivers = all.filter((p) => p.isDriver);
  const now = new Date().toISOString();
  const rows = drivers.map((p) => ({
    fc_person_id: p.id,
    first_name:   p.firstName,
    last_name:    p.lastName,
    email:        p.email,
    phone:        p.phone,
    employee_id:  p.employeeId,
    is_driver:    p.isDriver,
    is_user:      p.isUser,
    fleet_id:     p.fleetId,
    synced_at:    now,
  }));
  if (rows.length === 0) return { count: 0 };
  const { error } = await sb.from('fleet_drivers').upsert(rows, { onConflict: 'fc_person_id' });
  if (error) throw new Error('fleet_drivers upsert: ' + error.message);
  return { count: rows.length, total_people: all.length };
}

// ---------- geofences sync ----------

interface FcGeofence {
  id: string;
  name: string | null;
  description: string | null;
  type: string | null;
  color: string | null;
  geojson: unknown;
  fleetId: string;
}

const GEOFENCES_QUERY = `{
  getGeofences {
    id name description type color geojson fleetId
  }
}`;

async function syncGeofences(ctx: { accessToken: string; userId: string }) {
  const data = await graphql<{ getGeofences: FcGeofence[] }>(GEOFENCES_QUERY, ctx);
  const fences = data.getGeofences ?? [];
  if (fences.length === 0) {
    return { count: 0, note: 'no geofences defined in Unity portal — Tier-2 stop attribution stays dormant until you create some' };
  }
  const now = new Date().toISOString();
  const rows = fences.map((g) => ({
    fc_geofence_id: g.id,
    name:           g.name,
    description:    g.description,
    type:           g.type,
    color:          g.color,
    geojson:        g.geojson,
    fleet_id:       g.fleetId,
    synced_at:      now,
  }));
  const { error } = await sb.from('fleet_geofences').upsert(rows, { onConflict: 'fc_geofence_id' });
  if (error) throw new Error('fleet_geofences upsert: ' + error.message);
  return { count: rows.length };
}

// ---------- trips + driver-event extraction ----------
//
// One pass over getSnapshots produces both:
//   - ops.fleet_trips rows (one per ignition cycle ≥ 2 min apart)
//   - ops.fleet_driver_events rows (one per driverBehaviour event)
//
// Sequential per vehicle (Unity allows one active GraphQL request per
// user). Default window: last 26 hours, with 2-hour overlap with the
// previous run for robustness.
//
// Idempotency: fc_trip_id = sha1(fc_asset_id + ':' + start_time);
// fleet_driver_events has UNIQUE(fc_asset_id, event_at, event_type).

interface FcSnapshot {
  vehicleId: string;
  timestamp: string;
  locationTimestamp: string | null;
  gps: {
    state: boolean | null;
    latitude: number | null;
    longitude: number | null;
    direction: number | null;
    speed: number | null;
  } | null;
  ignition: { engineStatus: boolean | null } | null;
  driver: { driverId: string | null } | null;
  driverBehaviour: { driverBehaviourType: string | null; driverBehaviourValue: number | null } | null;
  canBus: { canDeltaDistance: number | null; canDistance: number | null } | null;
}

const SNAPSHOTS_QUERY = `query Snap($vid: UUID!, $from: DateTime!, $to: DateTime!) {
  getSnapshots(vehicleId: $vid, from: $from, to: $to) {
    vehicleId timestamp locationTimestamp
    gps      { state latitude longitude direction speed }
    ignition { engineStatus }
    driver   { driverId }
    driverBehaviour { driverBehaviourType driverBehaviourValue }
    canBus   { canDeltaDistance canDistance }
  }
}`;

const KM_TO_MILES = 0.621371;
const TRIP_GAP_MS = 2 * 60 * 1000;            // ≥2 min ignition-off splits trips
const TRIPS_WINDOW_MS = 26 * 60 * 60 * 1000;  // last 26 hours

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const x = Math.sin(dLat/2)**2 + Math.sin(dLon/2)**2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface ReconstructedTrip {
  fc_trip_id:        string;
  fc_asset_id:       string;
  fc_driver_id:      string | null;
  trip_date:         string;
  start_time:        string;
  end_time:          string;
  distance_miles:    number;
  drive_time_min:    number;
  idle_time_min:     number;
  max_speed_mph:     number;
  avg_speed_mph:     number;
  hard_brakes:       number;
  hard_accels:       number;
  speed_violations:  number;
  synced_at:         string;
}

interface ActiveTrip {
  start_time: string;
  last_active_time: string;
  last_active_t: number;
  snapshots: FcSnapshot[];
  distance_km: number;
  max_speed_kmh: number;
  idle_seconds: number;
  fc_driver_id: string | null;
}

async function reconstructTrips(fc_asset_id: string, snapshots: FcSnapshot[], now: string): Promise<ReconstructedTrip[]> {
  // Sort by timestamp ascending. Unity returns mostly-sorted but not guaranteed.
  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const trips: ReconstructedTrip[] = [];

  let active: ActiveTrip | null = null;

  let prevTime: number | null = null;
  let prevWasIgnitionOn: boolean | null = null;
  let prevLat: number | null = null;
  let prevLon: number | null = null;
  let prevSpeed: number | null = null;

  for (const snap of snapshots) {
    const t = Date.parse(snap.timestamp);
    if (isNaN(t)) continue;
    const ignOn = snap.ignition?.engineStatus === true;
    const lat = snap.gps?.latitude ?? null;
    const lon = snap.gps?.longitude ?? null;
    const speed = snap.gps?.speed ?? null;

    if (ignOn) {
      if (!active) {
        active = {
          start_time: snap.timestamp,
          last_active_time: snap.timestamp,
          last_active_t: t,
          snapshots: [],
          distance_km: 0,
          max_speed_kmh: 0,
          idle_seconds: 0,
          fc_driver_id: snap.driver?.driverId ?? null,
        };
      }
      active.last_active_time = snap.timestamp;
      active.last_active_t = t;
      active.snapshots.push(snap);
      if (snap.driver?.driverId && !active.fc_driver_id) active.fc_driver_id = snap.driver.driverId;
      if (typeof speed === 'number' && speed > active.max_speed_kmh) active.max_speed_kmh = speed;
      // Sum haversine if we have a previous in-trip GPS point (avoid the
      // 0,0 sentinel Unity emits before GPS lock).
      if (
        prevTime !== null && prevWasIgnitionOn === true &&
        typeof lat === 'number' && typeof lon === 'number' &&
        typeof prevLat === 'number' && typeof prevLon === 'number' &&
        !(lat === 0 && lon === 0) && !(prevLat === 0 && prevLon === 0)
      ) {
        const km = haversineKm(prevLat, prevLon, lat, lon);
        if (km < 50) active.distance_km += km;   // sanity gate
      }
      // Idle accumulation: speed=0 while ignition on.
      if (
        prevTime !== null && prevWasIgnitionOn === true &&
        typeof prevSpeed === 'number' && prevSpeed === 0 &&
        typeof speed === 'number' && speed === 0
      ) {
        active.idle_seconds += (t - prevTime) / 1000;
      }
    } else {
      // Ignition off: end the trip if it's been off long enough since last active sample.
      if (active && (t - active.last_active_t) >= TRIP_GAP_MS) {
        trips.push(await finalizeTrip(active, fc_asset_id, now));
        active = null;
      }
    }

    prevTime = t;
    prevWasIgnitionOn = ignOn;
    prevLat = lat;
    prevLon = lon;
    prevSpeed = speed;
  }

  // Window ended mid-trip: finalize what we have. Next run's overlap will pick up the rest.
  if (active) {
    trips.push(await finalizeTrip(active, fc_asset_id, now));
  }
  return trips;
}

async function finalizeTrip(
  active: ActiveTrip,
  fc_asset_id: string,
  now: string,
): Promise<ReconstructedTrip> {
  const start_t = Date.parse(active.start_time);
  const end_t   = Date.parse(active.last_active_time);
  const drive_min = Math.max(0, (end_t - start_t) / 60_000);
  const idle_min  = active.idle_seconds / 60;
  const distance_miles = active.distance_km * KM_TO_MILES;
  const dur_h = drive_min / 60;
  const avg_speed_mph = dur_h > 0 ? distance_miles / dur_h : 0;
  const max_speed_mph = active.max_speed_kmh * KM_TO_MILES;

  // Hard-event counts from this trip's snapshots.
  let hard_brakes = 0;
  let hard_accels = 0;
  let speed_violations = 0;
  for (const s of active.snapshots) {
    const ev = s.driverBehaviour?.driverBehaviourType;
    if (ev === 'HARSH_BRAKING') hard_brakes++;
    else if (ev === 'HARSH_ACCELERATION') hard_accels++;
    else if (ev === 'MAX_SPEED_EXCEEDED' || ev === 'SPEED_SIGN_VIOLATION') speed_violations++;
  }

  const fc_trip_id = await sha1Hex(fc_asset_id + ':' + active.start_time);
  // trip_date = ISO date portion of start_time (UTC). Local-TZ correction is
  // a separate problem; cron runs at 11:00 UTC = 03:00 PT so most yesterday-
  // PT trips fall into the right UTC date already. Refine if needed.
  const trip_date = active.start_time.slice(0, 10);

  return {
    fc_trip_id,
    fc_asset_id,
    fc_driver_id: active.fc_driver_id,
    trip_date,
    start_time: active.start_time,
    end_time: active.last_active_time,
    distance_miles,
    drive_time_min: drive_min,
    idle_time_min: idle_min,
    max_speed_mph,
    avg_speed_mph,
    hard_brakes,
    hard_accels,
    speed_violations,
    synced_at: now,
  };
}

interface DriverEventRow {
  fc_asset_id: string;
  fc_driver_id: string | null;
  event_type: string;
  event_value: number | null;
  event_at: string;
  latitude: number | null;
  longitude: number | null;
  speed_kmh: number | null;
}

function extractDriverEvents(fc_asset_id: string, snapshots: FcSnapshot[]): DriverEventRow[] {
  const out: DriverEventRow[] = [];
  for (const s of snapshots) {
    const t = s.driverBehaviour?.driverBehaviourType;
    if (!t || t === 'DRIVER_BEHAVIOUR_TYPE_UNKNOWN') continue;
    out.push({
      fc_asset_id,
      fc_driver_id: s.driver?.driverId ?? null,
      event_type: t,
      event_value: s.driverBehaviour?.driverBehaviourValue ?? null,
      event_at: s.timestamp,
      latitude: s.gps?.latitude ?? null,
      longitude: s.gps?.longitude ?? null,
      speed_kmh: s.gps?.speed ?? null,
    });
  }
  return out;
}

async function syncTripsAndEvents(ctx: { accessToken: string; userId: string }) {
  const { data: vehicles, error: vErr } = await sb.from('fleet_vehicles').select('fc_asset_id');
  if (vErr) throw new Error('fleet_vehicles read: ' + vErr.message);
  const ids = (vehicles ?? []).map((v) => v.fc_asset_id).filter(Boolean) as string[];
  if (ids.length === 0) return { trips_upserted: 0, events_upserted: 0, vehicles_processed: 0 };

  const to = new Date();
  const from = new Date(to.getTime() - TRIPS_WINDOW_MS);
  const fromIso = from.toISOString();
  const toIso   = to.toISOString();
  const nowIso  = to.toISOString();

  let totalTrips = 0;
  let totalEvents = 0;
  const perVehicle: { fc_asset_id: string; trips: number; events: number; snapshots: number }[] = [];

  for (const fc_asset_id of ids) {
    // One vehicle per request — Unity rate limit.
    const res = await fetch(FC_BASE + '/graphql', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + ctx.accessToken,
        'userId': ctx.userId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: SNAPSHOTS_QUERY, variables: { vid: fc_asset_id, from: fromIso, to: toIso } }),
    });
    if (res.status === 429) {
      // Back off + retry once for this vehicle, then continue.
      await sleep(2000);
      continue;
    }
    if (!res.ok) {
      console.warn('graphql(snapshots) ' + fc_asset_id + ': ' + res.status);
      continue;
    }
    const j = await res.json() as { data?: { getSnapshots: FcSnapshot[] }; errors?: { message: string }[] };
    if (j.errors?.length) {
      console.warn('graphql(snapshots) ' + fc_asset_id + ' errors: ' + j.errors.map((e) => e.message).join('; '));
      continue;
    }
    const snapshots = j.data?.getSnapshots ?? [];
    if (snapshots.length === 0) {
      perVehicle.push({ fc_asset_id, trips: 0, events: 0, snapshots: 0 });
      continue;
    }

    const trips = await reconstructTrips(fc_asset_id, snapshots, nowIso);
    const events = extractDriverEvents(fc_asset_id, snapshots);
    perVehicle.push({ fc_asset_id, trips: trips.length, events: events.length, snapshots: snapshots.length });

    if (trips.length > 0) {
      const { error } = await sb.from('fleet_trips').upsert(trips, { onConflict: 'fc_trip_id' });
      if (error) throw new Error('fleet_trips upsert (' + fc_asset_id + '): ' + error.message);
      totalTrips += trips.length;
    }
    if (events.length > 0) {
      // ignoreDuplicates so re-runs over overlapping windows don't fail on the unique constraint.
      const { error } = await sb.from('fleet_driver_events').upsert(events, {
        onConflict: 'fc_asset_id,event_at,event_type',
        ignoreDuplicates: true,
      });
      if (error) throw new Error('fleet_driver_events upsert (' + fc_asset_id + '): ' + error.message);
      totalEvents += events.length;
    }
  }

  return {
    trips_upserted: totalTrips,
    events_upserted: totalEvents,
    vehicles_processed: ids.length,
    window: { from: fromIso, to: toIso },
    per_vehicle: perVehicle,
  };
}

// ---------- still-stubbed syncs ----------

async function syncFuel(_ctx: { accessToken: string; userId: string }) {
  // NOT POSSIBLE via Unity GraphQL.
  //
  // Confirmed via getWrappedReportInputs() 2026-05-08: the only fuel-related
  // reports Unity exposes are emissions and engine-diagnostics — neither
  // includes $-denominated fuel transactions. Per-snapshot CommonFormat.fuel
  // gives tank level / consumption (telemetry), not station purchases.
  //
  // To populate ops.fleet_fuel_transactions (gallons / price_per_gal /
  // total_cost / station_name / receipt_ref) we need a separate integration
  // with whichever fuel card APBG uses (Wex, Fleetcor, Voyager, Comdata).
  // Build that as sync-<provider>-fuel and add it as a separate writer in
  // architecture/sync-manifest.json.
  return { skipped: 'no fuel-transaction API in Unity GraphQL; needs separate fuel-card integration' };
}

async function syncMaintenance(_ctx: { accessToken: string; userId: string }) {
  // BLOCKED upstream.
  //
  // Unity has no direct getMaintenance query. The only path is
  // getWrappedReport(reportId: "maintenance-schedule", input: ...). The
  // report engine returns
  //   { "errors": [{ "message": "Something went wrong",
  //                  "extensions": { "error": "php-exception", "classification": "BAD_REQUEST" } }] }
  // for every call we've tried (verified 2026-05-08 with the four input
  // shapes documented in the file header). Other top-level queries on the
  // same endpoint work fine — it is specifically getWrappedReport that's
  // failing.
  //
  // Action: open a Powerfleet support ticket with our userId
  // (82273656-cd69-4044-a431-36288e840181) and the timestamps of a few
  // failing calls. When fixed, replace this stub with:
  //   getWrappedReport(input: { reportId: "maintenance-schedule", input: {
  //     period: { begin: ..., end: ... },
  //     asset_uuids: [<every fleet_vehicles.fc_asset_id>],
  //     maintenance_plans: [<plan ids from a separate query>]
  //   }})
  // and map the JSON `report` rows onto ops.fleet_maintenance.
  return { skipped: 'getWrappedReport(reportId=maintenance-schedule) blocked by upstream php-exception' };
}

// ---------- HTTP entry point ----------

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'all';

  try {
    if (!FC_USERNAME || !FC_PASSWORD) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'FC_USERNAME and FC_PASSWORD env vars not configured. See supabase/functions/sync-fleetcomplete/README.md.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const ctx = await ensureToken();
    const result: Record<string, unknown> = { mode };

    // Sequential — Unity allows only one active request per user.
    if (mode === 'all' || mode === 'vehicles')    result.vehicles    = await syncVehicles(ctx);
    if (mode === 'all' || mode === 'latest')      result.latest      = await syncLatest(ctx);
    if (mode === 'all' || mode === 'people')      result.people      = await syncPeople(ctx);
    if (mode === 'all' || mode === 'geofences')   result.geofences   = await syncGeofences(ctx);
    if (mode === 'all' || mode === 'trips')       result.trips       = await syncTripsAndEvents(ctx);
    if (mode === 'all' || mode === 'fuel')        result.fuel        = await syncFuel(ctx);
    if (mode === 'all' || mode === 'maintenance') result.maintenance = await syncMaintenance(ctx);

    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const err = e as Error;
    console.error('sync-fleetcomplete error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
