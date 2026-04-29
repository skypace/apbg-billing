// Pulls QBO Item master into ops.qbo_items so the margin dashboard can
// compute estimated COGS = quantity x Item.PurchaseCost. Run on demand from
// the dashboard (or wire into a scheduled trigger later).
//
// Required env vars:
//   QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REALM_ID  (already used by qbo-helpers)
//   SUPABASE_URL                                     (https://<ref>.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY                        (service_role JWT — write access)

import { qboQuery, corsHeaders } from './qbo-helpers.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function pickAccount(ref) {
  if (!ref) return { id: null, name: null };
  return { id: ref.value || null, name: ref.name || null };
}

function mapItem(it) {
  const inc = pickAccount(it.IncomeAccountRef);
  const exp = pickAccount(it.ExpenseAccountRef);
  const ass = pickAccount(it.AssetAccountRef);
  return {
    qbo_item_id: it.Id,
    name: it.Name || it.FullyQualifiedName || it.Id,
    fully_qualified_name: it.FullyQualifiedName || null,
    sku: it.Sku || null,
    type: it.Type || null,
    active: it.Active !== false,
    taxable: typeof it.Taxable === 'boolean' ? it.Taxable : null,
    unit_price: it.UnitPrice != null ? Number(it.UnitPrice) : null,
    purchase_cost: it.PurchaseCost != null ? Number(it.PurchaseCost) : null,
    qty_on_hand: it.QtyOnHand != null ? Number(it.QtyOnHand) : null,
    income_account_ref_id: inc.id,
    income_account_name: inc.name,
    expense_account_ref_id: exp.id,
    expense_account_name: exp.name,
    asset_account_ref_id: ass.id,
    asset_account_name: ass.name,
    parent_ref_id: it.ParentRef ? it.ParentRef.value : null,
    category_path: it.FullyQualifiedName && it.FullyQualifiedName.includes(':')
      ? it.FullyQualifiedName.split(':').slice(0, -1).join(':')
      : null,
    qbo_updated_at: it.MetaData && it.MetaData.LastUpdatedTime
      ? new Date(it.MetaData.LastUpdatedTime).toISOString()
      : null
  };
}

async function upsertBatch(rows) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  const url = `${SUPABASE_URL}/rest/v1/qbo_items?on_conflict=qbo_item_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase upsert ${res.status}: ${txt.slice(0, 300)}`);
  }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  try {
    let all = [];
    let start = 1;
    const PAGE = 500;

    while (true) {
      const result = await qboQuery(
        `SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS ${PAGE}`
      );
      const batch = result.QueryResponse?.Item || [];
      all = all.concat(batch);
      if (batch.length < PAGE) break;
      start += PAGE;
      if (start > 20000) break; // safety
    }

    const mapped = all.map(mapItem);
    const withCost = mapped.filter(r => r.purchase_cost != null).length;

    // Upsert in chunks of 500 to keep each request small
    for (let i = 0; i < mapped.length; i += 500) {
      await upsertBatch(mapped.slice(i, i + 500));
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        ok: true,
        synced: mapped.length,
        with_purchase_cost: withCost,
        without_cost: mapped.length - withCost
      })
    };
  } catch (err) {
    console.error('sync-qbo-items', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
}
