import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDown, ChevronRight, Download, Loader2, RefreshCw, TrendingUp } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import {
  fetchSpendReport, fetchVendorDetail, alignMonthly, pctChange, buildSpendCsv,
  type SpendReport, type SpendRow, type SpendDetailRow,
} from '@/lib/spend';

// Spending — what are we spending, where, and what's growing.
//
// Source is the QBO expense mirror: ALL booked spend (bills keyed straight
// into QuickBooks included), accrual-dated, refreshed daily. This is a trends
// report, not a P&L — the P&L is QuickBooks' to print.

const WINDOWS = [6, 12, 24];

function monthLabel(ym: string) {
  const [y, m] = ym.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y.slice(2)}`;
}

/** Compact column chart for the window's monthly totals. */
function MonthlyBars({ data }: { data: { month: string; total: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.total));
  return (
    <div className="flex items-end gap-1 h-28 w-full">
      {data.map((d) => (
        <div key={d.month} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${monthLabel(d.month)} · ${formatCurrency(d.total)}`}>
          <div
            className="w-full rounded-t bg-primary/70 hover:bg-primary transition-colors"
            style={{ height: `${Math.max(2, (Math.max(0, d.total) / max) * 88)}px` }}
          />
          <span className="text-[9px] text-muted-foreground truncate w-full text-center">{monthLabel(d.month)}</span>
        </div>
      ))}
    </div>
  );
}

/** Tiny inline sparkline for one row's monthly series. */
function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const w = 4, gap = 1;
  return (
    <svg width={values.length * (w + gap)} height={18} className="shrink-0" aria-hidden>
      {values.map((v, i) => {
        const h = Math.max(1, (Math.abs(v) / max) * 16);
        return (
          <rect
            key={i} x={i * (w + gap)} y={18 - h} width={w} height={h} rx={1}
            className={v < 0 ? 'fill-emerald-500/80' : 'fill-primary/60'}
          />
        );
      })}
    </svg>
  );
}

function ChangeBadge({ current, previous }: { current: number; previous: number }) {
  const chg = pctChange(current, previous);
  if (chg === null) return <Badge variant="secondary">new</Badge>;
  const up = chg > 0;
  if (Math.abs(chg) < 1) return <Badge variant="secondary">flat</Badge>;
  return (
    <Badge variant={up ? 'destructive' : 'default'} title={`Prior window: ${formatCurrency(previous)}`}>
      {up ? '▲' : '▼'} {Math.abs(chg).toFixed(0)}%
    </Badge>
  );
}

