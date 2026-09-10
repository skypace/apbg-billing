import { useEffect, useState } from 'react';
import { MapPin, Pencil, Plus, RefreshCw } from 'lucide-react';
import { useToast } from '../lib/toast';
import {
  createLocation, fetchLocations, fetchOrdersCustomer, onOrdersCustomerChanged, formatAddress, locationQboRole,
  setBillingLocation, setLocationActive, updateLocation,
  type CustomerLocation, type LocationFields, type OrdersCustomer,
} from '../lib/customerMaster';
import { CardShell, Note, PushNotes, btn, chip, ctl, lbl } from './customerMasterUi';

/**
 * Locations, on the Refractor customer page — the ship-to(s), the bill-to,
 * the store phone, the driver notes.
 *
 * ⚠ TWO of these rows are what QuickBooks carries, and the tag on the row
 * says which: the row coded PRIMARY is the Customer's ShipAddr; the row
 * flagged bill-to is its BillAddr (and its phone is the Customer's
 * PrimaryPhone). Editing either pushes the address AS IT NOW STANDS through
 * brix-order's push — the portal is the record, QuickBooks is told. Every
 * other location is portal-only (a delivery site the order form offers).
 *
 * ⚠ Service Fusion has no customer-update API (PUT → 405). A push there is a
 * RETYPE INSTRUCTION, and it arrives in the amber notes below the save.
 */

const EMPTY: LocationFields = {
  display_name: '', address_line1: '', address_line2: '', city: '', state: '', zip: '',
  phone: '', delivery_notes: '',
};

function fieldsOf(l: CustomerLocation): LocationFields {
  return {
    display_name: l.display_name ?? '', address_line1: l.address_line1 ?? '',
    address_line2: l.address_line2 ?? '', city: l.city ?? '', state: l.state ?? '',
    zip: l.zip ?? '', phone: l.phone ?? '', delivery_notes: l.delivery_notes ?? '',
  };
}

/** Only the fields that changed ride the PATCH — a rename must not re-push an address. */
function diff(before: LocationFields, after: LocationFields): LocationFields {
  const out: LocationFields = {};
  (Object.keys(after) as (keyof LocationFields)[]).forEach((k) => {
    if ((before[k] ?? '') !== (after[k] ?? '')) out[k] = after[k] ?? '';
  });
  return out;
}

