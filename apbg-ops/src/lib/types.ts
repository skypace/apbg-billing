export type Department = "delivery" | "service" | "reman" | "ops" | "sales" | "admin"
export type Entity = "AS" | "FF" | "both"

export interface TeamMember {
  id: number
  name: string
  role: string
  department: Department
  entity: Entity
  annual_wage: number
  split_pct: number
  qbo_cogs_acct_id: string | null
  qbo_cogs_acct_name: string | null
  sf_tech_id: string | null
  fleet_driver_id: string | null
  email: string | null
  active: boolean
  hired_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface QboInvoice {
  id: number
  qbo_invoice_id: string
  doc_number: string
  txn_date: string
  due_date: string | null
  customer_ref_id: string
  customer_name: string
  total_amount: number
  balance: number
  status: "open" | "paid"
  department: string | null
  entity: Entity | null
  memo: string | null
  synced_at: string
  qbo_updated_at: string | null
}

export interface QboInvoiceLine {
  id: number
  invoice_id: number
  line_num: number
  description: string | null
  quantity: number | null
  unit_price: number | null
  amount: number
  item_ref_id: string | null
  item_name: string | null
  account_ref_id: string | null
  account_name: string | null
  revenue_line: string | null
  department: string | null
}

export interface PlSnapshot {
  id: number
  period: string
  account_id: string
  account_name: string
  account_type: string
  amount: number
  entity: string
  snapshot_at: string
}

export interface DeliveryStop {
  id: number
  sf_job_id: string
  sf_job_number: string
  stop_date: string
  driver_id: number | null
  driver_name: string
  customer_name: string
  customer_ref_id: string | null
  address: string | null
  arrival_time: string | null
  departure_time: string | null
  duration_min: number | null
  status: string
  invoice_amount: number | null
  qbo_invoice_id: string | null
  sf_total: number | null
  payment_status: string | null
  qbo_invoice_matched: boolean
  stale_alert_sent: boolean
  notes: string | null
  synced_at: string
}

export interface ServiceJob {
  id: number
  sf_job_id: string
  sf_job_number: string
  job_date: string
  tech_id: number | null
  tech_name: string
  customer_name: string
  customer_ref_id: string | null
  job_type: string
  status: string
  dispatch_time: string | null
  arrival_time: string | null
  completion_time: string | null
  duration_min: number | null
  billable_hours: number | null
  parts_cost: number | null
  labor_cost: number | null
  invoice_amount: number | null
  qbo_invoice_id: string | null
  is_callback: boolean
  first_time_fix: boolean
  sf_total: number | null
  payment_status: string | null
  qbo_invoice_matched: boolean
  stale_alert_sent: boolean
  notes: string | null
  synced_at: string
}

export interface RemanJob {
  id: number
  sf_job_id: string
  sf_job_number: string
  intake_date: string
  completion_date: string | null
  tech_id: number | null
  tech_name: string
  equipment_type: string | null
  serial_number: string | null
  status: "intake" | "in_progress" | "qc" | "complete" | "shipped" | "scrapped"
  parts_cost: number | null
  labor_hours: number | null
  labor_cost: number | null
  sale_price: number | null
  customer_ref_id: string | null
  sf_total: number | null
  payment_status: string | null
  qbo_invoice_matched: boolean
  stale_alert_sent: boolean
  notes: string | null
  synced_at: string
}

export interface SyncLog {
  id: number
  source: string
  sync_type: string
  status: "running" | "success" | "error"
  records_synced: number | null
  error_message: string | null
  metadata: Record<string, unknown> | null
  started_at: string
  completed_at: string | null
}
