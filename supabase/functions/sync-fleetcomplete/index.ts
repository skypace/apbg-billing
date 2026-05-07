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
// Status of resource syncs:
//   getVehicles         IMPLEMENTED  (queries vin / id / name / groups / devices)
//   getTrips            STUBBED      (need GraphQL query name + shape from GraphiQL)
//   getFuelTransactions STUBBED      (same)
//   getMaintenance      STUBBED      (same)
//
// Once the GraphQL query strings are confirmed via the GraphiQL IDE at
// https://api.fleetcomplete.com/graphiql?path=/graphql, fill in the
// stubbed sync* functions below — the upsert plumbing is already wired
// to the corresponding ops.fleet_* tables.

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
  assignedGroups?: { id: string; description: string | null; name: string | null; fleetId: string; externalId: string | null }[];
  assignedDevices?: { id: string; serial: string | null; phoneNumber: string | null }[];
}

const VEHICLES_QUERY = `{
  getVehicles {
    vin
    id
    name
    assignedGroups { id description name fleetId externalId }
    assignedDevices { id serial phoneNumber }
  }
}`;

async function syncVehicles(ctx: { accessToken: string; userId: string }) {
  const data = await graphql<{ getVehicles: FcVehicle[] }>(VEHICLES_QUERY, ctx);
  const vehicles = data.getVehicles ?? [];
  const now = new Date().toISOString();

  const rows = vehicles.map((v) => ({
    fc_asset_id: v.id,
    vehicle_name: v.name,
    vin: v.vin,
    // Unity's getVehicles doesn't expose make/model/year/license/odometer in
    // this shape; if/when we find a richer query (e.g. getVehiclesById with a
    // full projection), populate those fields here. For now, default status
    // to 'active' to satisfy the CHECK constraint.
    status: 'active' as const,
    synced_at: now,
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
  // TODO(unity): replace with the real GraphQL query for trips. From the
  // GraphiQL IDE at https://api.fleetcomplete.com/graphiql?path=/graphql,
  // search the schema for getTrips / getJourneys / getRouteHistory or
  // similar, then map fields onto ops.fleet_trips:
  //   fc_trip_id, vehicle_id (FK to fleet_vehicles), driver_id, trip_date,
  //   start_time, end_time, start_address, end_address, distance_miles,
  //   drive_time_min, idle_time_min, max_speed_mph, avg_speed_mph,
  //   hard_brakes, hard_accels, speed_violations.
  return { skipped: 'TODO: GraphQL query for trips not yet wired' };
}

async function syncFuel(_ctx: { accessToken: string; userId: string }) {
  // TODO(unity): replace with the real GraphQL query for fuel transactions.
  // Map onto ops.fleet_fuel_transactions:
  //   vehicle_id, driver_id, txn_date, gallons, price_per_gal, total_cost,
  //   odometer_at, station_name, station_address, fuel_type, receipt_ref.
  return { skipped: 'TODO: GraphQL query for fuel not yet wired' };
}

async function syncMaintenance(_ctx: { accessToken: string; userId: string }) {
  // TODO(unity): replace with the real GraphQL query for maintenance records.
  // Map onto ops.fleet_maintenance:
  //   vehicle_id, service_date, service_type, description, vendor_name,
  //   cost, odometer_at, next_due_date, next_due_miles.
  return { skipped: 'TODO: GraphQL query for maintenance not yet wired' };
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
