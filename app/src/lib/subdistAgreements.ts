/**
 * The contract builder's client — Refractor → Sub-Distributors → Agreements.
 *
 * Backed by netlify/functions/subdist-agreement.mjs. It runs server-side
 * because it mints the signing token (only the sha256 is ever stored), reads
 * the company signature, and sends the email — none of which belongs in a
 * browser.
 *
 * ⚠ The raw signing token comes back exactly ONCE, on send. It exists nowhere
 * else, so a lost link is re-issued (Send again), never recovered.
 */

import {
  DealTerms, InsuranceLine, ServiceLevel, SubDistributorAgreement,
} from './subDistributors';

export type { DealTerms, FeeLine, InsuranceLine, ServiceLevel } from './subDistributors';
import { _sbToken } from './supabase';

const FN = '/margin/.netlify/functions/subdist-agreement';

async function call<T>(payload: Record<string, unknown>): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

// ── The deal ──────────────────────────────────────────────────────────────

/**
 * What the form starts from. Level 1 is the emergency — the direction Sky set
 * on 2026-09-04.
 *
 * ⚠ Mirrors DEFAULT_SERVICE_LEVELS / DEFAULT_INSURANCE in
 * netlify/functions/lib/distributor/subdist-doc.mjs. The SERVER is
 * authoritative — it fills these in for any key the deal leaves out — and
 * these copies exist only so the form opens with something to edit. Change
 * both together, or a partner sees one set on screen and signs another.
 */
export const DEFAULT_SERVICE_LEVELS: ServiceLevel[] = [
  { level: 1, name: 'Emergency', hours: 24, description: 'The account cannot serve product — no gas, no syrup, or the dispenser is down.' },
  { level: 2, name: 'Impaired', hours: 48, description: 'Part of the system is out but the account is still serving.' },
  { level: 3, name: 'Routine', hours: 72, description: 'Quality, cosmetic, scheduled and preventive work.' },
];

export const DEFAULT_INSURANCE: InsuranceLine[] = [
  { line: 'Commercial general liability', limit: '$1,000,000 each occurrence / $2,000,000 aggregate' },
  { line: 'Automobile liability (any auto used to deliver Company product)', limit: '$1,000,000 combined single limit' },
  { line: "Workers' compensation", limit: 'Statutory' },
  { line: "Employers' liability", limit: '$1,000,000' },
];

export interface AgreementTemplate {
  id: string;
  code: string;
  version: string;
  title: string | null;
  subtitle: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
}

export interface BuildPayload {
  sub_distributor_id: string;
  template_code?: string;
  effective_date?: string | null;
  expiry_date?: string | null;
  scope?: string | null;
  counterparty_legal_name?: string | null;
  counterparty_entity_type?: string | null;
  counterparty_state?: string | null;
  counterparty_address?: string | null;
  signer_name?: string | null;
  signer_email?: string | null;
  signer_title?: string | null;
  notes?: string | null;
  deal_terms: DealTerms;
}

// ── Calls ─────────────────────────────────────────────────────────────────

export const fetchAgreementTemplates = () =>
  call<{ templates: AgreementTemplate[] }>({ action: 'templates' }).then((r) => r.templates);

export const buildAgreement = (p: BuildPayload) =>
  call<{ agreement: SubDistributorAgreement }>({ action: 'build', ...p }).then((r) => r.agreement);

export const updateBuiltAgreement = (
  id: string,
  patch: Record<string, unknown>,
  deal_terms?: DealTerms,
) => call<{ agreement: SubDistributorAgreement }>({ action: 'update', id, patch, deal_terms })
  .then((r) => r.agreement);

export const previewAgreement = (id: string) =>
  call<{ html: string; title: string | null; subtitle: string | null }>({ action: 'preview', id });

/** Returns the signing URL. Shown once — it cannot be read back. */
export const sendAgreementForSignature = (
  id: string,
  opts: { to?: string; expires_days?: number; send_email?: boolean } = {},
) => call<{ agreement: SubDistributorAgreement; url: string; emailed: boolean; email_error: string | null }>(
  { action: 'send', id, ...opts },
);

/** Mints a NEW token and kills the old one in the same write. */
export const resendAgreement = (
  id: string,
  opts: { to?: string; expires_days?: number; send_email?: boolean } = {},
) => call<{ agreement: SubDistributorAgreement; url: string; emailed: boolean; email_error: string | null }>(
  { action: 'resend', id, ...opts },
);

export const revokeAgreement = (id: string) =>
  call<{ agreement: SubDistributorAgreement }>({ action: 'revoke', id }).then((r) => r.agreement);
