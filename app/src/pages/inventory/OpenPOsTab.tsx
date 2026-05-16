// Inventory → "Purchase Orders" sub-tab.
//
// Unified read-only view of every open PO that contributes to the On Order
// column on the Reorder/Velocity tabs. Sources are merged client-side so
// the operator gets one list to scan:
//
//   1. BRIX-native — ops.purchase_orders + lines (status draft/open/partial/received)
//   2. QBO-direct  — ops.qbo_purchase_orders + lines (status='Open', not also brix-native)
//
// Same logic fn_items_master.brix_on_order + qbo_direct_on_order CTEs use,
// just surfaced as rows instead of summed into qty_on_order.

import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { ChevronRight, ChevronDown, ExternalLink, Loader2 } from 'lucide-react';
import { fm, fmtNum } from '../../lib/formatters';
import { btnSecondary, inp } from '../../lib/styles';
import {
  PoStatus, PurchaseOrderLine, PurchaseOrderRow,
  fetchPoLines, fetchPurchaseOrders,
} from '../../lib/purchasing';
import { sbq } from '../../lib/rpc';
import { KPICard } from '../../components/KPICard';
import { TableSkeleton } from '../../components/Skeletons';

const GRID_SX = {
  height: '64vh', border: 'none', background: 'transparent', color: 'var(--ink)',
  fontFamily: 'inherit', fontSize: 12,
  '--DataGrid-rowBorderColor': 'rgba(255,255,255,0.04)',
  '--DataGrid-containerBackground': 'var(--sf)',
  '& .MuiDataGrid-columnHeaders': { background: 'var(--sf)', borderBottom: '1px solid var(--bd)' },
  '& .MuiDataGrid-columnHeader': {
    fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
    fontSize: 10.5, color: 'var(--mt)',
  },
  '& .MuiDataGrid-cell': { borderBottom: '1px solid rgba(255,255,255,0.04)', py: 0.5 },
  '& .MuiDataGrid-row:hover': { background: 'rgba(91, 181, 240, 0.05)' },
  '& .mn': { fontFeatureSettings: '"tnum" on, "lnum" on' },
};

// ── Shadow-table types (BRIX-side ops.qbo_purchase_orders) ───────────────

interface QboPoShadow {
  qbo_id: string;
  doc_number: string | null;
  qbo_vendor_id: string | null;
  vendor_name: string | null;
  txn_date: string | null;
  po_status: string;        // 'Open', 'Closed', 'PartiallyBilled', etc.
  total_amt: number | null;
  memo: string | null;
  imported_by: string | null;
  imported_at: string;
  last_synced_at: string;
}

interface QboPoLineShadow {
  qbo_po_id: string;
  line_num: number;
  qbo_item_id: string | null;
  description: string | null;
  qty: number | null;
  unit_cost: number | null;
  amount: number | null;
}

interface BrixQboLink {
  qbo_purchase_order_id: string;
}

// ── Unified row shape ────────────────────────────────────────────────────

type UnifiedSource = 'brix' | 'qbo';

interface UnifiedPoRow {
  id: string;             // DataGrid row id (composite)
  source: UnifiedSource;
  po_number: string;
  status: string;         // BRIX PoStatus or QBO po_status
  vendor_name: string | null;
  txn_date: string | null;
  expected_date: string | null;
  line_count: number;
  qty_open: number;       // ordered - received (BRIX) or qty (QBO open)
  qty_received: number;   // BRIX only — QBO always 0
  qty_ordered: number;
  subtotal: number;
  brix_po_id?: string;    // for "Open in Production"
  qbo_id?: string;
}

const STATUS_COLOR: Record<string, string> = {
  draft:    'var(--mt)',
  open:     'var(--ac)',
  Open:     'var(--ac)',
  partial:  'var(--am)',
  PartiallyBilled: 'var(--am)',
  received: 'var(--gn)',
  closed:   '#64748b',
  Closed:   '#64748b',
  void:     '#64748b',
};

