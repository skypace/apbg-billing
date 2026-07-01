import { useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Search, X } from 'lucide-react';
import { InventoryLocation, InventoryMovement, MovementType } from '../../lib/inventoryControl';
import { fmtNum } from '../../lib/formatters';
import { btnSecondary, inp } from '../../lib/styles';
import { downloadCsv, toCsv } from '../../lib/csv';
import { GRID_SX, GRID_DEFAULTS } from './stockStyles';
import type { ItemLookup } from './StockPage';

interface Props {
  rows: InventoryMovement[] | null;
  locationById: Map<string, InventoryLocation>;
  itemLookup: ItemLookup;
}

const TYPE_LABEL: Record<MovementType, string> = {
  transfer_ship:      'Transfer · Ship',
  transfer_receive:   'Transfer · Receive',
  receipt:            'Receipt',
  shipment:           'Shipment',
  adjustment:         'Adjustment',
  production_consume: 'Production · Consume',
  production_yield:   'Production · Yield',
};

export function StockMovementsTab({ rows, locationById, itemLookup }: Props) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | MovementType>('all');

  const enriched = useMemo(() => {
    if (!rows) return [];
    return rows.map((m) => {
      const from = m.from_location_id ? locationById.get(m.from_location_id) : null;
      const to   = m.to_location_id   ? locationById.get(m.to_location_id)   : null;
      const item = itemLookup.byId.get(m.qbo_item_id);
      return {
        ...m,
        id: m.id,
        item_name: item?.item_name ?? m.qbo_item_id,
        from_label: from ? from.code : '— external —',
        to_label:   to   ? to.code   : '— external —',
      };
    });
  }, [rows, locationById, itemLookup]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return enriched.filter((r) => {
      if (typeFilter !== 'all' && r.movement_type !== typeFilter) return false;
      if (!needle) return true;
      return (
        r.item_name.toLowerCase().includes(needle) ||
        r.from_label.toLowerCase().includes(needle) ||
        r.to_label.toLowerCase().includes(needle)
      );
    });
  }, [enriched, search, typeFilter]);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'occurred_at',
      headerName: 'When',
      width: 160,
      valueFormatter: (v) => v ? new Date(String(v)).toLocaleString() : '—',
    },
    {
      field: 'movement_type',
      headerName: 'Type',
      width: 180,
      renderCell: (p) => (
        <span style={{ color: 'var(--ac)', fontSize: 10.5, letterSpacing: 0.4 }}>
          {TYPE_LABEL[p.value as MovementType] ?? String(p.value)}
        </span>
      ),
    },
    { field: 'item_name', headerName: 'Item', flex: 1, minWidth: 200,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value ?? '')}</span> },
    { field: 'qty', headerName: 'Qty', type: 'number', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    { field: 'from_label', headerName: 'From',
      width: 140,
      renderCell: (p) => <span style={{ color: p.value === '— external —' ? 'var(--mt)' : 'var(--tx)' }}>{String(p.value)}</span>,
    },
    { field: 'to_label', headerName: 'To',
      width: 140,
      renderCell: (p) => <span style={{ color: p.value === '— external —' ? 'var(--mt)' : 'var(--tx)' }}>{String(p.value)}</span>,
    },
    { field: 'source_doc_type', headerName: 'Doc', width: 100,
      valueFormatter: (v) => (v ? String(v) : '—') },
  ], []);

  function exportCsv() {
    if (filtered.length === 0) return;
    const head = ['When', 'Type', 'Item', 'Item ID', 'Qty', 'From', 'To', 'Unit Cost', 'Source Doc', 'Notes'];
    const data = filtered.map((r) => [
      r.occurred_at, r.movement_type, r.item_name, r.qbo_item_id,
      r.qty, r.from_label, r.to_label, r.unit_cost ?? '',
      r.source_doc_type ?? '', r.notes ?? '',
    ]);
    downloadCsv(`movements_${new Date().toISOString().slice(0, 10)}.csv`, toCsv([head, ...data]));
  }

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search item or location…" />
          <div className="toolbar-section" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="toolbar-label">Type</span>
            <select value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'all' | MovementType)}
              style={inp()}>
              <option value="all">All</option>
              {(Object.keys(TYPE_LABEL) as MovementType[]).map((k) => (
                <option key={k} value={k}>{TYPE_LABEL[k]}</option>
              ))}
            </select>
          </div>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={exportCsv} style={btnSecondary()}>Export CSV</button>
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
          initialState={{ sorting: { sortModel: [{ field: 'occurred_at', sort: 'desc' }] } }}
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
