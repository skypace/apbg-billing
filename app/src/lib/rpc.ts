import { SB_URL, SB_KEY, _sbToken } from './supabase';

// Thin wrappers around PostgREST that target the `ops` schema.
// Each write helper sends BOTH Accept-Profile (response) and
// Content-Profile (request). Without Content-Profile, PostgREST
// falls back to `public` — which silently 404s DELETEs because
// these tables only exist in `ops`.

/**
 * Read from the `orders` schema (brix-order's tables) instead of `ops`.
 *
 * Refractor is the customer master + billing home as of 2026-09-09 (Sky's
 * ownership map), and the customer master lives in ONE table —
 * `orders.customers` — which all the APBG apps already reach. Nothing was
 * migrated; this is the read side of hosting the UI here.
 *
 * ⚠ READS ONLY, and deliberately so. `authenticated` holds SELECT and nothing
 * else on `orders.customers` / `customer_locations` / `company_settings`, so
 * there is no browser write path at all — every write goes through
 * brix-order's admin endpoints (see lib/customerBilling.ts), which are the
 * ONE writer and the one place the change is pushed onward to QuickBooks.
 * Do not add an `sbUpdateOrders`.
 *
 * ⚠ The rows come back under RLS policies gated on `ops.fn_is_staff()` — the
 * GATEWAY role — added in migration 20260909a. Before that the only staff
 * read policy keyed on `orders.customer_users.is_superadmin`, a brix-order
 * PORTAL flag: every current staff account happens to hold it, so this read
 * would have worked by luck and returned zero rows for the first staff member
 * added without one.
 */
export async function sbqOrders<T = unknown>(tbl: string, query = ''): Promise<T[]> {
  const url = SB_URL + '/rest/v1/' + tbl + (query ? '?' + query : '');
  const token = await _sbToken();
  const res = await fetch(url, {
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'orders',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    // Distinguish the three, because they need three different actions and a
    // single "load failed" is how a policy gap reads as a broken screen.
    const body = await res.text().catch(() => '');
    throw new Error(
      'sbqOrders ' + tbl + ' failed: ' + res.status
      + (res.status === 401 ? ' (session expired — sign in again)' : '')
      + (res.status === 403 ? ' (not permitted — needs a gateway superadmin/admin role)' : '')
      + (body ? ' ' + body.slice(0, 200) : ''),
    );
  }
  return res.json() as Promise<T[]>;
}

export async function sbq<T = unknown>(tbl: string, query = ''): Promise<T[]> {
  const url = SB_URL + '/rest/v1/' + tbl + (query ? '?' + query : '');
  const token = await _sbToken();
  const res = await fetch(url, {
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error('sbq ' + tbl + ' failed: ' + res.status);
  return res.json() as Promise<T[]>;
}

export async function sbrpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('sbrpc ' + fn + ' failed: ' + res.status + ' ' + text);
  }
  // VOID-returning RPCs (e.g. fn_set_inventory_settings) reply with 204 or an
  // empty 200 body. Tolerate both by reading as text first and only parsing
  // when there's content.
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Body wasn't JSON — return as raw text. Edge cases only; most RPCs
    // return either valid JSON or empty.
    return text as unknown as T;
  }
}

export async function sbInsert<T = unknown>(tbl: string, row: T): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/' + tbl, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error('sbInsert ' + tbl + ' failed: ' + res.status);
  return res.json() as Promise<T>;
}

export async function sbUpdate<T = unknown>(
  tbl: string,
  filter: string,
  patch: Partial<T>,
): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/' + tbl + '?' + filter, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('sbUpdate ' + tbl + ' failed: ' + res.status);
  return res.json() as Promise<T>;
}

export async function sbDelete(tbl: string, filter: string): Promise<void> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/' + tbl + '?' + filter, {
    method: 'DELETE',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('sbDelete ' + tbl + ' failed: ' + res.status + ' ' + text);
  }
}