export function OpenPOsTab() {
  const [loading, setLoading] = useState(true);
  const [brixPos, setBrixPos] = useState<PurchaseOrderRow[]>([]);
  const [qboPos, setQboPos] = useState<QboPoShadow[]>([]);
  const [brixLinkedIds, setBrixLinkedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'open_only' | 'all'>('open_only');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedLines, setExpandedLines] = useState<{
    source: UnifiedSource;
    lines: PurchaseOrderLine[] | QboPoLineShadow[];
  } | null>(null);
  const [linesLoading, setLinesLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [brix, qbo, links] = await Promise.all([
        fetchPurchaseOrders(500),
        sbq<QboPoShadow>('qbo_purchase_orders', 'select=*&order=imported_at.desc&limit=500'),
        sbq<BrixQboLink>(
          'purchase_orders',
          'select=qbo_purchase_order_id&qbo_purchase_order_id=not.is.null',
        ),
      ]);
      setBrixPos(brix);
      setQboPos(qbo);
      setBrixLinkedIds(new Set(links.map((l) => l.qbo_purchase_order_id)));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  // Build unified row list. Filter QBO POs to exclude already-linked BRIX
  // ones (same dedup logic as fn_items_master).
  const rows = useMemo<UnifiedPoRow[]>(() => {
    const brixUnified: UnifiedPoRow[] = brixPos.map((p) => {
      const ordered = Number(p.qty_ordered_total ?? 0);
      const received = Number(p.qty_received_total ?? 0);
      return {
        id: `brix:${p.id}`,
        source: 'brix',
        po_number: p.po_number,
        status: p.status,
        vendor_name: p.vendor_name,
        txn_date: p.created_at ? p.created_at.slice(0, 10) : null,
        expected_date: p.expected_date,
        line_count: Number(p.line_count ?? 0),
        qty_open: Math.max(0, ordered - received),
        qty_received: received,
        qty_ordered: ordered,
        subtotal: Number(p.subtotal ?? 0),
        brix_po_id: p.id,
      };
    });
    const qboUnified: UnifiedPoRow[] = qboPos
      .filter((p) => !brixLinkedIds.has(p.qbo_id))
      .map((p) => ({
        id: `qbo:${p.qbo_id}`,
        source: 'qbo',
        po_number: p.doc_number ?? p.qbo_id,
        status: p.po_status,
        vendor_name: p.vendor_name,
        txn_date: p.txn_date,
        expected_date: null,
        line_count: 0,            // populated on expand
        qty_open: 0,              // computed from lines on expand; for top-line we use total_amt
        qty_received: 0,
        qty_ordered: 0,
        subtotal: Number(p.total_amt ?? 0),
        qbo_id: p.qbo_id,
      }));

    const all = [...brixUnified, ...qboUnified];
    if (statusFilter === 'open_only') {
      return all.filter(
        (r) => r.status === 'open' || r.status === 'partial' || r.status === 'Open' || r.status === 'draft',
      );
    }
    return all;
  }, [brixPos, qboPos, brixLinkedIds, statusFilter]);

  async function toggleExpand(row: UnifiedPoRow) {
    if (expandedId === row.id) {
      setExpandedId(null);
      setExpandedLines(null);
      return;
    }
    setExpandedId(row.id);
    setExpandedLines(null);
    setLinesLoading(true);
    try {
      if (row.source === 'brix' && row.brix_po_id) {
        const lines = await fetchPoLines(row.brix_po_id);
        setExpandedLines({ source: 'brix', lines });
      } else if (row.source === 'qbo' && row.qbo_id) {
        const lines = await sbq<QboPoLineShadow>(
          'qbo_purchase_order_lines',
          `select=*&qbo_po_id=eq.${encodeURIComponent(row.qbo_id)}&order=line_num.asc`,
        );
        setExpandedLines({ source: 'qbo', lines });
      }
    } finally {
      setLinesLoading(false);
    }
  }

  const totalOpenQty = useMemo(
    () => rows.reduce((s, r) => s + (r.source === 'brix' ? r.qty_open : 0), 0),
    [rows],
  );
  const brixCount = rows.filter((r) => r.source === 'brix').length;
  const qboCount = rows.filter((r) => r.source === 'qbo').length;

  function openInProduction(row: UnifiedPoRow) {
    if (row.source !== 'brix' || !row.brix_po_id) return;
    // Production page reads ?tab and ?po from the hash. Simple deep-link.
    window.location.hash = `#production?tab=purchase_orders&po=${row.brix_po_id}`;
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
      field: 'source', headerName: 'Src', width: 70,
      renderCell: (p) => {
        const v = p.value as UnifiedSource;
        return (
          <span style={{
            background: v === 'brix' ? 'rgba(91,181,240,0.10)' : 'rgba(46,184,114,0.10)',
            color: v === 'brix' ? 'var(--ac)' : 'var(--gn)',
            border: '1px solid',
            borderColor: v === 'brix' ? 'rgba(91,181,240,0.40)' : 'rgba(46,184,114,0.40)',
            padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
          }}>{v === 'brix' ? 'BRIX' : 'QBO'}</span>
        );
      },
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
      field: 'status', headerName: 'Status', width: 110,
      renderCell: (p) => {
        const v = String(p.value ?? '');
        const c = STATUS_COLOR[v] ?? 'var(--mt)';
        return (
          <span style={{
            background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
            padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
          }}>{v.toUpperCase()}</span>
        );
      },
    },
    { field: 'vendor_name', headerName: 'Vendor', flex: 1, minWidth: 200,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value ?? '—')}</span> },
    {
      field: 'qty_open', headerName: 'Open / Ordered', width: 150, cellClassName: 'mn',
      renderCell: (p) => {
        if (p.row.source === 'qbo') {
          return <span style={{ color: 'var(--mt)' }}>—</span>;
        }
        const open = Number(p.row.qty_open);
        const ord  = Number(p.row.qty_ordered);
        return (
          <span>
            <strong style={{ color: 'var(--gn)' }}>{fmtNum(open)}</strong>
            <span style={{ color: 'var(--mt)' }}> / {fmtNum(ord)}</span>
          </span>
        );
      },
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
      field: '__open', headerName: '', width: 140, sortable: false,
      renderCell: (p) => p.row.source === 'brix'
        ? <button onClick={() => openInProduction(p.row)} style={btnSecondary()}>
            Open in Production <ExternalLink size={11} style={{ marginLeft: 4, verticalAlign: -1 }} />
          </button>
        : <span style={{ color: 'var(--mt)', fontSize: 10 }}>read-only shadow</span>,
    },
  ], [expandedId]);

  if (loading) {
    return <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={8} cols={9} /></div>;
  }

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 14 }}>
        <KPICard title="BRIX OPEN POS" value={brixCount} accent="var(--ac)" sub="created in BRIX" />
        <KPICard title="QBO IMPORTED" value={qboCount} accent="var(--gn)" sub="from QBO picker" />
        <KPICard title="UNITS OPEN" value={fmtNum(totalOpenQty)} accent="var(--gn)" sub="qty_ordered − qty_received" />
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
          style={{ ...inp(), width: 160 }}>
          <option value="open_only">Open + partial + draft</option>
          <option value="all">All statuses</option>
        </select>
        <span style={{ color: 'var(--mt)', marginLeft: 6 }}>
          {rows.length} PO{rows.length === 1 ? '' : 's'} · BRIX-native and QBO-direct both feed the On Order column
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button onClick={() => void load()} style={btnSecondary()}>Refresh</button>
        </span>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        <DataGridPro
          rows={rows}
          columns={columns}
          sx={GRID_SX}
          density="compact"
          disableRowSelectionOnClick
          initialState={{ sorting: { sortModel: [{ field: 'txn_date', sort: 'desc' }] } }}
        />
      </div>

      {/* Expanded line panel — rendered below the grid so it always has room */}
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
            <ExpandedLinesTable expandedLines={expandedLines} />
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedLinesTable({ expandedLines }: {
  expandedLines: { source: UnifiedSource; lines: PurchaseOrderLine[] | QboPoLineShadow[] };
}) {
  if (expandedLines.lines.length === 0) {
    return <div style={{ padding: 18, color: 'var(--mt)', fontStyle: 'italic' }}>No item lines.</div>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--bd)' }}>
          <th style={th}>Item</th>
          <th style={{ ...th, textAlign: 'right', width: 100 }}>Qty</th>
          {expandedLines.source === 'brix' && (
            <th style={{ ...th, textAlign: 'right', width: 100 }}>Received</th>
          )}
          <th style={{ ...th, textAlign: 'right', width: 100 }}>Unit cost</th>
          <th style={{ ...th, textAlign: 'right', width: 110 }}>Extended</th>
        </tr>
      </thead>
      <tbody>
        {expandedLines.source === 'brix'
          ? (expandedLines.lines as PurchaseOrderLine[]).map((l) => {
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
            })
          : (expandedLines.lines as QboPoLineShadow[]).map((l, i) => {
              const ext = Number(l.amount ?? (Number(l.qty ?? 0) * Number(l.unit_cost ?? 0)));
              return (
                <tr key={`${l.qbo_po_id}-${l.line_num}-${i}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{l.qbo_item_id || <span style={{ color: 'var(--am)' }}>(no item — won't count On Order)</span>}</div>
                    {l.description && <div style={{ fontSize: 10, color: 'var(--mt)' }}>{l.description}</div>}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{l.qty != null ? fmtNum(Number(l.qty)) : '—'}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{l.unit_cost != null ? fm(Number(l.unit_cost)) : '—'}</td>
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
