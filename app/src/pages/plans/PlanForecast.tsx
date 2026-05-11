import { useEffect, useState } from 'react';
import { KPICard } from '../../components/KPICard';
import { fm } from '../../lib/formatters';
import { PlanForecastRow, SalesPlan, fetchPlanForecast } from '../../lib/plans';

interface Props { plan: SalesPlan }

const STATUS_COLOR: Record<string, string> = {
  ahead: 'var(--gn)',
  on_track: 'var(--ac)',
  behind: 'var(--am)',
  critical: 'var(--rd)',
  no_data: 'var(--mt)',
};

export function PlanForecast({ plan }: Props) {
  const [rows, setRows] = useState<PlanForecastRow[] | null>(null);

  useEffect(() => {
    fetchPlanForecast(plan.id).then(setRows).catch(() => setRows([]));
  }, [plan.id]);

  if (!rows) return <div className="cd" style={{ padding: 14 }}>Computing forecast…</div>;

  const totalFY    = rows.reduce((s, r) => s + Number(r.full_year_plan ?? 0), 0);
  const totalProj  = rows.reduce((s, r) => s + Number(r.projected_full_year ?? 0), 0);
  const totalAct   = rows.reduce((s, r) => s + Number(r.ytd_actual ?? 0), 0);
  const monthsDone = rows[0]?.months_complete ?? 0;
  const deltaPct   = totalFY > 0 ? (totalProj - totalFY) / totalFY : null;
  const critical   = rows.filter((r) => r.status === 'critical');
  const behind     = rows.filter((r) => r.status === 'behind');
  const ahead      = rows.filter((r) => r.status === 'ahead');

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 10 }}>
        <KPICard title="FULL-YEAR PLAN" value={fm(totalFY)} sub={`${rows.length} lines · FY${plan.fiscal_year}`} />
        <KPICard title="YTD ACTUAL" value={fm(totalAct)} sub={monthsDone + ' months complete'} />
        <KPICard
          title="PROJECTED FULL-YEAR"
          value={fm(totalProj)}
          accent={deltaPct == null ? undefined : deltaPct >= 0 ? 'var(--gn)' : 'var(--rd)'}
          sub={
            deltaPct == null
              ? ''
              : (deltaPct >= 0 ? '+' : '') + (deltaPct * 100).toFixed(1) + '% vs plan'
          }
        />
        <KPICard
          title="CRITICAL / BEHIND"
          value={`${critical.length} / ${behind.length}`}
          accent="var(--rd)"
          sub={`${ahead.length} ahead`}
        />
      </div>

      <div className="cd" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="ld">No plan lines.</div>
        ) : (
          <div style={{ maxHeight: '58vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th>Item</th>
                  <th>Account</th>
                  <th style={{ textAlign: 'right' }}>YTD Actual</th>
                  <th style={{ textAlign: 'right' }}>YTD Plan</th>
                  <th style={{ textAlign: 'right' }}>Projected FY</th>
                  <th style={{ textAlign: 'right' }}>Plan FY</th>
                  <th style={{ textAlign: 'right' }}>Δ vs Plan</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const dPct = Number(r.projected_vs_plan_pct);
                  const color = STATUS_COLOR[r.status] ?? 'var(--mt)';
                  return (
                    <tr key={r.line_id}>
                      <td
                        style={{
                          maxWidth: 240,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: 600,
                        }}
                        title={r.item_name ?? ''}
                      >
                        {r.item_name ?? '—'}
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--mt)' }}>{r.account_name ?? '—'}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fm(r.ytd_actual)}</td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>{fm(r.ytd_plan)}</td>
                      <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>
                        {fm(r.projected_full_year)}
                      </td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>{fm(r.full_year_plan)}</td>
                      <td className="mn" style={{ textAlign: 'right', color, fontWeight: 600 }}>
                        {isFinite(dPct) ? (dPct >= 0 ? '+' : '') + (dPct * 100).toFixed(0) + '%' : '—'}
                      </td>
                      <td>
                        <span
                          style={{
                            background: 'var(--sf2)',
                            color,
                            border: '1px solid ' + color,
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
