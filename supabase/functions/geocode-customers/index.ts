// Supabase Edge Function: geocode-customers
// ------------------------------------------
// Populates ops.qbo_customers.lat/lon for customers we actively bill, plus
// the APBG depots (so depot stops can be labeled). Powers the auto-geofence
// stop-attribution feature — sync-fleetcomplete (mode=trips) reads these
// lat/lon and matches each truck stop to the nearest geocoded customer.
//
// Cohort (decided 2026-05-09 with Sky):
//   * Active in QBO AND
//   * Has a usable billing address AND
//   * Either has been billed in the last 90 days OR is "1951 Monarch …"
//     (the Alameda depot, which appears under several vehicle records).
//
// Geocoder: OpenStreetMap Nominatim. Free, polite (1 req/sec), good enough
// for ~150m match radius. Identify ourselves with a User-Agent string per
// usage policy. https://operations.osmfoundation.org/policies/nominatim/
//
// Idempotent: skips rows where geocoded_at IS NOT NULL unless the address
// changed since (qbo_updated_at > geocoded_at) or `force=true` is passed.
//
// Public state: ops.qbo_customers — adds lat / lon / geocoded_at /
// geocode_status (ok | not_found | error | no_address) / geocode_provider
// (always 'nominatim' for this function) / geocode_error.
//
// HTTP query params:
//   ?max=N        — cap the number of customers processed this run (default 200)
//   ?force=1      — also re-geocode rows that already have a result
//   ?cohort=...   — override the cohort SQL filter; default is "billed last 90d"
//                   (rare; for backfill or custom batches).

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const sb = createClient(SB_URL, SB_SERVICE_KEY, { db: { schema: 'ops' } });

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
// Per OSM usage policy: identify yourself.
const USER_AGENT = 'apbg-billing geocode-customers (skypace@brixbev.com)';
// Strict 1 req/sec on the public endpoint.
const REQ_INTERVAL_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface QboCustomerRow {
  qbo_customer_id: string;
  display_name: string | null;
  bill_addr_line1: string | null;
  bill_addr_city:  string | null;
  bill_addr_state: string | null;
  bill_addr_postal: string | null;
  qbo_updated_at:  string | null;
  geocoded_at:     string | null;
  geocode_status:  string | null;
}

// Fetch the cohort: active + addr-present + (billed-90d OR depot).
// We use an RPC-free implementation by hitting the customers table and the
// invoices table separately, then filtering client-side. Cohort is small
// (~440 rows), so this is fine.
async function loadCohort(maxRows: number, force: boolean): Promise<QboCustomerRow[]> {
  // Step 1: pull all active customers with an address.
  const { data: candidates, error: cErr } = await sb
    .from('qbo_customers')
    .select('qbo_customer_id,display_name,bill_addr_line1,bill_addr_city,bill_addr_state,bill_addr_postal,qbo_updated_at,geocoded_at,geocode_status')
    .eq('active', true)
    .not('bill_addr_line1', 'is', null);
  if (cErr) throw new Error('qbo_customers read: ' + cErr.message);

  // Step 2: pull qbo_customer_ids billed in last 90 days.
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const { data: billed, error: bErr } = await sb
    .from('qbo_invoices')
    .select('customer_ref_id')
    .gte('txn_date', since);
  if (bErr) throw new Error('qbo_invoices read: ' + bErr.message);
  const billedIds = new Set<string>();
  for (const b of (billed ?? [])) {
    if (b && (b as any).customer_ref_id) billedIds.add((b as any).customer_ref_id);
  }

  // Step 3: filter — keep billed-in-90d + always-keep-the-depot (matched
  // by the address line, since the depot appears under multiple vehicle
  // records in the customer list).
  const cohort = (candidates ?? []).filter((c: any) => {
    const billed = billedIds.has(c.qbo_customer_id);
    const isDepot = (c.bill_addr_line1 ?? '').toLowerCase().startsWith('1951 monarch');
    return billed || isDepot;
  });

  // Step 4: skip rows already geocoded unless force=true OR the customer
  // was updated upstream after our last geocode (address may have changed).
  const todo = cohort.filter((c: any) => {
    if (force) return true;
    if (!c.geocoded_at) return true;
    if (c.qbo_updated_at && c.geocoded_at && c.qbo_updated_at > c.geocoded_at) return true;
    return false;
  });

  return todo.slice(0, maxRows) as QboCustomerRow[];
}

