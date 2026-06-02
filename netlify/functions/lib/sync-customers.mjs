// Shared loader for ops.sync_customers — the single identity map for the
// RESQ-linked customers (ResQ facility <-> SF customer <-> QBO customer).
//
// Read by resq-sf-sync-background.mjs and expense-to-bill.mjs so the
// ResQ-facility / SF-customer / QBO-customer names live in ONE place instead
// of drifting across hardcoded literals. Managed via the sync-customers
// Netlify function + the Settings section in sync.html.
//
// Reads use the public anon key (RLS allows SELECT). Writes happen only in
// the sync-customers endpoint via the service-role key.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase-helpers.mjs';

// Defensive fallback used ONLY if the DB read fails or returns nothing, so a
// transient Supabase blip can't silently halt the whole sync. Mirrors the two
// live rows seeded by migration 20260602a_sync_customers.sql.
const FALLBACK = [
  { qbo_customer_id: '1944', qbo_customer_name: 'THE MELT RESQ', sf_customer_name: 'THE MELT RESQ', resq_facility_keywords: ['melt', 'homeroom'], qbo_cogs_account_id: null, entity: null, linked: true },
  { qbo_customer_id: '1945', qbo_customer_name: 'STARBIRD CHICKEN RESQ', sf_customer_name: 'STARBIRD CHICKEN RESQ', resq_facility_keywords: ['starbird', 'star bird'], qbo_cogs_account_id: null, entity: null, linked: true },
];

/**
 * Load sync-customer rows. By default only linked rows (active in the sync).
 * Returns the FALLBACK list if the read fails or is empty so the sync degrades
 * to the known-good two customers rather than syncing nothing.
 */
export async function loadSyncCustomers({ includeUnlinked = false } = {}) {
  const url =
    `${SUPABASE_URL}/rest/v1/sync_customers?select=*&order=qbo_customer_name.asc` +
    (includeUnlinked ? '' : '&linked=eq.true');
  try {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept-Profile': 'ops',
      },
    });
    if (!res.ok) throw new Error(`sync_customers read ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) return rows;
    // Empty table — fall back so the sync keeps working on first deploy.
    return includeUnlinked ? rows : FALLBACK;
  } catch (e) {
    console.warn('[sync-customers] read failed, using fallback:', e.message);
    return includeUnlinked ? [] : FALLBACK;
  }
}

/**
 * Classify a ResQ facility name to a linked customer row, or null if none
 * of the linked customers' facility keywords match.
 */
export function classifySyncCustomer(facilityName, customers) {
  const f = (facilityName || '').toLowerCase();
  if (!f) return null;
  for (const c of customers) {
    const kws = c.resq_facility_keywords || [];
    if (kws.some((k) => k && f.includes(String(k).toLowerCase()))) return c;
  }
  return null;
}

/** Union of every linked customer's facility keywords (for the WO filter). */
export function allFacilityKeywords(customers) {
  return customers
    .flatMap((c) => c.resq_facility_keywords || [])
    .map((k) => String(k || '').toLowerCase())
    .filter(Boolean);
}

/** The SF customer name to seed resolveSfCustomerName() with for a row. */
export function sfNameFor(customer) {
  return customer?.sf_customer_name || customer?.qbo_customer_name || null;
}

/** A short brand stem for fuzzy SF/QBO matching (first facility keyword). */
export function stemFor(customer) {
  return (customer?.resq_facility_keywords || [])[0] || null;
}
