import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/hooks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, CheckCircle } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';

export default function ManagerQueue() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [requests, setRequests] = useState<ExpenseRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      if (!session) return;
      const userEmail = session.user.email?.toLowerCase();
      if (!userEmail) { setLoading(false); return; }
      const { data } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('manager_email', userEmail)
        .in('status', ['pending'])
        .order('created_at', { ascending: false });
      setRequests((data as ExpenseRequest[]) ?? []);
      setLoading(false);
    }
    load();
  }, [session]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="page-title">Awaiting Your Approval</h1>
      </div>

      {loading ? (
        <div className="feedback-state">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="feedback-state">
            <CheckCircle className="h-10 w-10 text-emerald-400 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">All caught up — nothing to approve.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {requests.map((req) => (
            <Card
              key={req.id}
              className="cursor-pointer hover:shadow-sm transition-shadow"
              onClick={() => navigate(`/review/${req.id}`)}
            >
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[15px] font-semibold truncate">{req.vendor_name || 'No vendor'}</p>
                    <Badge variant="warning">
                      {req.request_type === 'purchase_request' ? 'PR' : 'Expense'}
                    </Badge>
                  </div>
                  <p className="text-[13px] text-muted-foreground mt-1">
                    {req.cogs_account_label ?? 'Uncategorized'}
                    {req.receipt_date ? ` · ${formatDate(req.receipt_date)}` : ''}
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
