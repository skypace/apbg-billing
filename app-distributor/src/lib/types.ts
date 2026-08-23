// Row shapes for the slices of ops.* the distributor portal reads.
// Columns per supabase/migrations/20260818f_sub_distributors.sql.
// ⚠ GUARDRAIL: unit_cost is never selected and never displayed anywhere.

export type DistributorModel = 'consignment' | 'sell_in';

export interface SubDistributor {
  id: string;
  code: string;
  name: string;
  status: 'pending' | 'active' | 'inactive';
  model: DistributorModel;
  per_case_delivery_fee: number | null;
  qbo_customer_id: string | null;
  inventory_location_id: string | null;
  territory: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

export interface InventoryLocation {
  id: string;
  code: string;
  name: string;
  kind: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  contact_name: string | null;
  contact_phone: string | null;
}

export type TransferStatus = 'draft' | 'in_transit' | 'received' | 'void';

export interface InventoryTransfer {
  id: string;
  bol_number: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  status: TransferStatus;
  carrier: string | null;
  tracking_number: string | null;
  pro_number: string | null;
  freight_terms: string | null;
  ship_date: string | null;
  received_date: string | null;
  total_weight_lbs: number | null;
  total_pallets: number | null;
  declared_value_usd: number | null;
  special_instructions: string | null;
  shipper_signature_name: string | null;
  receiver_signature_name: string | null;
  receiver_notes: string | null;
  has_discrepancy: boolean;
  notes: string | null;
  created_at: string;
}

export interface InventoryTransferLine {
  id: string;
  transfer_id: string;
  qbo_item_id: string;
  qty: number;
  qty_received: number | null;
  notes: string | null;
  // unit_cost exists on the table but is deliberately NEVER selected here.
}

export interface OnHandRow {
  qbo_item_id: string;
  location_id: string;
  on_hand: number;
}

export interface CatalogItem {
  qbo_item_id: string;
  name: string;
  fully_qualified_name: string | null;
  category_path: string | null;
  active: boolean | null;
}

export type OrderStatus = 'submitted' | 'fulfilled' | 'cancelled';

export interface DistributorOrder {
  id: string;
  sub_distributor_id: string;
  order_number: string;
  status: OrderStatus;
  requested_date: string | null;
  notes: string | null;
  submitted_by_email: string | null;
  submitted_at: string;
  decided_at: string | null;
  decision_notes: string | null;
  transfer_id: string | null;
  created_at: string;
}

export interface DistributorOrderLine {
  id: string;
  order_id: string;
  qbo_item_id: string;
  qty: number;
  unit_price: number | null;
  notes: string | null;
}

export interface DistributorAccount {
  id: string;
  sub_distributor_id: string;
  qbo_customer_id: string;
  account_name: string | null;
  chain: string | null;
  is_active: boolean;
}

export interface Depletion {
  id: string;
  batch_id: string;
  sub_distributor_id: string;
  account_id: string | null;
  qbo_item_id: string;
  cases: number;
  delivered_date: string;
  reference: string | null;
  fee_per_case: number | null;
  fee_amount: number | null;
  settlement_id: string | null;
  recorded_by_email: string | null;
  created_at: string;
}

/** ops.sub_distributor_settlements (20260820a) — what the distributor bills
 *  Brix for delivery fees. Member-SELECT-visible via RLS; read-only here. */
export interface Settlement {
  id: string;
  sub_distributor_id: string;
  period_start: string;
  period_end: string;
  depletion_count: number;
  total_cases: number;
  total_fee: number;
  status: 'open' | 'void';
  reference: string | null;
  created_at: string;
}

export type AgreementStatus = 'draft' | 'sent' | 'signed' | 'expired' | 'void';

export interface Agreement {
  id: string;
  sub_distributor_id: string;
  version: number;
  title: string | null;
  model: DistributorModel;
  per_case_delivery_fee: number | null;
  effective_date: string | null;
  expiry_date: string | null;
  scope: string | null; // territory / accounts / products the agreement covers (20260820a)
  terms: string | null;
  file_path: string | null;
  file_name: string | null;
  status: AgreementStatus;
  sent_at: string | null;
  signed_at: string | null;
  signer_name: string | null;
  signer_email: string | null;
  signature_data: string | null;
}

export interface QboInvoice {
  qbo_invoice_id: string;
  doc_number: string | null;
  txn_date: string | null;
  due_date: string | null;
  customer_name: string | null;
  total_amount: number | null;
  balance: number | null;
  status: string | null;
  txn_type: string | null;
}
