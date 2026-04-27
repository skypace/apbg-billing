# Fleet & HR Integration Guide

## AT&T FleetComplete (Powerfleet) Integration

### Status: Schema Ready, API Token Needed

**Base URL:** `https://tlshosted.fleetcomplete.com/Integration/v8_5_0`
**API Docs (Swagger):** `http://tlshosted.fleetcomplete.com/v8_6_1/Integration/WebAPI/fleet-docs/dist/index.html`
**Auth Help:** `https://tlshosted.fleetcomplete.com/Integration/v8_5_0/Help/Authentication`
**Support:** fcapi@fleetcomplete.com

### Authentication
- Token-based auth (session token)
- Requires ClientID, User, Password from your FC account
- Token stored in `ops.fc_token_cache` table (single-row pattern, same as QBO/SF)

### Key API Endpoints (v8.5/8.6)
| Endpoint | What it gives us | Maps to |
|---|---|---|
| GET /GPS/Asset | List all vehicles/assets | `ops.fleet_vehicles` |
| GET /GPS/Asset/{id} | Vehicle detail (VIN, plate, make, model) | `ops.fleet_vehicles` |
| GET /GPS/Trip | Trip history (start/end, distance, time) | `ops.fleet_trips` |
| GET /GPS/Asset/{id}/Trip | Trips for specific vehicle | `ops.fleet_trips` |
| GET /GPS/Position | Current GPS positions | Real-time map (future) |
| GET /GPS/Asset/{id}/Sensor | Fuel level, odometer, engine data | `ops.fleet_fuel_transactions` |
| GET /GPS/Asset/{id}/Rule | Speed violations, geofence alerts | `ops.fleet_daily` events |
| GET /GPS/FuelTransaction | Fuel card transactions | `ops.fleet_fuel_transactions` |

### Supabase Tables (Already Created)
- `ops.fleet_vehicles` — VIN, plate, make/model/year, odometer, fuel type, assigned driver, insurance/lease costs
- `ops.fleet_trips` — fc_trip_id, vehicle/driver FK, distance_miles, drive/idle time, hard brakes/accels, speed violations
- `ops.fleet_fuel_transactions` — vehicle/driver FK, gallons, price/gal, total_cost, odometer_at, station info
- `ops.fleet_maintenance` — vehicle FK, service_type (enum), cost, odometer, next_due tracking
- `ops.fleet_daily` — Daily rollup per driver: miles, idle, drive time, stops, fuel, safety events
- `ops.fc_token_cache` — Token storage (single row, id=1 constraint)

### Edge Function Needed: `sync-fleetcomplete`
Pattern: Same as sync-sf. Cron every 30 min.
1. Check token in `ops.fc_token_cache`, refresh if expired
2. Pull /GPS/Asset → upsert `ops.fleet_vehicles`
3. Pull /GPS/Trip (since last sync) → upsert `ops.fleet_trips`
4. Pull /GPS/FuelTransaction → upsert `ops.fleet_fuel_transactions`
5. Log to `ops.sync_log` with source='fleetcomplete'

### Setup Steps
1. Log into AT&T FleetComplete portal
2. Go to Integration → API Token Authentication
3. Generate API token (ClientID, credentials)
4. Store in Supabase: `INSERT INTO ops.fc_token_cache (id, api_token, account_id) VALUES (1, 'your-token', 'your-account-id') ON CONFLICT (id) DO UPDATE SET api_token = EXCLUDED.api_token, account_id = EXCLUDED.account_id, updated_at = now();`
5. Deploy `sync-fleetcomplete` edge function
6. Verify in `ops.sync_log`

---

## Bambee HR Integration

### Status: Schema Ready, Manual Entry (No API)

**Important:** Bambee does NOT offer a public API. Employee data must be managed manually through the dashboard UI or via CSV import.

**Alternative:** If PACER migrates to BambooHR in the future, the `bamboohr_id` column on `ops.hr_employees` is ready for automated sync via BambooHR's REST API (OAuth2, `https://{domain}.bamboohr.com/api/`).

### Supabase Tables (Already Created + Seeded)
- `ops.hr_employees` (20 records) — Linked to `ops.staff` via staff_id FK. Fields: name, email, phone, address, SSN last 4, DOB, hire/term dates, employment status/type, pay rate/type/frequency, exempt status, supervisor chain, Bambee/BambooHR IDs
- `ops.hr_time_off` — Request/approval workflow: vacation, sick, personal, bereavement, jury duty, FMLA, unpaid
- `ops.hr_documents` — Doc types: I-9, W-4, handbook ack, policy ack, offer letter, termination, warning, performance review, certification, training. Tracks signed_at, expires_at, status
- `ops.hr_performance` — Review types: annual, 90-day, verbal/written warning, PIP, commendation, coaching, termination. Rating 1-5, action items, next review date
- `ops.hr_onboarding` — Task checklist by category: paperwork, equipment, training, access, orientation

### Dashboard CRUD Needed
- Add/edit employee (from staff or standalone)
- Time-off request → approve/deny workflow
- Document upload tracking (signed status, expiry alerts)
- Performance review scheduling + history
- Onboarding checklist generator for new hires
- Bulk CSV import for initial data load from Bambee export

### Data Flow
```
Bambee (manual/CSV) → ops.hr_employees → Dashboard UI
                                ↕ FK
                          ops.staff ← ops.qbo_employees_cache (auto-sync)
```
