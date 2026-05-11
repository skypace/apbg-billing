import { useEffect, useMemo, useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import type { GridColDef } from '@mui/x-data-grid-pro';
import { KPICard } from '../components/KPICard';
import { ReportGrid } from '../components/ReportGrid';
import { fm, fmtNum } from '../lib/formatters';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../lib/styles';
import { downloadCsv, toCsv } from '../lib/csv';
import { KpiRowSkeleton, TableSkeleton } from '../components/Skeletons';
import {
  InventoryHealthRow, QboCustomerOption, VelocityExcludeRow,
  addVelocityExclude, fetchCustomerOptions, fetchInventoryHealth,
  fetchVelocityExcludes, removeVelocityExclude, setInventorySettings,
} from '../lib/inventory';

type TabId = 'reorder' | 'velocity' | 'settings' | 'excludes';

const TABS: { id: TabId; label: string }[] = [
  { id: 'reorder',  label: 'Reorder' },
  { id: 'velocity', label: 'Velocity' },
  { id: 'settings', label: 'Settings' },
  { id: 'excludes', label: 'Velocity Excludes' },
];

const STATUS_COLOR: Record<string, string> = {
  reorder_now:  'var(--rd)',
  reorder_soon: 'var(--am)',
  healthy:      'var(--gn)',
  overstock:    '#a78bfa',
  no_velocity:  'var(--mt)',
  unmanaged:    'var(--mt)',
};

const TABS_SX = {
  minHeight: 36, mb: 1.5, borderBottom: '1px solid var(--bd)',
  '& .MuiTabs-indicator': { background: 'var(--ac)', height: 2 },
  '& .MuiTab-root': {
    minHeight: 36, padding: '6px 18px', textTransform: 'uppercase',
    color: 'var(--mt)', fontSize: 11, fontWeight: 600, letterSpacing: 0.6, fontFamily: 'inherit',
  },
  '& .Mui-selected': { color: 'var(--ac) !important' },
};

export function InventoryPage() {
  const [tab, setTab] = useState<TabId>('reorder');
  const [lookback, setLookback] = useState(90);
  const [managedOnly, setManagedOnly] = useState(false);
  const [rows, setRows] = useState<InventoryHealthRow[] | null>(null);

  function load() {
    setRows(null);
    fetchInventoryHealth({ lookback: Number(lookback) || 90, managed_only: managedOnly })
      .then(setRows).catch(() => setRows([]));
  }
  useEffect(load, [lookback, managedOnly]);

  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? 'Inventory';

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Reorder · Velocity · Health</div>
          <h1 className="hero-title">Inventory</h1>
          <div className="hero-meta">
            {tabLabel} · {lookback}-day lookback{managedOnly ? ' · managed only' : ''}
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          {rows ? fmtNum(rows.length) + ' items' : 'loading…'}
        </div>
      </div>

      <Tabs value={tab} onChange={(_, v) => setTab(v as TabId)} sx={TABS_SX}>
        {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </Tabs>

      {(tab === 'reorder' || tab === 'velocity' || tab === 'settings') && (
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <div className="toolbar-row">
            <div className="toolbar-section">
              <span className="toolbar-label">Velocity lookback</span>
              <input type="number" min={7} max={365} value={lookback}
                onChange={(e) => setLookback(Number(e.target.value) || 90)}
                className="date-input" style={{ width: 70 }} />
              <span style={{ color: 'var(--mt)', fontSize: 11 }}>days</span>
            </div>
            <label className="toolbar-section" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={managedOnly}
                onChange={(e) => setManagedOnly(e.target.checked)}
                style={{ accentColor: 'var(--ac)' }} />
              <span className="toolbar-label">Managed only</span>
            </label>
            <div className="toolbar-spacer" />
            <button onClick={load} className="tb-btn">Refresh</button>
          </div>
        </div>
      )}

      {tab === 'reorder' && <ReorderTable rows={rows} />}
      {tab === 'velocity' && <VelocityTable rows={rows} />}
      {tab === 'settings' && <SettingsTable rows={rows} onChange={load} />}
      {tab === 'excludes' && <ExcludesTab />}
    </div>
  );
}

function ReorderTable({ rows }: { rows: InventoryHealthRow[] | null }) {
  const reorder = useMemo(() => {
    if (!rows) return [];
    const re = rows.filter((r) => r.status === 'reorder_now' || r.status === 'reorder_soon');
    return re.sort((a, b) => Number(a.days_of_supply ?? 999) - Number(b.days_of_supply ?? 999));
  }, [rows]);

  const gridRows = useMemo(
    () => reorder.map((r, i) => ({ ...r, id: r.qbo_item_id ?? ('r___' + i) })),
    [reorder],
  );

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'item_name', headerName: 'Item', flex: 2, minWidth: 240,
      renderCell: (p) => (
        <span title={p.value as string} style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.value as string}
        </span>
      ),
    },
    {
      field: 'status', headerName: 'Status', width: 130,
      renderCell: (p) => {
        const c = STATUS_COLOR[p.value as string] ?? 'var(--mt)';
        return (
          <span style={{
            background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
            padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
          }}>{String(p.value).toUpperCase().replace('_', ' ')}</span>
        );
      },
    },
    { field: 'on_hand', headerName: 'On Hand', type: 'number', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fmtNum(Number(v))) },
    { field: 'daily_velocity', headerName: 'Velocity/day', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'days_of_supply', headerName: 'Days Supply', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0)) },
    { field: 'reorder_point', headerName: 'Reorder Pt', type: 'number', width: 100, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : String(v)) },
    {
      field: 'suggested_order_qty', headerName: 'Suggested Qty', type: 'number', width: 130, cellClassName: 'mn',
      renderCell: (p) => (
        <span style={{ color: 'var(--ac)', fontWeight: 600 }}>{p.value != null ? String(p.value) : '—'}</span>
      ),
    },
  ], []);

  function exportCsv() {
    if (reorder.length === 0) return;
    const head = ['Item', 'On Hand', 'Daily Velocity', 'Days of Supply', 'Reorder Point', 'Suggested Order Qty', 'Status'];
    const data = reorder.map((r) => [
      r.item_name, r.on_hand ?? '',
      r.daily_velocity != null ? Number(r.daily_velocity).toFixed(2) : '',
      r.days_of_supply != null ? Number(r.days_of_supply).toFixed(0) : '',
      r.reorder_point ?? '', r.suggested_order_qty ?? '', r.status,
    ]);
    downloadCsv(`reorder_${new Date().toISOString().slice(0,10)}.csv`, toCsv([head, ...data]));
  }

  function printOrderSheet() {
    if (reorder.length === 0) return;
    const w = window.open('', '_blank');
    if (!w) return;
    const tableRows = reorder.map((r) => `<tr><td>${escapeHtml(r.item_name)}</td><td style="text-align:right">${r.on_hand ?? '—'}</td><td style="text-align:right">${r.daily_velocity != null ? Number(r.daily_velocity).toFixed(2) : '—'}</td><td style="text-align:right">${r.days_of_supply != null ? Number(r.days_of_supply).toFixed(0) : '—'}</td><td style="text-align:right;font-weight:600">${r.suggested_order_qty ?? '—'}</td><td>${r.status}</td><td>      </td></tr>`).join('');
    w.document.write(`<html><head><title>Reorder Sheet</title><style>body{font-family:system-ui,-apple-system,sans-serif;color:#0a0e17;max-width:980px;margin:24px auto;padding:0 24px}h1{font-size:18px;border-bottom:2px solid #0ea5b8;padding-bottom:6px}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:12px}td,th{padding:5px 8px;border-bottom:1px solid #e2e8f0;text-align:left}th{background:#f1f5f9;font-size:9px;text-transform:uppercase;letter-spacing:1px}@media print{body{margin:0}}</style></head><body><h1>Reorder Sheet — ${new Date().toISOString().slice(0,10)}</h1><div style="font-size:10px;color:#64748b">${reorder.length} items below threshold</div><table><thead><tr><th>Item</th><th style="text-align:right">On Hand</th><th style="text-align:right">Velocity/day</th><th style="text-align:right">Days Supply</th><th style="text-align:right">Suggested Qty</th><th>Status</th><th>Order Qty</th></tr></thead><tbody>${tableRows}</tbody></table><script>setTimeout(function(){window.print()},350);</script></body></html>`);
    w.document.close();
  }

  if (!rows) return (
    <>
      <KpiRowSkeleton count={4} />
      <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={8} cols={7} /></div>
    </>
  );

  const reorderNow  = rows.filter((r) => r.status === 'reorder_now');
  const reorderSoon = rows.filter((r) => r.status === 'reorder_soon');
  const healthy     = rows.filter((r) => r.status === 'healthy');
  const overstock   = rows.filter((r) => r.status === 'overstock');

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 14 }}>
        <KPICard title="REORDER NOW" value={reorderNow.length} accent="var(--rd)" sub="below reorder point" />
        <KPICard title="REORDER SOON" value={reorderSoon.length} accent="var(--am)" sub="approaching reorder point" />
        <KPICard title="HEALTHY" value={healthy.length} accent="var(--gn)" />
        <KPICard title="OVERSTOCK" value={overstock.length} accent="#a78bfa" sub=">2× target days" />
      </div>

      <div className="cd" style={{
        padding: '10px 12px', marginBottom: 14, display: 'flex',
        gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
      }}>
        <span style={{ color: 'var(--mt)' }}>{reorder.length} items below threshold</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={printOrderSheet} disabled={reorder.length === 0} style={btnPrimary()}>PRINT ORDER SHEET</button>
          <button onClick={exportCsv} disabled={reorder.length === 0} style={btnSecondary()}>EXPORT CSV</button>
        </span>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {reorder.length === 0 ? (
          <div className="ld">All managed inventory is healthy.</div>
        ) : (
          <ReportGrid
            rows={gridRows} columns={columns}
            pinnedLeft={['item_name']}
            defaultSort={[{ field: 'days_of_supply', sort: 'asc' }]}
            height="58vh"
          />
        )}
      </div>
    </div>
  );
}

