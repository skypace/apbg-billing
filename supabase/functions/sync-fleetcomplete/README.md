# sync-fleetcomplete edge function

Pulls fleet data from the Unity (Powerfleet / FleetComplete) GraphQL API at `https://api.fleetcomplete.com/graphql` and upserts into `ops.fleet_*` tables.

Status:

| Resource | Status |
|---|---|
| `getVehicles` → `ops.fleet_vehicles` | Implemented |
| `getTrips` → `ops.fleet_trips` | Stubbed; paste GraphQL query from GraphiQL IDE |
| `getFuelTransactions` → `ops.fleet_fuel_transactions` | Stubbed |
| `getMaintenance` → `ops.fleet_maintenance` | Stubbed |

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

## Filling in the stubbed syncs

For trips / fuel / maintenance:

1. Open `https://api.fleetcomplete.com/graphiql?path=/graphql` in your browser.
2. In the **Headers** panel paste:
   ```json
   { "userId": "82273656-cd69-4044-a431-36288e840181", "Authorization": "Bearer <fresh-access_token>" }
   ```
3. Browse the schema sidebar for query names matching the stubbed resources (likely `getTrips`, `getFuelTransactions`, `getMaintenance` — names are guesses; the IDE's autocomplete will reveal the truth).
4. Run a query, copy the working query string + the JSON shape of the result.
5. Paste both into the corresponding stub function in `index.ts` (the TODO comments document exactly which `ops.fleet_*` columns to populate).

Once a stub is filled in, redeploy with `supabase functions deploy sync-fleetcomplete`.
