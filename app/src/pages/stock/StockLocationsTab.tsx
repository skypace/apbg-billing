import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  InventoryLocation,
  LocationEntity,
  LocationKind,
  NewLocation,
  createLocation,
  updateLocation,
} from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';

interface Props {
  rows: InventoryLocation[] | null;
  onChanged: () => void;
}

const KIND_OPTIONS: { value: LocationKind; label: string }[] = [
  { value: 'warehouse',          label: 'Warehouse'           },
  { value: 'van',                label: 'Van'                 },
  { value: 'co_packer',          label: 'Co-Packer'           },
  { value: 'customer_consigned', label: 'Customer Consigned'  },
  { value: 'distributor',        label: 'Distributor'         },
];

const ENTITY_OPTIONS: LocationEntity[] = ['brix', 'freeflow', 'shared'];

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function StockLocationsTab({ rows, onChanged }: Props) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  if (rows === null) {
    return <div style={{ padding: 18, color: 'var(--mt)' }}>Loading…</div>;
  }

  const physical = rows.filter((r) => r.kind !== 'in_transit' && r.kind !== 'adjustment');
  const virtual  = rows.filter((r) => r.kind === 'in_transit' || r.kind === 'adjustment');

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--mt)', fontSize: 11 }}>
            {physical.length} physical location{physical.length === 1 ? '' : 's'} ·{' '}
            {virtual.length} virtual
          </span>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setCreating(true)} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New Location
          </button>
        </div>
      </div>

      {creating && (
        <NewLocationForm
          onCancel={() => setCreating(false)}
          onSave={async (loc) => {
            try {
              await createLocation(loc);
              toast.success(`Created ${loc.code}`);
              setCreating(false);
              onChanged();
            } catch (e) {
              toast.error(errMsg(e));
            }
          }}
        />
      )}

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        <LocationsTable rows={physical} editable onChanged={onChanged} />
      </div>

      {virtual.length > 0 && (
        <>
          <div style={{ marginTop: 24, marginBottom: 8, fontSize: 9.5, color: 'var(--mt)', letterSpacing: 1.2, textTransform: 'uppercase' }}>
            Virtual (system) locations
          </div>
          <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
            <LocationsTable rows={virtual} editable={false} onChanged={onChanged} />
          </div>
        </>
      )}
    </div>
  );
}

function LocationsTable({ rows, editable, onChanged }: {
  rows: InventoryLocation[]; editable: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
          <Th>Code</Th>
          <Th>Name</Th>
          <Th>Kind</Th>
          <Th>Entity</Th>
          <Th>City, ST</Th>
          <Th style={{ width: 90 }}>Active</Th>
          {editable && <Th style={{ width: 90 }}> </Th>}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={editable ? 7 : 6} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>
            No locations yet.
          </td></tr>
        )}
        {rows.map((r) => editing === r.id
          ? <EditLocationRow
              key={r.id}
              row={r}
              onCancel={() => setEditing(null)}
              onSave={async (patch) => {
                try {
                  await updateLocation(r.id, patch);
                  toast.success('Saved');
                  setEditing(null);
                  onChanged();
                } catch (e) { toast.error(errMsg(e)); }
              }}
            />
          : <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <Td><code style={{ color: 'var(--ac)', fontFamily: 'var(--ff-mono)' }}>{r.code}</code></Td>
              <Td><span style={{ fontWeight: 600 }}>{r.name}</span></Td>
              <Td><span style={{ color: 'var(--mt)', textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.4 }}>{r.kind.replace('_', ' ')}</span></Td>
              <Td><span style={{ color: 'var(--mt)', fontSize: 11 }}>{r.entity}</span></Td>
              <Td><span style={{ color: 'var(--mt)' }}>
                {[r.city, r.state].filter(Boolean).join(', ') || '—'}
              </span></Td>
              <Td>
                <span style={{
                  fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5,
                  color: r.is_active ? 'var(--gn)' : 'var(--mt)',
                }}>
                  {r.is_active ? 'ACTIVE' : 'INACTIVE'}
                </span>
              </Td>
              {editable && <Td>
                <button onClick={() => setEditing(r.id)} style={btnSecondary()}>Edit</button>
              </Td>}
            </tr>
        )}
      </tbody>
    </table>
  );
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <th style={{
    textAlign: 'left', padding: '8px 10px',
    fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)',
    ...style,
  }}>{children}</th>;
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: '7px 10px', verticalAlign: 'middle', ...style }}>{children}</td>;
}

