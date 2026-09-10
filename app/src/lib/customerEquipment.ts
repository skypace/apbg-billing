/**
 * Equipment on the Refractor customer page.
 *
 * Ask (Sky, 2026-09-09): the asset line "should be mirrored and SD and in
 * refractor under the customer". BrixSD's half shipped the same day; this is
 * Refractor's, and it closes the gap flagged at the end of the equipment-echo
 * work: "Refractor's own customer page shows no equipment at all."
 *
 * ⚠ ERLS OWNS THE ASSET RECORD. `ops.equipment_assets` (+ `equipment_contracts`)
 * is the ECHO, pulled nightly by brix-order's `sync-equipment-rentals`, and
 * BOTH readers read the echo and never ERLS. So everything here is read-only
 * and the one action is a link out to ERLS, which is where a change belongs.
 * The card prints how old the echo is, because the mirror has frozen twice in
 * three months and nothing ever showed its age.
 *
 * ⚠ NO NEW SQL. `ops.v_equipment_line` already composes the line, and chain
 * membership already lives in exactly one place — `ops.qbo_customers.parent_ref_id`,
 * the same link BrixSD's address ladder and brix-order's `ediMembers` read. A
 * `fn_customer_equipment` here would be a second definition of which customers
 * count.
 */
import { sbq } from './rpc';
import type { EquipmentAsset } from './assetLine';

export type { EquipmentAsset } from './assetLine';
export { assetLine, assetIdentity, assetNote, assetSerial, assetContract } from './assetLine';

/** A row plus WHERE it is. `store` is null on the customer's own equipment and
 *  carries the sub-customer's name on a chain master's stores. */
export type EquipmentRow = EquipmentAsset & { id: string; store: string | null };

export type CustomerEquipment = {
  rows: EquipmentRow[];
  /** How many of the rows sit at sub-customers rather than on this record. */
  atSubs: number;
  /** Newest `synced_at` across the rows — the age of the echo, as displayed. */
  syncedAt: string | null;
  /** Sum of `monthly_rent` over rows still on site. */
  monthlyOnSite: number;
  onSite: number;
};

/**
 * ⚠ DIGITS ONLY, and this is a guard rather than a formality: the id is
 * interpolated into a PostgREST `in.()` filter, and a value carrying a comma or
 * a paren would reshape the filter rather than fail it. Measured 2026-09-09 —
 * all 850 rows of `ops.qbo_customers.qbo_customer_id` match `^[0-9]+$`, so
 * refusing anything else provably drops nothing real.
 */
const numericId = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^[0-9]+$/.test(s) ? s : null;
};

const COLS = [
  'id', 'qbo_customer_id', 'asset_line', 'make_model', 'make', 'model_number',
  'serial_number', 'asset_tag', 'contract_number', 'contract_type', 'contract_status',
  'contract_start', 'contract_end', 'contract_document_url', 'category',
  'qbo_item_name', 'catalog_name', 'description', 'vendor', 'qty', 'monthly_rent',
  'ownership_type', 'status', 'is_loaner', 'installed_at', 'removed_at', 'on_site',
  'image_url', 'spec_sheet_url', 'synced_at',
].join(',');

export async function fetchCustomerEquipment(qboCustomerId: string): Promise<CustomerEquipment> {
  const self = numericId(qboCustomerId);
  if (!self) throw new Error(`Not a QuickBooks customer id: ${qboCustomerId}`);

  /* The sub-customers, so a chain MASTER does not read "no equipment on file"
     while its stores hold machines. Measured: 9 of the 67 equipment customers
     are sub-customers under 5 parents, and TAQUERIAS EL FAROLITOS MASTER holds
     11 assets at 4 stores ($1,320/month) with none on its own record — that
     page would have been silently wrong. Best-effort: a failed sub read must
     not cost the customer's own equipment. */
  let subs: { qbo_customer_id: string; display_name: string | null }[] = [];
  try {
    subs = await sbq<{ qbo_customer_id: string; display_name: string | null }>(
      'qbo_customers',
      `select=qbo_customer_id,display_name&parent_ref_id=eq.${self}&limit=500`,
    );
  } catch {
    subs = [];
  }

  const subName = new Map<string, string>();
  for (const s of subs) {
    const id = numericId(s.qbo_customer_id);
    if (id && id !== self) subName.set(id, (s.display_name || '').trim() || `Customer ${id}`);
  }

  const ids = [self, ...subName.keys()];
  const rows = await sbq<EquipmentRow>(
    'v_equipment_line',
    `select=${COLS}&qbo_customer_id=in.(${ids.join(',')})`
    + '&order=on_site.desc,make_model.asc,serial_number.asc.nullslast',
  );

  const out: EquipmentRow[] = rows.map((r) => ({
    ...r,
    store: r.qbo_customer_id && r.qbo_customer_id !== self
      ? subName.get(String(r.qbo_customer_id)) ?? `Customer ${r.qbo_customer_id}`
      : null,
  }));
  /* Own equipment first: on this page the customer's own machines are the
     answer and a store's are context. */
  out.sort((a, b) => Number(!!a.store) - Number(!!b.store));

  const rent = (v: EquipmentRow['monthly_rent']) => (v == null ? 0 : Number(v) || 0);
  return {
    rows: out,
    atSubs: out.filter((r) => r.store).length,
    syncedAt: out.reduce<string | null>(
      (n, r) => (r.synced_at && (!n || r.synced_at > n) ? r.synced_at : n), null),
    monthlyOnSite: out.filter((r) => r.on_site).reduce((s, r) => s + rent(r.monthly_rent), 0),
    onSite: out.filter((r) => r.on_site).length,
  };
}
