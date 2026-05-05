import { useEffect, useState } from 'react';
import { KPICard } from '../../components/KPICard';
import { CustomerLink } from '../../components/CustomerLink';
import { SegmentChip } from '../../components/SegmentChip';
import { fm } from '../../lib/formatters';
import { btnSecondary, inp } from '../../lib/styles';
import { HealthMoverRow, fetchHealthMovers, takeHealthSnapshot } from '../../lib/reports';

export function HealthMoversReport() {
  const [maxAge, setMaxAge] = useState(14);
  const [rows, setRows] = useState<HealthMoverRow[] | null>(null);
  const [snapMsg, setSnapMsg] = useState('');

  function load() {
    setRows(null);
    fetchHealthMovers(Number(maxAge) || 14)
      .then(setRows)
      .catch(() => setRows([]));
  }
  useEffect(load, [maxAge]);

  function takeSnapshot() {
    setSnapMsg('snapshotting…');
    takeHealthSnapshot()
      .then((n) => {
        setSnapMsg('snapshot taken: ' + (n ?? 0) + ' customers');
        load();
      })
      .catch((e) => setSnapMsg('error: ' + e.message));
  }

  if (!rows) return <div className="ld">Loading…</div>;

  const promoted = rows.filter((r) => Number(r.rfm_total_delta) > 0 || r.prev_segment === null);
  const demoted  = rows.filter((r) => Number(r.rfm_total_delta) < 0);
  const bigJump  = rows.filter((r) => Math.abs(Number(r.rfm_total_delta) || 0) >= 3);
  const newCust  = rows.filter((r) => r.prev_segment === null);

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="CUSTOMERS WITH MOVEMENT" value={rows.length} accent="var(--ac)" />
        <KPICard title="PROMOTED" value={promoted.length} accent="var(--gn)" sub="higher RFM or new" />
        <KPICard title="DEMOTED" value={demoted.length} accent="var(--rd)" sub="lower RFM total" />
        <KPICard title="BIG MOVES (≥3)" value={bigJump.length} accent="var(--am)" sub="segment-changing magnitudes" />
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
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>
          Compare vs snapshot within last
        </span>
        <input
          type="number"
          min={1}
          max={90}
          value={maxAge}
          onChange={(e) => setMaxAge(Number(e.target.value) || 14)}
          style={{ ...inp(), width: 60 }}
        />
        <span style={{ color: 'var(--mt)' }}>days</span>
        <button onClick={takeSnapshot} style={btnSecondary()}>TAKE SNAPSHOT NOW</button>
        {snapMsg && <span style={{ color: 'var(--mt)', fontSize: 10, marginLeft: 8 }}>{snapMsg}</span>}
        {newCust.length > 0 && (
          <span style={{ color: 'var(--mt)', fontSize: 10, marginLeft: 'auto' }}>
            {newCust.length} first-seen this period
          </span>
        )}
      </div>

      <div className="cd" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="ld">
            No customer health movement detected. Either no prior snapshot exists in this window, or every
            customer is stable.
          </div>
        ) : (
          <div style={{ maxHeight: '62vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th>Customer</th>
                  <th>Channel</th>
                  <th>Was</th>
                  <th>Now</th>
                  <th style={{ textAlign: 'right' }}>RFM Δ</th>
                  <th style={{ textAlign: 'right' }}>Monetary Δ</th>
                  <th>Movement</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = Number(r.rfm_total_delta);
                  const md = Number(r.monetary_delta);
                  const dColor = d > 0 ? 'var(--gn)' : d < 0 ? 'var(--rd)' : 'var(--mt)';
                  const mdColor = md > 0 ? 'var(--gn)' : md < 0 ? 'var(--rd)' : 'var(--mt)';
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
                      <td><SegmentChip segment={r.prev_segment} /></td>
                      <td><SegmentChip segment={r.curr_segment} /></td>
                      <td className="mn" style={{ textAlign: 'right', color: dColor, fontWeight: 600 }}>
                        {d > 0 ? '+' : ''}{d}
                      </td>
                      <td className="mn" style={{ textAlign: 'right', color: mdColor, fontWeight: 600 }}>
                        {md > 0 ? '+' : ''}{fm(md)}
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--mt)' }}>{r.movement || '—'}</td>
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
