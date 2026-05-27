import { useEffect, useMemo, useState } from 'react';
import { KPICard } from '../components/KPICard';
import { MarginGrid } from '../components/MarginGrid';
import { fm, fp, fmtNum } from '../lib/formatters';
import { inp } from '../lib/styles';
import {
  Dim,
  SalesFilters,
  SalesPivotRow,
  SalesTotals,
  fetchPivot,
  fetchTotals,
} from '../lib/sales';
import { SavedView, SavedViewConfig, fetchSavedViews } from '../lib/savedViews';
import { KpiRowSkeleton, TableSkeleton } from '../components/Skeletons';

interface SideState {
  totals: SalesTotals | null;
  rows: SalesPivotRow[] | null;
}

function configToFilters(c: SavedViewConfig): SalesFilters {
  return {
    start: c.start ?? new Date().getFullYear() + '-01-01',
    end: c.end ?? new Date().toISOString().slice(0, 10),
    entities:   c.entities ?? null,
    categories: c.categories ?? null,
    customers:  c.customers ?? null,
    items:      c.items ?? null,
    channels:   c.channels ?? null,
    segments:   c.segments ?? null,
  };
}

export function ComparePage() {
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [aId, setAId] = useState<string>('');
  const [bId, setBId] = useState<string>('');
  const [a, setA] = useState<SideState>({ totals: null, rows: null });
  const [b, setB] = useState<SideState>({ totals: null, rows: null });
  const [err, setErr] = useState('');

  useEffect(() => {
    fetchSavedViews()
      .then((vs) => {
        setViews(vs);
        if (vs.length >= 2 && !aId && !bId) {
          setAId(vs[0].id);
          setBId(vs[1].id);
        } else if (vs.length === 1 && !aId) {
          setAId(vs[0].id);
        }
      })
      .catch(() => setViews([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const aView = useMemo(() => views?.find((v) => v.id === aId) ?? null, [views, aId]);
  const bView = useMemo(() => views?.find((v) => v.id === bId) ?? null, [views, bId]);

  useEffect(() => { runSide(aView, setA); }, [aView]);
  useEffect(() => { runSide(bView, setB); }, [bView]);

  function runSide(v: SavedView | null, setSide: (s: SideState) => void) {
    if (!v) { setSide({ totals: null, rows: null }); return; }
    const f = configToFilters(v.config);
    const dim = (v.config.dim ?? 'category') as Dim;
    Promise.all([fetchTotals(f), fetchPivot(dim, f, 250)])
      .then(([t, p]) => setSide({ totals: t, rows: p ?? [] }))
      .catch((e) => { setErr(e.message); setSide({ totals: null, rows: [] }); });
  }

  const HeroBlock = (
    <div className="hero">
      <div>
        <div className="hero-eyebrow">Saved views · A / B</div>
        <h1 className="hero-title">Compare</h1>
        <div className="hero-meta">Two saved views, side by side</div>
      </div>
      <div className="hero-stamp">
        <span className="status-dot" aria-hidden="true" />
        {views?.length ?? '…'} saved views
      </div>
    </div>
  );

  if (!views) return (
    <div>
      {HeroBlock}
      <KpiRowSkeleton count={4} />
    </div>
  );
  if (views.length === 0) {
    return (
      <div>
        {HeroBlock}
        <div className="cd" style={{ padding: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--mt)' }}>
            No saved views yet. Build one in the legacy <a href="/sales/#margin">Margin</a> page first
            (saving views in the new app comes later).
          </div>
        </div>
      </div>
    );
  }

  function renderSide(label: string, view: SavedView | null, side: SideState) {
    if (!view) return <div className="ld">Pick a saved view.</div>;
    return (
      <div>
        <div style={{ marginBottom: 8 }}>
          <div className="ct" style={{ margin: 0 }}>{label} · {view.name}</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>
            {(view.config.dim ?? 'category')} · {(view.config.start ?? '?')} → {(view.config.end ?? '?')}
          </div>
        </div>
        {side.totals ? (
          <div className="gr g4" style={{ marginBottom: 10 }}>
            <KPICard title="REVENUE" value={fm(side.totals.revenue)} sub={fmtNum(side.totals.invoice_count) + ' invoices'} />
            <KPICard title="MARGIN" value={fm(side.totals.est_margin)} sub={fp(side.totals.margin_pct)} />
            <KPICard title="CUSTOMERS" value={fmtNum(side.totals.customer_count)} sub={fmtNum(side.totals.item_count) + ' items'} />
            <KPICard title="COVERAGE" value={fp(side.totals.cost_coverage_pct)} sub="cost coverage" />
          </div>
        ) : (
          <KpiRowSkeleton count={4} />
        )}
        <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
          {!side.rows ? (
            <TableSkeleton rows={6} cols={6} />
          ) : (
            <MarginGrid
              dim={(view.config.dim ?? 'category') as Dim}
              rows={side.rows}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {HeroBlock}

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 14,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
          <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>View A</span>
          <select value={aId} onChange={(e) => setAId(e.target.value)} style={{ ...inp(), flex: 1 }}>
            <option value="">— pick —</option>
            {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
          <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>View B</span>
          <select value={bId} onChange={(e) => setBId(e.target.value)} style={{ ...inp(), flex: 1 }}>
            <option value="">— pick —</option>
            {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
      </div>

      {err && <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>}

      <div className="gr g2" style={{ alignItems: 'flex-start' }}>
        {renderSide('A', aView, a)}
        {renderSide('B', bView, b)}
      </div>
    </div>
  );
}