function NewLocationForm({ onCancel, onSave }: {
  onCancel: () => void;
  onSave: (loc: NewLocation) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<NewLocation>({
    code: '', name: '', kind: 'warehouse', entity: 'shared', is_active: true,
  });

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 10 }}>
        New Location
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <LField label="Code">
          <input style={inp()} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
            placeholder="ALA-YARD" />
        </LField>
        <LField label="Name">
          <input style={inp()} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Alameda Yard" />
        </LField>
        <LField label="Kind">
          <select style={inp()} value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as LocationKind })}>
            {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </LField>
        <LField label="Entity">
          <select style={inp()} value={draft.entity}
            onChange={(e) => setDraft({ ...draft, entity: e.target.value as LocationEntity })}>
            {ENTITY_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </LField>
        <LField label="City">
          <input style={inp()} value={draft.city ?? ''}
            onChange={(e) => setDraft({ ...draft, city: e.target.value || null })} />
        </LField>
        <LField label="State">
          <input style={inp()} value={draft.state ?? ''} maxLength={2}
            onChange={(e) => setDraft({ ...draft, state: e.target.value.toUpperCase() || null })} />
        </LField>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button onClick={onCancel} style={btnSecondary()}>Cancel</button>
        <button
          disabled={!draft.code.trim() || !draft.name.trim()}
          onClick={() => onSave(draft)}
          style={btnPrimary()}
        >Create</button>
      </div>
    </div>
  );
}

function EditLocationRow({ row, onCancel, onSave }: {
  row: InventoryLocation;
  onCancel: () => void;
  onSave: (patch: Partial<InventoryLocation>) => void | Promise<void>;
}) {
  const [name, setName] = useState(row.name);
  const [kind, setKind] = useState<LocationKind>(row.kind);
  const [entity, setEntity] = useState<LocationEntity>(row.entity);
  const [city, setCity] = useState(row.city ?? '');
  const [state, setState] = useState(row.state ?? '');
  const [active, setActive] = useState(row.is_active);

  return (
    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(91,181,240,0.04)' }}>
      <Td><code style={{ color: 'var(--mt)', fontFamily: 'var(--ff-mono)' }}>{row.code}</code></Td>
      <Td><input style={inp()} value={name} onChange={(e) => setName(e.target.value)} /></Td>
      <Td>
        <select style={inp()} value={kind} onChange={(e) => setKind(e.target.value as LocationKind)}>
          {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </Td>
      <Td>
        <select style={inp()} value={entity} onChange={(e) => setEntity(e.target.value as LocationEntity)}>
          {ENTITY_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </Td>
      <Td>
        <div style={{ display: 'flex', gap: 4 }}>
          <input style={{ ...inp(), width: 90 }} value={city} placeholder="City"
            onChange={(e) => setCity(e.target.value)} />
          <input style={{ ...inp(), width: 40 }} value={state} maxLength={2} placeholder="ST"
            onChange={(e) => setState(e.target.value.toUpperCase())} />
        </div>
      </Td>
      <Td>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}
            style={{ accentColor: 'var(--ac)' }} />
          <span style={{ fontSize: 10, color: 'var(--mt)' }}>Active</span>
        </label>
      </Td>
      <Td>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={onCancel} style={btnSecondary()}>Cancel</button>
          <button onClick={() => onSave({
            name, kind, entity,
            city: city || null, state: state || null,
            is_active: active,
          })} style={btnPrimary()}>Save</button>
        </div>
      </Td>
    </tr>
  );
}

function LField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}
