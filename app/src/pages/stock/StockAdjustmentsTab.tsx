import { useEffect, useMemo, useState } from 'react';
import { Plus, Minus } from 'lucide-react';
import {
  AdjustmentDirection,
  InventoryLocation,
  InventoryMovement,
  recordAdjustment,
} from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import type { ItemLookup } from './StockPage';
import { fetchProductionItems } from '../../lib/rawMaterials';

interface Props {
  locations: InventoryLocation[];
  itemLookup: ItemLookup;
  movements: InventoryMovement[] | null;
  locationById: Map<string, InventoryLocation>;
  onChanged: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function StockAdjustmentsTab({
  locations, itemLookup, movements, locationById, onChanged,
}: Props) {
  const toast = useToast();

  const physicalLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );

  const [direction, setDirection] = useState<AdjustmentDirection>('add');
  const [locationId, setLocationId] = useState('');
  const [qboItemId, setQboItemId] = useState('');
  const [qty, setQty] = useState<string>('');
  const [unitCost, setUnitCost] = useState<string>('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // Raw materials (cans, gallons, Velcorin, dunnage) are `excluded` from every
  // inventory lane, so the lane picker cannot see them — but they are exactly
  // what sits at a co-packer. At a co-packer location the purchased-item master
  // is offered as well.
  const selectedLoc = locationId ? locationById.get(locationId) : null;
  const atCopacker = selectedLoc?.kind === 'co_packer';
  const [rawItems, setRawItems] = useState<{ id: string; label: string }[] | null>(null);
  useEffect(() => {
    if (!atCopacker || rawItems !== null) return;
    fetchProductionItems()
      .then((r) => setRawItems(r.filter((x) => x.active && x.qbo_type !== 'Service').map((x) => ({ id: x.qbo_item_id, label: x.item_name + ' · raw material' }))))
      .catch(() => setRawItems([]));
  }, [atCopacker, rawItems]);
  const itemOptions = useMemo(() => {
    if (!atCopacker || !rawItems) return itemLookup.options;
    const seen = new Set(itemLookup.options.map((o) => o.id));
    return [...itemLookup.options, ...rawItems.filter((o) => !seen.has(o.id))].sort((a, b) => a.label.localeCompare(b.label));
  }, [atCopacker, rawItems, itemLookup.options]);

  const canSubmit =
    !!locationId && !!qboItemId && Number(qty) > 0 && reason.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await recordAdjustment({
        location_id: locationId,
        qbo_item_id: qboItemId,
        qty: Number(qty),
        direction,
        reason: reason.trim(),
        unit_cost: unitCost === '' ? null : Number(unitCost),
      });
      toast.success(direction === 'add' ? 'Stock added' : 'Stock removed');
      setQty('');
      setUnitCost('');
      setReason('');
      onChanged();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  const recentAdjustments = useMemo(
    () => (movements ?? []).filter((m) => m.movement_type === 'adjustment').slice(0, 20),
    [movements],
  );

  return (
    <div>
      <div className="cd" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 12 }}>
          Record adjustment
        </div>

