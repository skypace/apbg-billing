import { useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw, Star, UserRound } from 'lucide-react';
import { useToast } from '../lib/toast';
import { saveBillingComms } from '../lib/customerBilling';
import {
  CONTACT_ROLES, contactRoleLabel, createContact, fetchContacts, fetchOrdersCustomer,
  forgetOrdersCustomer, onOrdersCustomerChanged, setContactActive, updateContact,
  type ContactFields, type ContactRole, type CustomerContact, type OrdersCustomer,
} from '../lib/customerMaster';
import { CardShell, Note, PushNotes, btn, chip, ctl, lbl } from './customerMasterUi';

/**
 * Contacts, on the Refractor customer page — who runs the account.
 *
 * ⚠ CONTACTS, NOT LOGINS. A row is a name, a role and a phone number; it has
 * no portal access and nothing here is ever emailed automatically. Logins are
 * a different table (`orders.customer_users`) and a different screen.
 *
 * QuickBooks holds exactly ONE contact on a Customer (GivenName/FamilyName),
 * so "Make QuickBooks primary" writes that person's name onto the billing
 * record's `billing_contact_name`, which brix-order pushes as the split name.
 * It is a pointer from the record to a person, not a second copy of them.
 */

const EMPTY: ContactFields = { name: '', role: 'other', title: '', email: '', phone: '', notes: '' };

function fieldsOf(c: CustomerContact): ContactFields {
  return {
    name: c.name, role: (c.role as ContactRole) || 'other', title: c.title ?? '',
    email: c.email ?? '', phone: c.phone ?? '', notes: c.notes ?? '',
  };
}
function diff(before: ContactFields, after: ContactFields): ContactFields {
  const out: ContactFields = {};
  (Object.keys(after) as (keyof ContactFields)[]).forEach((k) => {
    if ((before[k] ?? '') !== (after[k] ?? '')) (out as Record<string, unknown>)[k] = after[k] ?? '';
  });
  return out;
}

