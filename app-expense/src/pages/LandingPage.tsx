import { useNavigate } from 'react-router-dom';
import { useSession, useExpenseSettings } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Receipt, ShoppingCart, Clock, ArrowRight, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';

const HIDDEN_KEY = 'brixpense.hiddenRequestIds';

function loadHidden(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function saveHidden(ids: string[]) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
  } catch {
    // ignore quota / private-mode errors
  }
}

export default function LandingPage() {
  const navigate = useNavigate();
  const { session } = useSession();
  const { settings } = useExpenseSettings();
  const [recentRequests, setRecentRequests] = useState<ExpenseRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [hiddenIds, setHiddenIds] = useState<string[]>(() => loadHidden());

  useEffect(() => {
    async function loadRecent() {
      if (!session) return;
      const { data } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('submitted_by', session.user.id)
        .order('created_at', { ascending: false })
        .limit(20);
      setRecentRequests((data as ExpenseRequest[]) ?? []);
      setLoading(false);
    }
    loadRecent();
  }, [session]);

  const visibleRequests = useMemo(
    () => recentRequests.filter((r) => !hiddenIds.includes(r.id)).slice(0, 5),
    [recentRequests, hiddenIds],
  );

  const hideOne = (id: string) => {
    const next = Array.from(new Set([...hiddenIds, id]));
    setHiddenIds(next);
    saveHidden(next);
  };

  const clearVisible = () => {
    const idsToHide = visibleRequests.map((r) => r.id);
    const next = Array.from(new Set([...hiddenIds, ...idsToHide]));
    setHiddenIds(next);
    saveHidden(next);
  };

  const resetHidden = () => {
    setHiddenIds([]);
    saveHidden([]);
  };

  const userFirstName = session?.user?.user_metadata?.full_name?.split(' ')[0]
    ?? session?.user?.email?.split('@')[0]
    ?? 'there';

  const everythingHidden =
    !loading && recentRequests.length > 0 && visibleRequests.length === 0;

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

      {/* Mode selection — clickable cta-cards (not button-wrapped) */}
      <div className="grid gap-3">
        <div
          className="cta-card"
          role="button"
          tabIndex={0}
          onClick={() => navigate('new')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              navigate('new');
            }
          }}
        >
          <div className="cta-icon-tile">
            <Receipt className="h-6 w-6" />
          </div>
          <div className="cta-body">
            <div className="cta-title">Expense</div>
            <div className="cta-desc">
              I already bought something — snap receipt and log it
            </div>
          </div>
          <ArrowRight className="cta-arrow h-5 w-5" />
        </div>

        <div
          className="cta-card"
          role="button"
          tabIndex={0}
          onClick={() => navigate('new-pr')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              navigate('new-pr');
            }
          }}
        >
          <div className="cta-icon-tile amber">
            <ShoppingCart className="h-6 w-6" />
          </div>
          <div className="cta-body">
            <div className="cta-title">Purchase Request</div>
            <div className="cta-desc">
              I need to buy something — get approval first
            </div>
          </div>
          <ArrowRight className="cta-arrow h-5 w-5" />
        </div>
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
          <div className="flex items-center gap-2">
            {visibleRequests.length > 0 && (
              <button
                type="button"
                onClick={clearVisible}
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              >
                Clear queue
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate('pending')}
              className="text-xs text-primary hover:underline underline-offset-2"
            >
              View all →
            </button>
          </div>
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
        ) : everythingHidden ? (
          <Card>
            <CardContent className="py-6 text-center space-y-2">
              <p className="text-sm text-muted-foreground">
                Queue cleared. {hiddenIds.length} item{hiddenIds.length === 1 ? '' : 's'} hidden from dashboard.
              </p>
              <button
                type="button"
                onClick={resetHidden}
                className="text-xs text-primary hover:underline underline-offset-2"
              >
                Show hidden
              </button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {visibleRequests.map((req) => (
              <div key={req.id} className="recent-row">
                <div
                  className="recent-row-body"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`edit/${req.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`edit/${req.id}`);
                    }
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {req.vendor_name || 'No vendor'}
                      </p>
                      <StatusBadge status={req.status} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {req.request_type === 'purchase_request' ? 'PR' : 'Expense'}
                      {req.receipt_date ? ` · ${formatDate(req.receipt_date)}` : ''}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {req.total_amount ? formatCurrency(req.total_amount) : '—'}
                  </span>
                </div>
                <button
                  type="button"
                  className="recent-row-hide"
                  aria-label="Hide from dashboard"
                  title="Hide from dashboard"
                  onClick={(e) => {
                    e.stopPropagation();
                    hideOne(req.id);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {hiddenIds.length > 0 && (
              <div className="pt-1 text-center">
                <button
                  type="button"
                  onClick={resetHidden}
                  className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                >
                  {hiddenIds.length} hidden · show all
                </button>
              </div>
            )}
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
