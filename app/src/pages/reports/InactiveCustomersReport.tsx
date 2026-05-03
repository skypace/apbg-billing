import { useEffect, useState } from 'react';
import { KPICard } from '../../components/KPICard';
import { CustomerLink } from '../../components/CustomerLink';
import { fm } from '../../lib/formatters';
import { inp } from '../../lib/styles';
import { InactiveCustomerRow, fetchInactiveCustomers } from '../../lib/reports';

export function InactiveCustomersReport() {
  const today = new Date();
  const ytdStart = today.getFullYear() + '-01-01';
  const todayStr = today.toISOString().slice(0, 10);
  const priorYearStart = (today.getFullYear() - 1) + '-01-01';
  const priorYearEnd = (today.getFullYear() - 1) + '-12-31';

  const [f, setF] = useState({
    current_start: ytdStart,
    current_end: todayStr,
    prior_start: priorYearStart,
    prior_end: priorYearEnd,
    min_prior: 1000,
    max_current: 0,
  });
  const [rows, setRows] = useState<InactiveCustomerRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetchInactiveCustomers({
        current_start: f.current_start,
        current_end: f.current_end,
        prior_start: f.prior_start,
        prior_end: f.prior_end,
        min_prior_rev: Number(f.min_prior) || 1000,
        max_current_rev: Number(f.max_current) || 0,
        limit: 200,
      })
        .then((rs) => { if (!cancelled) { setRows(rs); setLoading(false); } })
        .catch(() => { if (!cancelled) { setRows([]); setLoading(false); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.current_start, f.current_end, f.prior_start, f.prior_end, f.min_prior, f.max_current]);

  if (!rows) return <div className="ld">Loading…</div>;

  const totalLost = rows.reduce((s, r) => s + Number(r.prior_revenue || 0), 0);
  const withRep = rows.filter((r) => r.primary_sales_rep).length;
  const biggest = rows[0];

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard
          title="INACTIVE CUSTOMERS"
          value={rows.length}
          accent={rows.length > 0 ? 'var(--am)' : 'var(--gn)'}
        />
        <KPICard
          title="PRIOR REV AT RISK"
          value={fm(totalLost)}
          accent="var(--am)"
          sub="prior period revenue not repeating"
        />
        <KPICard
          title="BIGGEST LOSS"
          value={biggest ? fm(biggest.prior_revenue) : '—'}
          sub={biggest?.customer_name ?? ''}
        />
        <KPICard
          title="WITH SALES REP"
          value={withRep}
          sub="have an assigned rep to call"
        />
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
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>Prior</span>
        <input type="date" value={f.prior_start} onChange={(e) => setF({ ...f, prior_start: e.target.value })} style={inp()} />
        <span style={{ color: 'var(--mt)' }}>to</span>
        <input type="date" value={f.prior_end} onChange={(e) => setF({ ...f, prior_end: e.target.value })} style={inp()} />

        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Current</span>
        <input type="date" value={f.current_start} onChange={(e) => setF({ ...f, current_start: e.target.value })} style={inp()} />
        <span style={{ color: 'var(--mt)' }}>to</span>
        <input type="date" value={f.current_end} onChange={(e) => setF({ ...f, current_end: e.target.value })} style={inp()} />

        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Min prior $</span>
        <input
          type="number"
          value={f.min_prior}
          onChange={(e) => setF({ ...f, min_prior: Number(e.target.value) })}
          style={{ ...inp(), width: 80 }}
        />
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Max current $</span>
        <input
          type="number"
          value={f.max_current}
          onChange={(e) => setF({ ...f, max_current: Number(e.target.value) })}
          style={{ ...inp(), width: 80 }}
        />
      </div>

      <div className="cd" style={{ padding: 0 }}>
        {loading ? (
          <div className="ld">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="ld">No inactive customers in this window — everyone is buying.</div>
        ) : (
          <div style={{ maxHeight: '58vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th>Customer</th>
                  <th>Channel</th>
                  <th>Sales Rep</th>
                  <th>State</th>
                  <th style={{ textAlign: 'right' }}>Prior Rev</th>
                  <th style={{ textAlign: 'right' }}>Current Rev</th>
                  <th>Last Invoice</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.qbo_customer_id}>
                    <td
                      style={{
                        fontWeight: 600,
                        maxWidth: 280,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <CustomerLink qboCustomerId={r.qbo_customer_id} name={r.customer_name} />
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--mt)' }}>{r.primary_channel ?? '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--mt)' }}>{r.primary_sales_rep ?? '— no rep —'}</td>
                    <td className="mn" style={{ fontSize: 11, color: 'var(--mt)' }}>{r.bill_state ?? '—'}</td>
                    <td className="mn" style={{ textAlign: 'right', fontWeight: 600, color: 'var(--am)' }}>
                      {fm(r.prior_revenue)}
                    </td>
                    <td className="mn" style={{ textAlign: 'right' }}>{fm(r.current_revenue)}</td>
                    <td className="mn" style={{ fontSize: 11, color: 'var(--mt)' }}>
                      {r.last_invoice_date ?? '—'}
                    </td>
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
