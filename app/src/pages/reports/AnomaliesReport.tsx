import { useEffect, useState } from 'react';
import { KPICard } from '../../components/KPICard';
import { CustomerLink } from '../../components/CustomerLink';
import { fm } from '../../lib/formatters';
import { inp } from '../../lib/styles';
import { AnomalyRow, fetchAnomalies } from '../../lib/reports';

export function AnomaliesReport() {
  const [f, setF] = useState({
    baseline_months: 6,
    recent_months: 1,
    min_baseline: 500,
    sigma: 2.0,
  });
  const [rows, setRows] = useState<AnomalyRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    const t = setTimeout(() => {
      fetchAnomalies({
        baseline_months: Number(f.baseline_months) || 6,
        recent_months:   Number(f.recent_months) || 1,
        min_baseline:    Number(f.min_baseline) || 0,
        sigma_threshold: Number(f.sigma) || 2,
      })
        .then((rs) => { if (!cancelled) setRows(rs); })
        .catch(() => { if (!cancelled) setRows([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.baseline_months, f.recent_months, f.min_baseline, f.sigma]);

  if (!rows) return <div className="ld">Loading…</div>;
  const spikes = rows.filter((r) => r.direction === 'spike');
  const drops  = rows.filter((r) => r.direction === 'drop');

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="ANOMALIES" value={rows.length} accent="var(--am)" sub={'>' + f.sigma + 'σ from baseline'} />
        <KPICard title="SPIKES" value={spikes.length} accent="var(--gn)" sub="recent revenue above trend" />
        <KPICard title="DROPS" value={drops.length} accent="var(--rd)" sub="recent revenue below trend" />
        <KPICard
          title="BIGGEST DROP"
          value={drops[0] ? fm(drops[0].baseline_avg) : '—'}
          sub={drops[0]?.customer_name ?? 'baseline @ risk'}
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
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>Baseline months</span>
        <input
          type="number" min={2} max={24}
          value={f.baseline_months}
          onChange={(e) => setF({ ...f, baseline_months: Number(e.target.value) })}
          style={{ ...inp(), width: 60 }}
        />
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Recent months</span>
        <input
          type="number" min={1} max={6}
          value={f.recent_months}
          onChange={(e) => setF({ ...f, recent_months: Number(e.target.value) })}
          style={{ ...inp(), width: 50 }}
        />
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Min baseline $</span>
        <input
          type="number"
          value={f.min_baseline}
          onChange={(e) => setF({ ...f, min_baseline: Number(e.target.value) })}
          style={{ ...inp(), width: 80 }}
        />
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Sigma threshold</span>
        <input
          type="number" step={0.1} min={0.5} max={5}
          value={f.sigma}
          onChange={(e) => setF({ ...f, sigma: Number(e.target.value) })}
          style={{ ...inp(), width: 60 }}
        />
      </div>

      <div className="cd" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="ld">No anomalies above threshold. Drop sigma to see softer signals.</div>
        ) : (
          <div style={{ maxHeight: '62vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th>Customer</th>
                  <th>Channel</th>
                  <th>Rep</th>
                  <th>Direction</th>
                  <th style={{ textAlign: 'right' }}>Baseline avg/mo</th>
                  <th style={{ textAlign: 'right' }}>Recent avg/mo</th>
                  <th style={{ textAlign: 'right' }}>Δ%</th>
                  <th style={{ textAlign: 'right' }}>Z-score</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const dirColor = r.direction === 'spike' ? 'var(--gn)' : 'var(--rd)';
                  const dPct = Number(r.delta_pct);
                  const zs = Number(r.z_score);
                  return (
                    <tr key={r.qbo_customer_id}>
                      <td
                        style={{
                          fontWeight: 600,
                          maxWidth: 240,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <CustomerLink qboCustomerId={r.qbo_customer_id} name={r.customer_name} />
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--mt)' }}>{r.primary_channel ?? '—'}</td>
                      <td style={{ fontSize: 11, color: 'var(--mt)' }}>{r.primary_sales_rep ?? '— no rep —'}</td>
                      <td>
                        <span
                          style={{
                            background: 'rgba(255,255,255,0.04)',
                            color: dirColor,
                            border: '1px solid ' + dirColor,
                            padding: '1px 7px',
                            borderRadius: 12,
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.5,
                          }}
                        >
                          {r.direction.toUpperCase()}
                        </span>
                      </td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fm(r.baseline_avg)}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fm(r.recent_avg)}</td>
                      <td
                        className="mn"
                        style={{
                          textAlign: 'right',
                          color: dPct >= 0 ? 'var(--gn)' : 'var(--rd)',
                          fontWeight: 600,
                        }}
                      >
                        {isFinite(dPct) ? (dPct >= 0 ? '+' : '') + (dPct * 100).toFixed(0) + '%' : '—'}
                      </td>
                      <td className="mn" style={{ textAlign: 'right', color: dirColor, fontWeight: 600 }}>
                        {isFinite(zs) ? (zs >= 0 ? '+' : '') + zs.toFixed(2) : '—'}
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
