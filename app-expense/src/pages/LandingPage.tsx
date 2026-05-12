import { useNavigate } from 'react-router-dom';
import { useSession, useExpenseSettings } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Receipt, ShoppingCart, Clock, ArrowRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';

export default function LandingPage() {
  const navigate = useNavigate();
  const { session } = useSession();
  const { settings } = useExpenseSettings();
  const [recentRequests, setRecentRequests] = useState<ExpenseRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadRecent() {
      if (!session) return;
      const { data } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('submitted_by', session.user.id)
        .order('created_at', { ascending: false })
        .limit(5);
      setRecentRequests((data as ExpenseRequest[]) ?? []);
      setLoading(false);
    }
    loadRecent();
  }, [session]);

  const userFirstName = session?.user?.user_metadata?.full_name?.split(' ')[0]
    ?? session?.user?.email?.split('@')[0]
    ?? 'there';

  return (
    <div className="space-y-6 pb-4">
      {/* Greeting */}
      <div>
        <h1 className="text-xl font-semibold text-foreground">
          Hey {userFirstName}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          What do you need to submit?
        </p>
      </div>

      {/* Mode selection cards */}
      <div className="grid gap-3">
        <button
          onClick={() => navigate('new')}
          className="text-left"
        >
          <Card className="hover:border-primary/50 hover:shadow-md transition-all cursor-pointer">
            <CardContent className="flex items-center gap-4 p-4">
              <div className="flex-shrink-0 h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                <Receipt className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold text-base">Expense</h2>
                <p className="text-sm text-muted-foreground">
                  I already bought something — snap receipt and log it
                </p>
              </div>
              <ArrowRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            </CardContent>
          </Card>
        </button>

        <button
          onClick={() => navigate('new-pr')}
          className="text-left"
        >
          <Card className="hover:border-primary/50 hover:shadow-md transition-all cursor-pointer">
            <CardContent className="flex items-center gap-4 p-4">
              <div className="flex-shrink-0 h-12 w-12 rounded-lg bg-amber-50 flex items-center justify-center">
                <ShoppingCart className="h-6 w-6 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold text-base">Purchase Request</h2>
                <p className="text-sm text-muted-foreground">
                  I need to buy something — get approval first
                </p>
              </div>
              <ArrowRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            </CardContent>
          </Card>
        </button>
      </div>

      {/* Threshold note */}
      {settings && (
        <p className="text-xs text-muted-foreground text-center">
          Expenses under {formatCurrency(settings.approval_threshold)} are auto-approved.
          All purchase requests require manager sign-off.
        </p>
      )}

      {/* Recent submissions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">Recent Submissions</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate('pending')}>
            View all
          </Button>
        </div>
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : recentRequests.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <Clock className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No submissions yet. Tap above to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {recentRequests.map((req) => (
              <Card
                key={req.id}
                className="cursor-pointer hover:shadow-sm transition-shadow"
                onClick={() => navigate(`edit/${req.id}`)}
              >
                <CardContent className="flex items-center gap-3 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {req.vendor_name || 'No vendor'}
                      </p>
                      <StatusBadge status={req.status} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {req.type === 'purchase_request' ? 'PR' : 'Expense'}
                      {req.receipt_date ? ` · ${formatDate(req.receipt_date)}` : ''}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {req.total_amount ? formatCurrency(req.total_amount) : '—'}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variantMap: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'info' | 'secondary'> = {
    draft: 'secondary',
    pending: 'warning',
    approved: 'success',
    denied: 'destructive',
    awaiting_invoice: 'info',
    fulfilled: 'info',
    posted: 'success',
  };
  const labelMap: Record<string, string> = {
    draft: 'Draft',
    pending: 'Pending',
    approved: 'Approved',
    denied: 'Denied',
    awaiting_invoice: 'Awaiting Invoice',
    fulfilled: 'Fulfilled',
    posted: 'Posted',
  };
  return (
    <Badge variant={variantMap[status] ?? 'secondary'}>
      {labelMap[status] ?? status}
    </Badge>
  );
}
