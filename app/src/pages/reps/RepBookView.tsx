import { useEffect, useState } from 'react';
import { KPICard } from '../../components/KPICard';
import { CustomerLink } from '../../components/CustomerLink';
import { SegmentChip } from '../../components/SegmentChip';
import { fm, fp } from '../../lib/formatters';
import { btnSecondary } from '../../lib/styles';
import { RepBookRow, fetchRepBook } from '../../lib/reps';

interface Props {
  repCode: string;
  start: string;
  end: string;
  onBack: () => void;
}

export function RepBookView({ repCode, start, end, onBack }: Props) {
  const [rows, setRows] = useState<RepBookRow[] | null>(null);

  useEffect(() => {
    fetchRepBook(repCode, start, end)
      .then(setRows)
      .catch(() => setRows([]));
  }, [repCode, start, end]);

  if (!rows) return <div className="ld">Loading book…</div>;

  const totalRev = rows.reduce((s, r) => s + Number(r.revenue ?? 0), 0);
  const totalMargin = rows.reduce((s, r) => s + Number(r.est_margin ?? 0), 0);
  const inactiveCount = rows.filter(
    (r) => Number(r.recency_days ?? 0) > 60 || r.recency_days == null,
  ).length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button onClick={onBack} style={btnSecondary()}>← Reps</button>
        <div className="pt" style={{ margin: 0 }}>
          {repCode} Book{' '}
          <span className="bg bg-l" style={{ marginLeft: 6 }}>{rows.length} CUSTOMERS</span>
        </div>
      </div>

      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="BOOK REVENUE" value={fm(totalRev)} />
        <KPICard
          title="BOOK MARGIN"
          value={fm(totalMargin)}
          sub={totalRev > 0 ? fp(totalMargin / totalRev) : '—'}
        />
        <KPICard
          title="INACTIVE"
          value={inactiveCount}
          accent={inactiveCount > 0 ? 'var(--am)' : 'var(--gn)'}
          sub=">60 days no order"
        />
        <KPICard
          title="AVG REV / CUSTOMER"
          value={rows.length > 0 ? fm(totalRev / rows.length) : '—'}
        />
      </div>

      <div className="cd" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="ld">No customers assigned to this rep.</div>
        ) : (
          <div style={{ maxHeight: '62vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th>Customer</th>
                  <th>Channel</th>
                  <th>Segment</th>
                  <th style={{ textAlign: 'right' }}>Invoices</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                  <th style={{ textAlign: 'right' }}>Margin</th>
                  <th style={{ textAlign: 'right' }}>Margin %</th>
                  <th>Last Order</th>
                  <th style={{ textAlign: 'right' }}>Days Ago</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const stale = Number(r.recency_days ?? 0) > 60;
                  const mp = r.margin_pct != null ? Number(r.margin_pct) : null;
                  const mpColor =
                    mp == null
                      ? 'var(--mt)'
                      : mp >= 0.4
                        ? 'var(--gn)'
                        : mp >= 0
                          ? 'var(--am)'
                          : 'var(--rd)';
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
                      <td><SegmentChip segment={r.rfm_segment} /></td>
                      <td className="mn" style={{ textAlign: 'right' }}>{r.invoice_count}</td>
                      <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(r.revenue)}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fm(r.est_margin)}</td>
                      <td className="mn" style={{ textAlign: 'right', color: mpColor }}>{fp(r.margin_pct)}</td>
                      <td className="mn" style={{ fontSize: 11, color: 'var(--mt)' }}>
                        {r.last_invoice ?? '—'}
                      </td>
                      <td
                        className="mn"
                        style={{
                          textAlign: 'right',
                          color: stale ? 'var(--am)' : 'var(--mt)',
                          fontWeight: stale ? 600 : 400,
                        }}
                      >
                        {r.recency_days ?? '—'}
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
