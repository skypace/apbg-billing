import { sbq, sbInsert, sbDelete, sbUpdate } from './rpc';

// ops.sales_reps schema:
//   rep_code     TEXT PK    (e.g. 'SP', 'JM' — short code, also used as label)
//   name         TEXT       full name
//   sort_order   INT        for stable list ordering
//   is_active    BOOL       inactive reps still selectable for legacy assignments
//   created_at   TIMESTAMPTZ
export interface SalesRep {
  rep_code:   string;
  name:       string;
  sort_order: number;
  is_active:  boolean;
  created_at: string | null;
}

// ops.customer_sales_reps schema:
//   PK is composite (qbo_customer_id, rep_code)
//   is_primary marks the lead rep — used for ordering in v_sales_lines.
//   sales_reps[] aggregation
export interface CustomerSalesRep {
  qbo_customer_id: string;
  rep_code:        string;
  is_primary:      boolean;
  created_at:      string | null;
}

export function fetchSalesReps(opts: { activeOnly?: boolean } = {}) {
  const filter = opts.activeOnly ? '&is_active=eq.true' : '';
  return sbq<SalesRep>(
    'sales_reps',
    'select=rep_code,name,sort_order,is_active,created_at&order=sort_order.asc,name.asc' + filter,
  );
}

export function insertSalesRep(rep: { rep_code: string; name: string; sort_order?: number; is_active?: boolean }) {
  return sbInsert<Partial<SalesRep>>('sales_reps', {
    rep_code:   rep.rep_code.trim(),
    name:       rep.name.trim(),
    sort_order: rep.sort_order ?? 100,
    is_active:  rep.is_active ?? true,
  });
}

export function updateSalesRep(rep_code: string, patch: Partial<SalesRep>) {
  return sbUpdate<SalesRep>('sales_reps', 'rep_code=eq.' + encodeURIComponent(rep_code), patch);
}

export function deleteSalesRep(rep_code: string) {
  // Clear assignments first to avoid FK trouble.
  return sbDelete('customer_sales_reps', 'rep_code=eq.' + encodeURIComponent(rep_code))
    .then(() => sbDelete('sales_reps', 'rep_code=eq.' + encodeURIComponent(rep_code)));
}

// Customer ↔ rep assignment

export function fetchCustomerAssignments() {
  return sbq<CustomerSalesRep>(
    'customer_sales_reps',
    'select=qbo_customer_id,rep_code,is_primary,created_at',
  );
}

// One-rep-per-customer UX: replace any existing assignment with the new
// rep flagged is_primary=true.
export function assignCustomerToRep(qbo_customer_id: string, rep_code: string) {
  return sbDelete('customer_sales_reps', 'qbo_customer_id=eq.' + encodeURIComponent(qbo_customer_id))
    .then(() => sbInsert<Partial<CustomerSalesRep>>('customer_sales_reps', {
      qbo_customer_id,
      rep_code,
      is_primary: true,
    }));
}

export function unassignCustomer(qbo_customer_id: string) {
  return sbDelete('customer_sales_reps', 'qbo_customer_id=eq.' + encodeURIComponent(qbo_customer_id));
}
