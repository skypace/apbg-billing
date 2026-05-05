import { useEffect, useMemo, useState } from 'react';
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

  // Pivot the long-format rows (one per customer × item) into a customer-row × item-col matrix.
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

    const arr = Array.from(byCustomer.values()).sort((a, b) => b.set_revenue - a.set_revenue);
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
  }, [rows]);

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
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
          <input
            type="checkbox"
            checked={f.require_some}
            onChange={(e) => setF({ ...f, require_some: e.target.checked })}
          />
          <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Require ≥1 item bought
          </span>
        </label>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        {loading || !rows ? (
          <div className="ld">Loading…</div>
        ) : customers.length === 0 ? (
          <div className="ld">No customers in this set / window.</div>
        ) : (
          <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th style={{ minWidth: 200 }}>Customer</th>
                  <th>Channel</th>
                  <th style={{ textAlign: 'right' }}>Set $</th>
                  <th style={{ textAlign: 'right' }}>Bought / Total</th>
                  {itemCols.map((it) => (
                    <th key={it.id} style={{ fontSize: 9, maxWidth: 90, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={it.name}>
                      {it.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td
                      style={{
                        maxWidth: 220,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: 600,
                      }}
                      title={c.name}
                    >
                      <CustomerLink qboCustomerId={c.id} name={c.name} />
                    </td>
                    <td style={{ fontSize: 10, color: 'var(--mt)' }}>{c.channel ?? '—'}</td>
                    <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(c.set_revenue)}</td>
                    <td
                      className="mn"
                      style={{
                        textAlign: 'right',
                        color:
                          c.items_bought >= c.set_total
                            ? 'var(--gn)'
                            : c.items_bought >= c.set_total / 2
                              ? 'var(--am)'
                              : 'var(--rd)',
                      }}
                    >
                      {c.items_bought}/{c.set_total}
                    </td>
                    {itemCols.map((it) => {
                      const cell = c.cells[it.id];
                      const has = cell?.has;
                      return (
                        <td
                          key={it.id}
                          className="mn"
                          style={{
                            textAlign: 'right',
                            background: has ? 'rgba(22,163,74,0.06)' : 'rgba(220,38,38,0.04)',
                            color: has ? 'var(--gn)' : 'var(--rd)',
                            fontWeight: has ? 600 : 400,
                            fontSize: 10,
                          }}
                        >
                          {has ? fm(cell?.revenue ?? 0) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
