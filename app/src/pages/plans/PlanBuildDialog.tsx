import { useEffect, useMemo, useState } from 'react';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fm, fp } from '../../lib/formatters';
import {
  PlanHistoryForItemRow,
  QboItemWithCategory,
  buildPlanFromGrowth,
  fetchItemsWithCategory,
  fetchPlanHistoryForItems,
} from '../../lib/plans';

interface Props {
  planId: string;
  planFiscalYear: number;
  onClose: () => void;
  onApplied: () => void;
}

interface ItemRow {
  qbo_item_id: string;
  item_name: string;
  category_path: string;
  ly_annual_qty: number;
  ly_annual_revenue: number;
  ly_avg_unit_price: number | null;
  ly_customer_count: number;
  qty_pct: number;
  price_pct: number;
  include: boolean;
}

type ScopeMode = 'all' | 'category';

const PRESETS = [
  { id: 'flat', label: 'Flat', qty: 0, price: 0 },
  { id: 'modest', label: 'Modest', qty: 5, price: 0 },
  { id: 'price', label: 'Price Lift', qty: 0, price: 3 },
  { id: 'stretch', label: 'Stretch', qty: 10, price: 3 },
];

export function PlanBuildDialog({ planId, planFiscalYear, onClose, onApplied }: Props) {
  const [sourceYear, setSourceYear] = useState<number>(planFiscalYear - 1);
  const [qtyPct, setQtyPct] = useState<number>(0);
  const [pricePct, setPricePct] = useState<number>(0);
  const [presetId, setPresetId] = useState<string>('flat');
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [category, setCategory] = useState<string>('');
  const [allItems, setAllItems] = useState<QboItemWithCategory[] | null>(null);
  const [rows, setRows] = useState<ItemRow[] | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchItemsWithCategory().then(setAllItems).catch((e: Error) => setErr(e.message));
  }, []);

  const categories: { value: string; label: string; itemCount: number }[] = useMemo(() => {
    if (!allItems) return [];
    const counts = new Map<string, number>();
    for (const it of allItems) {
      if (it.type === 'Category') continue;
      const key = it.category_path || '(no category)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([value, itemCount]) => ({ value, label: value, itemCount }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allItems]);

  const scopeItems = useMemo(() => {
    if (!allItems) return [];
    return allItems.filter((it) => {
      if (it.type === 'Category') return false;
      if (scopeMode === 'all') return true;
      return (it.category_path || '(no category)') === category;
    });
  }, [allItems, category, scopeMode]);

  useEffect(() => {
    if (!allItems) return;
    if (scopeMode === 'category' && !category) {
      setRows(null);
      return;
    }
    loadRows(scopeItems);
  }, [allItems, category, scopeMode, sourceYear]);

  function loadRows(items: QboItemWithCategory[]) {
    if (items.length === 0) {
      setRows([]);
      return;
    }

    setLoadingRows(true);
    setErr(null);
    fetchPlanHistoryForItems(items.map((i) => i.qbo_item_id), sourceYear)
      .then((hist) => {
        const byId = new Map<string, PlanHistoryForItemRow>(hist.map((h) => [h.qbo_item_id, h]));
        const out: ItemRow[] = items
          .map((it) => {
            const h = byId.get(it.qbo_item_id);
            const lyQty = Number(h?.ly_annual_qty ?? 0);
            const lyRevenue = Number(h?.ly_annual_revenue ?? 0);
            const hasHistory = lyQty > 0 || lyRevenue > 0;
            return {
              qbo_item_id: it.qbo_item_id,
              item_name: it.name || it.fully_qualified_name || it.qbo_item_id,
              category_path: it.category_path || '(no category)',
              ly_annual_qty: lyQty,
              ly_annual_revenue: lyRevenue,
              ly_avg_unit_price: h?.ly_avg_unit_price != null ? Number(h.ly_avg_unit_price) : null,
              ly_customer_count: Number(h?.ly_customer_count ?? 0),
              qty_pct: qtyPct,
              price_pct: pricePct,
              include: hasHistory,
            };
          })
          .filter((r) => scopeMode === 'category' || r.include)
          .sort((a, b) => b.ly_annual_revenue - a.ly_annual_revenue);
        setRows(out);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoadingRows(false));
  }

  function setGrowth(nextQty: number, nextPrice: number, nextPresetId = 'custom') {
    setQtyPct(nextQty);
    setPricePct(nextPrice);
    setPresetId(nextPresetId);
    setRows((current) => current?.map((r) => ({ ...r, qty_pct: nextQty, price_pct: nextPrice })) ?? current);
  }

  function updateRow(id: string, patch: Partial<ItemRow>) {
    setPresetId('custom');
    setRows((current) => current?.map((r) => (r.qbo_item_id === id ? { ...r, ...patch } : r)) ?? current);
  }

  const selectedRows = useMemo(
    () => (rows ?? []).filter((r) => r.include && (r.ly_annual_qty > 0 || r.ly_annual_revenue > 0)),
    [rows],
  );

  const totals = useMemo(() => {
    let lyQty = 0;
    let lyRev = 0;
    let planQty = 0;
    let planRev = 0;
    let customers = 0;
    for (const r of selectedRows) {
      lyQty += r.ly_annual_qty;
      lyRev += r.ly_annual_revenue;
      customers += r.ly_customer_count;
      const projected = projectionFor(r);
      planQty += projected.qty;
      planRev += projected.revenue;
    }
    return {
      lyQty,
      lyRev,
      planQty,
      planRev,
      customers,
      deltaPct: lyRev > 0 ? (planRev - lyRev) / lyRev : null,
    };
  }, [selectedRows]);

  const previewRows = selectedRows.slice(0, 8);
  const canApply = selectedRows.length > 0 && !loadingRows && !applying;

  async function apply() {
    if (!canApply) return;
    if (!confirm(`Build FY${planFiscalYear} from ${sourceYear} history for ${selectedRows.length} item${selectedRows.length === 1 ? '' : 's'}? Existing customer lines for those items will be refreshed.`)) return;

    setApplying(true);
    setErr(null);
    try {
      const groups = new Map<string, { qty_pct: number; price_pct: number; item_ids: string[] }>();
      for (const r of selectedRows) {
        const key = r.qty_pct.toFixed(4) + '|' + r.price_pct.toFixed(4);
        if (!groups.has(key)) groups.set(key, { qty_pct: r.qty_pct, price_pct: r.price_pct, item_ids: [] });
        groups.get(key)!.item_ids.push(r.qbo_item_id);
      }

      for (const g of groups.values()) {
        await buildPlanFromGrowth({
          plan_id: planId,
          item_ids: g.item_ids,
          qty_growth_pct: g.qty_pct,
          price_growth_pct: g.price_pct,
          source_year: sourceYear,
        });
      }

      onApplied();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div style={overlayStyle()} onClick={onClose}>
      <div style={panelStyle()} onClick={(e) => e.stopPropagation()}>
        <div style={headerRowStyle()}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Build Scenario</div>
            <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>
              FY{planFiscalYear} from {sourceYear} actuals
            </div>
          </div>
          <button onClick={onClose} style={btnSecondary()}>Close</button>
        </div>

        <div style={metricRowStyle()}>
          <Metric label="History revenue" value={loadingRows ? 'Loading' : fm(totals.lyRev)} />
          <Metric label="Planned revenue" value={loadingRows ? 'Loading' : fm(totals.planRev)} />
          <Metric
            label="Revenue change"
            value={loadingRows ? 'Loading' : fp(totals.deltaPct)}
            tone={totals.deltaPct == null ? 'muted' : totals.deltaPct >= 0 ? 'good' : 'bad'}
          />
          <Metric label="Items" value={loadingRows ? 'Loading' : String(selectedRows.length)} detail={`${scopeItems.length} in scope`} />
        </div>

        <div style={setupStyle()}>
          <div style={setupBlockStyle()}>
            <div style={lbl()}>Start With</div>
            <div style={controlLineStyle()}>
              <label style={ctrl()}>
                <span style={miniLbl()}>Source year</span>
                <input
                  type="number"
                  value={sourceYear}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setSourceYear(Number.isFinite(next) ? next : planFiscalYear - 1);
                  }}
                  style={{ ...inp(), width: 92 }}
                />
              </label>
              <label style={ctrl()}>
                <span style={miniLbl()}>Scope</span>
                <select
                  value={scopeMode}
                  onChange={(e) => setScopeMode(e.target.value as ScopeMode)}
                  style={{ ...inp(), width: 170 }}
                >
                  <option value="all">All selling items</option>
                  <option value="category">One category</option>
                </select>
              </label>
              {scopeMode === 'category' && (
                <label style={ctrl()}>
                  <span style={miniLbl()}>Category</span>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    style={{ ...inp(), width: 280 }}
                  >
                    <option value="">{allItems ? 'Pick category' : 'Loading items'}</option>
                    {categories.map((c) => (
                      <option key={c.value} value={c.value}>{c.label} ({c.itemCount})</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>

          <div style={setupBlockStyle()}>
            <div style={lbl()}>Growth</div>
            <div style={presetRowStyle()}>
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setGrowth(p.qty, p.price, p.id)}
                  style={presetButtonStyle(presetId === p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div style={controlLineStyle()}>
              <label style={ctrl()}>
                <span style={miniLbl()}>Qty growth</span>
                <input
                  type="number"
                  step={0.5}
                  value={qtyPct}
                  onChange={(e) => setGrowth(Number(e.target.value), pricePct)}
                  style={{ ...inp(), width: 88, textAlign: 'right' }}
                />
              </label>
              <label style={ctrl()}>
                <span style={miniLbl()}>Price growth</span>
                <input
                  type="number"
                  step={0.5}
                  value={pricePct}
                  onChange={(e) => setGrowth(qtyPct, Number(e.target.value))}
                  style={{ ...inp(), width: 88, textAlign: 'right' }}
                />
              </label>
              <button onClick={() => loadRows(scopeItems)} style={btnSecondary()} disabled={loadingRows || !allItems}>
                Refresh
              </button>
            </div>
          </div>
        </div>

        <div style={bodyToolbarStyle()}>
          <div>
            <div className="ct" style={{ margin: 0 }}>ITEMS</div>
            <div style={{ fontSize: 10, color: 'var(--mt)' }}>
              {loadingRows ? 'Loading history' : `${selectedRows.length} included · ${fm(totals.planRev)} planned`}
            </div>
          </div>
          <button onClick={() => setShowDetails(!showDetails)} style={btnSecondary()} disabled={!rows || rows.length === 0}>
            {showDetails ? 'Summary' : 'Item Detail'}
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', borderTop: '1px solid var(--bd)' }}>
          {!allItems ? (
            <div className="ld">Loading items...</div>
          ) : scopeMode === 'category' && !category ? (
            <div className="ld">Pick a category.</div>
          ) : loadingRows ? (
            <div className="ld">Loading {sourceYear} history...</div>
          ) : !rows || rows.length === 0 ? (
            <div className="ld">No source-year sales found for this scope.</div>
          ) : selectedRows.length === 0 ? (
            <div className="ld">No items selected.</div>
          ) : showDetails ? (
            <DetailTable rows={rows} onUpdate={updateRow} />
          ) : (
            <PreviewTable rows={previewRows} totalRows={selectedRows.length} />
          )}
        </div>

        {err && (
          <div style={{ padding: '8px 14px', color: 'var(--rd)', borderTop: '1px solid var(--bd)', fontSize: 11 }}>
            Error: {err}
          </div>
        )}

        <div style={footerRowStyle()}>
          <span style={{ fontSize: 10, color: 'var(--mt)' }}>
            {selectedRows.length} item{selectedRows.length === 1 ? '' : 's'} · {fm(totals.lyRev)} history · {fm(totals.planRev)} plan
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSecondary()} disabled={applying}>Cancel</button>
            <button onClick={apply} style={btnPrimary()} disabled={!canApply}>
              {applying ? 'Building...' : 'Build Scenario'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewTable({ rows, totalRows }: { rows: ItemRow[]; totalRows: number }) {
  return (
    <table style={{ width: '100%' }}>
      <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
        <tr>
          <th style={{ minWidth: 260 }}>Item</th>
          <th style={cellHeadR()}>Source Revenue</th>
          <th style={cellHeadR()}>Plan Revenue</th>
          <th style={cellHeadR()}>Change</th>
          <th style={cellHeadR()}>Customers</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const projected = projectionFor(r);
          const deltaPct = r.ly_annual_revenue > 0 ? (projected.revenue - r.ly_annual_revenue) / r.ly_annual_revenue : null;
          return (
            <tr key={r.qbo_item_id}>
              <td style={itemCellStyle()} title={r.item_name}>{r.item_name}</td>
              <td style={cellRight()}>{fm(r.ly_annual_revenue)}</td>
              <td style={{ ...cellRight(), color: 'var(--ac)', fontWeight: 700 }}>{fm(projected.revenue)}</td>
              <td style={{ ...cellRight(), color: deltaPct == null ? 'var(--mt)' : deltaPct >= 0 ? 'var(--gn)' : 'var(--rd)' }}>{fp(deltaPct)}</td>
              <td style={cellRight()}>{r.ly_customer_count}</td>
            </tr>
          );
        })}
        {totalRows > rows.length && (
          <tr>
            <td colSpan={5} style={{ padding: '8px 10px', color: 'var(--mt)', fontSize: 10 }}>
              +{totalRows - rows.length} more included
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function DetailTable({
  rows,
  onUpdate,
}: {
  rows: ItemRow[];
  onUpdate: (id: string, patch: Partial<ItemRow>) => void;
}) {
  return (
    <table style={{ width: '100%' }}>
      <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
        <tr>
          <th style={{ width: 44 }} />
          <th style={{ minWidth: 240 }}>Item</th>
          <th style={cellHeadR()}>Source Qty</th>
          <th style={cellHeadR()}>Source Price</th>
          <th style={cellHeadR()}>Source Revenue</th>
          <th style={cellHeadR()}>Qty %</th>
          <th style={cellHeadR()}>Price %</th>
          <th style={cellHeadR()}>Plan Qty</th>
          <th style={cellHeadR()}>Plan Price</th>
          <th style={cellHeadR()}>Plan Revenue</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const projected = projectionFor(r);
          return (
            <tr key={r.qbo_item_id} style={!r.include ? { opacity: 0.48 } : undefined}>
              <td style={{ textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={r.include}
                  onChange={(e) => onUpdate(r.qbo_item_id, { include: e.target.checked })}
                />
              </td>
              <td style={itemCellStyle()} title={r.item_name}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.item_name}</div>
                <div style={{ fontSize: 9, color: 'var(--mt)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.category_path}
                </div>
              </td>
              <td style={cellRight()}>{fmNum(r.ly_annual_qty)}</td>
              <td style={cellRight()}>{r.ly_avg_unit_price != null ? fm(r.ly_avg_unit_price) : '-'}</td>
              <td style={cellRight()}>{fm(r.ly_annual_revenue)}</td>
              <td style={cellRight()}>
                <input
                  type="number"
                  step={0.5}
                  value={r.qty_pct}
                  onChange={(e) => onUpdate(r.qbo_item_id, { qty_pct: Number(e.target.value) })}
                  style={{ ...inp(), width: 58, fontSize: 10, padding: '2px 4px', textAlign: 'right' }}
                />
              </td>
              <td style={cellRight()}>
                <input
                  type="number"
                  step={0.5}
                  value={r.price_pct}
                  onChange={(e) => onUpdate(r.qbo_item_id, { price_pct: Number(e.target.value) })}
                  style={{ ...inp(), width: 58, fontSize: 10, padding: '2px 4px', textAlign: 'right' }}
                />
              </td>
              <td style={cellRight()}>{fmNum(projected.qty)}</td>
              <td style={cellRight()}>{fm(projected.price)}</td>
              <td style={{ ...cellRight(), fontWeight: 700, color: 'var(--ac)' }}>{fm(projected.revenue)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = 'muted',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'muted' | 'good' | 'bad';
}) {
  const color = tone === 'good' ? 'var(--gn)' : tone === 'bad' ? 'var(--rd)' : 'var(--tx)';
  return (
    <div style={{ padding: '10px 14px', borderRight: '1px solid var(--bd)', minWidth: 0 }}>
      <div style={lbl()}>{label}</div>
      <div className="mn" style={{ marginTop: 4, color, fontSize: 15, fontWeight: 800, whiteSpace: 'nowrap' }}>
        {value}
        {detail && <span style={{ marginLeft: 6, color: 'var(--mt)', fontSize: 10, fontWeight: 600 }}>{detail}</span>}
      </div>
    </div>
  );
}

function projectionFor(r: ItemRow): { qty: number; price: number; revenue: number } {
  const qty = r.ly_annual_qty * (1 + r.qty_pct / 100);
  const price = (r.ly_avg_unit_price ?? 0) * (1 + r.price_pct / 100);
  return { qty, price, revenue: qty * price };
}

function fmNum(n: number): string {
  if (n == null || !isFinite(n)) return '0';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(n));
}

function overlayStyle(): React.CSSProperties {
  return {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    padding: '70px 20px 20px',
    overflowY: 'auto',
  };
}
function panelStyle(): React.CSSProperties {
  return {
    background: 'var(--bg)', border: '1px solid var(--bd)', borderRadius: 6,
    width: 'min(1120px, 98vw)', maxHeight: 'calc(100vh - 90px)', display: 'flex', flexDirection: 'column',
    boxShadow: '0 12px 60px rgba(0,0,0,0.4)',
  };
}
function headerRowStyle(): React.CSSProperties {
  return {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 16px', borderBottom: '1px solid var(--bd)',
  };
}
function metricRowStyle(): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))',
    borderBottom: '1px solid var(--bd)',
    background: 'rgba(255,255,255,0.018)',
  };
}
function setupStyle(): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 18,
    padding: '12px 16px',
    borderBottom: '1px solid var(--bd)',
  };
}
function setupBlockStyle(): React.CSSProperties {
  return { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 };
}
function controlLineStyle(): React.CSSProperties {
  return { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' };
}
function presetRowStyle(): React.CSSProperties {
  return { display: 'flex', gap: 6, flexWrap: 'wrap' };
}
function presetButtonStyle(active: boolean): React.CSSProperties {
  return {
    border: '1px solid var(--bd)',
    background: active ? 'rgba(91,181,240,0.18)' : 'var(--sf2)',
    color: active ? 'var(--ac)' : 'var(--tx2)',
    borderRadius: 4,
    padding: '5px 10px',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'pointer',
  };
}
function bodyToolbarStyle(): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '10px 14px',
  };
}
function footerRowStyle(): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 16px', borderTop: '1px solid var(--bd)',
  };
}
function ctrl(): React.CSSProperties {
  return { display: 'inline-flex', flexDirection: 'column', gap: 4 };
}
function lbl(): React.CSSProperties {
  return { fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 };
}
function miniLbl(): React.CSSProperties {
  return { fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.7 };
}
function cellHeadR(): React.CSSProperties {
  return { textAlign: 'right', fontSize: 9, color: 'var(--mt)' };
}
function cellRight(): React.CSSProperties {
  return { textAlign: 'right', fontSize: 10, padding: '4px 8px' };
}
function itemCellStyle(): React.CSSProperties {
  return {
    maxWidth: 280,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 11,
    padding: '5px 8px',
  };
}
