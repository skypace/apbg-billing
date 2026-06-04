import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/hooks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, Clock, Receipt } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';

export default function PendingList() {
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
        .eq('submitted_by', session.user.id)
        .order('created_at', { ascending: false });
      setRequests((data as ExpenseRequest[]) ?? []);
      setLoading(false);
    }
    load();
  }, [session]);

  const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'info' | 'secondary'> = {
    draft: 'secondary',
    pending: 'warning',
    approved: 'success',
    denied: 'destructive',
    awaiting_invoice: 'info',
    fulfilled: 'info',
    posted: 'success',
  };

  const statusLabel: Record<string, string> = {
    draft: 'Draft',
    pending: 'Pending',
    approved: 'Approved',
    denied: 'Denied',
    awaiting_invoice: 'Awaiting Invoice',
    fulfilled: 'Fulfilled',
    posted: 'Posted',
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold tracking-tight">My Submissions</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Clock className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No submissions yet.
            </p>
            <Button className="mt-4" onClick={() => navigate('')}>
              Submit Something
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {requests.map((req) => {
            // PRs in 'awaiting_invoice' status are approved-and-ready-to-be-fulfilled.
            // The "Log Receipt" CTA below opens ExpenseForm pre-filled from this PR
            // so the submitter doesn't have to re-type vendor/amount/accounts after
            // they actually buy the thing. Receipt + payment account close the loop.
            const isReadyForReceipt =
              req.request_type === 'purchase_request' && req.status === 'awaiting_invoice';
            return (
              <Card
                key={req.id}
                className="cursor-pointer hover:shadow-sm transition-shadow"
                onClick={() => navigate(`/edit/${req.id}`)}
              >
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[15px] font-semibold truncate">
                        {req.vendor_name || 'No vendor'}
                      </p>
                      <Badge variant={statusVariant[req.status] ?? 'secondary'}>
                        {statusLabel[req.status] ?? req.status}
                      </Badge>
                    </div>
                    <p className="text-[13px] text-muted-foreground mt-1">
                      {req.request_type === 'purchase_request' ? 'PR' : 'Expense'}
                      {req.receipt_date ? ` · ${formatDate(req.receipt_date)}` : ''}
                      {req.cogs_account_label ? ` · ${req.cogs_account_label}` : ''}
                    </p>
                  </div>
                  <span className="text-[15px] font-bold tabular-nums shrink-0">
                    {req.total_amount ? formatCurrency(req.total_amount) : '—'}
                  </span>
                  {isReadyForReceipt && (
                    <Button
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/new?fromPR=${req.id}`);
                      }}
                      title="Log the receipt for this approved purchase"
                    >
                      <Receipt className="h-4 w-4 mr-1" />
                      Log Receipt
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
