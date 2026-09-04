import { useEffect, useMemo, useState } from 'react';
import { SearchSelect } from '../../components/SearchSelect';
import { AlertTriangle, Package, RefreshCw } from 'lucide-react';
import { ProductionItem, fetchProductionItems, saveProductionItem } from '../../lib/rawMaterials';
import { QboVendor } from '../../lib/purchasing';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';

/**
 * Purchased items — what we buy, from whom, at what price.
 *
 * One row per stocked component the production system orders: the flavour
 * gallons, the printed cans, the tolling charge, Velcorin and dunnage. This is
 * the place a price or a supplier changes. It beats the QuickBooks purchase cost
 * (which cannot be managed from QuickBooks for this purpose and goes stale) and
 * is beaten only by an explicit override on a single BOM line.
 */

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function num(v: string): number | null {
  const t = v.trim(); if (!t) return null;
  const n = Number(t); return Number.isFinite(n) ? n : null;
}

interface Draft { qbo_vendor_id: string; unit_cost: string; cost_uom: string; cost_note: string; active: boolean }
function draftOf(r: ProductionItem): Draft {
  return {
    qbo_vendor_id: r.qbo_vendor_id ?? '',
    unit_cost: r.unit_cost == null ? '' : String(r.unit_cost),
    cost_uom: r.cost_uom ?? 'each',
    cost_note: r.cost_note ?? '',
    active: r.active,
  };
}
function dirty(a: Draft, b: Draft): boolean {
  return (Object.keys(a) as (keyof Draft)[]).some((k) => a[k] !== b[k]);
}
const money = (n: number | null) => n == null ? '—' : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 });

