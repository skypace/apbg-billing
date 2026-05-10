import { sbq, sbInsert, sbDelete, sbPatch } from './rpc';

export interface SalesRep {
  id:         string;
  name:       string;
  email:      string | null;
  phone:      string | null;
  initials:   string | null;
  is_active:  boolean;
  notes:      string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CustomerSalesRep {
  qbo_customer_id: string;
  rep_id:          string;
  assigned_at:     string | null;
}

// List all reps, optionally filtered to active only.
export function fetchSalesReps(opts: { activeOnly?: boolean } = {}) {
  const filter = opts.activeOnly ? '&is_active=eq.true' : '';
  return sbq<SalesRep>(
    'sales_reps',
    'select=id,name,email,phone,initials,is_active,notes,created_at,updated_at&order=name.asc' + filter,
  );
}

export function insertSalesRep(rep: Pick<SalesRep, 'name'> & Partial<SalesRep>) {
  return sbInsert<Partial<SalesRep>>('sales_reps', {
    name:      rep.name,
    email:     rep.email     ?? null,
    phone:     rep.phone     ?? null,
    initials:  rep.initials  ?? null,
    is_active: rep.is_active ?? true,
    notes:     rep.notes     ?? null,
  });
}

export function updateSalesRep(id: string, patch: Partial<SalesRep>) {
  return sbPatch<Partial<SalesRep>>('sales_reps', 'id=eq.' + id, patch);
}

export function deleteSalesRep(id: string) {
  // Cascade clears assignments first to avoid FK trouble.
  return sbDelete('customer_sales_reps', 'rep_id=eq.' + id)
    .then(() => sbDelete('sales_reps', 'id=eq.' + id));
}

// Customer ↔ rep assignment

export function fetchCustomerAssignments() {
  return sbq<CustomerSalesRep>(
    'customer_sales_reps',
    'select=qbo_customer_id,rep_id,assigned_at',
  );
}

export function assignCustomerToRep(qbo_customer_id: string, rep_id: string) {
  // Upsert via insert on conflict — using sbInsert with RFC 6902 merge through Prefer header
  // would be ideal, but our sbInsert wrapper is a plain POST. Emulate by deleting any
  // existing row first, then inserting.
  return sbDelete('customer_sales_reps', 'qbo_customer_id=eq.' + qbo_customer_id)
    .then(() => sbInsert<Partial<CustomerSalesRep>>('customer_sales_reps', {
      qbo_customer_id,
      rep_id,
    }));
}

export function unassignCustomer(qbo_customer_id: string) {
  return sbDelete('customer_sales_reps', 'qbo_customer_id=eq.' + qbo_customer_id);
}
