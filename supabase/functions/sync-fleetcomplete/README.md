# sync-fleetcomplete edge function

Pulls fleet data from the Unity (Powerfleet / FleetComplete) GraphQL API at `https://api.fleetcomplete.com/graphql` and upserts into `ops.fleet_*` tables.

Status (verified against the live schema 2026-05-08):

| Resource | Status | Source |
|---|---|---|
| `ops.fleet_vehicles` | **Implemented** | `getVehicles { vin id name assignedGroups{...} assignedDevices{...} }` |
| `ops.fleet_trips` | **Stubbed (data source confirmed)** | `getSnapshots(vehicleId, from, to)` works — needs trip-reconstruction logic. See [Filling in the stubs](#filling-in-the-stubs). |
| `ops.fleet_fuel_transactions` | **Not possible via Unity** | No fuel-transaction API exists in Unity GraphQL. Needs a separate fuel-card integration (Wex / Fleetcor / Voyager). |
| `ops.fleet_maintenance` | **Blocked upstream** | Only path is `getWrappedReport(reportId="maintenance-schedule")`. The report engine returns `php-exception` for every call regardless of input. Needs Powerfleet support ticket. |

## Setup

### 1. Set the secrets

The function authenticates against Unity by calling `POST /login/token` with form-encoded `username` and `password`. Those go in Supabase secrets, **not** in the database:

```bash
# Via Supabase CLI:
supabase secrets set --env-file .env.fc

# Or one-by-one:
supabase secrets set FC_USERNAME=skypace@brixbev.com
supabase secrets set FC_PASSWORD='your-password-here'
```

(The Supabase Studio UI also has a Secrets / Environment Variables panel under Project Settings → Edge Functions.)

### 2. Deploy the function

```bash
supabase functions deploy sync-fleetcomplete
```

### 3. Verify

```bash
curl 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-fleetcomplete?mode=vehicles' \
  -H 'apikey: <anon-or-service-role>' \
  -H 'Authorization: Bearer <anon-or-service-role>'
```

Expected first-run shape:

```json
{ "ok": true, "mode": "vehicles", "vehicles": { "count": 12 } }
```

After a successful run, `ops.fc_token_cache` (id=1) will hold the rotated `api_token` and `refresh_token`. The function will reuse those on subsequent runs and only re-login when the refresh token expires (12 hours).

### 4. Enable the nightly cron

After verifying a manual run works, enable the cron schedule. The cron is defined in `supabase/migrations/20260506h_sync_fleetcomplete_cron.sql` but ships **commented out** — uncomment, apply (Studio / CLI / MCP), and the function will run hourly.

## How auth works

Unity uses a 5-minute access token + 12-hour refresh token issued via username/password login:

```
POST /login/token  (form: username, password)         → access_token + refresh_token
POST /login/refresh (form: refreshToken)              → new access_token (and possibly new refresh_token)
GET  /login/userinfo (Bearer <access_token>)          → [{ userName, userId, fleetName, fleetId }, ...]
POST /graphql (Bearer <access_token>, userId header)  → GraphQL responses
```

The function's `ensureToken()` handles the lifecycle: cache hit → use; access expired but refresh valid → refresh; both expired → full login. Cached state lives in `ops.fc_token_cache` (id=1, singleton).

## Rate limiting

Unity allows **one active request per user**. Sending parallel requests returns HTTP 429. The function makes calls strictly sequentially and retries once after a 2-second backoff if it ever hits 429.

## Filling in the stubs

GraphiQL has been flaky for us — we recommend probing the schema directly via SQL through the Supabase MCP server (or any HTTP client) using `pg_net.http_post` against `https://api.fleetcomplete.com/graphql` with `Bearer <api_token>` + `userId: <account_id>` headers. The current token sits in `ops.fc_token_cache` (id=1) and is rotated by every function run.

### Trips — `getSnapshots`-based reconstruction

There is no direct `getTrips` query. The data is in `getSnapshots(vehicleId: UUID!, from: DateTime!, to: DateTime!) -> [CommonFormat]`. Snapshots are **event-driven** (not at fixed intervals — there are bursts of records when the engine starts and around state changes). To turn snapshots into `fleet_trips` rows:

1. For each `fc_asset_id` in `ops.fleet_vehicles`, look up the bigint `vehicle_id`.
2. Call `getSnapshots` for the desired window (last 26 h to overlap with the previous run).
3. Walk snapshots in `timestamp` order. A trip is a maximal segment where `ignition.engineStatus = true`, separated by ≥ 2 minutes of off.
4. `fc_trip_id = sha1(fc_asset_id + start_timestamp)` for upsert idempotency.
5. Compute per trip:
   - `trip_date` — start_time at vehicle local TZ
   - `distance_miles` — sum of haversine between consecutive `gps.{latitude,longitude}` (or sum `canBus.canDeltaDistance`) × 0.621371
   - `drive_time_min` — (end - start) / 60_000
   - `idle_time_min` — sum of intra-trip seconds with `gps.speed = 0` / 60
   - `max_speed_mph` — `max(gps.speed) × 0.621371` (Unity reports km/h)
   - `avg_speed_mph` — `distance_miles / (drive_time_min / 60)`
   - `driver_id` — lookup `ops.staff` by `driver.driverId` or `driver.iButton` (driver records are sparse; many snapshots have `driver: null`)
   - `hard_brakes` / `hard_accels` / `speed_violations` — from `driverBehaviour` events; left null until the `DriverBehaviourType` enum is mapped
6. Upsert into `ops.fleet_trips` on `fc_trip_id`.

Volume estimate at the current 9-asset fleet: ~75 K snapshots/day, ~5 MB JSON per daily run. Keep `getSnapshots` calls **strictly sequential** (Unity allows one active request per user).

Once the wrapped-report engine is fixed, `getWrappedReport(reportId: "vehicle-trips", input: ...)` becomes the easier path — its `report` field is JSON with the trip rows already aggregated.

### Maintenance — blocked

Only path is `getWrappedReport(reportId: "maintenance-schedule")`. Every call to `getWrappedReport` we've tried returns:

```json
{ "errors": [{
    "message": "Something went wrong",
    "extensions": { "error": "php-exception", "classification": "BAD_REQUEST" }
}]}
```

We confirmed this 2026-05-08 with empty input, full input matching `getWrappedReportInputs`, and explicit period/asset_uuids/timezone/working_hours. Other top-level queries (`getVehicles`, `getSnapshots`, `getPeople`, etc.) work — it is specifically the report engine. Open a Powerfleet support ticket with our userId (`82273656-cd69-4044-a431-36288e840181`) and timestamps of failing calls.

When unblocked, the resolver returns `{ reportId, report }` where `report` is JSON with rows ready to map onto `ops.fleet_maintenance`.

### Fuel — separate integration needed

Unity GraphQL has no fuel-transaction API. Per-snapshot `CommonFormat.fuel` and `canBus.canFuel*` give telemetry (tank level, consumption rate) but not $-denominated transactions. For `ops.fleet_fuel_transactions` we need to integrate the fuel-card provider (Wex / Fleetcor / Voyager / Comdata, depending on what APBG uses). Build that as a separate edge function (`sync-wex-fuel` or similar) and add it to `architecture/sync-manifest.json`.

## Schema discovery cheat sheet

Top-level queries on the Unity endpoint (verified 2026-05-08):

```
getUserInfo, getVehicles, getActiveVehicles, getVehicleById, getVehiclesByVin,
getPeople, getPersonById, getPersonCustomFields,
getGeofences, getGeofenceById,
getSnapshots, getLatestSnapshots,
getWrappedReport, getWrappedReportInputs,
getGroups, getMetaSensors, getVehicleMappedSensors, getVehicleCustomFields,
getLabels, getDeviceById, getDevicesBySerial,
getWorkSchedules, getWorkScheduleById,
getVehicleTypes, getRules, getRuleById, getRoles,
getDriverAssignments
```

`CommonFormat` (returned by `getSnapshots` / `getLatestSnapshots`) shape:

```
vehicleId         UUID
timestamp         DateTime
locationTimestamp DateTime
locationTimeZone  String
gps              { state, latitude, longitude, direction, altitude, speed }   // speed in km/h
ignition         { engineStatus }                                              // boolean
driver           { driverId, iButton, oneWire, rfidIButton, rfidIButtonHex, rfid, rfidHex, ... }
canBus           { canDistance, canDeltaDistance, canTripDistance, canFuelUsed, canTripFuelUsed,
                   canFuelRate, engineRunTime, engineIdleTime, ... ~80 fields }
fuel             { fuel, rawFuel, fuelLevel, totalFuelEconomy, fuelTankSize }
driverBehaviour  { driverBehaviourType, driverBehaviourValue }
misc             { power, vehicleBusType }
```

Speeds are km/h; distances are km — convert before writing `fleet_trips` (multiply by 0.621371).

Wrapped-report IDs available from `getWrappedReportInputs { id title description inputs }` (29 reports as of 2026-05-08): `distance-details, driver-performance, dvir-trips, emissions, engine-diagnostics, engine-diagnostics-summary, fleet-performance, fleet-sensors, geofence-interaction, geofence-list, group-list, ifta-distance, inspections, maintenance-schedule, people-list, safety-events, utilization, vehicle-activity, vehicle-daily-summary, vehicle-distance, vehicle-events, vehicle-idling, vehicle-period-summary, vehicle-positions, vehicle-sensor-measurements, vehicle-speeding, vehicle-stops, vehicle-towing, vehicle-trips, vehicles`. **All currently blocked by the upstream php-exception.**

Once a stub is filled in, redeploy with `supabase functions deploy sync-fleetcomplete`.