export function PurchasedItemsPanel({ vendors, onChanged }: {
  vendors: QboVendor[] | null;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ProductionItem[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const toast = useToast();

  function load() {
    setRows(null);
    fetchProductionItems()
      .then((r) => { setRows(r); setDrafts(Object.fromEntries(r.map((x) => [x.qbo_item_id, draftOf(x)]))); })
      .catch((e) => { toast.error(errMsg(e)); setRows([]); });
  }
  useEffect(load, []);

  const vendorOptions = useMemo(
    () => (vendors ?? []).slice().sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [vendors],
  );
  const vendorName = (id: string | null) => vendorOptions.find((v) => v.qbo_vendor_id === id)?.display_name ?? (id ? '#' + id : '—');

  // Group by vendor so the panel reads as "here is Quantum's order, here is
  // Calderoni's" -- the same grouping the purchase orders will take.
  const groups = useMemo(() => {
    const m = new Map<string, ProductionItem[]>();
    for (const r of rows ?? []) {
      const k = r.qbo_vendor_id ?? '';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()].sort((a, b) => vendorName(a[0]).localeCompare(vendorName(b[0])));
  }, [rows, vendorOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const list = rows ?? [];
    return {
      total: list.length,
      noVendor: list.filter((r) => !r.qbo_vendor_id).length,
      noCost: list.filter((r) => r.unit_cost == null).length,
      seeded: list.filter((r) => (r.cost_note ?? '').startsWith('seeded from QuickBooks')).length,
      inactiveQbo: list.filter((r) => r.qbo_active === false).length,
    };
  }, [rows]);

  async function save(r: ProductionItem) {
    const d = drafts[r.qbo_item_id];
    if (!d) return;
    setSaving(r.qbo_item_id);
    try {
      await saveProductionItem(r.qbo_item_id, {
        qbo_vendor_id: d.qbo_vendor_id || null,
        unit_cost: num(d.unit_cost),
        cost_uom: d.cost_uom.trim() || 'each',
        // A confirmed price stops carrying the "seeded" caveat unless the note was edited to say otherwise.
        cost_note: d.cost_note.startsWith('seeded from QuickBooks') && num(d.unit_cost) !== r.qbo_purchase_cost
          ? null : (d.cost_note.trim() || null),
        active: d.active,
      });
      toast.success(r.item_name + ' saved');
      load();
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(null); }
  }

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <div className="toolbar-row">
          <Package size={14} style={{ color: 'var(--ac)' }} />
          <strong style={{ fontSize: 12.5 }}>Purchased items &amp; vendors</strong>
          <span style={{ fontSize: 11, color: 'var(--mt)' }}>
            {stats.total} items · {groups.filter(([k]) => k).length} vendor{groups.filter(([k]) => k).length === 1 ? '' : 's'}
          </span>
          <div className="toolbar-spacer" />
          <button style={btnSecondary()} onClick={load}>
            <RefreshCw size={12} style={{ verticalAlign: -2, marginRight: 5 }} />Reload
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11.5, lineHeight: 1.65 }}>
          <strong>This is where a price or a supplier changes.</strong> Every work order prices its purchase
          orders from this table, and groups them by the vendor set here — so moving the cans from one
          supplier to another is one change, not seven. A BOM line can still override a single item for a
          single flavour; nothing else beats this. The QuickBooks purchase cost is shown alongside for
          comparison and is never written to.
          {stats.seeded > 0 && (
            <>
              {' '}
              <AlertTriangle size={12} style={{ verticalAlign: -2, margin: '0 4px 0 2px', color: 'var(--am)' }} />
              <b>{stats.seeded}</b> price{stats.seeded === 1 ? ' is' : 's are'} still the QuickBooks figure this table was
              seeded from — confirm against the vendor's current sheet and save to clear the flag.
            </>
          )}
          {stats.noVendor > 0 && (
            <> <b style={{ color: 'var(--am)' }}>{stats.noVendor}</b> {stats.noVendor === 1 ? 'item has' : 'items have'} no vendor and cannot be put on a purchase order.</>
          )}
        </div>
      </div>

      {rows === null ? (
        <div style={{ color: 'var(--mt)', fontSize: 12 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: 'var(--mt)', fontSize: 12 }}>No purchased items yet — they appear here once a BOM uses a stocked component.</div>
      ) : groups.map(([vendorId, items]) => (
        <div key={vendorId || 'none'} className="card" style={{ marginBottom: 10, padding: 0, overflow: 'hidden' }}>
          <div style={{
            padding: '8px 12px', borderBottom: '1px solid var(--bd)', display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(255,255,255,0.02)',
          }}>
            <strong style={{ fontSize: 12, color: vendorId ? 'var(--tx)' : 'var(--am)' }}>{vendorName(vendorId || null)}</strong>
            <span style={{ fontSize: 10.5, color: 'var(--mt)' }}>
              {items.length} item{items.length === 1 ? '' : 's'} · one purchase order per run
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse', minWidth: 980 }}>
              <thead>
                <tr style={{ fontSize: 9.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  <th style={{ textAlign: 'left', padding: '6px 10px' }}>Item</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', width: 230 }}>Buy from</th>
                  <th style={{ textAlign: 'right', padding: '6px 10px', width: 110 }}>Our price</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', width: 70 }}>per</th>
                  <th style={{ textAlign: 'right', padding: '6px 10px', width: 100 }}>QBO cost</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px' }}>Note</th>
                  <th style={{ textAlign: 'center', padding: '6px 10px', width: 60 }}>On</th>
                  <th style={{ padding: '6px 10px', width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const d = drafts[r.qbo_item_id] ?? draftOf(r);
                  const changed = dirty(d, draftOf(r));
                  const set = (patch: Partial<Draft>) => setDrafts((all) => ({ ...all, [r.qbo_item_id]: { ...d, ...patch } }));
                  const priceDiffers = r.unit_cost != null && r.qbo_purchase_cost != null && Math.abs(r.unit_cost - r.qbo_purchase_cost) > 0.00001;
                  return (
                    <tr key={r.qbo_item_id} style={{ borderTop: '1px solid var(--bd)', opacity: d.active ? 1 : 0.55 }}>
                      <td style={{ padding: '6px 10px' }}>
                        <div style={{ fontWeight: 600 }}>{r.item_name}</div>
                        <div style={{ fontSize: 10, color: 'var(--mt)' }}>
                          #{r.qbo_item_id} · {r.qbo_type ?? '?'} · on {r.bom_count} BOM{r.bom_count === 1 ? '' : 's'}
                          {r.qbo_active === false && <span style={{ color: 'var(--am)', marginLeft: 6 }}>inactive in QuickBooks</span>}
                          {r.qbo_type === 'Inventory' && <span style={{ color: 'var(--am)', marginLeft: 6 }}>inventory item — components should not be</span>}
                        </div>
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        <SearchSelect value={d.qbo_vendor_id} onChange={(id) => set({ qbo_vendor_id: id })} placeholder="choose a vendor…"
                          style={{ minWidth: 180, outline: d.qbo_vendor_id ? undefined : '1px solid var(--am)', borderRadius: 4 }}
                          options={vendorOptions.map((v) => ({ id: v.qbo_vendor_id, label: v.display_name }))} />
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        <input type="number" step="any" min={0} style={{ ...inp(), textAlign: 'right' }} value={d.unit_cost}
                          placeholder="—" onChange={(e) => set({ unit_cost: e.target.value })} />
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        <input style={inp()} value={d.cost_uom} onChange={(e) => set({ cost_uom: e.target.value })} />
                      </td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: priceDiffers ? 'var(--am)' : 'var(--mt)' }} className="mn"
                        title={priceDiffers ? 'QuickBooks carries a different purchase cost. Ours is what the PO uses.' : ''}>
                        {money(r.qbo_purchase_cost)}
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        <input style={inp()} value={d.cost_note} placeholder="e.g. Quantum sheet Aug 2026"
                          onChange={(e) => set({ cost_note: e.target.value })} />
                      </td>
                      <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                        <input type="checkbox" checked={d.active} onChange={(e) => set({ active: e.target.checked })} />
                      </td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                        <button style={{ ...btnPrimary(), opacity: changed ? 1 : 0.4 }} disabled={!changed || saving === r.qbo_item_id}
                          onClick={() => save(r)}>
                          {saving === r.qbo_item_id ? 'Saving…' : 'Save'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