function ContactForm({ initial, onSave, onCancel, busy, isNew }: {
  initial: ContactFields; onSave: (f: ContactFields) => void; onCancel: () => void;
  busy: boolean; isNew: boolean;
}) {
  const [f, setF] = useState<ContactFields>(initial);
  const text = (k: keyof ContactFields, label: string) => (
    <div>
      <div style={lbl}>{label}</div>
      <input style={{ ...ctl, width: '100%', marginTop: 3 }} value={(f[k] as string) ?? ''}
        onChange={(e) => setF((cur) => ({ ...cur, [k]: e.target.value }))} data-field={k} />
    </div>
  );
  return (
    <div style={{ marginTop: 8, padding: '10px 12px', border: '1px solid var(--bd)', borderRadius: 4 }}>
      <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 }}>
        {text('name', 'Name')}
        <div>
          <div style={lbl}>Role</div>
          <select style={{ ...ctl, width: '100%', marginTop: 3 }} value={f.role ?? 'other'}
            onChange={(e) => setF((cur) => ({ ...cur, role: e.target.value as ContactRole }))}>
            {CONTACT_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </div>
        {text('title', 'Title')}
        {text('email', 'Email')}
        {text('phone', 'Phone')}
        {text('notes', 'Notes')}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" style={btn('primary')} disabled={busy || !(f.name ?? '').trim()}
          onClick={() => onSave(f)}>
          {busy ? 'Saving…' : isNew ? 'Add contact' : 'Save contact'}
        </button>
        <button type="button" style={btn()} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

interface Props { qboCustomerId: string; customerName?: string | null }

export function CustomerContactsCard({ qboCustomerId, customerName }: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [cust, setCust] = useState<OrdersCustomer | null | undefined>(undefined);
  const [rows, setRows] = useState<CustomerContact[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  async function load() {
    setErr('');
    try {
      const c = await fetchOrdersCustomer(qboCustomerId);
      setCust(c);
      if (!c) { setRows([]); return; }
      setRows(await fetchContacts(c.id));
    } catch (e) {
      setErr((e as Error).message); setCust(null); setRows([]);
    }
  }
  useEffect(() => { setCust(undefined); setRows(null); void load(); },
    [qboCustomerId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Re-read when another card changes the record (e.g. Set up in the portal).
  useEffect(() => onOrdersCustomerChanged(qboCustomerId, () => { void load(); }),
    [qboCustomerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(what: string, fn: () => Promise<{ push_notes?: string[] }>, refetchCustomer = false) {
    setBusy(what); setNotes([]);
    try {
      const res = await fn();
      if (res.push_notes?.length) setNotes(res.push_notes);
      toast.success('Saved.');
      setEditing(null); setAdding(false);
      if (refetchCustomer) forgetOrdersCustomer(qboCustomerId);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const primaryName = (cust?.billing_contact_name ?? '').trim().toLowerCase();
  const isPrimary = (c: CustomerContact) => !!primaryName && c.name.trim().toLowerCase() === primaryName;
  const visible = (rows ?? []).filter((c) => showInactive || c.active !== false);
  const inactiveCount = (rows ?? []).filter((c) => c.active === false).length;
  const activeCount = (rows ?? []).filter((c) => c.active !== false).length;

  const summary = cust === undefined ? 'Refractor'
    : cust === null ? 'not set up in the portal'
    : `${activeCount} contact${activeCount === 1 ? '' : 's'}`
      + (cust.billing_contact_name ? ` · QuickBooks primary: ${cust.billing_contact_name}` : ' · no QuickBooks primary');

  return (
    <CardShell title="Contacts" open={open} onToggle={() => setOpen((o) => !o)} summary={summary}>
      {err ? (
        <Note tone="red">
          <div style={{ fontWeight: 600, color: 'var(--rd)' }}>Could not load contacts</div>
          <div style={{ marginTop: 2 }}>{err}</div>
          <button type="button" style={{ ...btn(), marginTop: 6 }} onClick={() => void load()}>
            <RefreshCw size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Try again
          </button>
        </Note>
      ) : cust === undefined || rows === null ? (
        <div style={{ fontSize: 11, color: 'var(--mt)' }}>Loading…</div>
      ) : cust === null ? (
        <Note tone="plain">
          <strong>{customerName ?? 'This customer'}</strong> has no portal record, so contacts cannot be
          filed against it yet. Set the customer up from the Billing card above.
        </Note>
      ) : (
        <>
          <div style={{ fontSize: 10, color: 'var(--mt)' }}>
            Who to call about this account. These are contacts, not logins — nobody here can sign in,
            and nothing is emailed to them automatically.
          </div>

          <div style={{ marginTop: 6 }}>
            {visible.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--mt)' }}>No contacts on file.</div>
            )}
            {visible.map((c) => {
              const isEditing = editing === c.id;
              return (
                <div key={c.id} data-contact-id={c.id} style={{
                  padding: '8px 0', borderTop: '1px solid var(--bd)', opacity: c.active === false ? 0.6 : 1,
                }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <UserRound size={12} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx)' }}>{c.name}</span>
                    <span style={chip('plain')}>{contactRoleLabel(c.role)}</span>
                    {c.title && <span style={{ fontSize: 11, color: 'var(--tx2)' }}>{c.title}</span>}
                    {isPrimary(c) && (
                      <span style={chip('accent')} title="Pushed to QuickBooks as the Customer's contact name">
                        <Star size={9} style={{ verticalAlign: -1, marginRight: 3 }} />QuickBooks primary
                      </span>
                    )}
                    {c.active === false && <span style={chip('red')}>inactive</span>}
                    {c.source && c.source !== 'manual' && (
                      <span style={{ fontSize: 9, color: 'var(--mt)' }}>from {c.source.replace(/_/g, ' ')}</span>
                    )}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      {!isEditing && (
                        <button type="button" style={btn()} disabled={!!busy}
                          onClick={() => { setAdding(false); setEditing(c.id); setNotes([]); }}>
                          <Pencil size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Edit
                        </button>
                      )}
                      {!isPrimary(c) && c.active !== false && (
                        <button type="button" style={btn()} disabled={!!busy}
                          title="Write this person onto the QuickBooks Customer as its contact name"
                          onClick={() => void run('primary:' + c.id,
                            () => saveBillingComms(cust.id, { billing_contact_name: c.name }), true)}>
                          {busy === 'primary:' + c.id ? 'Saving…' : 'Make QuickBooks primary'}
                        </button>
                      )}
                      <button type="button" style={btn()} disabled={!!busy}
                        onClick={() => void run('active:' + c.id,
                          () => setContactActive(cust.id, c.id, c.active === false))}>
                        {busy === 'active:' + c.id ? '…' : c.active === false ? 'Reactivate' : 'Deactivate'}
                      </button>
                    </span>
                  </div>
                  {!isEditing && (c.email || c.phone || c.notes) && (
                    <div style={{ fontSize: 11, color: 'var(--tx2)', marginTop: 3, paddingLeft: 20 }}>
                      {[c.email, c.phone].filter(Boolean).join(' · ')}
                      {c.notes && <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>{c.notes}</div>}
                    </div>
                  )}
                  {isEditing && (
                    <ContactForm initial={fieldsOf(c)} busy={busy === 'save:' + c.id} isNew={false}
                      onCancel={() => setEditing(null)}
                      onSave={(f) => {
                        const patch = diff(fieldsOf(c), f);
                        if (Object.keys(patch).length === 0) { setEditing(null); return; }
                        void run('save:' + c.id, () => updateContact(cust.id, c.id, patch));
                      }} />
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {!adding && (
              <button type="button" style={btn('primary')} disabled={!!busy}
                onClick={() => { setEditing(null); setAdding(true); setNotes([]); }}>
                <Plus size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Add a contact
              </button>
            )}
            {inactiveCount > 0 && (
              <label style={{ fontSize: 10, color: 'var(--mt)', display: 'flex', gap: 5, alignItems: 'center' }}>
                <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                show {inactiveCount} inactive
              </label>
            )}
          </div>
          {adding && (
            <ContactForm initial={EMPTY} busy={busy === 'create'} isNew
              onCancel={() => setAdding(false)}
              onSave={(f) => void run('create', () => createContact(cust.id, f))} />
          )}

          <PushNotes notes={notes} />

          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 14, borderTop: '1px solid var(--bd)', paddingTop: 8 }}>
            QuickBooks holds one contact per customer. “Make QuickBooks primary” pushes that person’s
            name as the Customer’s first/last name; the rest of the list is ours. The same person in
            two roles is two rows, on purpose. Same rows as Brix Order’s Store contacts card.
          </div>
        </>
      )}
    </CardShell>
  );
}
