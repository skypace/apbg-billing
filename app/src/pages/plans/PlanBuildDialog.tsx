// Bottom-up build dialog: pick a category (QBO item parent), see every item in
// that category with last year's qty / revenue / avg unit price, set per-item
// qty growth % and price growth %, and Apply — writes plan lines via
// fn_plan_build_from_growth (one call per unique (qty%, price%) pair).

import { useEffect, useMemo, useState } from 'react';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fm } from '../../lib/formatters';
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
}

export function PlanBuildDialog({ planId, planFiscalYear, onClose, onApplied }: Props) {
  const [sourceYear, setSourceYear] = useState<number>(planFiscalYear - 1);
  const [defaultQtyPct, setDefaultQtyPct]     = useState<number>(0);
  const [defaultPricePct, setDefaultPricePct] = useState<number>(0);
  const [allItems, setAllItems] = useState<QboItemWithCategory[] | null>(null);
  const [category, setCategory] = useState<string>('');
  const [rows, setRows] = useState<ItemRow[] | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchItemsWithCategory().then(setAllItems).catch((e: Error) => setErr(e.message));
  }, []);

  // Categories = distinct category_path among non-Category items
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

  function loadCategory(cat: string) {
    setCategory(cat);
    setRows(null);
    if (!cat || !allItems) return;
    const itemsInCat = allItems.filter(
      (it) => it.type !== 'Category' && (it.category_path || '(no category)') === cat,
    );
    if (itemsInCat.length === 0) { setRows([]); return; }
    setLoadingRows(true);
    fetchPlanHistoryForItems(itemsInCat.map((i) => i.qbo_item_id), sourceYear)
      .then((hist) => {
        const byId = new Map<string, PlanHistoryForItemRow>(hist.map((h) => [h.qbo_item_id, h]));
        const out: ItemRow[] = itemsInCat.map((it) => {
          const h = byId.get(it.qbo_item_id);
          return {
            qbo_item_id:        it.qbo_item_id,
            item_name:          it.fully_qualified_name || it.name,
            category_path:      cat,
            ly_annual_qty:      Number(h?.ly_annual_qty ?? 0),
            ly_annual_revenue:  Number(h?.ly_annual_revenue ?? 0),
            ly_avg_unit_price:  h?.ly_avg_unit_price != null ? Number(h.ly_avg_unit_price) : null,
            ly_customer_count:  Number(h?.ly_customer_count ?? 0),
            qty_pct:            defaultQtyPct,
            price_pct:          defaultPricePct,
          };
        });
        setRows(out);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoadingRows(false));
  }

  function applyDefaultsToAll() {
    if (!rows) return;
    setRows(rows.map((r) => ({ ...r, qty_pct: defaultQtyPct, price_pct: defaultPricePct })));
  }

  function updateRow(idx: number, patch: Partial<ItemRow>) {
    if (!rows) return;
    const next = rows.slice();
    next[idx] = { ...next[idx], ...patch };
    setRows(next);
  }

  async function apply() {
    if (!rows || rows.length === 0) return;
    if (!confirm(`Write ${rows.length} item${rows.length === 1 ? '' : 's'} into this plan? Existing lines for those items (any customer) will be overwritten.`)) return;
    setApplying(true); setErr(null);
    try {
      // Group items by (qty_pct, price_pct) so we can make one RPC call per unique combo
      const groups = new Map<string, { qty_pct: number; price_pct: number; item_ids: string[] }>();
      for (const r of rows) {
        const key = r.qty_pct.toFixed(4) + '|' + r.price_pct.toFixed(4);
        if (!groups.has(key)) groups.set(key, { qty_pct: r.qty_pct, price_pct: r.price_pct, item_ids: [] });
        groups.get(key)!.item_ids.push(r.qbo_item_id);
      }
      for (const g of groups.values()) {
        await buildPlanFromGrowth({
          plan_id:          planId,
          item_ids:         g.item_ids,
          qty_growth_pct:   g.qty_pct,
          price_growth_pct: g.price_pct,
          source_year:      sourceYear,
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

  // Computed totals
  const totals = useMemo(() => {
    if (!rows) return { ly_qty: 0, ly_rev: 0, plan_qty: 0, plan_rev: 0 };
    let ly_qty = 0, ly_rev = 0, plan_qty = 0, plan_rev = 0;
    for (const r of rows) {
      ly_qty  += r.ly_annual_qty;
      ly_rev  += r.ly_annual_revenue;
      const pq = r.ly_annual_qty * (1 + r.qty_pct / 100);
      const pp = (r.ly_avg_unit_price ?? 0) * (1 + r.price_pct / 100);
      plan_qty += pq;
      plan_rev += pq * pp;
    }
    return { ly_qty, ly_rev, plan_qty, plan_rev };
  }, [rows]);

  return (
    <div style={overlayStyle()} onClick={onClose}>
      <div style={panelStyle()} onClick={(e) => e.stopPropagation()}>
        <div style={headerRowStyle()}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Build plan from history × growth</div>
          <button onClick={onClose} style={btnSecondary()}>Close</button>
        </div>

        <div style={controlsRowStyle()}>
          <label style={ctrl()}>
            <span style={lbl()}>Source year</span>
            <input
              type="number"
              value={sourceYear}
              onChange={(e) => { setSourceYear(Number(e.target.value)); }}
              onBlur={() => { if (category) loadCategory(category); }}
              style={{ ...inp(), width: 80 }}
            />
          </label>
          <label style={ctrl()}>
            <span style={lbl()}>Category</span>
            <select
              value={category}
              onChange={(e) => loadCategory(e.target.value)}
              style={{ ...inp(), minWidth: 280 }}
            >
              <option value="">{allItems ? '-- pick a category --' : 'loading items…'}</option>
              {categories.map((c) => (
                <option key={c.value} value={c.value}>{c.label} ({c.itemCount})</option>
              ))}
            </select>
          </label>
          <label style={ctrl()}>
            <span style={lbl()}>Default qty %</span>
            <input
              type="number" step={0.5}
              value={defaultQtyPct}
              onChange={(e) => setDefaultQtyPct(Number(e.target.value))}
              style={{ ...inp(), width: 70 }}
            />
          </label>
          <label style={ctrl()}>
            <span style={lbl()}>Default price %</span>
            <input
              type="number" step={0.5}
              value={defaultPricePct}
              onChange={(e) => setDefaultPricePct(Number(e.target.value))}
              style={{ ...inp(), width: 70 }}
            />
          </label>
          <button
            onClick={applyDefaultsToAll}
            disabled={!rows || rows.length === 0}
            style={btnSecondary()}
          >
            Apply defaults to all
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', borderTop: '1px solid var(--bd)' }}>
          {!category ? (
            <div className="ld">Pick a category to load its items with last year's qty and revenue.</div>
          ) : loadingRows ? (
            <div className="ld">Loading {sourceYear} history…</div>
          ) : !rows || rows.length === 0 ? (
            <div className="ld">No items in this category.</div>
          ) : (
            <table style={{ width: '100%' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th style={{ minWidth: 200 }}>Item</th>
                  <th style={cellHeadR()}>LY Qty</th>
                  <th style={cellHeadR()}>LY Avg Price</th>
                  <th style={cellHeadR()}>LY Revenue</th>
                  <th style={cellHeadR()}>Cust</th>
                  <th style={cellHeadR()}>Qty %</th>
                  <th style={cellHeadR()}>Price %</th>
                  <th style={cellHeadR()}>Plan Qty</th>
                  <th style={cellHeadR()}>Plan Price</th>
                  <th style={cellHeadR()}>Plan Revenue</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const planQty   = r.ly_annual_qty * (1 + r.qty_pct / 100);
                  const planPrice = (r.ly_avg_unit_price ?? 0) * (1 + r.price_pct / 100);
                  const planRev   = planQty * planPrice;
                  const noHistory = r.ly_annual_revenue === 0;
                  return (
                    <tr key={r.qbo_item_id} style={noHistory ? { opacity: 0.5 } : undefined}>
                      <td style={{ fontSize: 11 }}>{r.item_name}</td>
                      <td style={cellRight()}>{fmNum(r.ly_annual_qty)}</td>
                      <td style={cellRight()}>{r.ly_avg_unit_price != null ? fm(r.ly_avg_unit_price) : '—'}</td>
                      <td style={cellRight()}>{fm(r.ly_annual_revenue)}</td>
                      <td style={cellRight()}>{r.ly_customer_count}</td>
                      <td style={cellRight()}>
                        <input
                          type="number" step={0.5}
                          value={r.qty_pct}
                          onChange={(e) => updateRow(i, { qty_pct: Number(e.target.value) })}
                          style={{ ...inp(), width: 56, fontSize: 10, padding: '2px 4px', textAlign: 'right' }}
                        />
                      </td>
                      <td style={cellRight()}>
                        <input
                          type="number" step={0.5}
                          value={r.price_pct}
                          onChange={(e) => updateRow(i, { price_pct: Number(e.target.value) })}
                          style={{ ...inp(), width: 56, fontSize: 10, padding: '2px 4px', textAlign: 'right' }}
                        />
                      </td>
                      <td style={cellRight()}>{fmNum(planQty)}</td>
                      <td style={cellRight()}>{fm(planPrice)}</td>
                      <td style={{ ...cellRight(), fontWeight: 600, color: 'var(--ac)' }}>{fm(planRev)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot style={{ position: 'sticky', bottom: 0, background: 'var(--sf2)' }}>
                <tr>
                  <td style={{ fontWeight: 700, padding: '6px 8px' }}>TOTAL ({rows.length} items)</td>
                  <td style={{ ...cellRight(), fontWeight: 700 }}>{fmNum(totals.ly_qty)}</td>
                  <td />
                  <td style={{ ...cellRight(), fontWeight: 700 }}>{fm(totals.ly_rev)}</td>
                  <td />
                  <td colSpan={3} />
                  <td style={{ ...cellRight(), fontWeight: 700 }}>{fmNum(totals.plan_qty)}</td>
                  <td style={{ ...cellRight(), fontWeight: 700, color: 'var(--ac)' }}>{fm(totals.plan_rev)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {err && (
          <div style={{ padding: '8px 14px', color: 'var(--rd)', borderTop: '1px solid var(--bd)', fontSize: 11 }}>
            Error: {err}
          </div>
        )}

        <div style={footerRowStyle()}>
          <span style={{ fontSize: 10, color: 'var(--mt)' }}>
            Applying writes plan lines for every (item × customer) combo present in {sourceYear} actuals.
            Existing lines for these items are overwritten with the new qty / price assumptions.
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSecondary()} disabled={applying}>Cancel</button>
            <button onClick={apply} style={btnPrimary()} disabled={applying || !rows || rows.length === 0}>
              {applying ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmNum(n: number): string {
  if (n == null || !isFinite(n)) return '0';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(n));
}

function overlayStyle(): React.CSSProperties {
  return {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    zIndex: 100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    padding: '90px 20px 20px',
    overflowY: 'auto',
  };
}
function panelStyle(): React.CSSProperties {
  return {
    background: 'var(--bg)', border: '1px solid var(--bd)', borderRadius: 6,
    width: 'min(1200px, 98vw)', maxHeight: 'calc(100vh - 110px)', display: 'flex', flexDirection: 'column',
    boxShadow: '0 12px 60px rgba(0,0,0,0.4)',
  };
}
function headerRowStyle(): React.CSSProperties {
  return {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 16px', borderBottom: '1px solid var(--bd)',
  };
}
function controlsRowStyle(): React.CSSProperties {
  return {
    display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap',
    padding: '12px 16px',
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
function cellHeadR(): React.CSSProperties {
  return { textAlign: 'right', fontSize: 9, color: 'var(--mt)' };
}
function cellRight(): React.CSSProperties {
  return { textAlign: 'right', fontSize: 10, padding: '4px 8px' };
}
