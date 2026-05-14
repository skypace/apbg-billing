import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, Inbox, Mail, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/hooks';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';

export default function ThirdPartyBills() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [bills, setBills] = useState<ExpenseRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      if (!session) return;
      // Surface anything that wasn't submitter-initiated through the app.
      // Heuristic: submitter_email NOT @brixbev.com OR submitter_name starts with "Inbound" / "Vendor".
      // When process-inbound is updated to persist, switch this to filter by source='inbound_email'.
      const { data } = await supabase
        .from('expense_requests')
        .select('*')
        .or(
          "submitter_name.ilike.Inbound%,submitter_name.ilike.Vendor%,submitter_email.not.ilike.%@brixbev.com",
        )
        .order('created_at', { ascending: false })
        .limit(50);
      setBills((data as ExpenseRequest[]) ?? []);
      setLoading(false);
    }
    load();
  }, [session]);

  return (
    <div className="space-y-6 pb-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">3rd Party Bills</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Vendor invoices that arrived by email, EDI, or Service Fusion.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Mail className="h-5 w-5 text-primary" />
            </div>
            <div className="text-sm">
              <p className="font-medium text-foreground">
                Forwarding address
              </p>
              <p className="text-muted-foreground mt-1">
                Forward vendor bills to{' '}
                <span className="font-mono text-primary">
                  bills@alamedapointbg.com
                </span>{' '}
                — Claude reads the PDF or image, extracts vendor, total, line
                items, and routes the bill here for approval.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <ExternalLink className="h-5 w-5 text-amber-500" />
            </div>
            <div className="text-sm">
              <p className="font-medium text-foreground">
                Service Fusion sync <Badge variant="warning" className="ml-2">Coming soon</Badge>
              </p>
              <p className="text-muted-foreground mt-1">
                Job invoices will flow in from Service Fusion automatically and
                cross-reference against the job number on each line so ROI is
                visible per ticket.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-sm font-semibold text-foreground mb-3">
          Recent inbound bills
        </h2>
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : bills.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center">
              <Inbox className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No inbound bills yet.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Forward a vendor invoice to{' '}
                <span className="font-mono">bills@alamedapointbg.com</span> to
                test the OCR flow.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {bills.map((b) => (
              <Card
                key={b.id}
                className="cursor-pointer hover:shadow-sm transition-shadow"
                onClick={() => navigate(`/expense/edit/${b.id}`)}
              >
                <CardContent className="flex items-center gap-3 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {b.vendor_name || 'Unknown vendor'}
                      </p>
                      <Badge variant="secondary">{b.status}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      From {b.submitter_email || '—'}
                      {b.receipt_date ? ` · ${formatDate(b.receipt_date)}` : ''}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {b.total_amount ? formatCurrency(b.total_amount) : '—'}
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