interface NominatimHit {
  lat: string;
  lon: string;
  display_name?: string;
  importance?: number;
}

async function nominatimLookup(query: string): Promise<NominatimHit | null> {
  const url = NOMINATIM_BASE + '?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
  if (!res.ok) {
    throw new Error('nominatim ' + res.status + ' ' + (await res.text()).slice(0, 200));
  }
  const arr = (await res.json()) as NominatimHit[];
  return arr.length > 0 ? arr[0] : null;
}

function buildQuery(c: QboCustomerRow): string {
  const parts = [c.bill_addr_line1, c.bill_addr_city, c.bill_addr_state, c.bill_addr_postal]
    .map((p) => (p ?? '').trim())
    .filter(Boolean);
  return parts.join(', ');
}

async function geocodeOne(c: QboCustomerRow): Promise<{ status: string; lat?: number; lon?: number; error?: string }> {
  const q = buildQuery(c);
  if (!q) return { status: 'no_address' };
  try {
    const hit = await nominatimLookup(q);
    if (!hit) return { status: 'not_found' };
    const lat = parseFloat(hit.lat);
    const lon = parseFloat(hit.lon);
    if (!isFinite(lat) || !isFinite(lon)) return { status: 'error', error: 'parse failed: ' + JSON.stringify(hit) };
    return { status: 'ok', lat, lon };
  } catch (e) {
    return { status: 'error', error: (e as Error).message };
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const max   = parseInt(url.searchParams.get('max')   ?? '200', 10);
  const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';

  try {
    const todo = await loadCohort(Math.max(1, Math.min(2000, max)), force);
    if (todo.length === 0) {
      return new Response(JSON.stringify({ ok: true, processed: 0, note: 'cohort already up to date' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    let ok = 0, notFound = 0, errors = 0, noAddr = 0;
    const errSamples: string[] = [];
    const now = new Date().toISOString();

    // Sequential with 1.1s spacing — Nominatim free tier rule.
    for (let i = 0; i < todo.length; i++) {
      const c = todo[i];
      const result = await geocodeOne(c);

      const patch: Record<string, unknown> = {
        geocoded_at: now,
        geocode_status: result.status,
        geocode_provider: 'nominatim',
        geocode_error: result.error ?? null,
      };
      if (result.status === 'ok') {
        patch.lat = result.lat;
        patch.lon = result.lon;
      } else {
        // Clear stale lat/lon if we re-tried and failed.
        patch.lat = null;
        patch.lon = null;
      }

      const { error } = await sb
        .from('qbo_customers')
        .update(patch)
        .eq('qbo_customer_id', c.qbo_customer_id);
      if (error) {
        errors++;
        if (errSamples.length < 5) errSamples.push(c.display_name + ': ' + error.message);
      } else {
        if      (result.status === 'ok')          ok++;
        else if (result.status === 'not_found')   notFound++;
        else if (result.status === 'no_address')  noAddr++;
        else                                      errors++;
        if (result.status === 'error' && errSamples.length < 5 && result.error) {
          errSamples.push(c.display_name + ': ' + result.error);
        }
      }

      // Politeness delay between requests (skip after last).
      if (i < todo.length - 1) await sleep(REQ_INTERVAL_MS);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        processed: todo.length,
        results: { ok, not_found: notFound, no_address: noAddr, errors },
        error_samples: errSamples,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const err = e as Error;
    console.error('geocode-customers error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
});
