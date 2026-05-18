import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef, type GridRenderCellParams } from '@mui/x-data-grid-pro';
import { KPICard } from '../../components/KPICard';
import { CustomerLink } from '../../components/CustomerLink';
import { fm, fp } from '../../lib/formatters';
import { inp } from '../../lib/styles';
import { sbq } from '../../lib/rpc';
import { ItemSet, VoidRow, fetchProductVoids } from '../../lib/reports';

interface CustomerCell {
  id: string;
  name: string;
  channel: string | null;
  set_revenue: number;
  items_bought: number;
  set_total: number;
  cells: Record<string, { revenue: number; has: boolean }>;
}

export function VoidsReport() {
  const today = new Date();
  const ytdStart = today.getFullYear() + '-01-01';
  const todayStr = today.toISOString().slice(0, 10);

  const [sets, setSets] = useState<ItemSet[]>([]);
  const [setCode, setSetCode] = useState('');
  const [f, setF] = useState({
    start: ytdStart,
    end: todayStr,
    min_set_revenue: 0,
    require_some: true,
  });
  const [rows, setRows] = useState<VoidRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Per-item filter chips. mustBuy = customer's row must show has_item=true
  // for every selected item. mustNotBuy = must show has_item=false.
  // Empty sets = no filter.
  const [mustBuy, setMustBuy] = useState<Set<string>>(new Set());
  const [mustNotBuy, setMustNotBuy] = useState<Set<string>>(new Set());
  const [minItems, setMinItems] = useState<number>(0);
  const [maxItems, setMaxItems] = useState<number | null>(null);

  // Three-state chip cycle: off → must buy → must NOT buy → off
  function cycleChip(itemId: string) {
    const inBuy    = mustBuy.has(itemId);
    const inNotBuy = mustNotBuy.has(itemId);
    const nextBuy    = new Set(mustBuy);
    const nextNotBuy = new Set(mustNotBuy);
    if (!inBuy && !inNotBuy)      nextBuy.add(itemId);
    else if (inBuy)             { nextBuy.delete(itemId); nextNotBuy.add(itemId); }
    else                          nextNotBuy.delete(itemId);
    setMustBuy(nextBuy);
    setMustNotBuy(nextNotBuy);
  }
  function clearItemFilters() { setMustBuy(new Set()); setMustNotBuy(new Set()); }

  useEffect(() => {
    sbq<ItemSet>('item_sets', 'select=set_code,label,sort_order,is_active&is_active=eq.true&order=sort_order,label')
      .then((rs) => {
        setSets(rs);
        if (rs.length > 0 && !setCode) setSetCode(rs[0].set_code);
      })
      .catch(() => setSets([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!setCode) { setRows(null); return; }
    setLoading(true);
    fetchProductVoids({
      set_code: setCode,
      start: f.start,
      end: f.end,
      min_set_revenue: Number(f.min_set_revenue) || 0,
      require_some: f.require_some,
    })
      .then((rs) => { setRows(rs); setLoading(false); })
      .catch(() => { setRows([]); setLoading(false); });
  }, [setCode, f.start, f.end, f.min_set_revenue, f.require_some]);

  // Pivot once into customers × items, then apply the per-item filters
  // (mustBuy / mustNotBuy / min items / max items) on top of the pivoted
  // matrix. This keeps the underlying RPC simple — the matrix shape doesn't
  // change, only which customer rows pass the filter.
  const { customers, itemCols, totalCovered, totalGapDollars } = useMemo(() => {
    if (!rows || rows.length === 0) {
      return { customers: [] as CustomerCell[], itemCols: [], totalCovered: 0, totalGapDollars: 0 };
    }
    const byCustomer = new Map<string, CustomerCell>();
    const itemCols: { id: string; name: string }[] = [];
    const seen = new Set<string>();

    for (const r of rows) {
      if (!seen.has(r.qbo_item_id)) {
        itemCols.push({ id: r.qbo_item_id, name: r.item_name });
        seen.add(r.qbo_item_id);
      }
      let cust = byCustomer.get(r.qbo_customer_id);
      if (!cust) {
        cust = {
          id: r.qbo_customer_id,
          name: r.customer_name,
          channel: r.primary_channel,
          set_revenue: Number(r.customer_set_revenue || 0),
          items_bought: r.customer_set_items_count,
          set_total: r.set_total_items,
          cells: {},
        };
        byCustomer.set(r.qbo_customer_id, cust);
      }
      cust.cells[r.qbo_item_id] = { revenue: Number(r.revenue || 0), has: r.has_item };
    }

    let arr = Array.from(byCustomer.values()).sort((a, b) => b.set_revenue - a.set_revenue);
    // Apply per-item + count filters
    if (mustBuy.size > 0) {
      arr = arr.filter((c) => Array.from(mustBuy).every((id) => c.cells[id]?.has === true));
    }
    if (mustNotBuy.size > 0) {
      arr = arr.filter((c) => Array.from(mustNotBuy).every((id) => c.cells[id]?.has !== true));
    }
    if (minItems > 0) arr = arr.filter((c) => c.items_bought >= minItems);
    if (maxItems != null) arr = arr.filter((c) => c.items_bought <= maxItems);

    const totalItems = arr.reduce((s, c) => s + c.set_total, 0);
    const totalBought = arr.reduce((s, c) => s + c.items_bought, 0);
    const cov = totalItems === 0 ? 0 : totalBought / totalItems;
    const gap = arr.reduce((s, c) => {
      if (c.items_bought === 0 || c.set_total === 0) return s;
      const avg = c.set_revenue / c.items_bought;
      const missing = c.set_total - c.items_bought;
      return s + avg * missing;
    }, 0);

    return { customers: arr, itemCols, totalCovered: cov, totalGapDollars: gap };
  }, [rows, mustBuy, mustNotBuy, minItems, maxItems]);

  if (!sets.length) {
    return (
      <div className="cd" style={{ padding: 20 }}>
        <div className="ct">NO ITEM SETS DEFINED</div>
        <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 6 }}>
          Set up product sets first in Settings → Item Sets.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="CUSTOMERS" value={customers.length} sub="buying ≥1 item from this set" />
        <KPICard
          title="COVERAGE"
          value={fp(totalCovered)}
          accent={totalCovered >= 0.6 ? 'var(--gn)' : totalCovered >= 0.3 ? 'var(--am)' : 'var(--rd)'}
          sub="items bought / total set items"
        />
        <KPICard title="GAP $ POTENTIAL" value={fm(totalGapDollars)} accent="var(--am)" sub="if missing items at avg AOV" />
        <KPICard title="ITEMS IN SET" value={itemCols.length} />
      </div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 10,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>Set</span>
        <select value={setCode} onChange={(e) => setSetCode(e.target.value)} style={inp()}>
          {sets.map((s) => <option key={s.set_code} value={s.set_code}>{s.label}</option>)}
        </select>

        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>From</span>
        <input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} style={inp()} />
        <span style={{ color: 'var(--mt)' }}>to</span>
        <input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} style={inp()} />

        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Min set $</span>
        <input
          type="number"
          value={f.min_set_revenue}
          onChange={(e) => setF({ ...f, min_set_revenue: Number(e.target.value) })}
          style={{ ...inp(), width: 80 }}
        />

        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}># items ≥</span>
        <input
          type="number"
          min={0}
          value={minItems}
          onChange={(e) => setMinItems(Number(e.target.value) || 0)}
          style={{ ...inp(), width: 60 }}
          title="Show customers who bought at least N items from the set"
        />
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>≤</span>
        <input
          type="number"
          min={0}
          value={maxItems ?? ''}
          onChange={(e) => setMaxItems(e.target.value === '' ? null : Number(e.target.value))}
          style={{ ...inp(), width: 60 }}
          title="Optional: cap at N items"
          placeholder="any"
        />

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
          <input
            type="checkbox"
            checked={f.require_some}
            onChange={(e) => setF({ ...f, require_some: e.target.checked })}
          />
          <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}
                title="When checked: hide customers who already bought every item in the set (no voids). When unchecked: show everyone, including completionists.">
            Hide completionists
          </span>
        </label>
      </div>

      {/* Item filter chips — click to cycle: none → must buy → must NOT buy → none.
          mustBuy = customers who DO have this item; mustNotBuy = customers MISSING this item. */}
      {itemCols.length > 0 && (
        <div className="cd" style={{ padding: '10px 12px', marginBottom: 10, fontSize: 11 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>
              Filter by item
            </span>
            <span style={{ color: 'var(--mt)', fontSize: 10 }}>
              Click to toggle MUST BUY (green) ↔ MUST NOT BUY (red) ↔ off
            </span>
            {(mustBuy.size > 0 || mustNotBuy.size > 0) && (
              <button onClick={clearItemFilters} style={{ ...inp(), background: 'transparent', cursor: 'pointer', fontSize: 10 }}>
                Clear ({mustBuy.size + mustNotBuy.size})
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {itemCols.map((it) => {
              const mode = mustBuy.has(it.id) ? 'buy' : mustNotBuy.has(it.id) ? 'notbuy' : 'off';
              const bg = mode === 'buy'    ? 'rgba(22,163,74,0.18)'
                      :  mode === 'notbuy' ? 'rgba(220,38,38,0.18)'
                      :                       'transparent';
              const bd = mode === 'buy'    ? 'var(--gn)'
                      :  mode === 'notbuy' ? 'var(--rd)'
                      :                       'var(--bd)';
              const fg = mode === 'buy'    ? 'var(--gn)'
                      :  mode === 'notbuy' ? 'var(--rd)'
                      :                       'var(--tx2)';
              const prefix = mode === 'buy' ? '+ ' : mode === 'notbuy' ? '− ' : '';
              return (
                <button
                  key={it.id}
                  onClick={() => cycleChip(it.id)}
                  title={mode === 'off' ? 'Click to require: must buy' : mode === 'buy' ? 'Click to flip: must NOT buy' : 'Click to clear'}
                  style={{
                    padding: '3px 8px', fontSize: 10, fontWeight: 600,
                    border: `1px solid ${bd}`, borderRadius: 12, cursor: 'pointer',
                    background: bg, color: fg,
                  }}
                >
                  {prefix}{it.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {loading || !rows ? (
          <div className="ld">Loading…</div>
        ) : customers.length === 0 ? (
          <div className="ld">No customers in this set / window.</div>
        ) : (
          <VoidsGrid customers={customers} itemCols={itemCols} />
        )}
      </div>
    </div>
  );
}

// MUI DataGrid Pro view: sortable, draggable columns, pinned Customer column,
// pagination, density toggle. Item columns are dynamic — one per item in the
// selected set — so we build the column defs in useMemo from itemCols.
interface GridRow {
  id: string;
  customer_name: string;
  channel: string | null;
  set_revenue: number;
  items_bought: number;
  set_total: number;
  // dynamic per-item fields: `item_${qbo_item_id}` = revenue (0 when not bought)
  [k: string]: unknown;
}

function VoidsGrid({ customers, itemCols }: { customers: CustomerCell[]; itemCols: { id: string; name: string }[] }) {
  const gridRows: GridRow[] = useMemo(
    () => customers.map((c) => {
      const r: GridRow = {
        id: c.id,
        customer_name: c.name,
        channel: c.channel,
        set_revenue: c.set_revenue,
        items_bought: c.items_bought,
        set_total: c.set_total,
      };
      for (const it of itemCols) r[`item_${it.id}`] = c.cells[it.id]?.revenue ?? 0;
      return r;
    }),
    [customers, itemCols],
  );

  const columns: GridColDef<GridRow>[] = useMemo(() => {
    const base: GridColDef<GridRow>[] = [
      {
        field: 'customer_name',
        headerName: 'Customer',
        flex: 2,
        minWidth: 200,
        renderCell: (p: GridRenderCellParams<GridRow>) => (
          <span
            title={String(p.value ?? '')}
            style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            <CustomerLink qboCustomerId={p.row.id} name={String(p.value ?? '')} />
          </span>
        ),
      },
      {
        field: 'channel',
        headerName: 'Channel',
        width: 160,
        valueFormatter: (v: unknown) => (v ?? '—') as string,
      },
      {
        field: 'set_revenue',
        headerName: 'Set $',
        type: 'number',
        width: 110,
        cellClassName: 'mn',
        renderCell: (p: GridRenderCellParams<GridRow>) => (
          <span style={{ fontWeight: 600 }}>{fm(p.value as number)}</span>
        ),
      },
      {
        field: 'items_bought',
        headerName: 'Bought',
        type: 'number',
        width: 80,
        cellClassName: 'mn',
        renderCell: (p: GridRenderCellParams<GridRow>) => {
          const bought = Number(p.value ?? 0);
          const total = p.row.set_total;
          const color = bought >= total ? 'var(--gn)' : bought >= total / 2 ? 'var(--am)' : 'var(--rd)';
          return <span style={{ color, fontWeight: 600 }}>{bought}/{total}</span>;
        },
      },
      {
        field: 'set_total',
        headerName: 'Set Total',
        type: 'number',
        width: 80,
        cellClassName: 'mn',
      },
    ];

    const itemColumns: GridColDef<GridRow>[] = itemCols.map((it) => ({
      field: `item_${it.id}`,
      headerName: it.name,
      type: 'number',
      width: 110,
      cellClassName: 'mn',
      renderCell: (p: GridRenderCellParams<GridRow>) => {
        const rev = Number(p.value ?? 0);
        const has = rev > 0;
        return (
          <span style={{
            color: has ? 'var(--gn)' : 'var(--rd)',
            fontWeight: has ? 600 : 400,
            fontSize: 10,
          }}>
            {has ? fm(rev) : '—'}
          </span>
        );
      },
    }));

    return [...base, ...itemColumns];
  }, [itemCols]);

  return (
    <DataGridPro
      rows={gridRows}
      columns={columns}
      density="compact"
      pagination
      pageSizeOptions={[10, 25, 50, 100, 250, { value: -1, label: 'All' }]}
      initialState={{
        pagination: { paginationModel: { pageSize: 25, page: 0 } },
        pinnedColumns: { left: ['customer_name'] },
        sorting: { sortModel: [{ field: 'set_revenue', sort: 'desc' }] },
        columns: { columnVisibilityModel: { set_total: false } },
      }}
      disableRowSelectionOnClick
      sx={{
        height: '64vh',
        border: 'none',
        background: 'transparent',
        color: 'var(--tx)',
        fontFamily: 'inherit',
        fontSize: 12,
        '& .MuiDataGrid-columnHeaders': { background: 'var(--sf)', borderBottom: '1px solid var(--bd)' },
        '& .MuiDataGrid-columnHeader': {
          fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
          fontSize: 10.5, color: 'var(--mt)',
        },
        '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },
        '& .MuiDataGrid-cell': { borderBottom: '1px solid rgba(255,255,255,0.04)', py: 0.5 },
        '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
        '& .MuiDataGrid-row:hover': { background: 'rgba(91,181,240,0.06)' },
        '& .MuiDataGrid-pinnedColumns': { background: 'var(--sf)', boxShadow: '4px 0 12px rgba(0,0,0,0.35)' },
        '& .MuiDataGrid-pinnedColumnHeaders': { background: 'var(--sf)' },
        '& .MuiDataGrid-footerContainer': {
          borderTop: '1px solid var(--bd)',
          background: 'var(--sf)',
          minHeight: 40,
        },
        '& .mn': { fontFeatureSettings: '"tnum" on, "lnum" on' },
        '& .MuiDataGrid-menuIconButton, & .MuiDataGrid-sortIcon': { color: 'var(--mt)' },
      }}
    />
  );
}
