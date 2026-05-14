import { sbq, sbrpc, sbInsert, sbUpdate } from './rpc';

// ── Types ────────────────────────────────────────────────────────────────

export type LocationKind =
  | 'warehouse'
  | 'van'
  | 'co_packer'
  | 'customer_consigned'
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
}

export interface InventoryTransferLineInput {
  qbo_item_id: string;
  qty: number;
  unit_cost?: number | null;
  notes?: string | null;
}

export type MovementType =
  | 'transfer_ship'
  | 'transfer_receive'
  | 'receipt'
  | 'shipment'
  | 'adjustment'
  | 'production_consume'
  | 'production_yield';

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

export async function fetchLocations(): Promise<InventoryLocation[]> {
  return sbq<InventoryLocation>(
    'inventory_locations',
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

export async function fetchMovements(limit = 500): Promise<InventoryMovement[]> {
  return sbq<InventoryMovement>(
    'inventory_movements',
    `select=*&order=occurred_at.desc&limit=${limit}`,
  );
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
}): Promise<string> {
  return sbrpc<string>('fn_create_transfer', {
    p_from_location_id: args.from_location_id,
    p_to_location_id: args.to_location_id,
    p_lines: args.lines,
    p_carrier: args.carrier ?? null,
    p_tracking_number: args.tracking_number ?? null,
    p_notes: args.notes ?? null,
  });
}

export async function shipTransfer(transferId: string, shipDate?: string | null): Promise<void> {
  await sbrpc('fn_ship_transfer', {
    p_transfer_id: transferId,
    p_ship_date: shipDate ?? null,
  });
}

export async function receiveTransfer(
  transferId: string,
  receivedDate?: string | null,
): Promise<void> {
  await sbrpc('fn_receive_transfer', {
    p_transfer_id: transferId,
    p_received_date: receivedDate ?? null,
  });
}

export async function voidTransfer(transferId: string, reason: string): Promise<void> {
  await sbrpc('fn_void_transfer', {
    p_transfer_id: transferId,
    p_reason: reason,
  });
}
