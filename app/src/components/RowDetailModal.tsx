import { useEffect, useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { X } from 'lucide-react';
import { fm, fp, fmtNum } from '../lib/formatters';
import { sbrpc } from '../lib/rpc';
import type { Dim, SalesPivotRow } from '../lib/sales';

interface Props {
  open: boolean;
  onClose: () => void;
  row: (SalesPivotRow & Record<string, unknown>) | null;
  dim: Dim;
  start: string;
  end: string;
}

interface PriceLadderRow {
  customer_name: string;
  invoices: number;
  qty: number;
  revenue: number;
  avg_price: number;
  median_overall: number;
  delta_to_median: number;
}

type TabId = 'waterfall' | 'ladder' | 'whatif';

const tabSx = {
  minHeight: 32,
  '& .MuiTabs-indicator': { background: 'var(--ac)', height: 2 },
  '& .MuiTab-root': {
    minHeight: 32, padding: '4px 14px', textTransform: 'uppercase',
    color: 'var(--mt)', fontSize: 11, fontWeight: 600, letterSpacing: 0.6, fontFamily: 'inherit',
  },
  '& .Mui-selected': { color: 'var(--ac) !important' },
};

export function RowDetailModal({ open, onClose, row, dim, start, end }: Props) {
  const [tab, setTab] = useState<TabId>('waterfall');
  const [priceLadder, setPriceLadder] = useState<PriceLadderRow[] | null>(null);
  const [ladderLoading, setLadderLoading] = useState(false);

  const canShowLadder = dim === 'item';

  // What-if state
  const [priceDelta, setPriceDelta] = useState(0);   // %
  const [volumeDelta, setVolumeDelta] = useState(0); // %

  useEffect(() => {
    if (!open) {
      setTab('waterfall');
      setPriceLadder(null);
      setPriceDelta(0);
      setVolumeDelta(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || tab !== 'ladder' || !row || !canShowLadder) return;
    setLadderLoading(true);
    sbrpc<PriceLadderRow[]>('fn_item_price_ladder', {
      p_item: row.dim_label,
      p_start: start,
      p_end: end,
    })
      .then((rs) => { setPriceLadder(rs ?? []); setLadderLoading(false); })
      .catch(() => { setPriceLadder([]); setLadderLoading(false); });
  }, [open, tab, row, canShowLadder, start, end]);

  const waterfall = useMemo(() => {
    if (!row) return null;
    const revenue = Number(row.revenue ?? 0);
    const cost = row.est_cost != null ? Number(row.est_cost) : 0;
    const grossMargin = row.est_margin != null ? Number(row.est_margin) : revenue - cost;
    const overhead = row._overhead != null ? Number(row._overhead) : 0;
    const netMargin = grossMargin - overhead;

    const steps = [
      { label: 'Revenue',           value: revenue,        running: revenue,           kind: 'pos' as const },
      { label: '− COGS',            value: -cost,          running: revenue - cost,    kind: 'neg' as const },
      { label: 'Gross Margin',      value: grossMargin,    running: grossMargin,       kind: 'sum' as const },
      { label: '− Allocated OH',    value: -overhead,      running: grossMargin - overhead, kind: 'neg' as const },
      { label: 'Net Margin',        value: netMargin,      running: netMargin,         kind: 'sum' as const },
    ];
    return { steps, revenue, grossMargin, netMargin };
  }, [row]);

  const whatIf = useMemo(() => {
    if (!row || !waterfall) return null;
    const qty = Number(row.qty ?? 0);
    const baseRev = waterfall.revenue;
    const baseCost = baseRev - waterfall.grossMargin;
    const overhead = baseRev - waterfall.grossMargin <= 0 ? 0 : (waterfall.grossMargin - waterfall.netMargin);

    const newPriceFactor = 1 + priceDelta / 100;
    const newVolFactor = 1 + volumeDelta / 100;
    const newQty = qty * newVolFactor;
    const newRev = baseRev * newPriceFactor * newVolFactor;
    const newCost = baseCost * newVolFactor; // assume COGS scales with volume, not price
    const newGross = newRev - newCost;
    // Overhead: keep absolute pool flat (sell more = OH per row may change in aggregate but
    // for what-if we hold this row's overhead constant — that's the realistic per-row scenario).
    const newOH = overhead;
    const newNet = newGross - newOH;

    return {
      baseRev, newRev, deltaRev: newRev - baseRev, deltaRevPct: baseRev > 0 ? (newRev - baseRev) / baseRev : 0,
      baseGross: waterfall.grossMargin, newGross, deltaGross: newGross - waterfall.grossMargin,
      baseNet: waterfall.netMargin, newNet, deltaNet: newNet - waterfall.netMargin,
      baseQty: qty, newQty,
      newUnitPrice: newQty > 0 ? newRev / newQty : null,
      newUnitNet:   newQty > 0 ? newNet / newQty : null,
    };
  }, [row, waterfall, priceDelta, volumeDelta]);

  if (!row) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      slotProps={{
        paper: { sx: { background: 'var(--sf)', color: 'var(--tx)', border: '1px solid var(--bd)' } },
      }}
    >
      <DialogTitle sx={{ p: 0 }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--bd)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>
              {dim} · row detail
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={row.dim_label}>
              {row.dim_label}
            </div>
          </div>
          <button onClick={onClose} className="tb-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <X size={12} strokeWidth={2.4} />
            <span>Close</span>
          </button>
        </div>
        <Tabs value={tab} onChange={(_, v) => setTab(v as TabId)} sx={tabSx}>
          <Tab value="waterfall" label="Waterfall" />
          {canShowLadder && <Tab value="ladder" label="Price Ladder" />}
          <Tab value="whatif" label="What-if" />
        </Tabs>
      </DialogTitle>

      <DialogContent sx={{ p: 2, background: 'var(--bg)' }}>
        {tab === 'waterfall' && waterfall && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 10 }}>
              Decomposition of the row's revenue into COGS, gross margin, allocated overhead, and net margin.
            </div>
            <table style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Step</th>
                  <th style={{ textAlign: 'right' }}>Δ</th>
                  <th style={{ textAlign: 'right' }}>Running</th>
                </tr>
              </thead>
              <tbody>
                {waterfall.steps.map((s, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: s.kind === 'sum' ? 700 : 500, color: s.kind === 'sum' ? 'var(--ac)' : 'var(--tx)' }}>
                      {s.label}
                    </td>
                    <td className="mn" style={{
                      textAlign: 'right',
                      color: s.kind === 'pos' ? 'var(--gn)' : s.kind === 'neg' ? 'var(--rd)' : 'var(--tx)',
                      fontWeight: s.kind === 'sum' ? 700 : 500,
                    }}>
                      {s.kind === 'sum' ? '' : fm(s.value)}
                    </td>
                    <td className="mn" style={{ textAlign: 'right', fontWeight: s.kind === 'sum' ? 700 : 500 }}>
                      {fm(s.running)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 14, fontSize: 11, color: 'var(--mt)' }}>
              Net margin %: <strong style={{ color: 'var(--tx)' }}>
                {waterfall.revenue > 0 ? fp(waterfall.netMargin / waterfall.revenue) : '—'}
              </strong>
              {' · '}Gross margin %: <strong style={{ color: 'var(--tx)' }}>
                {waterfall.revenue > 0 ? fp(waterfall.grossMargin / waterfall.revenue) : '—'}
              </strong>
            </div>
          </div>
        )}

        {tab === 'ladder' && canShowLadder && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 10 }}>
              Customers paying for this item, sorted by revenue. Avg price compared to the median across all customers — flagged red when below.
            </div>
            {ladderLoading ? (
              <div className="ld">Loading price distribution…</div>
            ) : !priceLadder || priceLadder.length === 0 ? (
              <div className="ld">No sales in this window for this item.</div>
            ) : (
              <div style={{ maxHeight: '54vh', overflow: 'auto' }}>
                <table>
                  <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                    <tr>
                      <th>Customer</th>
                      <th style={{ textAlign: 'right' }}>Inv</th>
                      <th style={{ textAlign: 'right' }}>Qty</th>
                      <th style={{ textAlign: 'right' }}>Revenue</th>
                      <th style={{ textAlign: 'right' }}>Avg Price</th>
                      <th style={{ textAlign: 'right' }}>vs Median</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceLadder.map((p) => {
                      const below = Number(p.delta_to_median) < 0;
                      return (
                        <tr key={p.customer_name} style={below ? { background: 'rgba(220,38,38,0.05)' } : undefined}>
                          <td title={p.customer_name} style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                            {p.customer_name}
                          </td>
                          <td className="mn" style={{ textAlign: 'right' }}>{p.invoices}</td>
                          <td className="mn" style={{ textAlign: 'right' }}>{fmtNum(Number(p.qty))}</td>
                          <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(Number(p.revenue))}</td>
                          <td className="mn" style={{ textAlign: 'right' }}>{fm(Number(p.avg_price))}</td>
                          <td className="mn" style={{
                            textAlign: 'right', fontWeight: 600,
                            color: below ? 'var(--rd)' : 'var(--gn)',
                          }}>
                            {Number(p.delta_to_median) >= 0 ? '+' : ''}{fm(Number(p.delta_to_median))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {priceLadder && priceLadder.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--mt)' }}>
                Median price across {priceLadder.length} customer{priceLadder.length === 1 ? '' : 's'}: <strong style={{ color: 'var(--tx)' }}>{fm(Number(priceLadder[0].median_overall))}</strong>
              </div>
            )}
          </div>
        )}

        {tab === 'whatif' && whatIf && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 14 }}>
              Project the impact of a price change and a volume change. COGS scales with volume; allocated overhead stays flat for this row.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 80px', gap: 10, alignItems: 'center', marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: 'var(--mt)' }}>Price change</label>
              <input
                type="range" min={-50} max={50} step={1} value={priceDelta}
                onChange={(e) => setPriceDelta(Number(e.target.value))}
                style={{ accentColor: 'var(--ac)' }}
              />
              <span className="mn" style={{ textAlign: 'right', fontWeight: 600, color: priceDelta >= 0 ? 'var(--gn)' : 'var(--rd)' }}>
                {priceDelta >= 0 ? '+' : ''}{priceDelta}%
              </span>

              <label style={{ fontSize: 11, color: 'var(--mt)' }}>Volume change</label>
              <input
                type="range" min={-50} max={50} step={1} value={volumeDelta}
                onChange={(e) => setVolumeDelta(Number(e.target.value))}
                style={{ accentColor: 'var(--ac)' }}
              />
              <span className="mn" style={{ textAlign: 'right', fontWeight: 600, color: volumeDelta >= 0 ? 'var(--gn)' : 'var(--rd)' }}>
                {volumeDelta >= 0 ? '+' : ''}{volumeDelta}%
              </span>
            </div>

            <table style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th></th>
                  <th style={{ textAlign: 'right' }}>Current</th>
                  <th style={{ textAlign: 'right' }}>Projected</th>
                  <th style={{ textAlign: 'right' }}>Δ</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Revenue</td>
                  <td className="mn" style={{ textAlign: 'right' }}>{fm(whatIf.baseRev)}</td>
                  <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(whatIf.newRev)}</td>
                  <td className="mn" style={{ textAlign: 'right', color: whatIf.deltaRev >= 0 ? 'var(--gn)' : 'var(--rd)', fontWeight: 600 }}>
                    {whatIf.deltaRev >= 0 ? '+' : ''}{fm(whatIf.deltaRev)}
                  </td>
                </tr>
                <tr>
                  <td>Gross Margin</td>
                  <td className="mn" style={{ textAlign: 'right' }}>{fm(whatIf.baseGross)}</td>
                  <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(whatIf.newGross)}</td>
                  <td className="mn" style={{ textAlign: 'right', color: whatIf.deltaGross >= 0 ? 'var(--gn)' : 'var(--rd)', fontWeight: 600 }}>
                    {whatIf.deltaGross >= 0 ? '+' : ''}{fm(whatIf.deltaGross)}
                  </td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600, color: 'var(--ac)' }}>Net Margin</td>
                  <td className="mn" style={{ textAlign: 'right' }}>{fm(whatIf.baseNet)}</td>
                  <td className="mn" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--ac)' }}>{fm(whatIf.newNet)}</td>
                  <td className="mn" style={{ textAlign: 'right', color: whatIf.deltaNet >= 0 ? 'var(--gn)' : 'var(--rd)', fontWeight: 700 }}>
                    {whatIf.deltaNet >= 0 ? '+' : ''}{fm(whatIf.deltaNet)}
                  </td>
                </tr>
                {whatIf.baseQty > 0 && (
                  <>
                    <tr>
                      <td>Units sold</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fmtNum(whatIf.baseQty)}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fmtNum(whatIf.newQty)}</td>
                      <td></td>
                    </tr>
                    <tr>
                      <td>Unit price</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fm(whatIf.baseRev / whatIf.baseQty)}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{whatIf.newUnitPrice != null ? fm(whatIf.newUnitPrice) : '—'}</td>
                      <td></td>
                    </tr>
                    <tr>
                      <td>Unit net</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fm(whatIf.baseNet / whatIf.baseQty)}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{whatIf.newUnitNet != null ? fm(whatIf.newUnitNet) : '—'}</td>
                      <td></td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
