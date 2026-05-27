import { fm, fp } from '../../lib/formatters';
import { MONTHS_SHORT, SalesPlan, SalesPlanLine } from '../../lib/plans';

interface Props {
  plan: SalesPlan;
  lines: SalesPlanLine[];
  actualsByItem: Record<string, { amounts: number[]; total: number }> | null;
}

export function PlanVsActuals({ plan, lines, actualsByItem }: Props) {
  if (!actualsByItem) {
    return <div className="cd" style={{ padding: 14 }}>Loading actuals for FY{plan.fiscal_year}…</div>;
  }

  const today = new Date();
  const elapsedIdx =
    today.getFullYear() === plan.fiscal_year
      ? today.getMonth()
      : today.getFullYear() > plan.fiscal_year
        ? 12
        : 0;

  function summarize(line: SalesPlanLine) {
    const amts = line.amounts ?? Array(12).fill(0);
    const act = actualsByItem?.[line.item_name ?? '']?.amounts ?? Array(12).fill(0);
    const totalPlan = amts.reduce((s, v) => s + Number(v || 0), 0);
    const totalAct = act.reduce((s, v) => s + Number(v || 0), 0);
    let ytdPlan = 0, ytdAct = 0;
    for (let i = 0; i < elapsedIdx; i++) {
      ytdPlan += Number(amts[i] || 0);
      ytdAct  += Number(act[i] || 0);
    }
    const ytdVar = ytdPlan === 0 ? null : (ytdAct - ytdPlan) / ytdPlan;
    const fyVar  = totalPlan === 0 ? null : (totalAct - totalPlan) / totalPlan;
    return { totalPlan, totalAct, ytdPlan, ytdAct, ytdVar, fyVar, amts, act };
  }

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--bd)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <div className="ct" style={{ margin: 0 }}>VS ACTUALS — through {MONTHS_SHORT[Math.max(0, elapsedIdx - 1)]} {plan.fiscal_year}</div>
        <div style={{ fontSize: 10, color: 'var(--mt)' }}>{elapsedIdx} months elapsed</div>
      </div>
      <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
        <table>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
            <tr>
              <th>Item</th>
              <th style={{ textAlign: 'right' }}>YTD Plan</th>
              <th style={{ textAlign: 'right' }}>YTD Actual</th>
              <th style={{ textAlign: 'right' }}>YTD Δ%</th>
              <th style={{ textAlign: 'right' }}>FY Plan</th>
              <th style={{ textAlign: 'right' }}>FY Actual</th>
              <th style={{ textAlign: 'right' }}>FY Δ%</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr><td colSpan={7} className="ld">No lines yet.</td></tr>
            ) : (
              lines.map((l) => {
                const s = summarize(l);
                const ytdColor =
                  s.ytdVar == null
                    ? 'var(--mt)'
                    : s.ytdVar >= 0
                      ? 'var(--gn)'
                      : s.ytdVar <= -0.1
                        ? 'var(--rd)'
                        : 'var(--am)';
                const fyColor =
                  s.fyVar == null
                    ? 'var(--mt)'
                    : s.fyVar >= 0
                      ? 'var(--gn)'
                      : s.fyVar <= -0.1
                        ? 'var(--rd)'
                        : 'var(--am)';
                return (
                  <tr key={l.id}>
                    <td
                      style={{
                        maxWidth: 240,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: 600,
                      }}
                      title={l.item_name ?? ''}
                    >
                      {l.item_name ?? '—'}
                    </td>
                    <td className="mn" style={{ textAlign: 'right' }}>{fm(s.ytdPlan)}</td>
                    <td className="mn" style={{ textAlign: 'right' }}>{fm(s.ytdAct)}</td>
                    <td className="mn" style={{ textAlign: 'right', color: ytdColor, fontWeight: 600 }}>{fp(s.ytdVar)}</td>
                    <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>{fm(s.totalPlan)}</td>
                    <td className="mn" style={{ textAlign: 'right' }}>{fm(s.totalAct)}</td>
                    <td className="mn" style={{ textAlign: 'right', color: fyColor, fontWeight: 600 }}>{fp(s.fyVar)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