function VendorDrill({ vendor, months }: { vendor: string; months: number }) {
  const [rows, setRows] = useState<SpendDetailRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchVendorDetail(vendor, months)
      .then((r) => { if (live) setRows(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Failed to load'); });
    return () => { live = false; };
  }, [vendor, months]);

  if (error) return <p className="text-xs text-destructive px-3 py-2">{error}</p>;
  if (!rows) return <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  return (
    <div className="px-3 pb-2 space-y-0.5">
      {rows.map((r, i) => (
        <div key={`${r.qbo_txn_id}-${i}`} className="flex items-center gap-2 text-xs py-1 border-b border-border/40 last:border-0">
          <span className="text-muted-foreground w-20 shrink-0">{r.txn_date}</span>
          <Badge variant="secondary" className="text-[10px]">{r.qbo_txn_type === 'VendorCredit' ? 'Credit' : r.qbo_txn_type}</Badge>
          <span className="text-muted-foreground truncate flex-1">
            {r.account_name || '—'}{r.description ? ` · ${r.description}` : ''}
          </span>
          <span className={`font-semibold tabular-nums ${r.amount < 0 ? 'text-emerald-500' : ''}`}>
            {formatCurrency(r.amount)}
          </span>
        </div>
      ))}
      {rows.length >= 100 && <p className="text-[10px] text-muted-foreground pt-1">Showing the 100 most recent lines.</p>}
    </div>
  );
}

type SortKey = 'total' | 'growth';

function SpendTable({
  rows, months, windowMonths, drillable,
}: {
  rows: SpendRow[];
  months: string[];
  windowMonths: number;
  drillable: boolean;
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('total');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const windowTotal = rows.reduce((s, r) => s + r.total, 0) || 1;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    let out = term ? rows.filter((r) => r.name.toLowerCase().includes(term)) : [...rows];
    if (sort === 'growth') {
      // Growth = absolute dollars added vs the prior window. Percent alone
      // makes a $12 vendor "growing 900%" outrank a $40k jump.
      out.sort((a, b) => (b.total - b.prev_total) - (a.total - a.prev_total));
    } else {
      out.sort((a, b) => b.total - a.total);
    }
    return out;
  }, [rows, search, sort]);

  const visible = showAll ? filtered : filtered.slice(0, 25);

  const exportCsv = () => {
    const blob = new Blob([buildSpendCsv(filtered, months)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `spending-${windowMonths}mo.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-[220px]"
        />
        <div className="flex gap-1">
          <Button size="sm" variant={sort === 'total' ? 'default' : 'outline'} onClick={() => setSort('total')}>
            Biggest
          </Button>
          <Button size="sm" variant={sort === 'growth' ? 'default' : 'outline'} onClick={() => setSort('growth')}>
            <TrendingUp className="h-3.5 w-3.5 mr-1" /> Growing fastest
          </Button>
        </div>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={exportCsv} title="Download CSV">
          <Download className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-1">
        {visible.map((r) => {
          const open = openRow === r.name;
          return (
            <div key={r.name} className="rounded-lg border border-border">
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-muted/40"
                onClick={() => drillable && setOpenRow(open ? null : r.name)}
              >
                {drillable && (open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />)}
                <span className="font-medium truncate flex-1" title={r.name}>{r.name}</span>
                <Spark values={alignMonthly(r, months)} />
                <ChangeBadge current={r.total} previous={r.prev_total} />
                <span className="text-xs text-muted-foreground w-10 text-right tabular-nums hidden sm:inline">
                  {((r.total / windowTotal) * 100).toFixed(0)}%
                </span>
                <span className="font-semibold tabular-nums w-24 text-right">{formatCurrency(r.total)}</span>
              </button>
              {open && drillable && <VendorDrill vendor={r.name} months={windowMonths} />}
            </div>
          );
        })}
      </div>
      {filtered.length > 25 && !showAll && (
        <Button size="sm" variant="outline" onClick={() => setShowAll(true)}>
          Show all {filtered.length}
        </Button>
      )}
    </div>
  );
}

export default function Spending() {
  const [months, setMonths] = useState(12);
  const [report, setReport] = useState<SpendReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'vendor' | 'account'>('vendor');

  const load = useCallback(async (m: number) => {
    setLoading(true); setError(null);
    try {
      setReport(await fetchSpendReport(m));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the spend report.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(months); }, [load, months]);

  const t = report?.totals;
  const windowDelta = t ? pctChange(t.window_total, t.prev_window_total) : null;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center gap-3">
        <TrendingUp className="h-6 w-6 text-primary" />
        <div className="flex-1 min-w-[220px]">
          <h1 className="text-xl font-extrabold tracking-tight">Spending</h1>
          <p className="text-sm text-muted-foreground">
            Everything booked in QuickBooks — by vendor, by account, by month. Trends, not a P&amp;L.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button key={w} size="sm" variant={months === w ? 'default' : 'outline'} onClick={() => setMonths(w)}>
              {w} mo
            </Button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load(months)} disabled={loading} title="Reload">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {error && (
        <div className="text-sm rounded-lg p-3 border border-destructive/40 bg-destructive/10 text-destructive">{error}</div>
      )}

      {loading && !report ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : report && t ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'This month', value: t.this_month ?? 0 },
              { label: 'Last month', value: t.last_month ?? 0 },
              { label: `${report.window.months}-month total`, value: t.window_total },
            ].map((s) => (
              <Card key={s.label}><CardContent className="p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{s.label}</p>
                <p className="text-lg font-extrabold tabular-nums">{formatCurrency(s.value)}</p>
              </CardContent></Card>
            ))}
            <Card><CardContent className="p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">vs prior {report.window.months} mo</p>
              <p className={`text-lg font-extrabold tabular-nums ${windowDelta !== null && windowDelta > 0 ? 'text-destructive' : 'text-emerald-500'}`}>
                {windowDelta === null ? '—' : `${windowDelta > 0 ? '+' : ''}${windowDelta.toFixed(0)}%`}
              </p>
              <p className="text-[10px] text-muted-foreground tabular-nums">{formatCurrency(t.prev_window_total)} before</p>
            </CardContent></Card>
          </div>

          <Card><CardContent className="p-4">
            <MonthlyBars data={report.monthly} />
          </CardContent></Card>

          <Card><CardContent className="p-4 space-y-3">
            <div className="flex gap-1">
              <Button size="sm" variant={tab === 'vendor' ? 'default' : 'outline'} onClick={() => setTab('vendor')}>
                By vendor ({report.by_vendor.length})
              </Button>
              <Button size="sm" variant={tab === 'account' ? 'default' : 'outline'} onClick={() => setTab('account')}>
                By account ({report.by_account.length})
              </Button>
            </div>
            {tab === 'vendor' ? (
              <SpendTable rows={report.by_vendor} months={report.months} windowMonths={report.window.months} drillable />
            ) : (
              <SpendTable rows={report.by_account} months={report.months} windowMonths={report.window.months} drillable={false} />
            )}
            <p className="text-[11px] text-muted-foreground">
              Accrual-dated from the QuickBooks mirror (refreshed daily) — a mis-dated bill lands in the month it
              claims. Vendor credits count negative. Item-based lines show their item when no GL account is on the line.
            </p>
          </CardContent></Card>
        </>
      ) : null}
    </div>
  );
}