function LocationForm({ initial, onSave, onCancel, busy, isNew }: {
  initial: LocationFields; onSave: (f: LocationFields) => void; onCancel: () => void;
  busy: boolean; isNew: boolean;
}) {
  const [f, setF] = useState<LocationFields>(initial);
  const set = (k: keyof LocationFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));
  const field = (k: keyof LocationFields, label: string, extra?: React.CSSProperties) => (
    <div style={extra}>
      <div style={lbl}>{label}</div>
      <input style={{ ...ctl, width: '100%', marginTop: 3 }} value={(f[k] as string) ?? ''}
        onChange={set(k)} data-field={k} />
    </div>
  );
  return (
    <div style={{ marginTop: 8, padding: '10px 12px', border: '1px solid var(--bd)', borderRadius: 4 }}>
      <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 }}>
        {field('display_name', 'Name (e.g. Store #12, Warehouse)')}
        {field('address_line1', 'Street')}
        {field('address_line2', 'Suite / unit')}
        {field('city', 'City')}
        {field('state', 'State')}
        {field('zip', 'ZIP')}
        {field('phone', 'Phone (the site’s own line)')}
        {field('delivery_notes', 'Delivery notes (gate code, dock, hours)', { gridColumn: '1 / -1' })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" style={btn('primary')} disabled={busy || !(f.display_name ?? '').trim()}
          onClick={() => onSave(f)}>
          {busy ? 'Saving…' : isNew ? 'Add location' : 'Save location'}
        </button>
        <button type="button" style={btn()} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

interface Props { qboCustomerId: string; customerName?: string | null }

export function CustomerLocationsCard({ qboCustomerId, customerName }: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [cust, setCust] = useState<OrdersCustomer | null | undefined>(undefined);
  const [locs, setLocs] = useState<CustomerLocation[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  async function load() {
    setErr('');
    try {
      const c = await fetchOrdersCustomer(qboCustomerId);
      setCust(c);
      if (!c) { setLocs([]); return; }
      setLocs(await fetchLocations(c.id));
    } catch (e) {
      setErr((e as Error).message); setCust(null); setLocs([]);
    }
  }
  // Loaded on mount, not on open: the collapsed line must be able to say
  // "3 locations · bill-to set", which needs the rows.
  useEffect(() => { setCust(undefined); setLocs(null); void load(); },
    [qboCustomerId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Re-read when another card changes the record (e.g. Set up in the portal).
  useEffect(() => onOrdersCustomerChanged(qboCustomerId, () => { void load(); }),
    [qboCustomerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(what: string, fn: () => Promise<{ push_notes?: string[]; data?: unknown }>) {
    setBusy(what); setNotes([]);
    try {
      const res = await fn();
      if (res.push_notes?.length) setNotes(res.push_notes);
      toast.success('Saved.');
      setEditing(null); setAdding(false);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const visible = (locs ?? []).filter((l) => showHidden || l.active !== false);
  const hiddenCount = (locs ?? []).filter((l) => l.active === false).length;
  const billTo = (locs ?? []).find((l) => l.is_billing);

  const summary = cust === undefined ? 'Refractor'
    : cust === null ? 'not set up in the portal'
    : `${(locs ?? []).filter((l) => l.active !== false).length} location`
      + `${(locs ?? []).filter((l) => l.active !== false).length === 1 ? '' : 's'}`
      + (billTo ? ' · bill-to set' : ' · NO BILL-TO');

  return (
    <CardShell title="Locations & addresses" open={open} onToggle={() => setOpen((o) => !o)} summary={summary}>
      {err ? (
        <Note tone="red">
          <div style={{ fontWeight: 600, color: 'var(--rd)' }}>Could not load locations</div>
          <div style={{ marginTop: 2 }}>{err}</div>
          <button type="button" style={{ ...btn(), marginTop: 6 }} onClick={() => void load()}>
            <RefreshCw size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Try again
          </button>
        </Note>
      ) : cust === undefined || locs === null ? (
        <div style={{ fontSize: 11, color: 'var(--mt)' }}>Loading…</div>
      ) : cust === null ? (
        <Note tone="plain">
          <strong>{customerName ?? 'This customer'}</strong> has no portal record, so there are no
          locations to edit yet. Set the customer up from the Billing card above and their
          QuickBooks addresses import as locations.
        </Note>
      ) : (
        <>
          {!billTo && (
            <Note tone="amber">
              <strong>No bill-to.</strong> No location is flagged as the billing address, so invoices
              and statements print none and QuickBooks gets no BillAddr. Pick one below with
              “Make bill-to”.
            </Note>
          )}

          <div style={{ marginTop: 6 }}>
            {visible.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--mt)' }}>No locations on file.</div>
            )}
            {visible.map((l) => {
              const role = locationQboRole(l);
              const isEditing = editing === l.id;
              return (
                <div key={l.id} data-location-id={l.id} style={{
                  padding: '8px 0', borderTop: '1px solid var(--bd)',
                  opacity: l.active === false ? 0.6 : 1,
                }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <MapPin size={12} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx)' }}>
                      {l.display_name || '(unnamed)'}
                    </span>
                    {role === 'bill-to' && <span style={chip('accent')} title="QuickBooks BillAddr + PrimaryPhone">bill-to</span>}
                    {role === 'ship-to' && <span style={chip('plain')} title="QuickBooks ShipAddr">primary · ship-to</span>}
                    {l.qbo_sub_customer_id != null && <span style={chip('plain')}>QuickBooks sub #{l.qbo_sub_customer_id}</span>}
                    {l.sf_location_id != null && <span style={chip('plain')}>SF #{l.sf_location_id}</span>}
                    {l.active === false && <span style={chip('red')}>hidden</span>}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      {!isEditing && (
                        <button type="button" style={btn()} disabled={!!busy}
                          onClick={() => { setAdding(false); setEditing(l.id); setNotes([]); }}>
                          <Pencil size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Edit
                        </button>
                      )}
                      {!l.is_billing && l.active !== false && (
                        <button type="button" style={btn()} disabled={!!busy || !l.address_line1}
                          title={l.address_line1 ? 'Make this the billing address (pushed to QuickBooks)' : 'Add a street address first'}
                          onClick={() => {
                            const ok = window.confirm(
                              `Make “${l.display_name}” the bill-to for ${cust.name}?\n\nThis is the address that `
                              + 'prints on invoices and statements, and it is pushed to QuickBooks as the '
                              + 'Customer’s BillAddr (with this site’s phone as PrimaryPhone).');
                            if (ok) void run('bill:' + l.id, () => setBillingLocation(cust.id, l.id));
                          }}>
                          {busy === 'bill:' + l.id ? 'Saving…' : 'Make bill-to'}
                        </button>
                      )}
                      <button type="button" style={btn(l.active === false ? 'ghost' : 'ghost')} disabled={!!busy}
                        onClick={() => void run('active:' + l.id,
                          () => setLocationActive(cust.id, l.id, l.active === false))}>
                        {busy === 'active:' + l.id ? '…' : l.active === false ? 'Show' : 'Hide'}
                      </button>
                    </span>
                  </div>
                  {!isEditing && (
                    <div style={{ fontSize: 11, color: 'var(--tx2)', marginTop: 3, paddingLeft: 20 }}>
                      {formatAddress(l) || <span style={{ color: 'var(--am)' }}>no street address</span>}
                      {l.phone && <span style={{ color: 'var(--mt)' }}> · {l.phone}</span>}
                      {l.delivery_notes && (
                        <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>{l.delivery_notes}</div>
                      )}
                    </div>
                  )}
                  {isEditing && (
                    <LocationForm initial={fieldsOf(l)} busy={busy === 'save:' + l.id} isNew={false}
                      onCancel={() => setEditing(null)}
                      onSave={(f) => {
                        const patch = diff(fieldsOf(l), f);
                        if (Object.keys(patch).length === 0) { setEditing(null); return; }
                        void run('save:' + l.id, () => updateLocation(cust.id, l.id, patch));
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
                <Plus size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Add a location
              </button>
            )}
            {hiddenCount > 0 && (
              <label style={{ fontSize: 10, color: 'var(--mt)', display: 'flex', gap: 5, alignItems: 'center' }}>
                <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
                show {hiddenCount} hidden
              </label>
            )}
          </div>
          {adding && (
            <LocationForm initial={EMPTY} busy={busy === 'create'} isNew
              onCancel={() => setAdding(false)}
              onSave={(f) => void run('create', () => createLocation(cust.id, f))} />
          )}

          <PushNotes notes={notes} />

          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 14, borderTop: '1px solid var(--bd)', paddingTop: 8 }}>
            The <strong>primary</strong> location is QuickBooks’ ship-to and the <strong>bill-to</strong> is its
            billing address and phone — editing either pushes to QuickBooks. Service Fusion has no
            update API, so a change there comes back as a retype note. Same rows as Brix Order’s
            Locations tab: one table, one writer.
          </div>
        </>
      )}
    </CardShell>
  );
}
