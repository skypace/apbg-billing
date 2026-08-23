import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';

// What we owe, and how late it is.
//
// Reads ops.v_ap_aging directly. That view is security_invoker, so RLS decides
// what each person sees: the AP desk gets the company's payables, an ordinary
// submitter gets their own. One component, correct for both, with no
// per-audience endpoint to keep in sync.
//
// It renders nothing at all when there is nothing outstanding. An empty aging
// panel is a permanent zero that teaches people to stop reading the row.

type Bucket = 'current' | '1-30' | '31-60' | '61-90' | '90+' | 'no due date';

const ORDER: Bucket[] = ['90+', '61-90', '31-60', '1-30', 'current', 'no due date'];

const LOOK: Record<Bucket, { label: string; tone: string }> = {
  '90+':          { label: '90+ days late', tone: 'text-red-300' },
  '61-90':        { label: '61–90 late',    tone: 'text-red-300/90' },
  '31-60':        { label: '31–60 late',    tone: 'text-amber-300' },
  '1-30':         { label: '1–30 late',     tone: 'text-amber-300/90' },
  current:        { label: 'Not due yet',   tone: 'text-muted-foreground' },
  'no due date':  { label: 'No due date',   tone: 'text-muted-foreground' },
};

interface Row { aging_bucket: Bucket; total_amount: number | null }

export function ApAgingStrip({ onPick }: { onPick?: (bucket: Bucket) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const { data } = await supabase
        .from('v_ap_aging')
        .select('aging_bucket,total_amount')
        .limit(2000);
      if (live) setRows((data as Row[]) ?? []);
    })();
    return () => { live = false; };
  }, []);

  if (!rows || rows.length === 0) return null;

  const totals = new Map<Bucket, { n: number; amt: number }>();
  for (const r of rows) {
    const b = (r.aging_bucket || 'no due date') as Bucket;
    const cur = totals.get(b) ?? { n: 0, amt: 0 };
    totals.set(b, { n: cur.n + 1, amt: cur.amt + Number(r.total_amount || 0) });
  }
  const shown = ORDER.filter((b) => totals.has(b));
  const owed = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
  const overdue = shown
    .filter((b) => b !== 'current' && b !== 'no due date')
    .reduce((s, b) => s + (totals.get(b)?.amt ?? 0), 0);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-semibold">Unpaid bills</h2>
            <p className="text-[11px] text-muted-foreground">
              {overdue > 0
                ? `${formatCurrency(overdue)} of it is past due.`
                : 'Nothing past due.'}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[15px] font-bold tabular-nums">{formatCurrency(owed)}</div>
            <div className="text-[11px] text-muted-foreground">{rows.length} bill{rows.length === 1 ? '' : 's'}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {shown.map((b) => {
            const t = totals.get(b)!;
            const body = (
              <>
                <div className={`text-[11px] font-semibold ${LOOK[b].tone}`}>{LOOK[b].label}</div>
                <div className="text-[13px] font-bold tabular-nums mt-0.5">{formatCurrency(t.amt)}</div>
                <div className="text-[10px] text-muted-foreground">{t.n}</div>
              </>
            );
            return onPick ? (
              <button
                key={b}
                type="button"
                onClick={() => onPick(b)}
                className="rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors px-2.5 py-2 text-left"
              >
                {body}
              </button>
            ) : (
              <div key={b} className="rounded-lg bg-white/[0.03] px-2.5 py-2">{body}</div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
