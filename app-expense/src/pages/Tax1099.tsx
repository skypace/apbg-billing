import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertTriangle, ArrowLeft, Download, Loader2, RefreshCw } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { list1099Candidates, rank1099, looksLikePerson, type Vendor1099Row } from '@/lib/vendors';

// 1099 candidates.
//
// ⚠ This is a WORKLIST, not a filing. It reads the QuickBooks expense mirror,
// which records Bills when they are entered (accrual); 1099 reporting is what
// you PAID in the calendar year (cash). A bill entered in December and paid in
// January is in the wrong year here. QuickBooks' own 1099 module files the
// forms and is right to.
//
// The job this page does is the one QuickBooks cannot do in August: show who
// has crossed the threshold and has no W-9, while they still answer the phone.

type View = 'chase' | 'over' | 'all';

const CLASS_LABEL: Record<string, string> = {
  individual: 'Individual', sole_prop: 'Sole proprietor', partnership: 'Partnership',
  c_corp: 'C corporation', s_corp: 'S corporation',
  llc_c: 'LLC (C corp)', llc_s: 'LLC (S corp)', llc_p: 'LLC (partnership)',
  trust: 'Trust / estate', other: 'Other',
};

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  // Vendor names come off OCR'd invoices. Excel executes a cell starting with
  // = + - @ as a formula, so prefix-quote those before they reach a spreadsheet.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export default function Tax1099() {
  const navigate = useNavigate();
  const thisYear = new Date().getFullYear();

  const [year, setYear] = useState(thisYear);
  const [threshold, setThreshold] = useState(600);
  const [rows, setRows] = useState<Vendor1099Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('chase');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await list1099Candidates(year, threshold));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the 1099 report.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [year, threshold]);

  useEffect(() => { void load(); }, [load]);

  const ranked = useMemo(() => rank1099(rows), [rows]);
  const chase = useMemo(() => ranked.filter((r) => r.needs_w9), [ranked]);
  const over = useMemo(() => ranked.filter((r) => r.over_threshold), [ranked]);
  const visible = view === 'chase' ? chase : view === 'over' ? over : ranked;

  const exportCsv = () => {
    const head = ['Vendor', 'Paid', 'Transactions', 'First', 'Last', 'W-9', 'W-9 received',
                  'Classification', 'EIN last 4', 'Backup withholding', 'Reportable', 'Needs a W-9'];
    const body = visible.map((r) => [
      r.vendor_name, r.paid_total.toFixed(2), r.txn_count, r.first_txn ?? '', r.last_txn ?? '',
      r.w9_status ?? 'not in the vendor registry', r.w9_received_at ?? '',
      r.tax_classification ? CLASS_LABEL[r.tax_classification] ?? r.tax_classification : '',
      r.ein_last4 ?? '', r.backup_withholding ? 'yes' : 'no',
      r.reportable === null ? 'unclassified' : r.reportable ? 'yes' : 'exempt',
      r.needs_w9 ? 'yes' : 'no',
    ].map(csvCell).join(','));
    const blob = new Blob([[head.map(csvCell).join(','), ...body].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `1099-candidates-${year}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const chaseTotal = chase.reduce((s, r) => s + r.paid_total, 0);

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('vendors')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="page-title">1099 candidates</h1>
          <p className="page-description">
            Who we paid enough to report, and who we still need a W-9 from.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      <Card className="border-sky-500/30">
        <CardContent className="p-3 text-xs text-sky-200/90 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            <strong>This is a worklist, not a filing.</strong> The amounts come from the QuickBooks
            expense mirror, which counts a bill when it is entered. 1099s report what was actually
            <em> paid</em> in the calendar year, so a December bill paid in January is in the wrong
            year here. File from QuickBooks' 1099 module — use this to chase the paperwork while
            people still answer the phone.
          </span>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-[11px] text-muted-foreground block mb-1">Year</label>
          <Input
            type="number" className="w-28" value={year}
            onChange={(e) => setYear(Number(e.target.value) || thisYear)}
          />
        </div>
        <div>
          <label className="text-[11px] text-muted-foreground block mb-1">Threshold ($)</label>
          <Input
            type="number" className="w-28" value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value) || 0)}
          />
        </div>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={!visible.length}>
          <Download className="h-4 w-4 mr-1.5" /> Export CSV
        </Button>
      </div>

      {error && (
        <Card className="border-red-500/40">
          <CardContent className="p-3 text-sm text-red-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {([
          ['chase', `Need a W-9 (${chase.length})`],
          ['over', `Over $${threshold} (${over.length})`],
          ['all', `Everyone we paid (${ranked.length})`],
        ] as [View, string][]).map(([k, label]) => (
          <Button key={k} size="sm" variant={view === k ? 'default' : 'outline'} onClick={() => setView(k)}>
            {label}
          </Button>
        ))}
      </div>

      {view === 'chase' && chase.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {formatCurrency(chaseTotal)} paid to {chase.length} vendor{chase.length === 1 ? '' : 's'} with no W-9 on
          file. Most of these are companies that need no 1099 at all — marking one exempt on its
          vendor record takes it off this list for good.
        </p>
      )}

      {loading ? (
        <div className="feedback-state">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            {view === 'chase'
              ? `Nothing to chase for ${year}. Every vendor over $${threshold} is either exempt or has a W-9 on file.`
              : `No spend recorded for ${year}.`}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {visible.map((r) => (
            <Card key={r.vendor_name}>
              <CardContent className="p-3.5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold truncate">{r.vendor_name}</span>
                      {r.needs_w9 && <Badge variant="warning">Needs a W-9</Badge>}
                      {r.w9_status === 'on_file' && <Badge variant="success">W-9 on file</Badge>}
                      {r.reportable === false && <Badge variant="secondary">Exempt</Badge>}
                      {r.backup_withholding && <Badge variant="destructive">Backup withholding</Badge>}
                      {r.needs_w9 && looksLikePerson(r.vendor_name) && (
                        <Badge variant="info">Looks like an individual</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {r.txn_count} transaction{r.txn_count === 1 ? '' : 's'}
                      {r.first_txn ? ` · ${r.first_txn} → ${r.last_txn}` : ''}
                      {r.tax_classification ? ` · ${CLASS_LABEL[r.tax_classification] ?? r.tax_classification}` : ''}
                      {r.ein_last4 ? ` · TIN ••${r.ein_last4}` : ''}
                    </div>
                    {!r.vendor_id && (
                      <div className="text-[11px] text-muted-foreground/80 mt-1">
                        Not in the vendor registry — add them to record a W-9 or mark them exempt.
                      </div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-[15px] font-bold tabular-nums">{formatCurrency(r.paid_total)}</div>
                    {r.vendor_id && (
                      <button
                        type="button"
                        className="text-[11px] underline text-muted-foreground hover:text-foreground mt-0.5"
                        onClick={() => navigate(`vendors/${r.vendor_id}`)}
                      >
                        Open vendor
                      </button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