function VelocityTable({ rows }: { rows: InventoryHealthRow[] | null }) {
  const sorted = useMemo(
    () => rows ? [...rows].sort((a, b) => Number(b.sold_revenue ?? 0) - Number(a.sold_revenue ?? 0)) : null,
    [rows],
  );

  const gridRows = useMemo(
    () => (sorted ?? []).map((r, i) => ({ ...r, id: r.qbo_item_id ?? ('v___' + i) })),
    [sorted],
  );

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'item_name', headerName: 'Item', flex: 2, minWidth: 240,
      renderCell: (p) => (
        <span title={p.value as string} style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.value as string}
        </span>
      ),
    },
    { field: 'category_path', headerName: 'Category', width: 180,
      valueFormatter: (v) => (v == null ? '—' : String(v)) },
    { field: 'sold_qty', headerName: 'Sold Qty', type: 'number', width: 100, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    {
      field: 'sold_revenue', headerName: 'Sold Rev', type: 'number', width: 130, cellClassName: 'mn',
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{fm(Number(p.value ?? 0))}</span>,
    },
    { field: 'customers_count', headerName: 'Customers', type: 'number', width: 100, cellClassName: 'mn' },
    { field: 'purchased_qty', headerName: 'Purchased', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    {
      field: 'adjustment_qty', headerName: 'Adj Qty', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return <span style={{ color: v < 0 ? 'var(--rd)' : 'var(--mt)' }}>{fmtNum(v)}</span>;
      },
    },
    {
      field: 'shrinkage_qty', headerName: 'Shrink', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => (
        <span style={{ color: 'var(--rd)' }}>{p.value != null ? fmtNum(Number(p.value)) : '—'}</span>
      ),
    },
    { field: 'daily_velocity', headerName: 'Velocity/day', type: 'number', width: 120, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'days_of_supply', headerName: 'Days Supply', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0)) },
  ], []);

  if (!sorted) return (
    <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={10} cols={9} /></div>
  );

  return (
    <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
      <ReportGrid
        rows={gridRows} columns={columns}
        pinnedLeft={['item_name']}
        defaultSort={[{ field: 'sold_revenue', sort: 'desc' }]}
        height="64vh"
      />
    </div>
  );
}

