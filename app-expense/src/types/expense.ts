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
  type: ExpenseType;
  status: ExpenseStatus;

  submitted_by: string;
  submitted_at: string;

  vendor_name: string | null;
  vendor_id: string | null;
  total_amount: number | null;
  currency: string;
  receipt_date: string | null;

  cogs_account_id: string | null;
  cogs_account_label: string | null;
  tag: string | null;
  department: string | null;

  customer_name: string | null;
  job_number: string | null;
  memo: string | null;

  line_items: LineItem[];

  manager_email: string | null;
  approval_threshold: number;

  linked_pr_id: string | null;

  qbo_bill_id: string | null;
  qbo_invoice_match: string | null;
  margin_result: Record<string, unknown> | null;

  created_at: string;
  updated_at: string;
}

/** Attachment record — mirrors ops.expense_request_attachments */
export interface ExpenseAttachment {
  id: string;
  request_id: string;
  file_name: string;
  file_type: string | null;
  file_size: number | null;
  storage_path: string;
  ocr_result: Record<string, unknown> | null;
  created_at: string;
}

/** Approval record — mirrors ops.expense_request_approvals */
export interface ExpenseApproval {
  id: string;
  request_id: string;
  decision: 'approved' | 'denied';
  decided_by: string;
  decided_at: string;
  signature_url: string | null;
  ip_address: string | null;
  user_agent: string | null;
  reason_note: string | null;
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
}
