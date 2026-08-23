import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { sbInsert } from '../../lib/rpc';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fm, fp } from '../../lib/formatters';
import {
  MONTHS_SHORT,
  PlanHistoryForItemRow,
  QboCustomerOption,
  QboItemWithCategory,
  SalesPlanLine,
  buildPlanFromGrowth,
  fetchCustomerOptions,
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

interface StoreProductRow {
  qbo_item_id: string;
  item_name: string;
  category_path: string;
  qbo_account_id: string | null;
  account_name: string | null;
  qty_per_store: number;
  unit_price: number;
  unit_cost: number;
}

type BuildMode = 'history' | 'stores';
type ScopeMode = 'all' | 'category';

const PRESETS = [
  { id: 'flat', label: 'Flat', qty: 0, price: 0 },
  { id: 'modest', label: 'Modest', qty: 5, price: 0 },
  { id: 'price', label: 'Price Lift', qty: 0, price: 3 },
  { id: 'stretch', label: 'Stretch', qty: 10, price: 3 },
];

export function PlanBuildDialog({ planId, planFiscalYear, onClose, onApplied }: Props) {
  const [mode, setMode] = useState<BuildMode>('history');
  const [sourceYear, setSourceYear] = useState<number>(planFiscalYear - 1);
  const [qtyPct, setQtyPct] = useState<number>(0);
  const [pricePct, setPricePct] = useState<number>(0);
  const [presetId, setPresetId] = useState<string>('flat');
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [category, setCategory] = useState<string>('');
  const [allItems, setAllItems] = useState<QboItemWithCategory[] | null>(null);
  const [customers, setCustomers] = useState<QboCustomerOption[] | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [storeCustomerId, setStoreCustomerId] = useState('');
  const [storeCount, setStoreCount] = useState<number>(3);
  const [storeStartMonth, setStoreStartMonth] = useState<number>(1);
  const [storeDuration, setStoreDuration] = useState<number>(12);
  const [storeItemSearch, setStoreItemSearch] = useState('');
  const [storeProductId, setStoreProductId] = useState('');
  const [storeRows, setStoreRows] = useState<StoreProductRow[]>([]);
  const [quickStoreText, setQuickStoreText] = useState('');
  const [quickStoreStatus, setQuickStoreStatus] = useState<string | null>(null);
  const [loadingStorePrice, setLoadingStorePrice] = useState(false);
  const [rows, setRows] = useState<ItemRow[] | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchItemsWithCategory().then(setAllItems).catch((e: Error) => setErr(e.message));
  }, []);

  useEffect(() => {
    fetchCustomerOptions().then(setCustomers).catch((e: Error) => setErr(e.message));
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

  const storeProductOptions = useMemo(() => {
    if (!allItems) return [];
    const selected = new Set(storeRows.map((r) => r.qbo_item_id));
    const search = storeItemSearch.trim().toLowerCase();
    return allItems
      .filter((it) => it.type !== 'Category' && !selected.has(it.qbo_item_id))
      .filter((it) => {
        if (!search) return true;
        const label = [it.name, it.fully_qualified_name, it.category_path].filter(Boolean).join(' ').toLowerCase();
        return label.includes(search);
      })
      .slice(0, 150);
  }, [allItems, storeItemSearch, storeRows]);

  const visibleCustomers = useMemo(() => {
    if (!customers) return [];
    const search = customerSearch.trim().toLowerCase();
    return customers
      .filter((c) => !search || c.display_name.toLowerCase().includes(search))
      .slice(0, 150);
  }, [customerSearch, customers]);

  const selectedStoreCustomer = useMemo(
    () => customers?.find((c) => c.qbo_customer_id === storeCustomerId) ?? null,
    [customers, storeCustomerId],
  );

  const storeCustomerOptions = useMemo(() => {
    if (!selectedStoreCustomer || visibleCustomers.some((c) => c.qbo_customer_id === selectedStoreCustomer.qbo_customer_id)) {
      return visibleCustomers;
    }
    return [selectedStoreCustomer, ...visibleCustomers];
  }, [selectedStoreCustomer, visibleCustomers]);

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

  async function addStoreProduct() {
    if (!allItems || !storeProductId) return;
    const item = allItems.find((it) => it.qbo_item_id === storeProductId);
    if (!item || storeRows.some((r) => r.qbo_item_id === item.qbo_item_id)) return;

    setLoadingStorePrice(true);
    try {
      const row = await storeProductRowFor(item, sourceYear);
      setStoreRows((current) => [...current, row]);
      setStoreProductId('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoadingStorePrice(false);
    }
  }

  function updateStoreRow(id: string, patch: Partial<StoreProductRow>) {
    setStoreRows((current) => current.map((r) => (r.qbo_item_id === id ? { ...r, ...patch } : r)));
  }

  function removeStoreRow(id: string) {
    setStoreRows((current) => current.filter((r) => r.qbo_item_id !== id));
  }

  async function applyQuickStoreSetup() {
    if (!allItems || !customers) {
      setQuickStoreStatus('Still loading workbook inputs.');
      return;
    }
    const parsed = parseStoreQuickEntry(quickStoreText);
    const matched: string[] = [];
    const missed: string[] = [];

    if (parsed.storeCount != null) {
      setStoreCount(parsed.storeCount);
      matched.push(`${parsed.storeCount} stores`);
    }
    if (parsed.startMonth != null) {
      setStoreStartMonth(parsed.startMonth);
      matched.push(MONTHS_SHORT[parsed.startMonth - 1]);
    }
    if (parsed.duration != null) {
      setStoreDuration(parsed.duration);
      matched.push(`${parsed.duration} months`);
    }
    if (parsed.customerTerm) {
      setCustomerSearch(parsed.customerTerm);
      const customer = bestCustomerMatch(customers, parsed.customerTerm);
      if (customer) {
        setStoreCustomerId(customer.qbo_customer_id);
        matched.push(customer.display_name);
      } else {
        missed.push(parsed.customerTerm);
      }
    }

    const selected = new Set(storeRows.map((r) => r.qbo_item_id));
    const productMatches: { term: string; item: QboItemWithCategory }[] = [];
    const unmatchedProducts: string[] = [];
    for (const term of parsed.productTerms) {
      const item = bestItemMatch(allItems, term, selected);
      if (item) {
        productMatches.push({ term, item });
        selected.add(item.qbo_item_id);
      } else {
        unmatchedProducts.push(term);
      }
    }

    if (productMatches.length > 0) {
      setLoadingStorePrice(true);
      try {
        const nextRows = await Promise.all(productMatches.map((m) => storeProductRowFor(m.item, sourceYear)));
        setStoreRows((current) => {
          const currentIds = new Set(current.map((r) => r.qbo_item_id));
          return [...current, ...nextRows.filter((r) => !currentIds.has(r.qbo_item_id))];
        });
        matched.push(`${productMatches.length} product${productMatches.length === 1 ? '' : 's'}`);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoadingStorePrice(false);
      }
    }

    missed.push(...unmatchedProducts);
    if (matched.length === 0 && missed.length === 0) {
      setQuickStoreStatus('No clear setup found.');
    } else if (missed.length > 0) {
      setQuickStoreStatus(`Matched ${matched.length || 0}; check ${missed.slice(0, 3).join(', ')}.`);
    } else {
      setQuickStoreStatus(`Matched ${matched.length}.`);
    }
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
  const validStoreRows = useMemo(
    () => storeRows.filter((r) => Number(r.qty_per_store) > 0 && Number(r.unit_price) > 0),
    [storeRows],
  );
  const storeTotals = useMemo(
    () => summarizeStoreRows(validStoreRows, storeCount, storeStartMonth, storeDuration),
    [storeCount, storeDuration, storeStartMonth, validStoreRows],
  );
  const canApplyStores = Boolean(selectedStoreCustomer)
    && validStoreRows.length > 0
    && Number(storeCount) > 0
    && Number(storeDuration) > 0
    && !applying;

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

  async function applyStoreRollout() {
    if (!canApplyStores || !selectedStoreCustomer) return;
    const rangeLabel = rolloutRangeLabel(storeStartMonth, storeDuration);
    const productWord = validStoreRows.length === 1 ? 'product' : 'products';
    const storeWord = Number(storeCount) === 1 ? 'store' : 'stores';
    if (!confirm(`Add ${validStoreRows.length} ${productWord} for ${Number(storeCount)} new ${storeWord} at ${selectedStoreCustomer.display_name}?`)) return;

    setApplying(true);
    setErr(null);
    try {
      await Promise.all(validStoreRows.map((row) => {
        const arrays = storeArraysFor(row, storeCount, storeStartMonth, storeDuration);
        return sbInsert<Partial<SalesPlanLine>>('sales_plan_lines', {
          plan_id: planId,
          line_type: 'item',
          qbo_item_id: row.qbo_item_id,
          item_name: row.item_name,
          qbo_customer_id: selectedStoreCustomer.qbo_customer_id,
          customer_name: selectedStoreCustomer.display_name,
          qbo_account_id: row.qbo_account_id,
          account_name: row.account_name,
          notes: `New store rollout: ${Number(storeCount)} ${storeWord}, ${rangeLabel}, ${Number(row.qty_per_store)} per store per month`,
          amounts: arrays.amounts,
          qty: arrays.qty,
          unit_price: arrays.unitPrice,
          unit_cost: arrays.unitCost,
        } as Partial<SalesPlanLine>);
      }));

      onApplied();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  function renderStoreRollout() {
    const rangeLabel = rolloutRangeLabel(storeStartMonth, storeDuration);
    return (
      <>
        <div style={metricRowStyle()}>
          <Metric
            label="Customer"
            value={selectedStoreCustomer ? 'Selected' : 'Pick customer'}
            detail={selectedStoreCustomer?.display_name}
          />
          <Metric label="Stores" value={String(Number(storeCount) || 0)} />
          <Metric label="Active months" value={rangeLabel} />
          <Metric label="Planned revenue" value={fm(storeTotals.revenue)} detail={`${fmNum(storeTotals.qty)} units`} />
        </div>

        <div style={quickSetupStyle()}>
          <label style={{ ...ctrl(), flex: '1 1 360px' }}>
            <span style={miniLbl()}>Quick Setup</span>
            <input
              value={quickStoreText}
              onChange={(e) => {
                setQuickStoreText(e.target.value);
                setQuickStoreStatus(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyQuickStoreSetup();
              }}
              placeholder="3 new stores for Customer X selling Product A, Product B over 6 months"
              style={{ ...inp(), width: '100%' }}
            />
          </label>
          <button
            onClick={applyQuickStoreSetup}
            style={btnSecondary()}
            disabled={!quickStoreText.trim() || !customers || !allItems || loadingStorePrice}
          >
            Fill
          </button>
          {quickStoreStatus && <span style={{ color: 'var(--mt)', fontSize: 10 }}>{quickStoreStatus}</span>}
        </div>

        <div style={setupStyle()}>
          <div style={setupBlockStyle()}>
            <div style={lbl()}>Customer</div>
            <div style={controlLineStyle()}>
              <label style={ctrl()}>
                <span style={miniLbl()}>Search</span>
                <input
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Customer name"
                  style={{ ...inp(), width: 220 }}
                />
              </label>
              <label style={ctrl()}>
                <span style={miniLbl()}>Customer</span>
                <select
                  value={storeCustomerId}
                  onChange={(e) => setStoreCustomerId(e.target.value)}
                  style={{ ...inp(), width: 280 }}
                >
                  <option value="">{customers ? 'Pick customer' : 'Loading customers'}</option>
                  {storeCustomerOptions.map((c) => (
                    <option key={c.qbo_customer_id} value={c.qbo_customer_id}>{c.display_name}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div style={setupBlockStyle()}>
            <div style={lbl()}>Rollout</div>
            <div style={controlLineStyle()}>
              <label style={ctrl()}>
                <span style={miniLbl()}>Stores</span>
                <input
                  type="number"
                  min={1}
                  value={storeCount}
                  onChange={(e) => setStoreCount(numberFromInput(e.target.value, 1))}
                  style={{ ...inp(), width: 78, textAlign: 'right' }}
                />
              </label>
              <label style={ctrl()}>
                <span style={miniLbl()}>Start</span>
                <select
                  value={storeStartMonth}
                  onChange={(e) => setStoreStartMonth(numberFromInput(e.target.value, 1))}
                  style={{ ...inp(), width: 92 }}
                >
                  {MONTHS_SHORT.map((m, idx) => <option key={m} value={idx + 1}>{m}</option>)}
                </select>
              </label>
              <label style={ctrl()}>
                <span style={miniLbl()}>Months</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={storeDuration}
                  onChange={(e) => setStoreDuration(numberFromInput(e.target.value, 1))}
                  style={{ ...inp(), width: 78, textAlign: 'right' }}
                />
              </label>
            </div>
          </div>

          <div style={setupBlockStyle()}>
            <div style={lbl()}>Products</div>
            <div style={controlLineStyle()}>
              <label style={ctrl()}>
                <span style={miniLbl()}>Search</span>
                <input
                  value={storeItemSearch}
                  onChange={(e) => setStoreItemSearch(e.target.value)}
                  placeholder="Product name"
                  style={{ ...inp(), width: 220 }}
                />
              </label>
              <label style={ctrl()}>
                <span style={miniLbl()}>Product</span>
                <select
                  value={storeProductId}
                  onChange={(e) => setStoreProductId(e.target.value)}
                  style={{ ...inp(), width: 300 }}
                >
                  <option value="">{allItems ? 'Pick product' : 'Loading items'}</option>
                  {storeProductOptions.map((it) => (
                    <option key={it.qbo_item_id} value={it.qbo_item_id}>
                      {(it.name || it.fully_qualified_name || it.qbo_item_id) + (it.category_path ? ` · ${it.category_path}` : '')}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={addStoreProduct}
                style={{ ...btnPrimary(), display: 'inline-flex', alignItems: 'center', gap: 6 }}
                disabled={!storeProductId || loadingStorePrice}
              >
                <Plus size={12} strokeWidth={2.4} aria-hidden="true" />
                {loadingStorePrice ? 'Adding' : 'Add'}
              </button>
            </div>
          </div>
        </div>

        <div style={bodyToolbarStyle()}>
          <div>
            <div className="ct" style={{ margin: 0 }}>PRODUCTS</div>
            <div style={{ fontSize: 10, color: 'var(--mt)' }}>
              {storeRows.length} selected · {fm(storeTotals.revenue)} planned
            </div>
          </div>
          <div style={{ fontSize: 10, color: 'var(--mt)' }}>FY{planFiscalYear}</div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', borderTop: '1px solid var(--bd)' }}>
          {!customers || !allItems ? (
            <div className="ld">Loading workbook inputs...</div>
          ) : storeRows.length === 0 ? (
            <div className="ld">Add products to build this customer rollout.</div>
          ) : (
            <StoreRolloutTable
              rows={storeRows}
              storeCount={storeCount}
              startMonth={storeStartMonth}
              duration={storeDuration}
              onUpdate={updateStoreRow}
              onRemove={removeStoreRow}
            />
          )}
        </div>
      </>
    );
  }

  return (
    <div style={overlayStyle()} onClick={onClose}>
      <div style={panelStyle()} onClick={(e) => e.stopPropagation()}>
        <div style={headerRowStyle()}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Build Scenario</div>
            <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>
              {mode === 'history' ? `FY${planFiscalYear} from ${sourceYear} actuals` : 'Customer rollout workbook'}
            </div>
          </div>
          <button onClick={onClose} style={btnSecondary()}>Close</button>
        </div>

        <div style={modeToggleStyle()}>
          <button onClick={() => setMode('history')} style={modeButtonStyle(mode === 'history')}>History Growth</button>
          <button onClick={() => setMode('stores')} style={modeButtonStyle(mode === 'stores')}>New Stores</button>
        </div>

        {mode === 'history' ? (
          <>
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
          </>
        ) : renderStoreRollout()}

        {err && (
          <div style={{ padding: '8px 14px', color: 'var(--rd)', borderTop: '1px solid var(--bd)', fontSize: 11 }}>
            Error: {err}
          </div>
        )}

        {mode === 'history' ? (
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
        ) : (
          <div style={footerRowStyle()}>
            <span style={{ fontSize: 10, color: 'var(--mt)' }}>
              {validStoreRows.length} product{validStoreRows.length === 1 ? '' : 's'} · {Number(storeCount) || 0} store{Number(storeCount) === 1 ? '' : 's'} · {rolloutRangeLabel(storeStartMonth, storeDuration)} · {fm(storeTotals.revenue)}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button onClick={onClose} style={btnSecondary()} disabled={applying}>Cancel</button>
              <button onClick={applyStoreRollout} style={btnPrimary()} disabled={!canApplyStores}>
                {applying ? 'Adding...' : 'Add Store Plan'}
              </button>
            </div>
          </div>
        )}
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

function StoreRolloutTable({
  rows,
  storeCount,
  startMonth,
  duration,
  onUpdate,
  onRemove,
}: {
  rows: StoreProductRow[];
  storeCount: number;
  startMonth: number;
  duration: number;
  onUpdate: (id: string, patch: Partial<StoreProductRow>) => void;
  onRemove: (id: string) => void;
}) {
  const rangeLabel = rolloutRangeLabel(startMonth, duration);
  return (
    <table style={{ width: '100%' }}>
      <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
        <tr>
          <th style={{ minWidth: 260 }}>Product</th>
          <th style={cellHeadR()}>Qty / Store / Mo</th>
          <th style={cellHeadR()}>Unit Price</th>
          <th style={cellHeadR()}>Unit Cost</th>
          <th style={cellHeadR()}>Months</th>
          <th style={cellHeadR()}>Annual Qty</th>
          <th style={cellHeadR()}>Revenue</th>
          <th style={{ width: 42 }} />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const arrays = storeArraysFor(r, storeCount, startMonth, duration);
          const qty = sumArray(arrays.qty);
          const revenue = sumArray(arrays.amounts);
          return (
            <tr key={r.qbo_item_id}>
              <td style={itemCellStyle()} title={r.item_name}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.item_name}</div>
                <div style={{ fontSize: 9, color: 'var(--mt)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.category_path}
                </div>
              </td>
              <td style={cellRight()}>
                <input
                  type="number"
                  step={0.25}
                  min={0}
                  value={r.qty_per_store}
                  onChange={(e) => onUpdate(r.qbo_item_id, { qty_per_store: numberFromInput(e.target.value, 0) })}
                  style={{ ...inp(), width: 82, fontSize: 10, padding: '2px 4px', textAlign: 'right' }}
                />
              </td>
              <td style={cellRight()}>
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  value={r.unit_price}
                  onChange={(e) => onUpdate(r.qbo_item_id, { unit_price: numberFromInput(e.target.value, 0) })}
                  style={{ ...inp(), width: 82, fontSize: 10, padding: '2px 4px', textAlign: 'right' }}
                />
              </td>
              <td style={cellRight()}>
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  value={r.unit_cost}
                  onChange={(e) => onUpdate(r.qbo_item_id, { unit_cost: numberFromInput(e.target.value, 0) })}
                  style={{ ...inp(), width: 82, fontSize: 10, padding: '2px 4px', textAlign: 'right' }}
                />
              </td>
              <td style={cellRight()}>{rangeLabel}</td>
              <td style={cellRight()}>{fmNum(qty)}</td>
              <td style={{ ...cellRight(), color: 'var(--ac)', fontWeight: 700 }}>{fm(revenue)}</td>
              <td style={{ textAlign: 'center' }}>
                <button
                  title="Remove product"
                  onClick={() => onRemove(r.qbo_item_id)}
                  style={iconButtonStyle()}
                >
                  <Trash2 size={12} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </td>
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

async function storeProductRowFor(item: QboItemWithCategory, sourceYear: number): Promise<StoreProductRow> {
  let unitPrice = 0;
  try {
    const [history] = await fetchPlanHistoryForItems([item.qbo_item_id], sourceYear);
    unitPrice = history?.ly_avg_unit_price != null ? Number(history.ly_avg_unit_price) : 0;
  } catch {
    unitPrice = 0;
  }

  return {
    qbo_item_id: item.qbo_item_id,
    item_name: item.name || item.fully_qualified_name || item.qbo_item_id,
    category_path: item.category_path || '(no category)',
    qbo_account_id: item.income_account_ref_id,
    account_name: item.income_account_name,
    qty_per_store: 1,
    unit_price: round2(unitPrice),
    unit_cost: 0,
  };
}

function parseStoreQuickEntry(text: string): {
  storeCount: number | null;
  startMonth: number | null;
  duration: number | null;
  customerTerm: string;
  productTerms: string[];
} {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  const stores = lower.match(/(\d+(?:\.\d+)?)\s+(?:new\s+)?stores?\b/);
  const months = lower.match(/\bover\s+(\d+)\s+months?\b/) ?? lower.match(/\bfor\s+(\d+)\s+months?\b/);
  const startMonth = monthFromText(lower);
  const customerTerm = cleanQuickTerm(
    firstCapture(raw, [
      /\bfor\s+customer\s+(.+?)(?=\s+(?:selling|sell|with|over|starting|start|beginning)\b|[,;.]|$)/i,
      /\bfor\s+(.+?)(?=\s+(?:selling|sell|with|over|starting|start|beginning)\b|[,;.]|$)/i,
      /\bcustomer\s+(.+?)(?=\s+(?:selling|sell|with|over|starting|start|beginning)\b|[,;.]|$)/i,
    ]),
  );
  return {
    storeCount: stores ? Math.max(1, Math.round(Number(stores[1]))) : null,
    startMonth,
    duration: months ? Math.max(1, Math.min(12, Math.round(Number(months[1])))) : null,
    customerTerm,
    productTerms: productTermsFromText(raw),
  };
}

function productTermsFromText(text: string): string[] {
  const explicit = firstCapture(text, [
    /\b(?:selling|sell|with)\s+(.+?)(?=\s+\bover\b|\s+\bstarting\b|\s+\bstart\b|\s+\bbeginning\b|$)/i,
    /\bproducts?\s*[:=]\s*(.+?)(?=\s+\bover\b|\s+\bstarting\b|\s+\bstart\b|\s+\bbeginning\b|$)/i,
  ]);
  const source = explicit || text.split(',').slice(1).join(',');
  return source
    .replace(/\bover\s+\d+\s+months?\b/gi, '')
    .replace(/\b(?:starting|start|beginning)\s+\w+\b/gi, '')
    .split(/,|\+|&|\band\b/gi)
    .map(cleanQuickTerm)
    .filter((term) => term.length >= 2)
    .filter((term) => !/^\d+(?:\.\d+)?\s*(?:products?|stores?|months?)?$/i.test(term))
    .filter((term) => !/\b(?:new\s+)?stores?\b/i.test(term))
    .slice(0, 8);
}

function firstCapture(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function cleanQuickTerm(term: string): string {
  return term
    .replace(/\b(?:they\s+will|will|inside|at|for|customer|products?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
    .trim();
}

function monthFromText(text: string): number | null {
  const match = text.match(/\b(?:starting|start|beginning)\s+([a-z]{3,9})\b/);
  if (!match) return null;
  const token = match[1].slice(0, 3).toLowerCase();
  const idx = MONTHS_SHORT.findIndex((m) => m.toLowerCase().slice(0, 3) === token);
  return idx >= 0 ? idx + 1 : null;
}

function bestCustomerMatch(customers: QboCustomerOption[], term: string): QboCustomerOption | null {
  const needle = normalizeQuickText(term);
  if (needle.length < 2) return null;
  return bestScored(customers, (customer) => scoreTextMatch(normalizeQuickText(customer.display_name), needle));
}

function bestItemMatch(items: QboItemWithCategory[], term: string, selected: Set<string>): QboItemWithCategory | null {
  const needle = normalizeQuickText(term);
  if (needle.length < 2) return null;
  return bestScored(
    items.filter((item) => item.type !== 'Category' && !selected.has(item.qbo_item_id)),
    (item) => {
      const label = normalizeQuickText([item.name, item.fully_qualified_name, item.category_path].filter(Boolean).join(' '));
      return scoreTextMatch(label, needle);
    },
  );
}

function bestScored<T>(items: T[], scoreFor: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const item of items) {
    const score = scoreFor(item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 45 ? best : null;
}

function scoreTextMatch(label: string, needle: string): number {
  if (!label || !needle) return 0;
  if (label === needle) return 100;
  if (label.startsWith(needle)) return 92 - Math.min(20, label.length - needle.length);
  if (label.includes(needle)) return 80 - Math.min(25, label.length - needle.length);
  const words = needle.split(' ').filter(Boolean);
  if (words.length > 0 && words.every((word) => label.includes(word))) return 62;
  return 0;
}

function normalizeQuickText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function storeArraysFor(
  row: StoreProductRow,
  storeCount: number,
  startMonth: number,
  duration: number,
): { amounts: number[]; qty: number[]; unitPrice: number[]; unitCost: number[] } {
  const amounts = zeros();
  const qty = zeros();
  const unitPrice = zeros();
  const unitCost = zeros();
  const monthlyQty = round2(Math.max(0, Number(storeCount) || 0) * Math.max(0, Number(row.qty_per_store) || 0));
  const price = round2(Math.max(0, Number(row.unit_price) || 0));
  const cost = round2(Math.max(0, Number(row.unit_cost) || 0));

  for (const idx of rolloutMonthIndexes(startMonth, duration)) {
    qty[idx] = monthlyQty;
    unitPrice[idx] = price;
    unitCost[idx] = cost;
    amounts[idx] = round2(monthlyQty * price);
  }
  return { amounts, qty, unitPrice, unitCost };
}

function summarizeStoreRows(
  rows: StoreProductRow[],
  storeCount: number,
  startMonth: number,
  duration: number,
): { qty: number; revenue: number } {
  let qty = 0;
  let revenue = 0;
  for (const row of rows) {
    const arrays = storeArraysFor(row, storeCount, startMonth, duration);
    qty += sumArray(arrays.qty);
    revenue += sumArray(arrays.amounts);
  }
  return { qty, revenue };
}

function rolloutMonthIndexes(startMonth: number, duration: number): number[] {
  const start = Math.max(0, Math.min(11, Math.round(Number(startMonth) || 1) - 1));
  const months = Math.max(1, Math.min(12, Math.round(Number(duration) || 1)));
  const out: number[] = [];
  for (let i = 0; i < months && start + i < 12; i++) out.push(start + i);
  return out;
}

function rolloutRangeLabel(startMonth: number, duration: number): string {
  const indexes = rolloutMonthIndexes(startMonth, duration);
  if (indexes.length === 0) return '-';
  const first = MONTHS_SHORT[indexes[0]];
  const last = MONTHS_SHORT[indexes[indexes.length - 1]];
  return first === last ? first : `${first}-${last}`;
}

function zeros(): number[] {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

function sumArray(values: number[] | null | undefined): number {
  return (values ?? []).reduce((s, v) => s + Number(v || 0), 0);
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function numberFromInput(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
function modeToggleStyle(): React.CSSProperties {
  return {
    display: 'flex',
    gap: 6,
    padding: '10px 16px',
    borderBottom: '1px solid var(--bd)',
    background: 'rgba(255,255,255,0.012)',
  };
}
function modeButtonStyle(active: boolean): React.CSSProperties {
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
function metricRowStyle(): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))',
    borderBottom: '1px solid var(--bd)',
    background: 'rgba(255,255,255,0.018)',
  };
}
function quickSetupStyle(): React.CSSProperties {
  return {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    padding: '10px 16px',
    borderBottom: '1px solid var(--bd)',
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
function iconButtonStyle(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    border: '1px solid var(--bd)',
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--rd)',
    cursor: 'pointer',
  };
}
