import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Search, X, CheckCircle2 } from 'lucide-react';
import { fmtNum } from '../../lib/formatters';
import { btnPrimary, btnSecondary } from '../../lib/styles';
import { KPICard } from '../../components/KPICard';
import {
  InventoryDriftRow,
  fetchInventoryDrift,
  reconcileInventoryToQbo,
} from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { GRID_SX } from './stockStyles';

// "Reconcile" tab — surfaces drift between QBO's Item.QtyOnHand
// (the authoritative total) and BRIX's per-location ledger sum
// (warehouses only). One-click reconcile posts a balancing
// inventory_movements row of type 'adjustment' between the target
// warehouse and the virtual Adjustment Counter.

interface Props {
  onRefresh: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function StockReconcileTab({ onRefresh }: Props) {
  const toast = useToast();
  const [rows, setRows] = useState<InventoryDriftRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState(false);

  function load() {
    setRows(null);
    fetchInventoryDrift().then(setRows).catch((e) => {
      toast.error(errMsg(e));
      setRows([]);
    });
  }
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (Number(r.drift) === 0) return false;
      if (trackedOnly && !r.track_locations) return false;
      if (!q) return true;
      return r.item_name.toLowerCase().includes(q)
          || r.category_resolved.toLowerCase().includes(q);
    });
  }, [rows, search, trackedOnly]);

  const gridRows = useMemo(
    () => filtered.map((r) => ({ ...r, id: r.qbo_item_id })),
    [filtered],
  );

  async function reconcileOne(qbo_item_id: string) {
    setBusy((cur) => ({ ...cur, [qbo_item_id]: true }));
    try {
      const res = await reconcileInventoryToQbo({ qbo_item_id });
      toast.success(res.message + ' · drift ' + fmtNum(Math.abs(res.drift_resolved)));
      // refresh just this row inline
      const refreshed = await fetchInventoryDrift();
      setRows(refreshed);
      onRefresh();
    } catch (e) { toast.error(errMsg(e)); }
    finally {
      setBusy((cur) => { const n = { ...cur }; delete n[qbo_item_id]; return n; });
    }
  }

  async function reconcileAll() {
    if (filtered.length === 0) return;
    if (!confirm('Reconcile ' + filtered.length + ' item(s) to QBO? This posts a balancing adjustment per item — net inventory across all locations stays the same, but each warehouse total will now match QBO.')) return;
    setBulkBusy(true);
    let okCount = 0;
    const errors: string[] = [];
    for (const r of filtered) {
      try {
        await reconcileInventoryToQbo({ qbo_item_id: r.qbo_item_id });
        okCount++;
      } catch (e) { errors.push(r.item_name + ': ' + errMsg(e)); }
    }
    if (errors.length === 0) {
      toast.success('Reconciled ' + okCount + ' item' + (okCount === 1 ? '' : 's'));
    } else {
      toast.error('Reconciled ' + okCount + ' · ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + ': ' + errors.slice(0, 3).join(' · '));
    }
    const refreshed = await fetchInventoryDrift();
    setRows(refreshed);
    onRefresh();
    setBulkBusy(false);
  }

  const columns: GridColDef[] = useMemo(() => [
    { field: 'item_name', headerName: 'Item', flex: 1, minWidth: 240,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value)}</span> },
    { field: 'category_resolved', headerName: 'Category', width: 200,
      renderCell: (p) => <span style={{ color: 'var(--mt)', fontSize: 11 }}>{String(p.value ?? '')}</span> },
    { field: 'qbo_qty', headerName: 'QBO Qty', type: 'number', width: 100, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    { field: 'brix_qty', headerName: 'BRIX Qty', type: 'number', width: 100, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    {
      field: 'drift', headerName: 'Drift', type: 'number', width: 110, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        if (v === 0) return <span style={{ color: 'var(--mt)' }}>0</span>;
        const sign = v > 0 ? '+' : '−';
        return (
          <span style={{ color: v > 0 ? 'var(--am)' : 'var(--rd)', fontWeight: 700 }}>
            {sign}{fmtNum(Math.abs(v))}
          </span>
        );
      },
    },
    {
      field: 'reconcile', headerName: '', width: 140, sortable: false, filterable: false,
      renderCell: (p) => (
        <button
          onClick={() => reconcileOne(String(p.row.qbo_item_id))}
          disabled={!!busy[String(p.row.qbo_item_id)]}
          style={{ ...btnSecondary(), padding: '4px 10px', fontSize: 10 }}
          title="Post a balancing adjustment so BRIX matches QBO"
        >
          {busy[String(p.row.qbo_item_id)] ? '…' : 'Reconcile'}
        </button>
      ),
    },
  ], [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rows === null) {
    return <div className="ld">Loading drift…</div>;
  }

  const totalDriftAbs = (rows ?? [])
    .filter((r) => !trackedOnly || r.track_locations)
    .reduce((s, r) => s + Math.abs(Number(r.drift ?? 0)), 0);
  const itemsWithDrift = (rows ?? [])
    .filter((r) => Number(r.drift ?? 0) !== 0 && (!trackedOnly || r.track_locations));
  const longCount  = itemsWithDrift.filter((r) => Number(r.drift) < 0).length;
  const shortCount = itemsWithDrift.filter((r) => Number(r.drift) > 0).length;
  const cleanCount = (rows ?? []).filter((r) => Number(r.drift ?? 0) === 0 && (!trackedOnly || r.track_locations)).length;

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 14 }}>
        <KPICard title="ITEMS WITH DRIFT" value={itemsWithDrift.length} accent={itemsWithDrift.length > 0 ? 'var(--am)' : undefined} sub="QBO ≠ BRIX warehouse sum" />
        <KPICard title="BRIX SHORT" value={shortCount} accent="var(--am)" sub="QBO has more — counted as missing" />
        <KPICard title="BRIX LONG" value={longCount} accent="var(--rd)" sub="BRIX has more — likely uncaught sales" />
        <KPICard title="IN AGREEMENT" value={cleanCount} accent="var(--gn)" sub={fmtNum(totalDriftAbs) + ' units total drift'} />
      </div>

      <div className="cd" style={{
        padding: '8px 12px', marginBottom: 12,
        background: 'rgba(91,181,240,0.04)', border: '1px solid var(--bd)',
        fontSize: 11, color: 'var(--mt)',
      }}>
        <strong style={{ color: 'var(--tx)' }}>What is this?</strong> QBO's <code>Item.QtyOnHand</code> is the authoritative total.
        BRIX's <code>inventory_movements</code> ledger sums to a different number when QBO has booked
        sales/adjustments that never made it back into the ledger. Clicking <strong>Reconcile</strong> posts a balancing
        movement between the warehouse and the virtual <em>Adjustment Counter</em>, so the warehouse sum matches QBO again.
        Net inventory across <em>all</em> locations stays the same.
      </div>

      <div className="cd" style={{
        padding: '10px 12px', marginBottom: 14, display: 'flex',
        gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', height: 30, borderRadius: 4,
          background: 'var(--bg)', border: '1px solid var(--bd)', minWidth: 240,
        }}>
          <Search size={13} strokeWidth={2.2} color="var(--mt)" aria-hidden="true" />
          <input type="text" value={search} placeholder="Search items…"
            onChange={(e) => setSearch(e.target.value)}
            style={{ background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--tx)', fontFamily: 'var(--ff-mono)', fontSize: 12, flex: 1, padding: 0 }} />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex' }}>
              <X size={12} strokeWidth={2.4} color="var(--mt)" />
            </button>
          )}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--mt)' }}>
          <input type="checkbox" checked={trackedOnly}
            onChange={(e) => setTrackedOnly(e.target.checked)}
            style={{ accentColor: 'var(--ac)' }} />
          Tracked items only
        </label>
        <span style={{ color: 'var(--mt)', marginLeft: 6 }}>
          {gridRows.length} item{gridRows.length === 1 ? '' : 's'} need reconciliation
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={load} style={btnSecondary()}>Refresh</button>
          <button onClick={reconcileAll} disabled={gridRows.length === 0 || bulkBusy} style={btnPrimary()}>
            {bulkBusy ? 'Reconciling…' : 'RECONCILE ALL'}
          </button>
        </span>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {gridRows.length === 0 ? (
          <div className="ld" style={{ padding: 24, display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--gn)' }}>
            <CheckCircle2 size={14} /> All items in agreement with QBO.
          </div>
        ) : (
          <DataGridPro
            rows={gridRows}
            columns={columns}
            sx={GRID_SX}
            density="compact"
            disableRowSelectionOnClick
            initialState={{ sorting: { sortModel: [{ field: 'drift', sort: 'desc' }] } }}
          />
        )}
      </div>
    </div>
  );
}
