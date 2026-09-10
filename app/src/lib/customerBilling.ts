import { sbq, sbqOrders } from './rpc';
import { _sbToken } from './supabase';

/**
 * customerBilling — Refractor's half of the customer master + billing.
 *
 * OWNERSHIP MAP (Sky, 2026-09-09):
 *   • brix-order  = the store — ordering, incoming service requests, the
 *                   customer-FACING billing portal, customer-facing equipment
 *   • BrixSD      = CRM, dispatch, invoicing (what Service Fusion did)
 *   • Refractor   = purchase orders, inventory, BILLING, the customer master
 *
 * The data did not move and does not need to: the customer master is ONE
 * table (`orders.customers`, 204 rows) in the one shared Supabase project that
 * all five APBG apps already reach. This is a UI relocation, so both UIs run
 * against the same rows for as long as the dual run lasts, and a change made
 * on either surface is visible on the other immediately — there is no cache
 * or mirror in between (checked: no blob cache, no materialized copy).
 *
 * ⚠ READS COME STRAIGHT FROM POSTGREST; WRITES GO THROUGH BRIX-ORDER.
 * That asymmetry is the design, not an accident of history:
 *
 *   1. `authenticated` holds SELECT and NOTHING ELSE on these tables, so no
 *      browser can write them. Granting UPDATE would let any of the 204
 *      CUSTOMER logins on this shared project PATCH their own payment terms
 *      and clear their own credit hold.
 *   2. A customer-master change has to be PUSHED ONWARD to QuickBooks
 *      (terms → SalesTermRef, name → DisplayName) and, for some fields, read
 *      back to confirm it landed. That rule already exists once, in
 *      brix-order's `_lib/push-customer-master`. A second writer here would
 *      be a second field allow-list and a second push rule, and the one that
 *      gets edited second is the one that silently stops pushing.
 *
 * ⚠ SO WHEN BRIX-ORDER'S STAFF BILLING UI IS SWITCHED OFF, THOSE FUNCTIONS
 * ARE NOT DELETED — they move to this repo, keeping their bodies. See
 * docs/OWNERSHIP-AND-MIGRATION.md for the ledger and the preconditions.
 */

/** Where brix-order's admin API lives. Override for a preview or local dev. */
export const ORDERS_API: string =
  (import.meta.env.VITE_ORDERS_API_URL as string | undefined)?.replace(/\/$/, '')
  || 'https://orders.brixbev.com';

