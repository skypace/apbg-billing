import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Search, X } from 'lucide-react';
import { fmtNum } from '../../lib/formatters';
import { btnSecondary } from '../../lib/styles';
import { downloadCsv, toCsv } from '../../lib/csv';
import { DriftRow, InventoryLocationView, OnHandRow, fetchDrift } from '../../lib/inventoryControl';
import { LedgerStatusStrip } from './LedgerStatusStrip';
import type { ItemLookup } from './StockPage';
import { GRID_SX, GRID_DEFAULTS } from './stockStyles';

interface Props {
  rows: OnHandRow[] | null;
  locationById: Map<string, InventoryLocationView>;
  itemLookup: ItemLookup;
  onRefresh: () => void;
}

export function StockOnHandTab({ rows, locationById, itemLookup, onRefresh }: Props) {
  const [search, setSearch] = useState('');
  const [hideZero, setHideZero] = useState(true);
  const [hideVirtual, setHideVirtual] = useState(true);
  const [trackedOnly, setTrackedOnly] = useState(true);
  // Per-ITEM, not per item-and-location: what QuickBooks says we hold in total.
  const [drift, setDrift] = useState<Map<string, DriftRow>>(new Map());
  useEffect(() => {
    fetchDrift()
      .then((rows) => setDrift(new Map(rows.map((r) => [r.qbo_item_id, r]))))
      .catch(() => setDrift(new Map()));
  }, [rows]);

  const enriched = useMemo(() => {
    if (!rows) return [];
    return rows.map((r) => {
      const item = itemLookup.byId.get(r.qbo_item_id);
      const loc  = locationById.get(r.location_id);
      return {
        id: `${r.qbo_item_id}::${r.location_id}`,
        qbo_item_id: r.qbo_item_id,
        item_name: item?.item_name ?? r.qbo_item_id,
        item_active: item?.active ?? false,
        item_tracked: item?.track_locations ?? false,
        location_id: r.location_id,
        location_code: loc?.code ?? '?',
        location_name: loc?.name ?? '?',
        location_kind: loc?.kind ?? 'warehouse',
        on_hand: Number(r.on_hand),
        // QuickBooks counts what we OWN, with no notion of where it sits, so
        // the comparison belongs on rows whose stock is ours -- our warehouses
        // AND a partner holding consignment, since that is still ours until
        // they sell it. On a co-packer or in-transit row it is left blank
        // rather than repeated, which would read as that location being short.
        qbo_qty:  loc?.counts_as_our_stock ? (drift.get(r.qbo_item_id)?.qbo_qty ?? null) : null,
        variance: loc?.counts_as_our_stock ? (drift.get(r.qbo_item_id)?.drift   ?? null) : null,
      };
    });
  }, [rows, itemLookup, locationById, drift]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return enriched.filter((r) => {
      if (hideZero && r.on_hand === 0) return false;
      if (hideVirtual && (r.location_kind === 'in_transit' || r.location_kind === 'adjustment')) return false;
      if (trackedOnly && !r.item_tracked) return false;
      if (!needle) return true;
      return (
        r.item_name.toLowerCase().includes(needle) ||
        r.location_name.toLowerCase().includes(needle) ||
        r.location_code.toLowerCase().includes(needle)
      );
    });
  }, [enriched, search, hideZero, hideVirtual, trackedOnly]);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'item_name',
      headerName: 'Item',
      flex: 1.4,
      minWidth: 220,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value ?? '')}</span>,
    },
    {
      field: 'location_name',
      headerName: 'Location',
      flex: 1,
      minWidth: 180,
      renderCell: (p) => (
        <span>
          <span style={{ color: 'var(--mt)', fontFamily: 'var(--ff-mono)', fontSize: 11, marginRight: 6 }}>
            {p.row.location_code}
          </span>
          {String(p.value ?? '')}
        </span>
      ),
    },
    {
      field: 'location_kind',
      headerName: 'Kind',
      width: 130,
      renderCell: (p) => (
        <span style={{
          color: 'var(--mt)',
          fontSize: 9.5,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
        }}>
          {String(p.value ?? '').replace('_', ' ')}
        </span>
      ),
    },
    {
      field: 'on_hand',
      headerName: 'On Hand',
      type: 'number',
      width: 110,
      cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        const color = v < 0 ? 'var(--rd)' : v === 0 ? 'var(--mt)' : 'var(--tx)';
        return <span style={{ color, fontWeight: 600 }}>{fmtNum(v)}</span>;
      },
    },
    {
      field: 'qbo_qty',
      // QuickBooks has no notion of location, so both of these describe the
      // ITEM, not the row. The headers say so: on an item held in two places
      // the same total appears twice, and without "item" in the name a reader
      // could reasonably add the two variances together.
      headerName: 'QB item total',
      type: 'number',
      width: 125,
      cellClassName: 'mn',
      renderCell: (p) => (p.value == null
        ? <span style={{ color: 'var(--mt)' }}>—</span>
        : <span style={{ color: 'var(--mt)' }}>{fmtNum(Number(p.value))}</span>),
    },
    {
      field: 'variance',
      headerName: 'Item variance',
      type: 'number',
      width: 110,
      cellClassName: 'mn',
      renderCell: (p) => {
        if (p.value == null) return <span style={{ color: 'var(--mt)' }}>—</span>;
        const v = Number(p.value);
        if (v === 0) return <span style={{ color: 'var(--gn)' }}>0</span>;
        return <span style={{ color: 'var(--am)', fontWeight: 600 }}>{v > 0 ? '+' : ''}{fmtNum(v)}</span>;
      },
    },
  ], []);

  function exportCsv() {
    if (filtered.length === 0) return;
    const head = ['Item', 'Item ID', 'Location Code', 'Location Name', 'Kind', 'On Hand',
      'QB item total', 'Item variance'];
    const data = filtered.map((r) => [
      r.item_name, r.qbo_item_id, r.location_code, r.location_name, r.location_kind, r.on_hand,
      r.qbo_qty ?? '', r.variance ?? '',
    ]);
    downloadCsv(`on_hand_${new Date().toISOString().slice(0,10)}.csv`, toCsv([head, ...data]));
  }

  return (
    <div>
      <LedgerStatusStrip onReconciled={onRefresh} />
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search item or location…" />
          <label className="toolbar-section" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)}
              style={{ accentColor: 'var(--ac)' }} />
            <span className="toolbar-label">Hide zero qty</span>
          </label>
          <label className="toolbar-section" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={hideVirtual} onChange={(e) => setHideVirtual(e.target.checked)}
              style={{ accentColor: 'var(--ac)' }} />
            <span className="toolbar-label">Hide virtual locations</span>
          </label>
          <label className="toolbar-section" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title="Show only items flagged Track Locations in Settings → Items.">
            <input type="checkbox" checked={trackedOnly} onChange={(e) => setTrackedOnly(e.target.checked)}
              style={{ accentColor: 'var(--ac)' }} />
            <span className="toolbar-label">Tracked items only</span>
          </label>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={exportCsv} style={btnSecondary()}>Export CSV</button>
          <button onClick={onRefresh} style={btnSecondary()}>Refresh</button>
        </div>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={filtered}
          columns={columns}
          {...GRID_DEFAULTS}
          sx={GRID_SX}
          density="compact"
          loading={rows === null}
          initialState={{ sorting: { sortModel: [{ field: 'item_name', sort: 'asc' }] } }}
          disableRowSelectionOnClick
        />
      </div>
    </div>
  );
}

function SearchInput({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', height: 30, borderRadius: 4,
      background: 'var(--ctl-bg)', border: '1px solid var(--ctl-bd)', minWidth: 260,
    }}>
      <Search size={13} strokeWidth={2.2} color="var(--mt)" aria-hidden="true" />
      <input type="text" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--tx)', fontFamily: 'var(--ff-mono)', fontSize: 12,
          flex: 1, padding: 0,
        }} />
      {value && (
        <button onClick={() => onChange('')} aria-label="Clear search"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex' }}>
          <X size={12} strokeWidth={2.4} color="var(--mt)" />
        </button>
      )}
    </div>
  );
}
