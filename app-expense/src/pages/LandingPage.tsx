import { useNavigate } from 'react-router-dom';
import { useSession, useExpenseSettings } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Receipt, ShoppingCart, Loader2, PieChart, BarChart3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import { Donut, BarList, type Slice } from '@/components/Charts';

interface SpendRow {
  total_amount: number | null;
  cogs_account_label: string | null;
  vendor_name: string | null;
}

export default function LandingPage() {
  const navigate = useNavigate();
  const { session } = useSession();
  const { settings } = useExpenseSettings();
  const [rows, setRows] = useState<SpendRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      if (!session) return;
      const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
      const { data } = await supabase
        .from('expense_requests')
        .select('total_amount, cogs_account_label, vendor_name, created_at')
        .gte('created_at', yearStart)
        .limit(2000);
      setRows((data as SpendRow[]) ?? []);
      setLoading(false);
    }
    load();
  }, [session]);

  const { byAccount, byVendor, total } = useMemo(() => {
    const acct = new Map<string, number>();
    const vend = new Map<string, number>();
    let tot = 0;
    for (const r of rows) {
      const amt = Number(r.total_amount) || 0;
      if (amt <= 0) continue;
      tot += amt;
      const a = (r.cogs_account_label || 'Unassigned').trim();
      acct.set(a, (acct.get(a) ?? 0) + amt);
      const v = (r.vendor_name || 'No vendor').trim();
      vend.set(v, (vend.get(v) ?? 0) + amt);
    }
    const toSlices = (m: Map<string, number>): Slice[] =>
      Array.from(m.entries()).map(([label, value]) => ({ label, value }));
    return { byAccount: toSlices(acct), byVendor: toSlices(vend), total: tot };
  }, [rows]);

  const userFirstName =
    session?.user?.user_metadata?.full_name?.split(' ')[0] ??
    session?.user?.email?.split('@')[0] ??
    'there';

  const hasData = !loading && total > 0;

  return (
    <div className="space-y-7 pb-6">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-extrabold text-foreground tracking-tight">
          Hey {userFirstName}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">What do you need to submit?</p>
      </div>

      {/* Two centered CTA buttons */}
      <div className="grid gap-4 sm:grid-cols-2">
        <CtaTile
          icon={<Receipt className="h-7 w-7" />}
          title="Expense"
          desc="I already bought something — snap the receipt and log it"
          onClick={() => navigate('new')}
        />
        <CtaTile
          icon={<ShoppingCart className="h-7 w-7" />}
          title="Purchase Request"
          desc="I need to buy something — get approval first"
          amber
          onClick={() => navigate('new-pr')}
        />
      </div>

      {settings && (
        <p className="text-xs text-muted-foreground text-center">
          Expenses under {formatCurrency(settings.approval_threshold)} are auto-approved.
          All purchase requests require manager sign-off.
        </p>
      )}

      {/* Spend insights — replaces the recent-submissions list */}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !hasData ? (
        <Card>
          <CardContent className="py-10 text-center">
            <PieChart className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              No spend recorded yet this year. Your cost charts will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                <PieChart className="h-4 w-4 text-primary" />
                Cost per Account
              </div>
              <Donut data={byAccount} total={total} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  Top Vendors this year
                </div>
                <button
                  type="button"
                  onClick={() => navigate('pending')}
                  className="text-xs text-primary hover:underline underline-offset-2"
                >
                  Previous expenses →
                </button>
              </div>
              <BarList data={byVendor} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function CtaTile({
  icon,
  title,
  desc,
  amber,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  amber?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className="cta-card"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className={`cta-icon-tile${amber ? ' amber' : ''}`}>{icon}</div>
      <div className="cta-body">
        <div className="cta-title">{title}</div>
        <div className="cta-desc">{desc}</div>
      </div>
    </div>
  );
}
