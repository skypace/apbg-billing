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

// ---------- stubbed syncs (paste GraphQL queries from GraphiQL IDE) ----------

async function syncTrips(_ctx: { accessToken: string; userId: string }) {
  // STUB: data source confirmed. Implementation deferred.
  //
  // No direct getTrips query — Unity exposes raw snapshots and expects clients
  // to reconstruct trips. Two paths:
  //
  // (a) getWrappedReport(reportId: "vehicle-trips", input: ...)
  //     Description: "Details about trips made by each asset within the
  //     selected time period (based on vehicle ignition & idling states)."
  //     Currently broken — returns php-exception for every call (see file
  //     header). When Powerfleet fixes it, this is the easy path: the report
  //     `report` field is JSON with the per-trip rows ready to upsert.
  //
  // (b) getSnapshots(vehicleId: UUID!, from: DateTime!, to: DateTime!) -> [CommonFormat]
  //     Works today. Returns event-driven snapshots (not at fixed intervals).
  //     To build a trip row:
  //       1. Look up vehicle_id (bigint) by fc_asset_id from ops.fleet_vehicles.
  //       2. For each fc_asset_id, call getSnapshots for the sync window
  //          (e.g. last 26h to overlap with the previous run).
  //       3. Walk snapshots in timestamp order; a "trip" is a maximal segment
  //          where ignition.engineStatus = true, separated by ≥2 min of off.
  //       4. fc_trip_id = sha1(fc_asset_id + start_timestamp) → deterministic
  //          for upsert idempotency.
  //       5. Per trip, compute:
  //            trip_date         = start_time at vehicle local TZ
  //            distance_miles    = haversine sum (or sum canBus.canDeltaDistance) × 0.621371
  //            drive_time_min    = (end - start) / 60_000
  //            idle_time_min     = sum of intra-trip seconds with speed=0 / 60
  //            max_speed_mph     = max(gps.speed) × 0.621371
  //            avg_speed_mph     = distance_miles / (drive_time_min / 60)
  //            driver_id         = lookup ops.staff by driver.driverId or driver.iButton
  //          (hard_brakes / hard_accels / speed_violations come from
  //          driverBehaviour.driverBehaviourType events; left null until we
  //          map the DriverBehaviourType enum.)
  //       6. Upsert into ops.fleet_trips on fc_trip_id.
  //
  // Cost estimate for option (b) on the current fleet (9 fc_asset_ids, ~700
  // snapshots / vehicle / 2h ≈ 8K snapshots/vehicle/day): ~75K snapshots/day,
  // ~5MB JSON per daily run. Keep getSnapshots calls strictly sequential
  // (Unity's one-active-request rule).
  return {
    skipped:
      'getSnapshots-based trip reconstruction not yet implemented. ' +
      'Wrapped report (reportId=vehicle-trips) blocked by upstream php-exception.',
  };
}

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
    if (mode === 'all' || mode === 'trips')       result.trips       = await syncTrips(ctx);
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
