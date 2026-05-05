import { useEffect, useMemo, useState } from 'react';
import { fm, fp } from '../../lib/formatters';
import { inp } from '../../lib/styles';
import { TopMoverRow, fetchTopMovers } from '../../lib/reports';

type Dim = 'customer' | 'item' | 'category' | 'segment';

export function TopMoversReport() {
  const today = new Date();
  const ytdStart = today.getFullYear() + '-01-01';
  const todayStr = today.toISOString().slice(0, 10);
  const priorYearStart = (today.getFullYear() - 1) + '-01-01';
  const priorYearEnd = (today.getFullYear() - 1) + '-12-31';

  const [f, setF] = useState({
    dim: 'customer' as Dim,
    current_start: ytdStart,
    current_end: todayStr,
    prior_start: priorYearStart,
    prior_end: priorYearEnd,
  });
  const [rows, setRows] = useState<TopMoverRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      fetchTopMovers({
        dim: f.dim,
        start: f.current_start,
        end: f.current_end,
        prev_start: f.prior_start,
        prev_end: f.prior_end,
        limit: 50,
      })
        .then((rs) => { if (!cancelled) setRows(rs); })
        .catch(() => { if (!cancelled) setRows([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.dim, f.current_start, f.current_end, f.prior_start, f.prior_end]);

  const { gainers, losers } = useMemo(() => {
    if (!rows) return { gainers: [], losers: [] };
    const g = rows.filter((r) => Number(r.delta_rev) > 0)
      .sort((a, b) => Number(b.delta_rev) - Number(a.delta_rev))
      .slice(0, 20);
    const l = rows.filter((r) => Number(r.delta_rev) < 0)
      .sort((a, b) => Number(a.delta_rev) - Number(b.delta_rev))
      .slice(0, 20);
    return { gainers: g, losers: l };
  }, [rows]);

  if (!rows) return <div className="ld">Loading…</div>;

  const DIMS: { id: Dim; label: string }[] = [
    { id: 'customer', label: 'Customer' },
    { id: 'item',     label: 'Item' },
    { id: 'category', label: 'Category' },
    { id: 'segment',  label: 'Segment' },
  ];

  return (
    <div>
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
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>By</span>
        <div style={{ display: 'inline-flex', gap: 4 }}>
          {DIMS.map((d) => {
            const on = f.dim === d.id;
            return (
              <button
                key={d.id}
                onClick={() => setF({ ...f, dim: d.id })}
                style={{
                  background: on ? 'var(--ac)' : 'var(--sf2)',
                  color: on ? 'var(--bg)' : 'var(--tx)',
                  border: '1px solid var(--bd)',
                  padding: '4px 9px',
                  borderRadius: 4,
                  fontSize: 11,
                  cursor: 'pointer',
                  fontWeight: on ? 700 : 400,
                }}
              >
                {d.label}
              </button>
            );
          })}
        </div>

        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>
          Current
        </span>
        <input type="date" value={f.current_start} onChange={(e) => setF({ ...f, current_start: e.target.value })} style={inp()} />
        <span style={{ color: 'var(--mt)' }}>to</span>
        <input type="date" value={f.current_end} onChange={(e) => setF({ ...f, current_end: e.target.value })} style={inp()} />

        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>vs Prior</span>
        <input type="date" value={f.prior_start} onChange={(e) => setF({ ...f, prior_start: e.target.value })} style={inp()} />
        <span style={{ color: 'var(--mt)' }}>to</span>
        <input type="date" value={f.prior_end} onChange={(e) => setF({ ...f, prior_end: e.target.value })} style={inp()} />
      </div>

      <div className="gr g2">
        <MoverColumn title="TOP GAINERS" items={gainers} color="var(--gn)" />
        <MoverColumn title="TOP DECLINERS" items={losers} color="var(--rd)" />
      </div>
    </div>
  );
}

function MoverColumn({ title, items, color }: { title: string; items: TopMoverRow[]; color: string }) {
  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
        <div className="ct" style={{ margin: 0, color }}>{title}</div>
      </div>
      {items.length === 0 ? (
        <div className="ld">No movers in this window.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th style={{ textAlign: 'right' }}>Current</th>
              <th style={{ textAlign: 'right', color }}>Δ $</th>
              <th style={{ textAlign: 'right', color: 'var(--mt)' }}>Δ %</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const dr = Number(r.delta_rev);
              const sign = dr >= 0 ? '+' : '';
              return (
                <tr key={r.dim_label}>
                  <td
                    style={{
                      maxWidth: 300,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={r.dim_label}
                  >
                    {r.dim_label}
                  </td>
                  <td className="mn" style={{ textAlign: 'right' }}>{fm(r.current_rev)}</td>
                  <td className="mn" style={{ textAlign: 'right', color, fontWeight: 600 }}>
                    {sign}{fm(dr)}
                  </td>
                  <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>
                    {fp(r.delta_pct)}
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
