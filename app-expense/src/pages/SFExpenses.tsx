import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/hooks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, Wrench } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';

// Service Fusion expenses: ops.expense_requests rows tagged 'Service Fusion'.
// These are landed by the ResQ↔SF sync when a job is invoiced (🔒 Close →
// expense-to-bill builds the row, handleCloseJob posts it). Read-only view so
// you can see what flowed over from Service Fusion.
export default function SFExpenses() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [requests, setRequests] = useState<ExpenseRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      if (!session) return;
      const { data } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('tag', 'Service Fusion')
        .order('created_at', { ascending: false });
      setRequests((data as ExpenseRequest[]) ?? []);
      setLoading(false);
    }
    load();
  }, [session]);

  const total = requests.reduce((sum, r) => sum + (r.total_amount ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold tracking-tight">SF Expenses</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Service Fusion job expenses — posted to Brixpense when the job is invoiced.
          </p>
        </div>
        {!loading && requests.length > 0 && (
          <div className="text-right">
            <div className="text-[15px] font-bold tabular-nums">{formatCurrency(total)}</div>
            <div className="text-[11px] text-muted-foreground">{requests.length} expense{requests.length === 1 ? '' : 's'}</div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Wrench className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No Service Fusion expenses yet.
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              They appear here once a SF job is billed and invoiced.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {requests.map((req) => (
            <Card
              key={req.id}
              className="cursor-pointer hover:shadow-sm transition-shadow"
              onClick={() => navigate(`/expense/edit/${req.id}`)}
            >
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[15px] font-semibold truncate">
                      {req.vendor_name || 'No vendor'}
                    </p>
                    <Badge variant="success">Posted</Badge>
                  </div>
                  <p className="text-[13px] text-muted-foreground mt-1 truncate">
                    {req.customer_name || 'No customer'}
                    {req.job_number ? ` · SF #${req.job_number}` : ''}
                    {req.posted_at ? ` · ${formatDate(req.posted_at)}` : (req.created_at ? ` · ${formatDate(req.created_at)}` : '')}
                  </p>
                </div>
                <span className="text-[15px] font-bold tabular-nums shrink-0">
                  {req.total_amount ? formatCurrency(req.total_amount) : '—'}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
