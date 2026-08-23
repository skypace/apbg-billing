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

  /** Vendor's own invoice/bill number — OCR-extracted or hand-entered. Flows
   *  to QBO's "Bill no." (DocNumber) when the bill is created. */
  bill_number?: string | null;
  /** OCR gate state for SF-landed drafts (null = not yet run). SF drafts only
   *  auto-post once this is 'processed' AND bill_number is set — anything
   *  else ('no_attachment' | 'failed') holds the draft for manual review. */
  ocr_status?: 'processed' | 'no_attachment' | 'failed' | null;
  ocr_error?: string | null;

  /** Reason the last "Post to QuickBooks" attempt failed (e.g. a closed QBO
   *  accounting period, no vendor match). Cleared on a successful post. */
  autopost_error?: string | null;

  /** Another expense this one looks like a re-entry of. Advisory: it never
   *  blocks a save, and only blocks a POST when the twin is already in
   *  QuickBooks (see netlify/functions/lib/expense-dupes.mjs). */
  duplicate_of?: string | null;
  duplicate_reason?: string | null;
  duplicate_checked_at?: string | null;
  duplicate_cleared_by?: string | null;

  /** True for an unpaid vendor Bill (posts to QBO as a Bill); false for an
   *  already-paid receipt (posts as a Purchase). */
  as_bill?: boolean | null;
  paid_at?: string | null;

  /** When this bill is due, and how we know. A printed due date beats one
   *  computed from terms; `due_date_source` records which we had. */
  due_date?: string | null;
  payment_terms?: string | null;
  due_date_source?: 'printed' | 'terms' | 'manual' | null;

  // Soft-archive (SF-landed rows): hidden from lists, kept for sync dedup.
  archived_at?: string | null;
  archived_by?: string | null;

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

/** Vendor type — mirrors the ops.vendors CHECK */
export type VendorType = 'contractor' | 'supplier' | 'service' | 'other';

/** How the vendor prefers to be paid. 'zelle_manual'/'check_manual' are
 *  recorded-by-hand rails (no API exists / deliberate). */
export type VendorPaymentPref = 'ach' | 'paypal' | 'venmo' | 'zelle_manual' | 'check_manual';

/** W-9 line 3. `llc_c`/`llc_s` are LLCs that elected corporate treatment and
 *  are therefore exempt; `llc_p` is a partnership-taxed LLC and is not. */
export type TaxClassification =
  | 'individual' | 'sole_prop' | 'partnership'
  | 'c_corp' | 's_corp'
  | 'llc_c' | 'llc_s' | 'llc_p'
  | 'trust' | 'other';

export type VendorOnboardStatus = 'new' | 'invited' | 'docs_pending' | 'complete';

/** Coverage requirements riding ops.vendors.requirements (jsonb). Compliance
 *  status against these is computed where displayed — nothing stored. */
export interface VendorRequirements {
  gl_each_occurrence?: number | null;
  wc_required?: boolean;
  auto_required?: boolean;
  additional_insured_required?: boolean;
}

/** Vendor registry row — mirrors ops.vendors (Vendor Portal Phase 1). */
export interface Vendor {
  id: string;
  display_name: string;
  legal_name: string | null;
  vendor_type: VendorType;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  /** → ops.qbo_vendors.qbo_vendor_id (the daily QBO mirror); null until linked. */
  qbo_vendor_id: string | null;
  /** → ops.insured_parties.id — the compliance-vault party whose COI/W-9 docs
   *  this vendor's compliance chips read. Null until document filing is set up. */
  insured_party_id: string | null;
  /** Stripe Global Payouts recipient Account id (acct_…) — the ONLY Stripe
   *  datum stored. Bank details live with Stripe, collected on their hosted
   *  onboarding page, never here. */
  stripe_recipient_id?: string | null;
  payment_method_pref: VendorPaymentPref | null;
  /** Venmo @handle or PayPal email — the ONLY payment datum stored.
   *  Bank account numbers live with the payment rail, never here. */
  payment_handle: string | null;
  default_terms: string | null;
  requirements: VendorRequirements;
  w9_status: 'missing' | 'on_file';
  ein_last4: string | null;

  // ── 1099 ──
  /** W-9 line 3. Drives whether a 1099 is expected when is_1099 is unset. */
  tax_classification: TaxClassification | null;
  /** Explicit override. NULL = derive from tax_classification, because the
   *  corporate exemption has carve-outs (attorneys, medical) that depend on
   *  what the vendor DOES, not on a checkbox. */
  is_1099: boolean | null;
  tin_type: 'ein' | 'ssn' | null;
  w9_received_at: string | null;
  /** W-9 certification 2 struck, or an IRS B-notice — 24% withholding. */
  backup_withholding: boolean;
  tax_address: Record<string, unknown> | null;
  onboard_status: VendorOnboardStatus;
  notes: string | null;
  archived_at: string | null;
  archived_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Row from the ops.qbo_vendors daily mirror (read-only here). */
export interface QboVendorMirror {
  qbo_vendor_id: string;
  display_name: string;
  company_name: string | null;
  active: boolean;
  email: string | null;
  phone: string | null;
}

/** Compliance-vault document (subset of ops.compliance_documents we render). */
export interface VendorComplianceDoc {
  id: string;
  category: 'insurance' | 'permit' | 'food_safety' | 'safety' | 'tax' | 'other';
  doc_type: string;
  issuer: string | null;
  reference_number: string | null;
  issue_date: string | null;
  expiration_date: string | null;
  file_name: string | null;
  storage_path: string | null;
  archived_at: string | null;
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