        {/* Direction toggle */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 14, border: '1px solid var(--bd)', borderRadius: 4, overflow: 'hidden', width: 'fit-content' }}>
          <DirectionButton
            active={direction === 'add'}
            onClick={() => setDirection('add')}
            icon={<Plus size={13} />}
            label="Add stock"
            hint="Opening balance, receipt, found inventory"
            color="var(--gn)"
          />
          <DirectionButton
            active={direction === 'remove'}
            onClick={() => setDirection('remove')}
            icon={<Minus size={13} />}
            label="Remove stock"
            hint="Shrinkage, write-off, count variance"
            color="var(--rd)"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <LField label="Location">
            <select style={inp()} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">—</option>
              {physicalLocs.map((l) => (
                <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
              ))}
            </select>
          </LField>
          <LField label="Item">
            <select style={inp()} value={qboItemId} onChange={(e) => setQboItemId(e.target.value)}>
              <option value="">— Select item —</option>
              {itemOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </LField>
          <LField label="Quantity">
            <input type="number" min={0.0001} step="any" style={inp()}
              value={qty} onChange={(e) => setQty(e.target.value)} />
          </LField>
          <LField label={direction === 'add' ? 'Unit cost (optional)' : 'Unit cost (optional)'}>
            <input type="number" min={0} step="any" style={inp()}
              value={unitCost} onChange={(e) => setUnitCost(e.target.value)}
              placeholder="0.00" />
          </LField>
        </div>

        <div style={{ marginTop: 12 }}>
          <LField label="Reason">
            <input style={{ ...inp(), width: '100%' }}
              value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={direction === 'add'
                ? 'e.g. Opening balance May 2026 / Vendor receipt PO-1234 / Found in back room'
                : 'e.g. Damaged in transit / Counted short / Wrote off expired'}
            />
          </LField>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={submit} disabled={!canSubmit || saving} style={btnPrimary()}>
            {saving ? 'Saving…' : (direction === 'add' ? 'Add stock' : 'Remove stock')}
          </button>
        </div>

        {itemLookup.options.length === 0 && (
          <div style={{
            marginTop: 12, padding: 10,
            background: 'rgba(239, 191, 65, 0.08)',
            border: '1px solid rgba(239, 191, 65, 0.30)',
            borderRadius: 4, fontSize: 11, color: 'var(--am)',
          }}>
            No items are flagged for location tracking. Toggle <strong>Stock</strong> on items in{' '}
            <strong>Settings → Items (master)</strong> to make them available here.
          </div>
        )}
      </div>

      <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
        Recent adjustments
      </div>
      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th>When</Th>
              <Th>Direction</Th>
              <Th>Item</Th>
              <Th style={{ textAlign: 'right' }}>Qty</Th>
              <Th>Location</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody>
            {recentAdjustments.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 14, textAlign: 'center', color: 'var(--mt)' }}>
                No adjustments yet.
              </td></tr>
            )}
            {recentAdjustments.map((m) => {
              const it = itemLookup.byId.get(m.qbo_item_id);
              const itemName = it?.item_name ?? m.qbo_item_id;
              const fromLoc = m.from_location_id ? locationById.get(m.from_location_id) : null;
              const toLoc   = m.to_location_id   ? locationById.get(m.to_location_id)   : null;
              const isAdd = toLoc?.code !== 'ADJUSTMENT';   // ADJUSTMENT -> real_loc means add
              const realLoc = isAdd ? toLoc : fromLoc;
              return (
                <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <Td><span style={{ color: 'var(--mt)' }}>{new Date(m.occurred_at).toLocaleString()}</span></Td>
                  <Td>
                    <span style={{
                      fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5,
                      color: isAdd ? 'var(--gn)' : 'var(--rd)',
                    }}>
                      {isAdd ? '+ ADD' : '− REMOVE'}
                    </span>
                  </Td>
                  <Td><span style={{ fontWeight: 600 }}>{itemName}</span></Td>
                  <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(m.qty))}</Td>
                  <Td>
                    <span style={{ color: 'var(--mt)', fontFamily: 'var(--ff-mono)', fontSize: 11, marginRight: 6 }}>
                      {realLoc?.code ?? '?'}
                    </span>
                    {realLoc?.name ?? ''}
                  </Td>
                  <Td><span style={{ color: 'var(--mt)' }}>{m.notes ?? '—'}</span></Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DirectionButton({ active, onClick, icon, label, hint, color }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      title={hint}
      style={{
        background: active ? color : 'transparent',
        color: active ? 'var(--bg)' : 'var(--tx)',
        border: 'none',
        padding: '8px 16px',
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: active ? 700 : 500,
        letterSpacing: 0.5,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        textTransform: 'uppercase',
      }}
    >
      {icon}
      {label}
    </button>
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
