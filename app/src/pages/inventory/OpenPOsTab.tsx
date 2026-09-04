// Inventory → "Purchase Orders" sub-tab.
//
// Every open PO that contributes to the On Order column, in ONE list:
// ops.purchase_orders holds both the POs created here (origin 'brix') and the
// POs created in QuickBooks (origin 'qbo', mirrored every 15 minutes by
// qbo-purchasing-sync — 20260904d). The shadow tables this tab used to merge
// in (ops.qbo_purchase_orders) are retired; a QuickBooks PO is a real row now,
// so it can be opened, edited, received and pushed back like any other.
//
// Sync now = the same pull the cron runs, on demand.

import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { ChevronRight, ChevronDown, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { fm, fmtNum } from '../../lib/formatters';
import { btnPrimary, btnSecondary } from '../../lib/styles';
import {
  PurchaseOrderLine, PurchaseOrderRow, PurchasingSyncStatus,
  fetchPoLines, fetchPurchaseOrders, fetchPurchasingSyncStatus, pullQboVendorsNow, syncPurchasingNow,
} from '../../lib/purchasing';
import { sbq } from '../../lib/rpc';
import { KPICard } from '../../components/KPICard';
import { TableSkeleton } from '../../components/Skeletons';
import { useToast } from '../../lib/toast';
import { GRID_SX, GRID_DEFAULTS } from '../../lib/gridStyles';
import { laneSelected, type InventoryLane } from '../../lib/inventoryLane';
import { OriginBadge } from '../production/PoDetailModal';

interface BrixPoLineSummary {
  po_id: string;
  qbo_item_id: string;
  qty_ordered: number | null;
  qty_received: number | null;
}

interface LaneItemLookup {
  byId: Map<string, { inventory_lane?: string | null }>;
}

interface UnifiedPoRow {
  id: string;
  origin: 'brix' | 'qbo';
  po_number: string;
  status: string;
  qbo_status: string | null;
  qbo_dirty: boolean;
  vendor_name: string | null;
  txn_date: string | null;
  expected_date: string | null;
  line_count: number;
  qty_open: number;
  qty_received: number;
  qty_ordered: number;
  subtotal: number;
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'var(--mt)', open: 'var(--ac)', partial: 'var(--am)',
  received: 'var(--gn)', closed: '#64748b', void: '#64748b',
};

interface Props {
  /** Selected lanes (empty = all). Omitted = no lane filter at all. */
  lanes?: InventoryLane[];
  itemLookup?: LaneItemLookup;
  /** Parent can hook in so the Reorder/Velocity tabs also refetch
   *  fn_items_master after a sync lands (qty_on_order refresh). */
  onChanged?: () => void;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function OpenPOsTab({ lanes, itemLookup, onChanged }: Props = {}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState<PurchaseOrderRow[]>([]);
  const [lines, setLines] = useState<BrixPoLineSummary[]>([]);
  const [sync, setSync] = useState<PurchasingSyncStatus | null>(null);
  const [statusFilter, setStatusFilter] = useState<'open_only' | 'all'>('open_only');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedLines, setExpandedLines] = useState<PurchaseOrderLine[] | null>(null);
  const [linesLoading, setLinesLoading] = useState(false);
  const [syncingVendors, setSyncingVendors] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [rows, lineRows, st] = await Promise.all([
        fetchPurchaseOrders(500),
        sbq<BrixPoLineSummary>('purchase_order_lines', 'select=po_id,qbo_item_id,qty_ordered,qty_received'),
        fetchPurchasingSyncStatus().catch(() => null),
      ]);
      setPos(rows); setLines(lineRows); setSync(st);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  function lineIsInLane(qboItemId: string | null | undefined): boolean {
    if (!lanes || !itemLookup) return true;
    if (!qboItemId) return false;
    return laneSelected(lanes, itemLookup.byId.get(qboItemId)?.inventory_lane as InventoryLane | null | undefined);
  }

  const lineTotals = useMemo(() => {
    const totals = new Map<string, { line_count: number; qty_ordered: number; qty_received: number }>();
    for (const line of lines) {
      if (!lineIsInLane(line.qbo_item_id)) continue;
      const cur = totals.get(line.po_id) ?? { line_count: 0, qty_ordered: 0, qty_received: 0 };
      cur.line_count += 1;
      cur.qty_ordered += Number(line.qty_ordered ?? 0);
      cur.qty_received += Number(line.qty_received ?? 0);
      totals.set(line.po_id, cur);
    }
    return totals;
  }, [lines, lanes, itemLookup]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function doSyncVendors() {
    setSyncingVendors(true);
    try {
      const r = await pullQboVendorsNow();
      toast.success('Synced ' + r.vendors_synced + ' vendors from QuickBooks');
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingVendors(false);
    }
  }

  async function doSyncNow() {
    setSyncing(true);
    try {
      const r = await syncPurchasingNow();
      const parts = [`${r.pos} PO${r.pos === 1 ? '' : 's'}`, `${r.bills} bill${r.bills === 1 ? '' : 's'}`, `${r.items} item quantities`];
      if (r.conflicts) parts.push(`${r.conflicts} edited here, not pushed`);
      if (r.errors?.length) toast.error('Sync finished with problems: ' + r.errors.slice(0, 3).join(' · '));
      else toast.success('QuickBooks pulled · ' + parts.join(' · '));
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  const rows = useMemo<UnifiedPoRow[]>(() => {
    const all = pos.map((p) => {
      const laneTotals = lineTotals.get(p.id);
      const ordered = laneTotals ? laneTotals.qty_ordered : Number(p.qty_ordered_total ?? 0);
      const received = laneTotals ? laneTotals.qty_received : Number(p.qty_received_total ?? 0);
      return {
        id: p.id,
        origin: p.origin ?? 'brix',
        po_number: p.po_number,
        status: p.status,
        qbo_status: p.qbo_status,
        qbo_dirty: !!p.qbo_dirty,
        vendor_name: p.vendor_name,
        txn_date: (p.ordered_at ?? p.created_at ?? '').slice(0, 10) || null,
        expected_date: p.expected_date,
        line_count: laneTotals ? laneTotals.line_count : Number(p.line_count ?? 0),
        qty_open: Math.max(0, ordered - received),
        qty_received: received,
        qty_ordered: ordered,
        subtotal: Number(p.subtotal ?? 0),
      };
    }).filter((row) => !lanes || !itemLookup || row.line_count > 0);
    if (statusFilter === 'open_only') {
      return all.filter((r) => r.status === 'open' || r.status === 'partial' || r.status === 'draft');
    }
    return all;
  }, [pos, statusFilter, lineTotals, lanes, itemLookup]);

  async function toggleExpand(row: UnifiedPoRow) {
    if (expandedId === row.id) { setExpandedId(null); setExpandedLines(null); return; }
    setExpandedId(row.id); setExpandedLines(null); setLinesLoading(true);
    try {
      const ls = await fetchPoLines(row.id);
      setExpandedLines(ls.filter((line) => lineIsInLane(line.qbo_item_id)));
    } finally {
      setLinesLoading(false);
    }
  }

  const totalOpenQty = useMemo(() => rows.reduce((s, r) => s + r.qty_open, 0), [rows]);
  const brixCount = rows.filter((r) => r.origin === 'brix').length;
  const qboCount = rows.filter((r) => r.origin === 'qbo').length;

  function openInProduction(row: UnifiedPoRow) {
    window.location.hash = `#production?tab=purchase_orders&po=${row.id}`;
  }

  const columns: GridColDef<UnifiedPoRow>[] = useMemo(() => [
    {
      field: '__expand', headerName: '', width: 38, sortable: false, filterable: false,
      renderCell: (p) => {
        const isOpen = expandedId === p.row.id;
        return (
          <button onClick={() => void toggleExpand(p.row)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: isOpen ? 'var(--ac)' : 'var(--mt)', padding: 2,
          }} aria-label={isOpen ? 'Collapse' : 'Expand'}>
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        );
      },
    },
    {
      field: 'origin', headerName: 'Created in', width: 120,
      renderCell: (p) => <OriginBadge origin={p.row.origin} />,
    },
    {
      field: 'po_number', headerName: 'PO #', width: 140,
      renderCell: (p) => (
        <span style={{ color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600, fontSize: 12 }}>
          {String(p.value ?? '')}
        </span>
      ),
    },
    {
      field: 'status', headerName: 'Status', width: 150,
      renderCell: (p) => {
        const v = String(p.value ?? '');
        const c = STATUS_COLOR[v] ?? 'var(--mt)';
        return (
          <span>
            <span style={{
              background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
              padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
            }}>{v.toUpperCase()}</span>
            {p.row.qbo_dirty && <span style={{ color: 'var(--am)', fontSize: 9, fontWeight: 700, marginLeft: 6 }}>edits to push</span>}
          </span>
        );
      },
    },
    { field: 'vendor_name', headerName: 'Vendor', flex: 1, minWidth: 200,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value ?? '—')}</span> },
    {
      field: 'qty_open', headerName: 'Open / Ordered', width: 150, cellClassName: 'mn',
      renderCell: (p) => (
        <span>
          <strong style={{ color: 'var(--gn)' }}>{fmtNum(Number(p.row.qty_open))}</strong>
          <span style={{ color: 'var(--mt)' }}> / {fmtNum(Number(p.row.qty_ordered))}</span>
        </span>
      ),
    },
    {
      field: 'subtotal', headerName: 'Subtotal', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => fm(Number(v ?? 0)),
    },
    {
      field: 'expected_date', headerName: 'Expected', width: 110,
      valueFormatter: (v) => v ? String(v) : '—',
    },
    {
      field: 'txn_date', headerName: 'Created', width: 110,
      valueFormatter: (v) => v ? String(v) : '—',
    },
    {
      field: '__open', headerName: '', width: 150, sortable: false,
      renderCell: (p) => (
        <button onClick={() => openInProduction(p.row)} style={btnSecondary()}>
          Open <ExternalLink size={11} style={{ marginLeft: 4, verticalAlign: -1 }} />
        </button>
      ),
    },
  ], [expandedId]);

  if (loading) {
    return <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={8} cols={9} /></div>;
  }

  const qboStale = sync?.qbo_as_of ? (Date.now() - new Date(sync.qbo_as_of).getTime()) > 45 * 60_000 : true;

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 14 }}>
        <KPICard title="REFRACTOR POs" value={brixCount} accent="var(--ac)" sub="created here" />
        <KPICard title="QUICKBOOKS POs" value={qboCount} accent="var(--gn)" sub="created in QuickBooks, mirrored" />
        <KPICard title="UNITS OPEN" value={fmtNum(totalOpenQty)} accent="var(--gn)" sub="ordered − received" />
        <KPICard
          title="ALL POs"
          value={rows.length}
          accent="var(--mt)"
          sub={statusFilter === 'open_only' ? 'open + partial + draft' : 'all statuses'}
        />
      </div>

      <div className="cd" style={{
        padding: '10px 12px', marginBottom: 14, display: 'flex',
        gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
      }}>
        <span className="toolbar-label">Filter</span>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'open_only' | 'all')}
          style={{
            padding: '4px 8px', height: 28, fontSize: 11, borderRadius: 4,
            background: 'var(--ctl-bg)', color: 'var(--tx)', border: '1px solid var(--ctl-bd)', width: 160,
          }}>
          <option value="open_only">Open + partial + draft</option>
          <option value="all">All statuses</option>
        </select>
        <span style={{ color: 'var(--mt)', marginLeft: 6 }}>
          {rows.length} PO{rows.length === 1 ? '' : 's'} · QuickBooks pulled{' '}
          <strong style={{ color: qboStale ? 'var(--am)' : 'var(--tx)' }}>{ago(sync?.purchasing_synced_at)}</strong>
          {' · item quantities as of '}
          <strong style={{ color: qboStale ? 'var(--am)' : 'var(--tx)' }}>{ago(sync?.qbo_as_of)}</strong>
          {' · every 15 min, or now'}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => void doSyncVendors()} style={btnSecondary()} disabled={syncingVendors}>
            {syncingVendors ? 'Syncing…' : 'Pull Vendors from QuickBooks'}
          </button>
          <button onClick={() => void doSyncNow()} style={btnPrimary()} disabled={syncing}
            title="Pull QuickBooks POs, bills and item quantities now instead of waiting for the 15-minute cron">
            <RefreshCw size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
            {syncing ? 'Pulling QuickBooks…' : 'Sync now'}
          </button>
          <button onClick={() => void load()} style={btnSecondary()}>Refresh</button>
        </span>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        <DataGridPro
          rows={rows}
          columns={columns}
          {...GRID_DEFAULTS}
          sx={GRID_SX}
          density="compact"
          disableRowSelectionOnClick
          initialState={{ sorting: { sortModel: [{ field: 'txn_date', sort: 'desc' }] } }}
        />
      </div>

      {expandedId && (
        <div className="cd" style={{ marginTop: 14, padding: 14 }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
            Lines for {rows.find((r) => r.id === expandedId)?.po_number ?? '—'}
          </div>
          {linesLoading || !expandedLines ? (
            <div style={{ padding: 18, color: 'var(--mt)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading lines…
            </div>
          ) : (
            <ExpandedLinesTable lines={expandedLines} />
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedLinesTable({ lines }: { lines: PurchaseOrderLine[] }) {
  if (lines.length === 0) {
    return <div style={{ padding: 18, color: 'var(--mt)', fontStyle: 'italic' }}>No item lines.</div>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--bd)' }}>
          <th style={th}>Item</th>
          <th style={{ ...th, textAlign: 'right', width: 100 }}>Qty</th>
          <th style={{ ...th, textAlign: 'right', width: 100 }}>Received</th>
          <th style={{ ...th, textAlign: 'right', width: 100 }}>Unit cost</th>
          <th style={{ ...th, textAlign: 'right', width: 110 }}>Extended</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => {
          const ext = Number(l.qty_ordered) * Number(l.unit_cost);
          return (
            <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <td style={td}>
                <div style={{ fontWeight: 600 }}>{l.qbo_item_id}</div>
                {l.description && <div style={{ fontSize: 10, color: 'var(--mt)' }}>{l.description}</div>}
              </td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(l.qty_ordered))}</td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)',
                color: Number(l.qty_received) >= Number(l.qty_ordered) ? 'var(--gn)' : 'var(--am)' }}>
                {fmtNum(Number(l.qty_received))}
              </td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fm(Number(l.unit_cost))}</td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)', fontWeight: 600 }}>{fm(ext)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '7px 8px', fontSize: 10, fontWeight: 600,
  letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)',
};
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle' };