function SettingsTable({ rows, onChange }: { rows: InventoryHealthRow[] | null; onChange: () => void }) {
  if (!rows) return <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={8} cols={5} /></div>;
  function patch(p: Parameters<typeof setInventorySettings>[0]) { setInventorySettings(p).then(onChange); }
  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ maxHeight: '64vh', overflow: 'auto' }}>
        <table>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
            <tr>
              <th>Item</th><th>Managed?</th>
              <th style={{ textAlign: 'right' }}>Target Days</th>
              <th style={{ textAlign: 'right' }}>Lead Time</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.qbo_item_id}>
                <td style={{ fontWeight: 600, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={r.item_name}>{r.item_name}</td>
                <td>
                  <input type="checkbox" checked={r.is_managed}
                    onChange={(e) => patch({ qbo_item_id: r.qbo_item_id, is_managed: e.target.checked })} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input type="number" defaultValue={r.target_days_supply}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== r.target_days_supply) patch({ qbo_item_id: r.qbo_item_id, target_days_supply: v });
                    }}
                    style={{ ...inp(), width: 60, textAlign: 'right' }} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input type="number" defaultValue={r.lead_time_days}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== r.lead_time_days) patch({ qbo_item_id: r.qbo_item_id, lead_time_days: v });
                    }}
                    style={{ ...inp(), width: 60, textAlign: 'right' }} />
                </td>
                <td>
                  <input type="text" defaultValue={r.notes ?? ''}
                    onBlur={(e) => {
                      if ((e.target.value ?? '') !== (r.notes ?? '')) {
                        patch({ qbo_item_id: r.qbo_item_id, notes: e.target.value || null });
                      }
                    }}
                    placeholder="—" style={{ ...inp(), width: 260 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExcludesTab() {
  const [excludes, setExcludes] = useState<VelocityExcludeRow[]>([]);
  const [customers, setCustomers] = useState<QboCustomerOption[]>([]);

  function load() {
    Promise.all([fetchVelocityExcludes(), fetchCustomerOptions()])
      .then(([ex, cs]) => { setExcludes(ex); setCustomers(cs); })
      .catch(() => { setExcludes([]); setCustomers([]); });
  }
  useEffect(load, []);

  function add(custId: string) {
    if (!custId) return;
    const reason = prompt('Why exclude this customer from velocity? (optional)') ?? null;
    addVelocityExclude(custId, reason ?? undefined).then(load);
  }

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)' }}>
        <div className="ct" style={{ margin: 0 }}>VELOCITY EXCLUDES — {excludes.length}</div>
        <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3 }}>
          Customers in this list don't count toward inventory velocity (one-off bulk buyers, internal transfers, samples).
        </div>
      </div>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)' }}>
        <select style={{ ...inp(), width: '100%', maxWidth: 600 }} defaultValue=""
          onChange={(e) => { add(e.target.value); e.target.value = ''; }}>
          <option value="">+ exclude a customer from velocity</option>
          {customers.filter((c) => !excludes.some((ex) => ex.qbo_customer_id === c.qbo_customer_id))
            .map((c) => <option key={c.qbo_customer_id} value={c.qbo_customer_id}>{c.display_name}</option>)}
        </select>
      </div>
      {excludes.length === 0 ? (
        <div className="ld">No customers excluded.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Customer</th><th>Reason</th><th>Added</th><th></th></tr>
          </thead>
          <tbody>
            {excludes.map((ex) => {
              const cust = customers.find((c) => c.qbo_customer_id === ex.qbo_customer_id);
              return (
                <tr key={ex.qbo_customer_id}>
                  <td style={{ fontWeight: 600 }}>{cust?.display_name ?? ex.qbo_customer_id}</td>
                  <td style={{ fontSize: 11, color: 'var(--mt)' }}>{ex.reason ?? '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--mt)' }}>
                    {ex.added_at ? new Date(ex.added_at).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button onClick={() => removeVelocityExclude(ex.qbo_customer_id).then(load)} style={btnDanger()}>×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}
