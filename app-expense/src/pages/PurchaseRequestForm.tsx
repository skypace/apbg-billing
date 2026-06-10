import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Loader2, CheckCircle, AlertTriangle, Plus, Trash2,
  ShoppingCart,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SelectField } from '@/components/ui/select-field';
import { Badge } from '@/components/ui/badge';
import { useSession, useExpenseSettings } from '@/lib/hooks';
import { getAccessToken, supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/utils';
import type { LineItem } from '@/types/expense';

type FormStep = 'details' | 'submitting' | 'success' | 'error';

export default function PurchaseRequestForm() {
  const navigate = useNavigate();
  const { session } = useSession();
  const { settings, loading: settingsLoading } = useExpenseSettings();

  const [step, setStep] = useState<FormStep>('details');

  const [vendorName, setVendorName] = useState('');
  const [estimatedAmount, setEstimatedAmount] = useState('');
  const [neededByDate, setNeededByDate] = useState('');
  const [cogsAccountLabel, setCogsAccountLabel] = useState('');
  const [cogsAccountId, setCogsAccountId] = useState('');
  const [tag, setTag] = useState('');
  const [department, setDepartment] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [jobNumber, setJobNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [entity, setEntity] = useState<'brix' | 'freeflow' | 'shared'>('brix');
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { description: '', qty: 1, unit_price: 0, amount: 0 },
  ]);

  const [resultMessage, setResultMessage] = useState('');
  const [emailWarning, setEmailWarning] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const totalNum = parseFloat(estimatedAmount) || 0;

  const handleCogsChange = (label: string) => {
    setCogsAccountLabel(label);
    const match = settings?.cogs_accounts.find((a) => a.label === label);
    setCogsAccountId(match?.id ?? '');
  };

  // Cascade: entity → department → COGS. Picking a department pre-selects its
  // mapped default COGS account (configured in Settings → Organization); the
  // user can still override it afterward.
  const handleDepartmentChange = (dept: string) => {
    setDepartment(dept);
    const mappedId = settings?.department_cogs_map?.[dept];
    if (mappedId) {
      const match = settings?.cogs_accounts.find((a) => a.id === mappedId);
      if (match) {
        setCogsAccountId(match.id);
        setCogsAccountLabel(match.label);
      }
    }
    // Auto-route the approver: per-department override, else the default.
    const routed =
      settings?.approval_routing?.by_department?.[dept] ||
      settings?.approval_routing?.default_approver;
    if (routed) setManagerEmail(routed);
  };

  // Pre-fill the approver from default routing once settings load (if unset).
  useEffect(() => {
    if (!settings) return;
    setManagerEmail((cur) => cur || settings.approval_routing?.default_approver || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const updateLineItem = (idx: number, field: keyof LineItem, val: string) => {
    setLineItems((prev) => {
      const next = [...prev];
      const li = { ...next[idx] };
      if (field === 'description') li.description = val;
      if (field === 'qty') li.qty = parseFloat(val) || 0;
      if (field === 'unit_price') li.unit_price = parseFloat(val) || 0;
      li.amount = li.qty * li.unit_price;
      next[idx] = li;
      return next;
    });
  };
  const addLineItem = () =>
    setLineItems((p) => [...p, { description: '', qty: 1, unit_price: 0, amount: 0 }]);
  const removeLineItem = (idx: number) =>
    setLineItems((p) => p.filter((_, i) => i !== idx));

  const handleSubmit = async () => {
    if (!session) return;
    setStep('submitting');
    setEmailWarning('');
    try {
      const nonEmptyLines = lineItems.filter((li) => li.description.trim());

      const { data: req, error: insertErr } = await supabase
        .from('expense_requests')
        .insert({
          request_type: 'purchase_request',
          status: 'draft',
          submitted_by: session.user.id,
          submitter_name: session.user.user_metadata?.full_name || session.user.email,
          submitter_email: session.user.email,
          entity,
          vendor_name: vendorName || null,
          total_amount: totalNum || null,
          receipt_date: neededByDate || null,
          cogs_account_id: cogsAccountId || null,
          cogs_account_label: cogsAccountLabel || null,
          tag: tag || null,
          department: department || null,
          customer_name: customerName || null,
          job_number: jobNumber || null,
          memo: memo || null,
          line_items: nonEmptyLines,
          manager_email: managerEmail || null,
        })
        .select()
        .single();

      if (insertErr || !req) throw new Error(insertErr?.message ?? 'Insert failed');

      const token = await getAccessToken();
      const notifyRes = await fetch('/expense/api/expense-request-notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ requestId: req.id }),
      });

      const notifyData = await notifyRes.json().catch(() => ({}));

      if (!notifyRes.ok) {
        // The submission itself succeeded — only the notify failed
        setResultMessage('Purchase request submitted.');
        setEmailWarning(
          `Notification email failed to send: ${notifyData.error || `HTTP ${notifyRes.status}`}. ` +
          `${managerEmail} won't see this in their queue until they log in manually.`,
        );
      } else if (notifyData.email_sent) {
        setResultMessage(`Purchase request submitted — ${managerEmail} has been notified.`);
      } else {
        // 200 OK but email didn't go out — surface the email_error
        setResultMessage('Purchase request submitted.');
        setEmailWarning(
          notifyData.email_error
            ? `Notification email failed: ${notifyData.email_error}. ${managerEmail} can still find it by logging into the queue.`
            : `Notification email did NOT send (no Resend API key configured, or the call returned false). ${managerEmail} will see this on their next login.`,
        );
      }
      setStep('success');
    } catch (err: any) {
      console.error('PR submission error:', err);
      setErrorMessage(err.message || 'Something went wrong');
      setStep('error');
    }
  };

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (step === 'details') {
    return (
      <div className="space-y-4 pb-36">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">Purchase Request</h1>
        </div>

        <div className="flex items-center gap-2 text-xs bg-amber-50/10 text-amber-300 rounded-lg p-3 border border-amber-300/20">
          <ShoppingCart className="h-4 w-4 flex-shrink-0" />
          All purchase requests require manager approval before buying.
        </div>

        <div>
          <Label>What do you need to buy?</Label>
          <Input placeholder="e.g. CO2 tank, syrup pump, van tire" value={lineItems[0]?.description || ''} onChange={(e) => updateLineItem(0, 'description', e.target.value)} />
        </div>

        <div>
          <Label>Vendor / Where to buy</Label>
          <Input placeholder="e.g. Home Depot, Amazon, Grainger" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Estimated Cost ($)</Label>
            <Input type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00" value={estimatedAmount} onChange={(e) => setEstimatedAmount(e.target.value)} />
          </div>
          <div>
            <Label>Needed By</Label>
            <Input type="date" value={neededByDate} onChange={(e) => setNeededByDate(e.target.value)} />
          </div>
        </div>

        <Badge variant="warning">Manager approval required</Badge>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Entity</Label>
            <SelectField
              value={entity}
              onChange={(e) => setEntity(e.target.value as 'brix' | 'freeflow' | 'shared')}
              options={[
                { value: 'brix', label: 'Brix / Alameda Soda' },
                { value: 'freeflow', label: 'FreeFlow' },
                { value: 'shared', label: 'Shared (split)' },
              ]}
            />
          </div>
          <div>
            <Label>Department</Label>
            <SelectField
              value={department}
              onChange={(e) => handleDepartmentChange(e.target.value)}
              placeholder="Select department"
              options={[
                { value: '', label: 'None' },
                ...(settings?.departments ?? []).map((d) => ({ value: d, label: d })),
              ]}
            />
          </div>
        </div>

        <div>
          <Label>Expense Account</Label>
          <SelectField value={cogsAccountLabel} onChange={(e) => handleCogsChange(e.target.value)} placeholder="Select account" options={(settings?.cogs_accounts ?? []).map((a) => ({ value: a.label, label: a.label }))} />
          {department && settings?.department_cogs_map?.[department] && (
            <p className="text-xs text-muted-foreground mt-1">
              Defaulted from the <span className="font-medium">{department}</span> department — change it if needed.
            </p>
          )}
        </div>

        <div>
          <Label>Tag</Label>
          <SelectField value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Optional" options={[{ value: '', label: 'None' }, ...(settings?.tags ?? []).map((t) => ({ value: t, label: t }))]} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Customer (optional)</Label>
            <Input placeholder="Customer name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
          </div>
          <div>
            <Label>Job # (optional)</Label>
            <Input placeholder="Job number" value={jobNumber} onChange={(e) => setJobNumber(e.target.value)} />
          </div>
        </div>

        <div>
          <Label>Why is this needed?</Label>
          <Textarea placeholder="Briefly explain the business need" value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} />
        </div>

        <div>
          <Label>Manager for Approval</Label>
          <SelectField value={managerEmail} onChange={(e) => setManagerEmail(e.target.value)} placeholder="Select manager" options={(settings?.manager_emails ?? []).map((em) => ({ value: em, label: em }))} />
        </div>

        <Card>
          <CardHeader className="p-3 pb-0"><CardTitle className="text-sm font-medium">Items to Purchase</CardTitle></CardHeader>
          <CardContent className="p-3 space-y-3">
            {lineItems.map((li, idx) => (
              <div key={idx} className="flex items-start gap-2">
                <div className="flex-1 space-y-1">
                  <Input placeholder="Item description" value={li.description} onChange={(e) => updateLineItem(idx, 'description', e.target.value)} className="text-sm" />
                  <div className="grid grid-cols-3 gap-1">
                    <Input type="number" placeholder="Qty" value={li.qty || ''} onChange={(e) => updateLineItem(idx, 'qty', e.target.value)} className="text-sm" />
                    <Input type="number" step="0.01" placeholder="Price" value={li.unit_price || ''} onChange={(e) => updateLineItem(idx, 'unit_price', e.target.value)} className="text-sm" />
                    <div className="flex items-center justify-end text-sm font-medium tabular-nums pr-2">{formatCurrency(li.amount)}</div>
                  </div>
                </div>
                {lineItems.length > 1 && (
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive mt-1" onClick={() => removeLineItem(idx)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" className="w-full" onClick={addLineItem}>
              <Plus className="h-4 w-4 mr-1" /> Add Item
            </Button>
          </CardContent>
        </Card>

        <div className="form-submit-bar">
          <div className="max-w-lg mx-auto">
            <Button className="w-full" size="lg" disabled={!lineItems[0]?.description.trim() || totalNum <= 0 || !managerEmail} onClick={handleSubmit}>
              Submit for Approval — {formatCurrency(totalNum)}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'submitting') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Submitting and notifying manager…</p>
      </div>
    );
  }

  if (step === 'success') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
        <CheckCircle className="h-12 w-12 text-emerald-500" />
        <h2 className="text-lg font-semibold">{resultMessage}</h2>
        {emailWarning && (
          <div className="ap-error" style={{ maxWidth: 480 }}>
            <strong>Heads-up:</strong> {emailWarning}
          </div>
        )}
        {!emailWarning && (
          <p className="text-sm text-muted-foreground">You'll be notified when your manager responds.</p>
        )}
        <div className="flex gap-2 mt-4">
          <Button variant="outline" onClick={() => navigate('/')}>Home</Button>
          <Button onClick={() => navigate('/pending')}>View My Requests</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h2 className="text-lg font-semibold">Submission Failed</h2>
      <p className="text-sm text-muted-foreground">{errorMessage}</p>
      <Button variant="outline" onClick={() => setStep('details')}>Try Again</Button>
    </div>
  );
}