// ── the vocabulary, mirrored from brix-order's _lib/pay-method.ts ────────────
// ⚠ `ach` and `ach_push` are NOT the same thing and read identically to a
// human. `ach` is Stripe DEBITING a bank the customer authorized, so it needs
// a saved bank; `ach_push` is money the customer SENDS us, which needs nothing
// saved — and gating that on the wallet would block precisely the customer who
// chose it because they refuse to connect an account.
export const PAY_METHODS = ['check', 'card', 'ach', 'ach_push'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

export const PAY_METHOD_LABEL: Record<PayMethod, string> = {
  check: 'Check',
  card: 'Card (we charge it)',
  ach: 'ACH (we debit their bank)',
  ach_push: 'ACH / bill pay (they send it)',
};

/** Methods we PULL, which require a saved Stripe method of that kind. */
export const PULL_METHODS: readonly PayMethod[] = ['card', 'ach'];

export const PAY_SECTIONS = [
  { key: 'orders',  column: 'payment_method_orders',  label: 'Product & delivery orders' },
  { key: 'rentals', column: 'payment_method_rentals', label: 'Equipment rentals' },
  { key: 'tanks',   column: 'payment_method_tanks',   label: 'CO₂ / tank rentals' },
] as const;

/** The four routing slots. The COLUMN names are frozen; the LABELS are what a
 *  human reads (brix-order session 1.19 renamed them without touching storage). */
export const EMAIL_SLOTS = [
  { key: 'billing',    column: 'billing_email',    label: 'Primary' },
  { key: 'remittance', column: 'remittance_email', label: 'Secondary' },
  { key: 'optional',   column: 'optional_email',   label: 'Optional' },
  { key: 'accounting', column: 'accounting_email', label: 'Accounting' },
] as const;
export type SlotKey = (typeof EMAIL_SLOTS)[number]['key'];

export const DOC_TYPES = [
  { key: 'invoice_recipients',      label: 'Invoices' },
  { key: 'statement_recipients',    label: 'Statements' },
  { key: 'reminder_recipients',     label: 'Reminders' },
  { key: 'order_update_recipients', label: 'Order updates' },
] as const;
export type DocKey = (typeof DOC_TYPES)[number]['key'];

export interface CustomerBillingRow {
  id: string;                       // orders.customers.id (uuid)
  name: string | null;
  qbo_customer_id: string | null;
  active: boolean | null;
  payment_terms: string | null;
  taxable: boolean | null;
  on_credit_hold: boolean | null;
  payment_method_orders: string | null;
  payment_method_rentals: string | null;
  payment_method_tanks: string | null;
  billing_email: string | null;
  remittance_email: string | null;
  optional_email: string | null;
  accounting_email: string | null;
  billing_contact_name: string | null;
  invoice_recipients: string[] | null;
  statement_recipients: string[] | null;
  reminder_recipients: string[] | null;
  order_update_recipients: string[] | null;
  invoice_emails_enabled: boolean | null;
  statements_enabled: boolean | null;
  reminders_enabled: boolean | null;
  paper_invoices_enabled: boolean | null;
  paper_statements_enabled: boolean | null;
  group_kind: string | null;
  group_billing_mode: string | null;
  on_new_system: boolean | null;
  /** The customer's free-text notes — pushed to the QuickBooks Customer's Notes box. */
  notes: string | null;
}

const SELECT = [
  'id', 'name', 'qbo_customer_id', 'active', 'payment_terms', 'taxable',
  'on_credit_hold', 'payment_method_orders', 'payment_method_rentals',
  'payment_method_tanks', 'billing_email', 'remittance_email', 'optional_email',
  'accounting_email', 'billing_contact_name', 'invoice_recipients',
  'statement_recipients', 'reminder_recipients', 'order_update_recipients',
  'invoice_emails_enabled', 'statements_enabled', 'reminders_enabled',
  'paper_invoices_enabled', 'paper_statements_enabled', 'group_kind',
  'group_billing_mode', 'on_new_system', 'notes',
].join(',');

/**
 * Find the billing record for a QuickBooks customer id.
 *
 * ⚠ Returns null for a customer that has NEVER BEEN ENABLED in the portal,
 * which is most of them — 204 of the ~850 QuickBooks customers have a row.
 * That is a real and different state from "load failed", and the UI must say
 * so rather than rendering an empty form: an empty form invites somebody to
 * type terms into a record that does not exist and will not save.
 */
export async function fetchCustomerBilling(
  qboCustomerId: string,
): Promise<CustomerBillingRow | null> {
  const id = String(qboCustomerId).replace(/[^0-9A-Za-z_-]/g, '');
  if (!id) return null;
  const rows = await sbqOrders<CustomerBillingRow>(
    'customers',
    `qbo_customer_id=eq.${encodeURIComponent(id)}&select=${SELECT}&limit=1`,
  );
  return rows[0] ?? null;
}

export interface BillingLocation {
  id: string;
  label: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/**
 * The bill-to. It is a LOCATION (`is_billing`, one per customer by partial
 * unique index) and NOT a column on the customer — brix-order settled that on
 * 2026-08-31 after briefly having both, because two homes for one address is
 * exactly the drift this whole exercise is removing.
 */
export async function fetchBillingLocation(
  customerId: string,
): Promise<BillingLocation | null> {
  const rows = await sbqOrders<BillingLocation>(
    'customer_locations',
    `customer_id=eq.${encodeURIComponent(customerId)}&is_billing=is.true`
      + '&select=id,label,address_line1,address_line2,city,state,zip&limit=1',
  );
  return rows[0] ?? null;
}

export interface CompanyBillingSettings {
  id: number;
  company_name: string | null;
  from_name: string | null;
  remittance_email: string | null;
  accounting_email: string | null;
  reply_to: string | null;
  statement_send_day: number | null;
  reminders_enabled_global: boolean | null;
  statements_enabled_global: boolean | null;
  reminder_schedule: unknown;
}

/**
 * Company billing identity — the letterhead, the remit-to and the dunning
 * calendar.
 *
 * ⚠ It shares a row with `order_fees` and `order_desk`, which are genuinely
 * ORDER-PORTAL settings and stay brix-order's. 9 of the 14 columns are
 * billing and 2 are the portal's; that split is why the table reads as two
 * tables wearing one name, and why this function selects explicitly rather
 * than `select=*`.
 */
export async function fetchCompanyBillingSettings(): Promise<CompanyBillingSettings | null> {
  const rows = await sbqOrders<CompanyBillingSettings>(
    'company_settings',
    'select=id,company_name,from_name,remittance_email,accounting_email,reply_to,'
      + 'statement_send_day,reminders_enabled_global,statements_enabled_global,'
      + 'reminder_schedule&limit=1',
  );
  return rows[0] ?? null;
}

// ── writes: brix-order's endpoints, which are the ONE writer ────────────────

export interface WriteResult<T = unknown> {
  ok: boolean;
  /** Notes from the outward push to QuickBooks / Service Fusion. */
  push_notes?: string[];
  data?: T;
}

/**
 * ⚠ Every failure mode gets its own sentence. A single "save failed" here
 * would collapse four different problems that need four different actions —
 * an expired session, a role that is not staff, a QuickBooks refusal (a
 * duplicate DisplayName is a real and common one), and the endpoint being
 * unreachable because the origin is not on brix-order's CORS allow-list.
 *
 * The last one is worth naming explicitly: a blocked cross-origin request
 * arrives in the browser as an opaque "Failed to fetch" with no status, which
 * reads as a network outage rather than as a configuration gap. ERLS paid a
 * day for exactly that confusion (its own CLAUDE.md records it).
 */
export async function postOrders<T>(fn: string, body: Record<string, unknown>): Promise<WriteResult<T>> {
  const token = await _sbToken();
  let res: Response;
  try {
    res = await fetch(`${ORDERS_API}/.netlify/functions/${fn}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `Could not reach the billing API (${fn}). If this says "Failed to fetch" it is `
      + `usually a blocked origin rather than a network fault — this page must be served `
      + `from an origin on brix-order's allow-list (see its netlify/functions/_lib/cors.ts). `
      + `Underlying: ${(e as Error).message}`,
    );
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* not json */ }

  if (!res.ok) {
    const detail = typeof json.error === 'string' ? json.error : text.slice(0, 300);
    if (res.status === 401) throw new Error('Your session expired — sign in again.');
    if (res.status === 403) {
      throw new Error(
        'Not permitted. Editing billing needs a superadmin account. ' + (detail || ''),
      );
    }
    throw new Error(`${fn} failed (${res.status}): ${detail || 'no detail'}`);
  }
  return {
    ok: true,
    push_notes: Array.isArray(json.push_notes) ? (json.push_notes as string[]) : undefined,
    data: json as T,
  };
}

/**
 * GET against a brix-order admin endpoint under the staff bearer.
 *
 * Used where the answer cannot come from PostgREST: the document vault's
 * signed file URLs are minted by the endpoint from the service-role bucket
 * key, which the browser must never hold. Same failure vocabulary as
 * postOrders — a blocked origin reads as "Failed to fetch" and must be named.
 */
export async function getOrders<T>(fn: string, query: string): Promise<T> {
  const token = await _sbToken();
  let res: Response;
  try {
    res = await fetch(`${ORDERS_API}/.netlify/functions/${fn}?${query}`, {
      headers: { Authorization: 'Bearer ' + token },
    });
  } catch (e) {
    throw new Error(
      `Could not reach the billing API (${fn}). If this says "Failed to fetch" it is `
      + `usually a blocked origin rather than a network fault — this page must be served `
      + `from an origin on brix-order's allow-list. Underlying: ${(e as Error).message}`,
    );
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* not json */ }
  if (!res.ok) {
    const detail = typeof json.error === 'string' ? json.error : text.slice(0, 300);
    if (res.status === 401) throw new Error('Your session expired — sign in again.');
    if (res.status === 403) throw new Error('Not permitted. This needs a superadmin account. ' + (detail || ''));
    throw new Error(`${fn} failed (${res.status}): ${detail || 'no detail'}`);
  }
  return json as T;
}

export function savePaymentProfile(customerId: string, patch: {
  payment_terms?: string | null;
  payment_method_orders?: PayMethod | null;
  payment_method_rentals?: PayMethod | null;
  payment_method_tanks?: PayMethod | null;
  taxable?: boolean;
}) {
  return postOrders('admin-payment-profile', { customer_id: customerId, ...patch });
}

export function saveBillingComms(customerId: string, patch: {
  billing_email?: string | null;
  remittance_email?: string | null;
  optional_email?: string | null;
  accounting_email?: string | null;
  invoice_recipients?: SlotKey[];
  statement_recipients?: SlotKey[];
  reminder_recipients?: SlotKey[];
  order_update_recipients?: SlotKey[];
  reminders_enabled?: boolean;
  statements_enabled?: boolean;
  paper_invoices_enabled?: boolean;
  paper_statements_enabled?: boolean;
  /** The one primary contact on the QuickBooks Customer (GivenName + FamilyName). */
  billing_contact_name?: string | null;
  /** Free text → the QuickBooks Customer's Notes box (2000 chars, QBO's cap). */
  notes?: string | null;
}) {
  return postOrders('admin-set-billing-comms', { customer_id: customerId, ...patch });
}

export function setCreditHold(customerId: string, onHold: boolean) {
  return postOrders('admin-set-credit-hold', { customer_id: customerId, on_credit_hold: onHold });
}

export interface EnableResult {
  ok: true;
  customer_id: string;
  qbo_customer_id: number;
  name: string | null;
  locations_imported: number | null;
  location_mode: string | null;
  already_enabled: boolean;
  switch_on_email_sent?: boolean;
  switch_on_email_warning?: string | null;
  collection_seed_error?: string | null;
}

/**
 * Create the portal record for a QuickBooks customer that has none — the
 * "Enable" button from brix-order's Customers admin, reachable from here so
 * the customer page is not a dead end for 650 of the 850 accounts.
 *
 * ⚠ Enable is NOT a bare insert. brix-order's `_lib/enable-customer` imports
 * the QuickBooks sub-customers as locations, seeds the customer's pricing
 * from invoice history, switches every email notification ON (paper OFF),
 * and sends the account-live invite. It REFUSES (409) an EQUIPMENT / RESQ
 * bucket — those are internal accounts and never belong on the portal.
 * The confirm dialog on the card says all of that before the click.
 */
export function enableCustomerInPortal(qboCustomerId: string) {
  return postOrders<EnableResult>('admin-enable-customer', {
    qbo_customer_id: Number(String(qboCustomerId).replace(/[^0-9]/g, '')),
  });
}

export function setCustomerName(customerId: string, name: string) {
  return postOrders('admin-set-customer-name', { customer_id: customerId, name });
}

/** The live QuickBooks comparison, plus the Stripe wallet state. */
export interface PaymentProfilePayload {
  ok: true;
  profile: {
    payment_terms: string | null;
    taxable: boolean;
    payment_method_orders: string | null;
    payment_method_rentals: string | null;
    payment_method_tanks: string | null;
  };
  stripe: {
    needed: boolean;
    has_stripe_customer: boolean;
    active_methods: number;
    methods: { kind: string; brand: string | null; last4: string | null; is_default: boolean }[];
  };
  qbo: { terms: string | null; payment_method: string | null } | null;
  billing_email: string | null;
}

/**
 * Read the profile through brix-order, which also reads QuickBooks LIVE.
 *
 * ⚠ Terms and the preferred payment method are NOT mirrored into `ops.*`, so
 * a drift check off the mirror would be blind to exactly the fields the
 * portal pushes. That is why this goes via the endpoint rather than
 * PostgREST — the QuickBooks half cannot be had any other way.
 *
 * Best-effort: a failure here must not stop the page rendering the local
 * record, which is the authoritative one.
 */
export async function fetchPaymentProfile(
  customerId: string,
): Promise<PaymentProfilePayload | null> {
  try {
    const token = await _sbToken();
    const res = await fetch(
      `${ORDERS_API}/.netlify/functions/admin-payment-profile`
        + `?customer_id=${encodeURIComponent(customerId)}`,
      { headers: { Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return null;
    return (await res.json()) as PaymentProfilePayload;
  } catch {
    return null;
  }
}

// ── pure helpers, so the UI cannot invent a rule of its own ─────────────────

/**
 * Which methods may be OFFERED for a section, given the wallet.
 *
 * ⚠ A pull method with no saved instrument is refused SERVER-SIDE (409), so
 * offering it produces a save that can only fail. But a value already stored
 * stays selectable — otherwise a legacy row silently re-saves as something
 * else the moment somebody opens the form to change a different field.
 */
export function offerableMethods(
  walletKinds: readonly string[],
  current: string | null,
): PayMethod[] {
  return PAY_METHODS.filter((m) => {
    if (m === current) return true;
    if (!PULL_METHODS.includes(m)) return true;
    return walletKinds.includes(m === 'card' ? 'card' : 'us_bank_account')
      || walletKinds.includes(m);
  });
}

/** Is a store's billing controlled by its chain master? */
/**
 * The chain master whose Master billing governs this store, or null.
 *
 * ⚠ THIS USED TO READ `customers.parent_customer_id` AND THAT COLUMN DOES NOT
 * EXIST — it is melt-dashboard's franchise column, on a different schema. The
 * SELECT failed with 42703 on every customer, so the whole card rendered as
 * "not set up in the portal" for a week and read as "not connected". brix-order
 * never stored a parent on the store row: chain membership is DERIVED from the
 * QuickBooks parent link (`ops.qbo_customers.parent_ref_id`) and then the
 * master's own `group_kind` / `group_billing_mode` — its
 * `findEnabledGroupMasterOf` + `masterBillingMasterFor`. This is the same rule,
 * read-only, so a store locks here exactly when brix-order would lock it.
 * Best-effort: a failed lookup reads as "not managed", never as an error,
 * because the store's own record is the thing this card exists to show.
 */
export interface BillingMaster {
  id: string;
  name: string | null;
  qbo_customer_id: number;
  group_kind: string | null;
  group_billing_mode: string | null;
}

export async function fetchBillingMaster(qboCustomerId: string): Promise<BillingMaster | null> {
  const id = String(qboCustomerId).replace(/[^0-9]/g, '');
  if (!id) return null;
  try {
    const subs = await sbq<{ parent_ref_id: string | number | null }>(
      'qbo_customers',
      `qbo_customer_id=eq.${id}&select=parent_ref_id&limit=1`,
    );
    const parent = String(subs[0]?.parent_ref_id ?? '').replace(/[^0-9]/g, '');
    if (!parent) return null;
    const masters = await sbqOrders<BillingMaster>(
      'customers',
      `qbo_customer_id=eq.${parent}&group_kind=not.is.null&active=is.true`
        + '&select=id,name,qbo_customer_id,group_kind,group_billing_mode&limit=1',
    );
    return masters[0] ?? null;
  } catch {
    return null;
  }
}

/** Locked when the store sits under a chain master set to Master billing. */
export function managedByMaster(master: BillingMaster | null | undefined): boolean {
  return !!master && master.group_billing_mode === 'master';
}

/**
 * Which slots a document type will actually be sent to, resolved for display.
 * An empty array means NOBODY — a real choice, and distinct from "not set".
 */
export function routedSlots(row: CustomerBillingRow, doc: DocKey): SlotKey[] {
  const v = row[doc];
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is SlotKey => EMAIL_SLOTS.some((e) => e.key === s));
}

/** The address on a slot, so the UI can show a slot routed to nothing. */
export function slotAddress(row: CustomerBillingRow, slot: SlotKey): string | null {
  const col = EMAIL_SLOTS.find((s) => s.key === slot)?.column;
  if (!col) return null;
  const v = (row as unknown as Record<string, unknown>)[col];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
