/** Status flow for expense requests */
export type ExpenseStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'denied'
  | 'awaiting_invoice'
  | 'fulfilled'
  | 'posted';

/** Request type */
export type ExpenseType = 'expense' | 'purchase_request';

/** Entity */
export type Entity = 'brix' | 'freeflow' | 'shared';

/** Line item within an expense or PR */
export interface LineItem {
  description: string;
  qty: number;
  unit_price: number;
  amount: number;
}

/** Core expense request record — mirrors ops.expense_requests */
export interface ExpenseRequest {
  id: string;
  request_type: ExpenseType;
  status: ExpenseStatus;
  entity: Entity;

  submitted_by: string;
  submitter_name: string | null;
  submitter_email: string | null;

  vendor_name: string | null;
  vendor_id: string | null;
  total_amount: number | null;
  currency: string;
  receipt_date: string | null;

  cogs_account_id: string | null;
  cogs_account_label: string | null;
  tag: string | null;
  department: string | null;

  /** QBO Department (Location tracking) → posted as DepartmentRef. */
  qbo_department_id: string | null;
  qbo_department_name: string | null;

  customer_name: string | null;
  job_number: string | null;
  /** SF admin-portal encrypted job id → deep link to the SF job page. */
  sf_admin_job_id: string | null;
  memo: string | null;

  line_items: LineItem[];

  manager_email: string | null;

  linked_pr_id: string | null;

  /** QBO account the expense was paid FROM (CC / bank / petty cash). Required
   *  for receipt-style expenses since they post as QBO Purchases, not Bills. */
  payment_account_id: string | null;
  payment_account_name: string | null;
  payment_account_type: string | null;

  qbo_bill_id: string | null;
  posted_at: string | null;
  qbo_invoice_match: string | null;
  margin_result: Record<string, unknown> | null;

  created_at: string;
  updated_at: string;
}

/** Payment account option from /api/expense-payment-accounts (QBO Bank +
 *  CreditCard accounts). Used by the "Paid with" dropdown on the expense
 *  form. */
export interface PaymentAccount {
  id: string;
  name: string;
  account_type: string;
  account_sub_type: string | null;
  payment_type: 'Cash' | 'Check' | 'CreditCard';
}

/** Attachment record — mirrors ops.expense_request_attachments */
export interface ExpenseAttachment {
  id: string;
  request_id: string;
  file_name: string;
  file_type: string | null;
  file_size: number | null;
  storage_path: string | null;
  ocr_result: Record<string, unknown> | null;
  created_at: string;
}

/** Approval record — mirrors ops.expense_request_approvals */
export interface ExpenseApproval {
  id: string;
  request_id: string;
  decision: 'approved' | 'denied';
  decided_by: string | null;
  decided_by_email: string | null;
  decided_at: string;
  signature_url: string | null;
  ip_address: string | null;
  user_agent: string | null;
  notes: string | null;
  magic_token: string | null;
}

/** Settings record — mirrors ops.expense_settings */
export interface ExpenseSetting {
  key: string;
  value: unknown;
  updated_at: string;
}

/** COGS account option */
export interface CogsAccount {
  id: string;
  label: string;
}

/** Loaded settings from the settings table */
export interface ExpenseSettings {
  approval_threshold: number;
  manager_emails: string[];
  cogs_accounts: CogsAccount[];
  tags: string[];
  departments: string[];
  /** Optional department → default COGS account id. Drives the form cascade:
   *  picking a department pre-selects (but never locks) the COGS account. */
  department_cogs_map: Record<string, string>;
  /** Auto-routing for approvals: a default approver + per-department overrides.
   *  The form pre-selects the approver (still overridable by the submitter). */
  approval_routing: {
    default_approver: string;
    by_department: Record<string, string>;
  };
}
