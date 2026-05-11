import { useEffect, useMemo, useState } from 'react';
import { KPICard } from '../components/KPICard';
import { fm, fmtNum } from '../lib/formatters';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../lib/styles';
import { downloadCsv, toCsv } from '../lib/csv';
import {
  InventoryHealthRow,
  QboCustomerOption,
  VelocityExcludeRow,
  addVelocityExclude,
  fetchCustomerOptions,
  fetchInventoryHealth,
  fetchVelocityExcludes,
  removeVelocityExclude,
  setInventorySettings,
} from '../lib/inventory';

type Tab = 'reorder' | 'velocity' | 'settings' | 'excludes';

const TABS: { id: Tab; label: string }[] = [
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

export function InventoryPage() {
  const [tab, setTab] = useState<Tab>('reorder');
  const [lookback, setLookback] = useState(90);
  const [managedOnly, setManagedOnly] = useState(false);
  const [rows, setRows] = useState<InventoryHealthRow[] | null>(null);

  function load() {
    setRows(null);
    fetchInventoryHealth({ lookback: Number(lookback) || 90, managed_only: managedOnly })
      .then(setRows)
      .catch(() => setRows([]));
  }
  useEffect(load, [lookback, managedOnly]);

  return (
    <div>
      <div className="pt">Inventory <span className="bg bg-l">HEALTH</span></div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: on ? 'var(--ac)' : 'var(--sf2)',
                color: on ? 'var(--bg)' : 'var(--tx)',
                border: '1px solid var(--bd)',
                padding: '6px 12px',
                borderRadius: 4,
                fontSize: 11,
                cursor: 'pointer',
                fontWeight: on ? 700 : 500,
                letterSpacing: 0.5,
              }}
            >
              {t.label.toUpperCase()}
            </button>
          );
        })}
      </div>

      {(tab === 'reorder' || tab === 'velocity' || tab === 'settings') && (
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
          <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Velocity lookback
          </span>
          <input
            type="number"
            min={7}
            max={365}
            value={lookback}
            onChange={(e) => setLookback(Number(e.target.value) || 90)}
            style={{ ...inp(), width: 70 }}
          />
          <span style={{ color: 'var(--mt)' }}>days</span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
            <input type="checkbox" checked={managedOnly} onChange={(e) => setManagedOnly(e.target.checked)} />
            <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>
              managed only
            </span>
          </label>
          <button onClick={load} style={btnSecondary()}>REFRESH</button>
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
  if (!rows) return <div className="ld">Loading…</div>;
  const reorderNow  = rows.filter((r) => r.status === 'reorder_now');
  const reorderSoon = rows.filter((r) => r.status === 'reorder_soon');
  const healthy     = rows.filter((r) => r.status === 'healthy');
  const overstock   = rows.filter((r) => r.status === 'overstock');
  const reorder     = [...reorderNow, ...reorderSoon].sort((a, b) =>
    Number(a.days_of_supply ?? 999) - Number(b.days_of_supply ?? 999),
  );

  function exportCsv() {
    if (reorder.length === 0) return;
    const head = ['Item', 'On Hand', 'Daily Velocity', 'Days of Supply', 'Reorder Point', 'Suggested Order Qty', 'Status'];
    const data = reorder.map((r) => [
      r.item_name,
      r.on_hand ?? '',
      r.daily_velocity != null ? Number(r.daily_velocity).toFixed(2) : '',
      r.days_of_supply != null ? Number(r.days_of_supply).toFixed(0) : '',
      r.reorder_point ?? '',
      r.suggested_order_qty ?? '',
      r.status,
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

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="REORDER NOW" value={reorderNow.length} accent="var(--rd)" sub="below reorder point" />
        <KPICard title="REORDER SOON" value={reorderSoon.length} accent="var(--am)" sub="approaching reorder point" />
        <KPICard title="HEALTHY" value={healthy.length} accent="var(--gn)" />
        <KPICard title="OVERSTOCK" value={overstock.length} accent="#a78bfa" sub=">2× target days" />
      </div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 10,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        <span style={{ color: 'var(--mt)' }}>{reorder.length} items below threshold</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={printOrderSheet} disabled={reorder.length === 0} style={btnPrimary()}>PRINT ORDER SHEET</button>
          <button onClick={exportCsv} disabled={reorder.length === 0} style={btnSecondary()}>EXPORT CSV</button>
        </span>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        {reorder.length === 0 ? (
          <div className="ld">All managed inventory is healthy.</div>
        ) : (
          <div style={{ maxHeight: '58vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th>Item</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>On Hand</th>
                  <th style={{ textAlign: 'right' }}>Velocity/day</th>
                  <th style={{ textAlign: 'right' }}>Days Supply</th>
                  <th style={{ textAlign: 'right' }}>Reorder Pt</th>
                  <th style={{ textAlign: 'right' }}>Suggested Qty</th>
                </tr>
              </thead>
              <tbody>
                {reorder.map((r) => {
                  const c = STATUS_COLOR[r.status] ?? 'var(--mt)';
                  return (
                    <tr key={r.qbo_item_id}>
                      <td
                        style={{
                          fontWeight: 600,
                          maxWidth: 320,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={r.item_name}
                      >
                        {r.item_name}
                      </td>
                      <td>
                        <span
                          style={{
                            background: 'rgba(255,255,255,0.04)',
                            color: c,
                            border: '1px solid ' + c,
                            padding: '1px 7px',
                            borderRadius: 12,
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.5,
                          }}
                        >
                          {r.status.toUpperCase().replace('_', ' ')}
                        </span>
                      </td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fmtNum(r.on_hand)}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>
                        {r.daily_velocity != null ? Number(r.daily_velocity).toFixed(2) : '—'}
                      </td>
                      <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>
                        {r.days_of_supply != null ? Number(r.days_of_supply).toFixed(0) : '—'}
                      </td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>
                        {r.reorder_point ?? '—'}
                      </td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--ac)', fontWeight: 600 }}>
                        {r.suggested_order_qty ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function VelocityTable({ rows }: { rows: InventoryHealthRow[] | null }) {
  if (!rows) return <div className="ld">Loading…</div>;
  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.sold_revenue ?? 0) - Number(a.sold_revenue ?? 0)),
    [rows],
  );

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ maxHeight: '64vh', overflow: 'auto' }}>
        <table>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th style={{ textAlign: 'right' }}>Sold Qty</th>
              <th style={{ textAlign: 'right' }}>Sold Rev</th>
              <th style={{ textAlign: 'right' }}>Customers</th>
              <th style={{ textAlign: 'right' }}>Purchased Qty</th>
              <th style={{ textAlign: 'right' }}>Adj Qty</th>
              <th style={{ textAlign: 'right' }}>Shrink Qty</th>
              <th style={{ textAlign: 'right' }}>Velocity/day</th>
              <th style={{ textAlign: 'right' }}>Days Supply</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.qbo_item_id}>
                <td
                  style={{
                    fontWeight: 600,
                    maxWidth: 280,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={r.item_name}
                >
                  {r.item_name}
                </td>
                <td style={{ fontSize: 11, color: 'var(--mt)' }}>{r.category_path ?? '—'}</td>
                <td className="mn" style={{ textAlign: 'right' }}>{fmtNum(r.sold_qty)}</td>
                <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(r.sold_revenue)}</td>
                <td className="mn" style={{ textAlign: 'right' }}>{r.customers_count}</td>
                <td className="mn" style={{ textAlign: 'right' }}>{fmtNum(r.purchased_qty)}</td>
                <td
                  className="mn"
                  style={{ textAlign: 'right', color: r.adjustment_qty < 0 ? 'var(--rd)' : 'var(--mt)' }}
                >
                  {fmtNum(r.adjustment_qty)}
                </td>
                <td className="mn" style={{ textAlign: 'right', color: 'var(--rd)' }}>
                  {r.shrinkage_qty != null ? fmtNum(r.shrinkage_qty) : '—'}
                </td>
                <td className="mn" style={{ textAlign: 'right' }}>
                  {r.daily_velocity != null ? Number(r.daily_velocity).toFixed(2) : '—'}
                </td>
                <td className="mn" style={{ textAlign: 'right' }}>
                  {r.days_of_supply != null ? Number(r.days_of_supply).toFixed(0) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsTable({ rows, onChange }: { rows: InventoryHealthRow[] | null; onChange: () => void }) {
  if (!rows) return <div className="ld">Loading…</div>;

  function patch(p: Parameters<typeof setInventorySettings>[0]) {
    setInventorySettings(p).then(onChange);
  }

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ maxHeight: '64vh', overflow: 'auto' }}>
        <table>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
            <tr>
              <th>Item</th>
              <th>Managed?</th>
              <th style={{ textAlign: 'right' }}>Target Days</th>
              <th style={{ textAlign: 'right' }}>Lead Time</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.qbo_item_id}>
                <td
                  style={{
                    fontWeight: 600,
                    maxWidth: 280,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={r.item_name}
                >
                  {r.item_name}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.is_managed}
                    onChange={(e) => patch({ qbo_item_id: r.qbo_item_id, is_managed: e.target.checked })}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    type="number"
                    defaultValue={r.target_days_supply}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== r.target_days_supply) patch({ qbo_item_id: r.qbo_item_id, target_days_supply: v });
                    }}
                    style={{ ...inp(), width: 60, textAlign: 'right' }}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    type="number"
                    defaultValue={r.lead_time_days}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== r.lead_time_days) patch({ qbo_item_id: r.qbo_item_id, lead_time_days: v });
                    }}
                    style={{ ...inp(), width: 60, textAlign: 'right' }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    defaultValue={r.notes ?? ''}
                    onBlur={(e) => {
                      if ((e.target.value ?? '') !== (r.notes ?? '')) {
                        patch({ qbo_item_id: r.qbo_item_id, notes: e.target.value || null });
                      }
                    }}
                    placeholder="—"
                    style={{ ...inp(), width: 260 }}
                  />
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
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
        <div className="ct" style={{ margin: 0 }}>VELOCITY EXCLUDES — {excludes.length}</div>
        <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3 }}>
          Customers in this list don't count toward inventory velocity (used for one-off bulk buyers,
          internal transfers, samples, etc.)
        </div>
      </div>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
        <select
          style={{ ...inp(), width: '100%', maxWidth: 600 }}
          defaultValue=""
          onChange={(e) => { add(e.target.value); e.target.value = ''; }}
        >
          <option value="">+ exclude a customer from velocity</option>
          {customers
            .filter((c) => !excludes.some((ex) => ex.qbo_customer_id === c.qbo_customer_id))
            .map((c) => (
              <option key={c.qbo_customer_id} value={c.qbo_customer_id}>{c.display_name}</option>
            ))}
        </select>
      </div>
      {excludes.length === 0 ? (
        <div className="ld">No customers excluded.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Reason</th>
              <th>Added</th>
              <th></th>
            </tr>
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
                    <button
                      onClick={() => removeVelocityExclude(ex.qbo_customer_id).then(load)}
                      style={btnDanger()}
                    >
                      ×
                    </button>
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
    c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
          : c === '"' ? '&quot;'
            : '&#39;');
}
