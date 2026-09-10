import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Pencil, RefreshCw } from 'lucide-react';
import { useToast } from '../lib/toast';
import {
  DOC_TYPES, EMAIL_SLOTS, PAY_METHOD_LABEL, PAY_SECTIONS,
  enableCustomerInPortal,
  fetchBillingLocation, fetchBillingMaster, fetchCustomerBilling, fetchPaymentProfile,
  managedByMaster, offerableMethods, savePaymentProfile, saveBillingComms,
  setCreditHold, setCustomerName, slotAddress,
  type BillingLocation, type BillingMaster, type CustomerBillingRow, type DocKey,
  type PayMethod, type PaymentProfilePayload, type SlotKey,
} from '../lib/customerBilling';
import { forgetOrdersCustomer } from '../lib/customerMaster';
import { Note, Section, btn, ctl, lbl } from './customerMasterUi';

/**
 * Billing & customer master, on the Refractor customer page.
 *
 * Sky's ownership map (2026-09-09) puts billing and the customer master here;
 * brix-order keeps the store, incoming service requests and the CUSTOMER-facing
 * billing portal. Both UIs edit the same `orders.customers` row for as long as
 * the dual run lasts, and there is no cache between them, so a change on
 * either surface shows on the other on the next load.
 *
 * ⚠ WHAT THIS CARD DELIBERATELY DOES NOT HOLD:
 *  • the customer's OWN four email addresses as a self-service preference —
 *    they edit those in the portal (Settings → billing emails), which is a
 *    legitimate customer surface. This is the STAFF view of the same columns.
 *  • the bill-to ADDRESS as an editable field. It is a location row
 *    (`is_billing`) and is edited in the Locations card directly below this
 *    one (2026-09-10); showing an editable copy here would be the second home
 *    for one address, which is the drift being removed rather than added to.
 *  • `order_fees` / `order_desk`. They live on the same company_settings row
 *    and are genuinely order-portal settings.
 *
 * ⚠ EVERY WRITE GOES THROUGH BRIX-ORDER'S ENDPOINTS, never PostgREST — see
 * lib/customerBilling.ts for why (no browser write grant exists, and the
 * outward QuickBooks push must have exactly one implementation).
 */

interface Props { qboCustomerId: string; customerName?: string | null }

