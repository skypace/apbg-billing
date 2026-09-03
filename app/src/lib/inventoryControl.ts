import { sbq, sbrpc, sbInsert, sbUpdate } from './rpc';

// ── Types ────────────────────────────────────────────────────────────────

export type LocationKind =
  | 'warehouse'
  | 'van'
  | 'co_packer'
  | 'customer_consigned'
  | 'distributor'
  | 'in_transit'
  | 'adjustment';

export type LocationEntity = 'brix' | 'freeflow' | 'shared';

export interface InventoryLocation {
  id: string;
  code: string;
  name: string;
  kind: LocationKind;
  entity: LocationEntity;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type TransferStatus = 'draft' | 'in_transit' | 'received' | 'void';

export type FreightTerms = 'prepaid' | 'collect' | 'third_party';

export interface InventoryTransfer {
  id: string;
  bol_number: string;
  from_location_id: string;
  to_location_id: string;
  status: TransferStatus;
  carrier: string | null;
  tracking_number: string | null;
  ship_date: string | null;
  received_date: string | null;
  shipped_by: string | null;
  received_by: string | null;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  pro_number: string | null;
  freight_terms: FreightTerms | null;
  total_weight_lbs: number | null;
  total_pallets: number | null;
  declared_value_usd: number | null;
  special_instructions: string | null;
  shipper_signature_name: string | null;
  shipper_signature_at: string | null;
  receiver_signature_name: string | null;
  receiver_signature_at: string | null;
  reopened_at?: string | null;
  reopen_reason?: string | null;
}

export interface InventoryTransferLine {
  id: string;
  transfer_id: string;
  qbo_item_id: string;
  qty: number;
  qty_received: number | null;
  unit_cost: number | null;
  notes: string | null;
  created_at: string;
  line_weight_lbs: number | null;
  line_pallets: number | null;
  /** Producer lot / batch code. A production return is one line per lot. */
  lot_code: string | null;
  born_on_date: string | null;
  best_by_date: string | null;
}

export type InventoryTransferLineSummary = Pick<InventoryTransferLine, 'transfer_id' | 'qbo_item_id'>;

export interface InventoryTransferLineInput {
  qbo_item_id: string;
  qty: number;
  unit_cost?: number | null;
  notes?: string | null;
  line_weight_lbs?: number | null;
  line_pallets?: number | null;
  lot_code?: string | null;
  born_on_date?: string | null;
  best_by_date?: string | null;
}

export type MovementType =
  | 'transfer_ship'
  | 'transfer_receive'
  | 'receipt'
  | 'shipment'
  | 'adjustment'
  | 'production_consume'
  | 'production_yield'
  /** A receipt corrected down or a received transfer reopened (20260903c). */
  | 'receipt_reversal';

export interface InventoryMovement {
  id: string;
  movement_type: MovementType;
  qbo_item_id: string;
  qty: number;
  from_location_id: string | null;
  to_location_id: string | null;
  unit_cost: number | null;
  source_doc_type: string | null;
  source_doc_id: string | null;
  source_doc_line_id: string | null;
  occurred_at: string;
  created_by: string | null;
  created_at: string;
  notes: string | null;
}

export interface OnHandRow {
  qbo_item_id: string;
  location_id: string;
  on_hand: number;
}

// ── Reads ────────────────────────────────────────────────────────────────

// Reads go through the view so callers get `counts_as_our_stock` without
// re-deriving it; writes still go to the table (createLocation/updateLocation).
// A view cannot drift from what it derives, which a copied boolean would.
export async function fetchLocations(): Promise<InventoryLocationView[]> {
  return sbq<InventoryLocationView>(
    'v_inventory_locations',
    'select=*&order=is_active.desc,name.asc',
  );
}

export async function fetchTransfers(limit = 200): Promise<InventoryTransfer[]> {
  return sbq<InventoryTransfer>(
    'inventory_transfers',
    `select=*&order=created_at.desc&limit=${limit}`,
  );
}

export async function fetchTransferLines(transferId: string): Promise<InventoryTransferLine[]> {
  return sbq<InventoryTransferLine>(
    'inventory_transfer_lines',
    `select=*&transfer_id=eq.${transferId}&order=created_at.asc`,
  );
}

export async function fetchAllTransferLineSummaries(): Promise<InventoryTransferLineSummary[]> {
  return sbq<InventoryTransferLineSummary>(
    'inventory_transfer_lines',
    'select=transfer_id,qbo_item_id',
  );
}

export async function fetchMovements(limit = 500): Promise<InventoryMovement[]> {
  return sbq<InventoryMovement>(
    'inventory_movements',
    `select=*&order=occurred_at.desc&limit=${limit}`,
  );
}

/**
 * A location, plus the two questions `kind` was conflating.
 *
 * `kind` answers "what sort of place is this" — a building, a truck, a virtual
 * counter. It was ALSO being read as "does the stock here belong to us", which
 * is why a partner who is both a warehouse and a distributor had nowhere to
 * live. Ownership is a commercial fact and comes from the partner's model:
 * consignment stock is still ours until they sell it (which is why QuickBooks
 * keeps counting it), sell-in stock is theirs the moment it ships.
 */
export interface InventoryLocationView extends InventoryLocation {
  /** A real place stock can sit. False for TRANSIT and the adjustment counter. */
  is_physical: boolean;
  /** Counts toward the QuickBooks comparison. */
  counts_as_our_stock: boolean;
  partner_code: string | null;
  partner_name: string | null;
  partner_model: string | null;
}

export async function fetchOnHand(): Promise<OnHandRow[]> {
  return sbq<OnHandRow>('v_inventory_on_hand', 'select=*');
}

// ── Location CRUD ────────────────────────────────────────────────────────

export type NewLocation = Pick<InventoryLocation,
  'code' | 'name' | 'kind' | 'entity'
> & Partial<Pick<InventoryLocation,
  'address_line1' | 'address_line2' | 'city' | 'state' | 'postal_code' |
  'country' | 'contact_name' | 'contact_phone' | 'is_active' | 'notes'
>>;

export async function createLocation(loc: NewLocation): Promise<InventoryLocation> {
  const inserted = await sbInsert<NewLocation>('inventory_locations', loc);
  // sbInsert returns the row(s); PostgREST returns an array
  return Array.isArray(inserted) ? (inserted[0] as InventoryLocation) : (inserted as unknown as InventoryLocation);
}

export async function updateLocation(
  id: string,
  patch: Partial<InventoryLocation>,
): Promise<InventoryLocation> {
  const updated = await sbUpdate<InventoryLocation>(
    'inventory_locations',
    `id=eq.${id}`,
    patch,
  );
  return Array.isArray(updated) ? (updated[0] as InventoryLocation) : (updated as unknown as InventoryLocation);
}

// ── Transfer transitions (via SECURITY DEFINER RPCs) ────────────────────

export async function createTransfer(args: {
  from_location_id: string;
  to_location_id: string;
  lines: InventoryTransferLineInput[];
  carrier?: string | null;
  tracking_number?: string | null;
  notes?: string | null;
  pro_number?: string | null;
  freight_terms?: FreightTerms | null;
  total_weight_lbs?: number | null;
  total_pallets?: number | null;
  declared_value_usd?: number | null;
  special_instructions?: string | null;
}): Promise<string> {
  return sbrpc<string>('fn_create_transfer', {
    p_from_location_id: args.from_location_id,
    p_to_location_id: args.to_location_id,
    p_lines: args.lines,
    p_carrier: args.carrier ?? null,
    p_tracking_number: args.tracking_number ?? null,
    p_notes: args.notes ?? null,
    p_pro_number: args.pro_number ?? null,
    p_freight_terms: args.freight_terms ?? null,
    p_total_weight_lbs: args.total_weight_lbs ?? null,
    p_total_pallets: args.total_pallets ?? null,
    p_declared_value_usd: args.declared_value_usd ?? null,
    p_special_instructions: args.special_instructions ?? null,
  });
}

export async function updateTransferFreight(transferId: string, patch: {
  carrier?: string | null;
  tracking_number?: string | null;
  pro_number?: string | null;
  freight_terms?: FreightTerms | null;
  total_weight_lbs?: number | null;
  total_pallets?: number | null;
  declared_value_usd?: number | null;
  special_instructions?: string | null;
  notes?: string | null;
}): Promise<void> {
  await sbrpc('fn_update_transfer_freight', {
    p_transfer_id: transferId,
    p_carrier: patch.carrier ?? null,
    p_tracking_number: patch.tracking_number ?? null,
    p_pro_number: patch.pro_number ?? null,
    p_freight_terms: patch.freight_terms ?? null,
    p_total_weight_lbs: patch.total_weight_lbs ?? null,
    p_total_pallets: patch.total_pallets ?? null,
    p_declared_value_usd: patch.declared_value_usd ?? null,
    p_special_instructions: patch.special_instructions ?? null,
    p_notes: patch.notes ?? null,
  });
}

export async function shipTransfer(
  transferId: string,
  shipDate?: string | null,
  shipperSignatureName?: string | null,
): Promise<void> {
  await sbrpc('fn_ship_transfer', {
    p_transfer_id: transferId,
    p_ship_date: shipDate ?? null,
    p_shipper_signature_name: shipperSignatureName ?? null,
  });
}

export async function receiveTransfer(
  transferId: string,
  receivedDate?: string | null,
  receiverSignatureName?: string | null,
): Promise<void> {
  await sbrpc('fn_receive_transfer', {
    p_transfer_id: transferId,
    p_received_date: receivedDate ?? null,
    p_receiver_signature_name: receiverSignatureName ?? null,
  });
}

/** Received → in transit: every line reversed back to TRANSIT (refused once the stock has moved on). */
export async function reopenTransfer(transferId: string, reason: string): Promise<string> {
  return sbrpc<string>('fn_reopen_transfer', { p_transfer_id: transferId, p_reason: reason });
}

export async function voidTransfer(transferId: string, reason: string): Promise<void> {
  await sbrpc('fn_void_transfer', {
    p_transfer_id: transferId,
    p_reason: reason,
  });
}

// ── Adjustments ──────────────────────────────────────────────────────────

export type AdjustmentDirection = 'add' | 'remove';

export async function recordAdjustment(args: {
  location_id: string;
  qbo_item_id: string;
  qty: number;
  direction: AdjustmentDirection;
  reason: string;
  unit_cost?: number | null;
  occurred_at?: string | null;
}): Promise<string> {
  return sbrpc<string>('fn_record_adjustment', {
    p_location_id: args.location_id,
    p_qbo_item_id: args.qbo_item_id,
    p_qty:         args.qty,
    p_direction:   args.direction,
    p_reason:      args.reason,
    p_unit_cost:   args.unit_cost ?? null,
    p_occurred_at: args.occurred_at ?? null,
  });
}

// ── Reconciling to QuickBooks ────────────────────────────────────────────
//
// The division of labour: QuickBooks owns HOW MANY of a thing we hold; this
// ledger owns WHERE it is. So drift means our warehouse total has come adrift
// from QuickBooks, and a reconcile posts the correcting movement rather than
// rewriting history.
//
// This exists because the ledger sat frozen from 2026-05-14 to 2026-09-02 --
// 31 of 34 tracked items adrift, 3,345 units -- with nothing on any screen
// saying so. The numbers below are what stop that happening quietly again.

export interface LedgerStatus {
  movement_count: number;
  last_movement_at: string | null;
  items_drifting: number;
  abs_drift: number;
  /** At a co-packer or on a truck. Non-zero blocks a reconcile — see below. */
  qty_away_from_warehouse: number;
  /** Ours, but sitting at a partner on consignment. Counted in the comparison. */
  qty_on_consignment: number;
}

export interface DriftRow {
  qbo_item_id: string;
  item_name: string;
  qbo_qty: number;
  /** Everything that is ours, wherever it sits: our warehouses + consignment. */
  brix_qty: number;
  brix_warehouse_only: number;
  brix_consigned: number;
  brix_in_transit: number;
  drift: number;
  track_locations: boolean;
}

export interface ReconcilePreviewRow {
  qbo_item_id: string;
  item_name: string;
  qbo_qty: number;
  brix_qty: number;
  drift: number;
  applied: boolean;
}

export async function fetchLedgerStatus(): Promise<LedgerStatus | null> {
  const rows = await sbq<LedgerStatus>('v_inventory_ledger_status', 'select=*&limit=1');
  return rows[0] ?? null;
}

/** Only the rows worth showing: something we track by location, or something
 *  carrying a balance we did not expect it to have. */
export async function fetchDrift(): Promise<DriftRow[]> {
  return sbq<DriftRow>(
    'v_inventory_drift',
    'select=qbo_item_id,item_name,qbo_qty,brix_qty,brix_warehouse_only,brix_consigned,'
    + 'brix_in_transit,drift,track_locations'
    + '&or=(track_locations.eq.true,brix_qty.neq.0)&order=item_name.asc',
  );
}

/** Preview by default. `commit` writes one correcting movement per drifting
 *  item — and the server REFUSES outright while any stock is at a co-packer or
 *  in transit, because those units are not warehouse drift and adjusting them
 *  in would double-count the batch when it is received. */
export async function reconcileInventoryBulk(
  reason: string | null,
  commit: boolean,
): Promise<ReconcilePreviewRow[]> {
  return sbrpc<ReconcilePreviewRow[]>('fn_reconcile_inventory_bulk', {
    p_reason: reason,
    p_commit: commit,
  });
}

// ── The sales feed ───────────────────────────────────────────────────────
//
// A sale is the one movement nothing was writing, and it is why the ledger
// lost a day of stock a day: on 2026-09-01 we invoiced 174 units of tracked
// stock and the ledger was 176 adrift the next morning.
//
// An invoice cannot say WHICH building the case left, so the customer decides
// it: a customer attached to a sub-distributor (Refractor → Sub-Distributors →
// Accounts) deducts from that partner's warehouse, and everyone else from
// ours. Partners are always consignment and our system bills their customers,
// so the invoice is the depletion signal for their stock exactly as it is for
// ours.

export type SalesFeedMode = 'off' | 'shadow' | 'live';

export interface SalesFeedRow {
  mode: SalesFeedMode;
  apply_from: string;
  location_code: string;
  location_name: string;
  /** 'default_warehouse' or 'distributor:<CODE>' — why it routed there. */
  route_reason: string;
  lines_pending: number;
  units_pending: number;
}

export async function fetchSalesFeed(): Promise<SalesFeedRow[]> {
  return sbq<SalesFeedRow>('v_sales_ledger_summary', 'select=*&order=units_pending.desc');
}

/** ⚠ Writing needs BOTH live mode and an explicit commit; in shadow this
 *  computes and records nothing, which is how the cutover is checked. */
export async function setSalesFeedMode(mode: SalesFeedMode): Promise<string> {
  return sbrpc<string>('fn_sales_ledger_set_mode', { p_mode: mode });
}
