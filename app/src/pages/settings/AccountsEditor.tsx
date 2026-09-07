import { useEffect, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import { btnSecondary, inp } from '../../lib/styles';
import { fetchAccountSettings, setAccountActive, type AccountSettingRow } from '../../lib/settings';
import { useToast } from '../../lib/toast';

// Accounts come from QBO (read-only naming). The user can only toggle each
// P&L account active or inactive — toggling inactive hides every item
// attached to that account from the Items master grid. Historical sales
// data on v_sales_lines stays unaffected.

export function AccountsEditor() {
  const [rows, setRows] = useState<AccountSettingRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(true);
  const toast = useToast();

  function load() {
    fetchAccountSettings()
      .then((rs) => setRows(rs))
      .catch((e) => { toast.error('Load failed: ' + (e as Error).message); setRows([]); });
  }
  useEffect(load, []);

  async function toggle(name: string, next: boolean) {
    try {
      await setAccountActive(name, next);
      setRows((cur) => cur?.map((r) =>
        r.account_name === name ? { ...r, is_active: next } : r,
      ) ?? cur);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  if (!rows) return <div className="ld">Loading accounts…</div>;

  const q = search.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (q && !r.account_name.toLowerCase().includes(q)) return false;
    if (!showInactive && !r.is_active) return false;
    return true;
  });

  const activeCount   = rows.filter((r) => r.is_active).length;
  const inactiveCount = rows.length - activeCount;
  const hiddenItems   = rows.filter((r) => !r.is_active).reduce((s, r) => s + r.item_count, 0);

  return (
    <div>
      <div className="cd" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div className="ct" style={{ margin: 0, marginBottom: 4 }}>P&amp;L ACCOUNTS — {rows.length}</div>
        <div style={{ fontSize: 11, color: 'var(--mt)', lineHeight: 1.4 }}>
          One row per income account from QBO. Toggle an account inactive to hide every item
          attached to it from the Items master. Historical sales / margin data stays intact —
          if you want to exclude an account from a margin report, use the Account filter
          on the Margin page instead.
        </div>
      </div>

      <div className="gr g4" style={{ marginBottom: 12 }}>
        <div className="kpi-card">
          <div className="kpi-label">ACTIVE</div>
          <div className="kpi-value">{activeCount}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">INACTIVE</div>
          <div className="kpi-value" style={{ color: inactiveCount > 0 ? 'var(--am)' : undefined }}>
            {inactiveCount}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">ITEMS HIDDEN</div>
          <div className="kpi-value" style={{ color: hiddenItems > 0 ? 'var(--am)' : undefined }}>
            {hiddenItems}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">TOTAL ITEMS</div>
          <div className="kpi-value">{rows.reduce((s, r) => s + r.item_count, 0)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <input
          type="text" placeholder="Search account name…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ ...inp(), flex: 1, maxWidth: 400 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--tx2)' }}>
          <input type="checkbox" checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <button onClick={load} style={btnSecondary()}>Refresh</button>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
          <PrintableTable>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th style={{ textAlign: 'left' }}>Account name</th>
                  <th style={{ textAlign: 'right' }}>Items</th>
                  <th style={{ textAlign: 'right' }}>Active items</th>
                  <th style={{ textAlign: 'center', width: 110 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={4} style={{ padding: 14, color: 'var(--mt)' }}>No accounts match.</td></tr>
                ) : (
                  filtered.map((r) => (
                    <tr key={r.account_name} style={{ opacity: r.is_active ? 1 : 0.55 }}>
                      <td style={{ fontSize: 12 }}>{r.account_name}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{r.item_count}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{r.active_item_count}</td>
                      <td style={{ textAlign: 'center' }}>
                        <label style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          cursor: 'pointer', fontSize: 11,
                          color: r.is_active ? 'var(--gn)' : 'var(--am)',
                          fontWeight: 600,
                        }}>
                          <input type="checkbox" checked={r.is_active}
                            onChange={(e) => toggle(r.account_name, e.target.checked)} />
                          {r.is_active ? 'Active' : 'Hidden'}
                        </label>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </PrintableTable>
        </div>
      </div>
    </div>
  );
}
