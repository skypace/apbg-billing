import { useEffect, useMemo, useState } from 'react';
import { Boxes, Plus, Trash2 } from 'lucide-react';
import {
  CopackerStockRow, ProductionItem, OpeningBalanceLine,
  fetchCopackerStock, fetchProductionItems, recordCopackerOpeningBalance,
} from '../../lib/rawMaterials';
import { InventoryLocationView, fetchLocations } from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';

/**
 * Raw materials at the co-packer — what is there, what the open work orders
 * will take, and the one-time form for the STARTING amounts.
 *
 * Every figure here is the append-only ledger (`ops.v_copacker_stock` over
 * inventory_movements). Opening stock posts one `adjustment` per item, refused
 * a second time: a wrong opening is corrected on Stock → Adjustments with its
 * own reason, not by entering another opening.
 */

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
const money = (n: number | null) => n == null ? '—' : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  return d < 1 ? 'today' : Math.round(d) + 'd ago';
};

interface DraftLine { key: number; qbo_item_id: string; qty: string; unit_cost: string }

export function CopackerStockPanel({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<CopackerStockRow[] | null>(null);
  const [locs, setLocs] = useState<InventoryLocationView[]>([]);
  const [items, setItems] = useState<ProductionItem[]>([]);
  const [locId, setLocId] = useState('');
  const [open, setOpen] = useState(false);
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ key: 1, qbo_item_id: '', qty: '', unit_cost: '' }]);
  const [saving, setSaving] = useState(false);

  function load() {
    fetchCopackerStock().then(setRows).catch((e) => { toast.error(errMsg(e)); setRows([]); });
  }
  useEffect(() => {
    load();
    fetchLocations().then((l) => {
      const cp = l.filter((x) => x.kind === 'co_packer' && x.is_active);
      setLocs(cp);
      setLocId((cur) => cur || cp[0]?.id || '');
    }).catch(() => undefined);
    fetchProductionItems().then((r) => setItems(r.filter((x) => x.active && x.qbo_type !== 'Service'))).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => (rows ?? []).filter((r) => !locId || r.location_id === locId)
    .filter((r) => r.on_hand !== 0 || r.open_demand !== 0 || r.min_order_qty != null || r.item_type !== 'Service'), [rows, locId]);
  const nonZero = visible.filter((r) => r.on_hand !== 0).length;
  const negative = visible.filter((r) => r.on_hand < 0);

  const validLines = lines.filter((l) => l.qbo_item_id && Number(l.qty) > 0);
  async function submit() {
    if (!locId || validLines.length === 0) return;
    setSaving(true);
    try {
      const payload: OpeningBalanceLine[] = validLines.map((l) => ({
        qbo_item_id: l.qbo_item_id, qty: Number(l.qty), unit_cost: l.unit_cost.trim() === '' ? null : Number(l.unit_cost),
      }));
      const res = await recordCopackerOpeningBalance(locId, payload, asOf ? asOf + 'T12:00:00Z' : null, note.trim() || null);
      if (res.done.length) toast.success(`Opening stock recorded at ${res.location}: ${res.done.length} item${res.done.length === 1 ? '' : 's'}`);
      for (const s of res.skipped) toast.error(`${s.item ?? s.qbo_item_id ?? 'line'}: ${s.reason}`);
      if (res.done.length) { setLines([{ key: Date.now(), qbo_item_id: '', qty: '', unit_cost: '' }]); setNote(''); setOpen(false); }
      load(); onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  const setLine = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => l.key === key ? { ...l, ...patch } : l));

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <Boxes size={14} style={{ color: 'var(--ac)' }} />
        <strong style={{ fontSize: 12.5 }}>Raw materials at the co-packer</strong>
        {locs.length > 1 && (
          <select style={{ ...inp(), width: 220 }} value={locId} onChange={(e) => setLocId(e.target.value)}>
            {locs.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        )}
        <span style={{ fontSize: 10.5, color: 'var(--mt)' }}>
          {rows === null ? 'loading…' : `${nonZero} item${nonZero === 1 ? '' : 's'} on hand`}
          {negative.length > 0 && <span style={{ color: 'var(--am)', marginLeft: 8 }}>{negative.length} negative — consumed before anything was landed; fix with an adjustment</span>}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btnSecondary()} onClick={() => setOpen((v) => !v)} disabled={!locId}>
          {open ? 'Hide opening stock' : 'Record opening stock…'}
        </button>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--mt)', lineHeight: 1.6, marginBottom: 8 }}>
        A run <strong>orders</strong> the vendor's minimum and <strong>uses</strong> what the batch needs; the difference sits here and
        the next run draws on it. Nothing on this table is typed in — it is the movement ledger. The starting amounts are entered
        once, below; anything after that is a receipt, a consumption, or a Stock → Adjustment with a reason on it.
      </div>

      {open && (
        <div className="card" style={{ padding: 12, marginBottom: 10, border: '1px solid var(--bd)' }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
            Opening stock at {locs.find((l) => l.id === locId)?.code ?? '—'} · one entry per item, ever
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, marginBottom: 10 }}>
            <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>As of<br />
              <input type="date" style={{ ...inp(), width: '100%' }} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
            <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Note (where the count came from)<br />
              <input style={{ ...inp(), width: '100%' }} value={note} placeholder="e.g. Quantum inventory sheet 2026-09-01" onChange={(e) => setNote(e.target.value)} /></label>
          </div>
          <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--mt)', fontSize: 10, textTransform: 'uppercase' }}>
                <th style={{ padding: '4px 6px' }}>Item</th>
                <th style={{ padding: '4px 6px', width: 130 }}>Quantity</th>
                <th style={{ padding: '4px 6px', width: 130 }}>Unit cost (optional)</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td style={{ padding: '3px 6px' }}>
                    <select style={{ ...inp(), width: '100%' }} value={l.qbo_item_id} onChange={(e) => setLine(l.key, { qbo_item_id: e.target.value })}>
                      <option value="">— item —</option>
                      {items.map((i) => <option key={i.qbo_item_id} value={i.qbo_item_id}>{i.item_name}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '3px 6px' }}>
                    <input type="number" min={0} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }} value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                  </td>
                  <td style={{ padding: '3px 6px' }}>
                    <input type="number" min={0} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }} value={l.unit_cost} placeholder="—" onChange={(e) => setLine(l.key, { unit_cost: e.target.value })} />
                  </td>
                  <td style={{ padding: '3px 6px' }}>
                    <button type="button" title="Remove line" style={{ ...btnSecondary(), padding: '2px 6px' }} disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 size={11} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button type="button" style={btnSecondary()} onClick={() => setLines((ls) => [...ls, { key: Date.now(), qbo_item_id: '', qty: '', unit_cost: '' }])}>
              <Plus size={11} style={{ verticalAlign: -1 }} /> Add item
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" style={btnPrimary()} disabled={saving || !locId || validLines.length === 0} onClick={submit}>
              {saving ? 'Recording…' : `Record ${validLines.length} opening balance${validLines.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--mt)', fontSize: 10, textTransform: 'uppercase', background: 'var(--sf)' }}>
              <th style={{ padding: '6px 10px' }}>Item</th>
              <th style={{ padding: '6px 10px', textAlign: 'right' }} title="Ledger balance at this location">On hand</th>
              <th style={{ padding: '6px 10px', textAlign: 'right' }} title="What the work orders not yet in production will use">Open demand</th>
              <th style={{ padding: '6px 10px', textAlign: 'right' }} title="On hand less open demand — what the NEXT run can draw on">After runs</th>
              <th style={{ padding: '6px 10px', textAlign: 'right' }}>MOQ</th>
              <th style={{ padding: '6px 10px', textAlign: 'right' }}>Last cost</th>
              <th style={{ padding: '6px 10px' }}>Last moved</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && <tr><td colSpan={7} style={{ padding: 12, color: 'var(--mt)' }}>Loading…</td></tr>}
            {rows !== null && visible.length === 0 && <tr><td colSpan={7} style={{ padding: 12, color: 'var(--mt)' }}>Nothing recorded at this co-packer yet — record the opening stock above.</td></tr>}
            {visible.map((r) => {
              const after = r.on_hand - r.open_demand;
              return (
                <tr key={r.location_id + r.qbo_item_id} style={{ borderTop: '1px solid var(--bd)', opacity: r.on_hand === 0 && r.open_demand === 0 ? 0.6 : 1 }}>
                  <td style={{ padding: '6px 10px' }}>
                    <div style={{ fontWeight: 600 }}>{r.item_name ?? r.qbo_item_id}</div>
                    <div style={{ fontSize: 10, color: 'var(--mt)' }}>#{r.qbo_item_id} · {r.item_type ?? '?'}</div>
                  </td>
                  <td className="mn" style={{ padding: '6px 10px', textAlign: 'right', color: r.on_hand < 0 ? 'var(--am)' : undefined }}>{fmtNum(r.on_hand)}</td>
                  <td className="mn" style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--mt)' }}>{r.open_demand ? fmtNum(r.open_demand) : '—'}</td>
                  <td className="mn" style={{ padding: '6px 10px', textAlign: 'right', color: after < 0 ? 'var(--am)' : 'var(--gn)' }}>{fmtNum(after)}</td>
                  <td className="mn" style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--mt)' }}>
                    {r.min_order_qty == null ? '—' : fmtNum(r.min_order_qty)}{r.order_multiple && r.order_multiple !== 1 ? ` ×${fmtNum(r.order_multiple)}` : ''}
                  </td>
                  <td className="mn" style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--mt)' }}>{money(r.last_unit_cost)}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--mt)' }}>{ago(r.last_movement_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