export function CustomerBillingCard({ qboCustomerId, customerName }: Props) {
  const toast = useToast();
  // Open by default since 2026-09-09: it leads the customer page now, and a
  // folded line at the top of the page is what read as "not connected".
  const [open, setOpen] = useState(true);
  // undefined = not loaded yet · null = no portal record · row = loaded.
  // Three states, three renders: an empty form on a customer with no record
  // invites somebody to type terms that cannot save.
  const [row, setRow] = useState<CustomerBillingRow | null | undefined>(undefined);
  const [live, setLive] = useState<PaymentProfilePayload | null>(null);
  const [billTo, setBillTo] = useState<BillingLocation | null>(null);
  const [master, setMaster] = useState<BillingMaster | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState<string[]>([]);

  // draft state
  const [terms, setTerms] = useState('');
  const [taxable, setTaxable] = useState(false);
  const [methods, setMethods] = useState<Record<string, string>>({});
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [routing, setRouting] = useState<Record<DocKey, SlotKey[]>>({
    invoice_recipients: [], statement_recipients: [],
    reminder_recipients: [], order_update_recipients: [],
  });
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  // The two fields on this row that reach QuickBooks as the Customer's own
  // contact name and Notes box (2026-09-10).
  const [contactName, setContactName] = useState('');
  const [custNotes, setCustNotes] = useState('');
  const [enabling, setEnabling] = useState(false);

  function hydrate(r: CustomerBillingRow) {
    setRow(r);
    setTerms(r.payment_terms ?? '');
    setTaxable(r.taxable === true);
    setMethods({
      orders: r.payment_method_orders ?? '', rentals: r.payment_method_rentals ?? '',
      tanks: r.payment_method_tanks ?? '',
    });
    setEmails({
      billing_email: r.billing_email ?? '', remittance_email: r.remittance_email ?? '',
      optional_email: r.optional_email ?? '', accounting_email: r.accounting_email ?? '',
    });
    setRouting({
      invoice_recipients: (r.invoice_recipients ?? []) as SlotKey[],
      statement_recipients: (r.statement_recipients ?? []) as SlotKey[],
      reminder_recipients: (r.reminder_recipients ?? []) as SlotKey[],
      order_update_recipients: (r.order_update_recipients ?? []) as SlotKey[],
    });
    setNewName(r.name ?? '');
    setContactName(r.billing_contact_name ?? '');
    setCustNotes(r.notes ?? '');
  }

  async function load() {
    setErr(''); setRow(undefined); setLive(null); setBillTo(null); setMaster(null);
    try {
      const r = await fetchCustomerBilling(qboCustomerId);
      if (!r) { setRow(null); return; }
      hydrate(r);
      // Both best-effort: the LOCAL record is the authoritative one, so a
      // QuickBooks read that times out must not stop the page rendering.
      void fetchPaymentProfile(r.id).then(setLive);
      void fetchBillingLocation(r.id).then(setBillTo).catch(() => setBillTo(null));
      void fetchBillingMaster(qboCustomerId).then(setMaster);
    } catch (e) {
      setErr((e as Error).message);
      setRow(null);
    }
  }
  useEffect(() => { if (open && row === undefined) void load(); },
    [open, qboCustomerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = !!row && managedByMaster(master);
  const walletKinds = useMemo(
    () => (live?.stripe.methods ?? []).map((m) => m.kind), [live]);

  /** QuickBooks disagreeing with us is a real finding, not a display detail. */
  const termsDiffer = !!live?.qbo?.terms && !!row?.payment_terms
    && live.qbo.terms.trim().toLowerCase() !== row.payment_terms.trim().toLowerCase();

  const dirty = !!row && (
    (row.payment_terms ?? '') !== terms
    || (row.taxable === true) !== taxable
    || PAY_SECTIONS.some((s) => (row[s.column] ?? '') !== (methods[s.key] ?? ''))
  );
  const commsDirty = !!row && (
    EMAIL_SLOTS.some((s) => (row[s.column] ?? '') !== (emails[s.column] ?? ''))
    || DOC_TYPES.some((d) =>
      JSON.stringify([...(row[d.key] ?? [])].sort())
        !== JSON.stringify([...routing[d.key]].sort()))
  );

  const contactDirty = !!row && (
    (row.billing_contact_name ?? '') !== contactName || (row.notes ?? '') !== custNotes
  );

  /**
   * Enable the customer in the portal from here, so the page is not a dead
   * end for the ~650 QuickBooks customers with no record. Enable imports
   * locations, seeds pricing, switches notifications on and emails the
   * account-live invite — the confirm says so before the click.
   */
  async function enableHere() {
    const ok = window.confirm(
      `Set up ${customerName ?? 'this customer'} in the portal?\n\n`
      + 'This creates their billing record, imports their QuickBooks addresses as locations, '
      + 'seeds their pricing from invoice history, switches every email notification ON '
      + '(paper off), and sends them the account-live invite email.\n\n'
      + 'It refuses an EQUIPMENT / RESQ bucket — those never belong on the portal.');
    if (!ok) return;
    setEnabling(true);
    try {
      const res = await enableCustomerInPortal(qboCustomerId);
      const d = res.data;
      toast.success(d?.already_enabled ? 'Already enabled — record loaded.'
        : `Enabled. ${d?.locations_imported ?? 0} location${d?.locations_imported === 1 ? '' : 's'} imported.`);
      const warn: string[] = [];
      if (d?.collection_seed_error) warn.push('Pricing seed: ' + d.collection_seed_error);
      if (d?.switch_on_email_warning) warn.push('Invite email: ' + d.switch_on_email_warning);
      if (warn.length) setNotes(warn);
      forgetOrdersCustomer(qboCustomerId);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setEnabling(false);
    }
  }

  async function run(what: string, fn: () => Promise<{ push_notes?: string[] }>) {
    setBusy(what); setNotes([]);
    try {
      const res = await fn();
      // Notes are the whole point of a best-effort push: a save that landed
      // locally but was refused by QuickBooks must say so, or the screen
      // implies the two systems agree when they do not.
      if (res.push_notes?.length) setNotes(res.push_notes);
      toast.success('Saved.');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const header = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      style={{
        all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center',
        gap: 8, width: '100%', boxSizing: 'border-box',
      }}
      aria-expanded={open}
    >
      {open
        ? <ChevronDown size={14} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />
        : <ChevronRight size={14} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />}
      <span style={{ ...lbl, color: 'var(--tx2)' }}>Billing &amp; customer master</span>
      {/* Collapsed must still answer "is it on, and set to what" — otherwise
          folding hides state rather than tidying it. But it is a summary OF
          the folded state and is hidden once open, where the real controls
          say the same thing two lines lower: leaving it up put "Net 30"
          above a terms picker reading Net 30. */}
      {!open && (
        <span style={{ fontSize: 10, color: 'var(--mt)', marginLeft: 'auto' }}>
          {row === undefined ? 'Refractor'
            : row === null ? 'not set up in the portal'
            : [row.payment_terms ?? 'no terms',
               row.on_credit_hold ? 'CREDIT HOLD' : null,
               locked ? 'managed by master' : null,
              ].filter(Boolean).join(' · ')}
        </span>
      )}
    </button>
  );

  return (
    <div className="cd" style={{ padding: '10px 14px', marginBottom: 14 }}>
      {header}
      {!open ? null : err ? (
        <Note tone="red">
          <div style={{ fontWeight: 600, color: 'var(--rd)' }}>Could not load the billing record</div>
          <div style={{ marginTop: 2 }}>{err}</div>
          <button type="button" style={{ ...btn(), marginTop: 6 }} onClick={() => void load()}>
            <RefreshCw size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Try again
          </button>
        </Note>
      ) : row === undefined ? (
        <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 10 }}>Loading…</div>
      ) : row === null ? (
        <Note tone="plain">
          <div style={{ color: 'var(--tx2)' }}>
            <strong>{customerName ?? 'This customer'}</strong> has no portal billing record, so
            there is nothing to bill from yet — terms, payment methods and document routing all
            live on that record. 204 of roughly 850 QuickBooks customers have one.
          </div>
          <div style={{ marginTop: 4, color: 'var(--mt)' }}>
            Setting them up creates that record, imports their QuickBooks addresses as locations,
            seeds their pricing from invoice history, and emails them the account-live invite.
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={btn('primary')} disabled={enabling}
              onClick={() => void enableHere()}>
              {enabling ? 'Setting up…' : 'Set up this customer in the portal'}
            </button>
            <span style={{ fontSize: 10, color: 'var(--mt)' }}>
              Same action as Brix Order → Customers → Enable. Needs a superadmin account.
            </span>
          </div>
          {notes.length > 0 && (
            <div style={{ marginTop: 6, color: 'var(--am)' }}>{notes.join(' · ')}</div>
          )}
        </Note>
      ) : (
        <div style={{ marginTop: 12 }}>
          {locked && (
            <Note tone="amber">
              <Lock size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
              This store&apos;s billing is <strong>managed by its chain master{master?.name ? ` (${master.name})` : ''}</strong>. Terms,
              payment methods and document routing are set on the master and synced down —
              editing them here would be undone by the next sync.
            </Note>
          )}

          {/* ── terms, tax, methods ─────────────────────────────────────── */}
          <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12 }}>
            <div>
              <div style={lbl}>Payment terms</div>
              <select style={{ ...ctl, marginTop: 3, width: '100%' }} value={terms}
                disabled={locked} onChange={(e) => setTerms(e.target.value)}>
                <option value="">— not set —</option>
                {['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
                {/* A stored value outside the list must stay selectable, or
                    opening the form to change something else silently
                    rewrites the terms. */}
                {terms && !['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'].includes(terms)
                  && <option value={terms}>{terms} (on file)</option>}
              </select>
            </div>
            <div>
              <div style={lbl}>Sales tax</div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginTop: 7 }}>
                <input type="checkbox" checked={taxable} disabled={locked}
                  onChange={(e) => setTaxable(e.target.checked)} />
                Taxable
              </label>
              <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>
                Most accounts are non-taxable (resale certificate on file).
              </div>
            </div>
            {PAY_SECTIONS.map((s) => {
              const cur = methods[s.key] || '';
              const offer = offerableMethods(walletKinds, cur || null);
              return (
                <div key={s.key}>
                  <div style={lbl}>{s.label}</div>
                  <select style={{ ...ctl, marginTop: 3, width: '100%' }} value={cur}
                    disabled={locked}
                    onChange={(e) => setMethods((m) => ({ ...m, [s.key]: e.target.value }))}>
                    <option value="">— not set —</option>
                    {offer.map((m) => (
                      <option key={m} value={m}>{PAY_METHOD_LABEL[m as PayMethod]}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          {/* Card / ACH are only offerable when the wallet actually backs
              them — the server refuses otherwise (409), so offering one
              produces a save that can only fail. */}
          {live && !live.stripe.active_methods && (
            <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 6 }}>
              No saved Stripe method, so “we charge it” options are unavailable — Check and
              “they send it” always are. {live.stripe.needed
                ? 'A section is already set to a method Stripe cannot back.'
                : ''}
            </div>
          )}
          {live && live.stripe.active_methods > 0 && (
            <div style={{ fontSize: 10, color: 'var(--gn)', marginTop: 6 }}>
              Stripe: {live.stripe.active_methods} saved method
              {live.stripe.active_methods === 1 ? '' : 's'}
              {live.stripe.methods[0]?.last4 ? ` (${live.stripe.methods[0].brand ?? ''} •${live.stripe.methods[0].last4})` : ''}
            </div>
          )}

          {/* ── what QuickBooks says, read LIVE ─────────────────────────── */}
          {live?.qbo && (
            <div style={{
              marginTop: 8, padding: '7px 10px', borderRadius: 4, fontSize: 11,
              border: '1px solid var(--bd)', color: 'var(--tx2)',
            }}>
              <span style={{ ...lbl, marginRight: 8 }}>QuickBooks says</span>
              Terms <strong>{live.qbo.terms ?? '— none —'}</strong>
              {live.qbo.payment_method ? <> · preferred method <strong>{live.qbo.payment_method}</strong></> : null}
              {termsDiffer && (
                <span style={{ color: 'var(--am)', marginLeft: 8 }}>
                  — differs from the portal ({row.payment_terms}). The portal is the master; saving
                  here pushes ours to QuickBooks.
                </span>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={btn('primary')} disabled={!dirty || locked || !!busy}
              onClick={() => void run('profile', () => savePaymentProfile(row.id, {
                payment_terms: terms || null,
                taxable,
                payment_method_orders: (methods.orders || null) as PayMethod | null,
                payment_method_rentals: (methods.rentals || null) as PayMethod | null,
                payment_method_tanks: (methods.tanks || null) as PayMethod | null,
              }))}>
              {busy === 'profile' ? 'Saving…' : 'Save terms & methods'}
            </button>
            {live?.qbo?.terms && termsDiffer && !locked && (
              <button type="button" style={btn()} disabled={!!busy}
                onClick={() => setTerms(live.qbo!.terms!)}>
                Match QuickBooks ({live.qbo.terms})
              </button>
            )}
          </div>

          {/* ── the four slots + per-email routing ──────────────────────── */}
          <Section hint="The customer can also edit these four addresses themselves in the ordering portal — they are a customer preference as well as a staff setting.">
            Billing emails &amp; what each one receives
          </Section>
          <div style={{ height: 8 }} />
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 11, minWidth: 560, width: '100%', maxWidth: 820 }}>
              <thead>
                <tr>
                  <th style={{ ...lbl, textAlign: 'left', padding: '4px 8px 4px 0' }}>Slot</th>
                  <th style={{ ...lbl, textAlign: 'left', padding: '4px 8px', width: '40%' }}>Address</th>
                  {DOC_TYPES.map((d) => (
                    <th key={d.key} style={{ ...lbl, padding: '4px 8px' }}>{d.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {EMAIL_SLOTS.map((s) => (
                  <tr key={s.key} style={{ borderTop: '1px solid var(--bd)' }}>
                    <td style={{ padding: '5px 8px 5px 0', color: 'var(--tx2)' }}>{s.label}</td>
                    <td style={{ padding: '5px 8px' }}>
                      <input style={{ ...ctl, width: '100%', minWidth: 180 }} type="email" disabled={locked}
                        placeholder="—"
                        value={emails[s.column] ?? ''}
                        onChange={(e) => setEmails((m) => ({ ...m, [s.column]: e.target.value }))} />
                    </td>
                    {DOC_TYPES.map((d) => {
                      const on = routing[d.key].includes(s.key);
                      const addr = slotAddress(row, s.key);
                      return (
                        <td key={d.key} style={{ padding: '5px 8px', textAlign: 'center' }}>
                          <input type="checkbox" checked={on} disabled={locked}
                            title={on && !addr ? 'Routed here, but this slot has no address on file' : undefined}
                            onChange={(e) => setRouting((r) => ({
                              ...r,
                              [d.key]: e.target.checked
                                ? [...r[d.key], s.key]
                                : r[d.key].filter((k) => k !== s.key),
                            }))} />
                          {/* A slot ticked with no address sends to nobody and
                              looks configured — say so rather than let it
                              read as done. */}
                          {on && !addr && <span style={{ color: 'var(--am)', marginLeft: 3 }}>!</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {DOC_TYPES.some((d) => routing[d.key].length === 0) && (
            <div style={{ fontSize: 10, color: 'var(--am)', marginTop: 6 }}>
              {DOC_TYPES.filter((d) => routing[d.key].length === 0).map((d) => d.label).join(', ')}
              {' '}routed to nobody — nothing will be sent.
            </div>
          )}
          <button type="button" style={{ ...btn('primary'), marginTop: 10 }}
            disabled={!commsDirty || locked || !!busy}
            onClick={() => void run('comms', () => saveBillingComms(row.id, {
              billing_email: emails.billing_email || null,
              remittance_email: emails.remittance_email || null,
              optional_email: emails.optional_email || null,
              accounting_email: emails.accounting_email || null,
              invoice_recipients: routing.invoice_recipients,
              statement_recipients: routing.statement_recipients,
              reminder_recipients: routing.reminder_recipients,
              order_update_recipients: routing.order_update_recipients,
            }))}>
            {busy === 'comms' ? 'Saving…' : 'Save emails & routing'}
          </button>

          {/* ── the QuickBooks contact + notes ──────────────────────────── */}
          <Section hint="QuickBooks holds one contact name and one Notes box per customer; both are pushed on save. Pick the contact from the Contacts card below, or type it here.">
            QuickBooks contact &amp; notes
          </Section>
          <div className="gr" style={{ gridTemplateColumns: 'minmax(200px,280px) 1fr', gap: 12, marginTop: 8 }}>
            <div>
              <div style={lbl}>Primary contact (first + last name)</div>
              <input style={{ ...ctl, width: '100%', marginTop: 3 }} value={contactName} disabled={locked}
                placeholder="—" data-field="billing_contact_name"
                onChange={(e) => setContactName(e.target.value)} />
            </div>
            <div>
              <div style={lbl}>Notes (2,000 characters — QuickBooks’ cap)</div>
              <textarea style={{ ...ctl, width: '100%', marginTop: 3, minHeight: 54, resize: 'vertical' }}
                value={custNotes} disabled={locked} maxLength={2000} data-field="notes"
                onChange={(e) => setCustNotes(e.target.value)} />
            </div>
          </div>
          <button type="button" style={{ ...btn('primary'), marginTop: 8 }}
            disabled={!contactDirty || locked || !!busy}
            onClick={() => void run('contact', () => saveBillingComms(row.id, {
              billing_contact_name: contactName.trim() || null,
              notes: custNotes.trim() || null,
            }))}>
            {busy === 'contact' ? 'Saving…' : 'Save contact & notes'}
          </button>

          {/* ── bill-to, read-only here on purpose ─────────────────────── */}
          <Section>Bill-to</Section>
          <div style={{ fontSize: 11, color: 'var(--tx2)', marginTop: 3 }}>
            {billTo
              ? [billTo.address_line1, billTo.address_line2, [billTo.city, billTo.state].filter(Boolean).join(', '), billTo.zip]
                  .filter(Boolean).join(' · ')
              : <span style={{ color: 'var(--am)' }}>
                  No location is flagged as the bill-to, so invoices print no address.
                </span>}
          </div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>
            The bill-to is a LOCATION, not a field on the customer — pick or edit it in the
            <strong> Locations &amp; addresses</strong> card below, so there is one copy of the address.
            It is pushed to QuickBooks as the Customer’s billing address.
          </div>

          {/* ── the two that carry consequences ────────────────────────── */}
          <Section>Account</Section>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            {renaming ? (
              <>
                <input style={{ ...ctl, width: 260 }} value={newName}
                  onChange={(e) => setNewName(e.target.value)} />
                <button type="button" style={btn('primary')}
                  disabled={!!busy || !newName.trim() || newName.trim() === row.name}
                  onClick={() => void run('name', () => setCustomerName(row.id, newName.trim()))
                    .then(() => setRenaming(false))}>
                  {busy === 'name' ? 'Saving…' : 'Rename'}
                </button>
                <button type="button" style={btn()}
                  onClick={() => { setRenaming(false); setNewName(row.name ?? ''); }}>Cancel</button>
                <div style={{ fontSize: 10, color: 'var(--mt)', flexBasis: '100%' }}>
                  Also pushed to QuickBooks as the display name, which must be unique — a clash
                  comes back as a note and the local rename still stands. Service Fusion has no
                  update API, so it will tell you to retype it there.
                </div>
              </>
            ) : (
              <button type="button" style={btn()} onClick={() => setRenaming(true)}>
                <Pencil size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                Rename “{row.name}”
              </button>
            )}

            <button type="button"
              style={btn(row.on_credit_hold ? 'ghost' : 'danger')} disabled={!!busy}
              onClick={() => {
                const on = !row.on_credit_hold;
                const ok = window.confirm(on
                  ? `Put ${row.name} on credit hold?\n\nThis BLOCKS them from placing any order — `
                    + 'the portal disables checkout and the submit endpoint refuses before it '
                    + 'reaches Service Fusion.'
                  : `Release the credit hold on ${row.name}?\n\nThey will be able to order again `
                    + 'immediately.');
                if (ok) void run('hold', () => setCreditHold(row.id, on));
              }}>
              {busy === 'hold' ? 'Saving…'
                : row.on_credit_hold ? 'Release credit hold' : 'Put on credit hold'}
            </button>
          </div>
          {row.on_credit_hold && (
            <Note tone="red">
              <strong>On credit hold.</strong> This account cannot place an order on any channel —
              portal, phone or EDI.
            </Note>
          )}

          {notes.length > 0 && (
            <Note tone="amber">
              <div style={{ fontWeight: 600, color: 'var(--am)' }}>
                Saved here, but not everything reached the other systems
              </div>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </Note>
          )}

          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 14, borderTop: '1px solid var(--bd)', paddingTop: 8 }}>
            Editing the same record as the Brix Order admin — one table, one writer, so a change
            made on either surface shows on the other. Terms, name, taxable, contact, notes, bill-to
            and ship-to all push to QuickBooks on save. Brix Order&apos;s staff billing screens are
            being retired; see docs/OWNERSHIP-AND-MIGRATION.md.
          </div>
        </div>
      )}
    </div>
  );
}
