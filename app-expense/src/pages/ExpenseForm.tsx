import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Camera, Upload, X, Plus, Trash2, Loader2,
  CheckCircle, AlertTriangle, Receipt,
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

type FormStep = 'upload' | 'details' | 'submitting' | 'success' | 'error';

export default function ExpenseForm() {
  const navigate = useNavigate();
  const { session } = useSession();
  const { settings, loading: settingsLoading } = useExpenseSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── step / receipt state ── */
  const [step, setStep] = useState<FormStep>('upload');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);

  /* ── form fields ── */
  const [vendorName, setVendorName] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [receiptDate, setReceiptDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [entity, setEntity] = useState('brix');
  const [cogsAccountLabel, setCogsAccountLabel] = useState('');
  const [cogsAccountId, setCogsAccountId] = useState('');
  const [tag, setTag] = useState('');
  const [department, setDepartment] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [jobNumber, setJobNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { description: '', qty: 1, unit_price: 0, amount: 0 },
  ]);

  /* ── submission state ── */
  const [, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [resultBillId, setResultBillId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  /* ── derived ── */
  const totalNum = parseFloat(totalAmount) || 0;
  const threshold = settings?.approval_threshold ?? 500;
  const needsApproval = totalNum > threshold;

  /* ── receipt handling ── */
  const handleFileSelect = useCallback(
    async (file: File) => {
      setReceiptFile(file);
      if (file.type.startsWith('image/')) {
        setReceiptPreview(URL.createObjectURL(file));
      } else {
        setReceiptPreview(null);
      }

      // OCR
      setOcrLoading(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const token = await getAccessToken();
        const res = await fetch('/.netlify/functions/process-inbound', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        });
        if (res.ok) {
          const ocr = await res.json();
          if (ocr.vendor) setVendorName(ocr.vendor);
          if (ocr.total) setTotalAmount(String(ocr.total));
          if (ocr.date) setReceiptDate(ocr.date);
          if (ocr.line_items?.length) {
            setLineItems(
              ocr.line_items.map((li: any) => ({
                description: li.description ?? '',
                qty: li.qty ?? 1,
                unit_price: li.unit_price ?? 0,
                amount: li.amount ?? (li.qty ?? 1) * (li.unit_price ?? 0),
              })),
            );
          }
        }
      } catch (e) {
        console.warn('OCR failed — manual entry required', e);
      } finally {
        setOcrLoading(false);
        setStep('details');
      }
    },
    [],
  );

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  };

  /* ── COGS account change ── */
  const handleCogsChange = (label: string) => {
    setCogsAccountLabel(label);
    const match = settings?.cogs_accounts.find((a) => a.label === label);
    setCogsAccountId(match?.id ?? '');
  };

  /* ── line items ── */
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

  /* ── submit ── */
  const handleSubmit = async () => {
    if (!session) return;
    setStep('submitting');
    setSubmitting(true);
    try {
      const nonEmptyLines = lineItems.filter((li) => li.description.trim());
      const user = session.user;
      const userName = user.user_metadata?.full_name || user.email || 'Unknown';

      // Insert as draft — the notify function handles status transition
      const { data: req, error: insertErr } = await supabase
        .from('expense_requests')
        .insert({
          request_type: 'expense',
          status: 'draft',
          submitted_by: user.id,
          submitter_name: userName,
          submitter_email: user.email || '',
          entity,
          department: department || null,
          description: memo || null,
          vendor_name: vendorName || null,
          notes: null,
          receipt_date: receiptDate || null,
          cogs_account_id: cogsAccountId || null,
          cogs_account_label: cogsAccountLabel || null,
          tag: tag || null,
          customer_name: customerName || null,
          job_number: jobNumber || null,
          manager_email: needsApproval ? managerEmail : null,
          total_amount: totalNum || 0,
          line_items: nonEmptyLines,
        })
        .select()
        .single();

      if (insertErr || !req) throw new Error(insertErr?.message ?? 'Insert failed');

      // Upload receipt if present
      if (receiptFile) {
        const storagePath = `${user.id}/${req.id}/${receiptFile.name}`;
        const { error: uploadErr } = await supabase.storage
          .from('expense-attachments')
          .upload(storagePath, receiptFile, {
            contentType: receiptFile.type,
            upsert: false,
          });

        if (!uploadErr) {
          await supabase.from('expense_request_attachments').insert({
            request_id: req.id,
            file_name: receiptFile.name,
            file_type: receiptFile.type,
            file_size: receiptFile.size,
            storage_path: storagePath,
          });
        }
      }

      // Call notify — handles auto-approve or sends email
      const accessToken = await getAccessToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      };

      const notifyRes = await fetch('/api/expense-request-notify', {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestId: req.id }),
      });

      if (notifyRes.ok) {
        const notifyData = await notifyRes.json();
        if (notifyData.auto_approved) {
          setResultMessage('Expense auto-approved and logged.');
        } else {
          setResultMessage(
            `Submitted for approval — ${notifyData.approval_email} has been notified.`,
          );
        }
      } else {
        setResultMessage('Request saved but notification may have failed.');
      }

      setStep('success');
    } catch (err: any) {
      console.error('Submission error:', err);
      setErrorMessage(err.message || 'Something went wrong');
      setStep('error');
    } finally {
      setSubmitting(false);
    }
  };

  /* ── RENDER ── */

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  /* Step: upload receipt */
  if (step === 'upload') {
    return (
      <div className="space-y-6 pb-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">New Expense</h1>
        </div>

        <Card>
          <CardContent className="p-4 space-y-4">
            <div
              className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
                         hover:border-primary/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
            >
              <Receipt className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground">
                Snap or upload your receipt
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Photo, scan, or PDF — we'll pull the details
              </p>
              <div className="flex items-center justify-center gap-2 mt-4">
                <Button size="sm" variant="outline">
                  <Camera className="h-4 w-4 mr-1" /> Camera
                </Button>
                <Button size="sm" variant="outline">
                  <Upload className="h-4 w-4 mr-1" /> Upload
                </Button>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf"
              capture="environment"
              className="hidden"
              onChange={onFileInput}
            />
          </CardContent>
        </Card>

        <button
          className="text-sm text-primary font-medium w-full text-center py-2"
          onClick={() => setStep('details')}
        >
          Skip — enter details manually
        </button>
      </div>
    );
  }

  /* Step: details form */
  if (step === 'details') {
    return (
      <div className="space-y-4 pb-24">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => setStep('upload')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">Expense Details</h1>
        </div>

        {/* Receipt preview */}
        {receiptPreview && (
          <div className="relative">
            <img
              src={receiptPreview}
              alt="Receipt"
              className="w-full max-h-48 object-contain rounded-lg border bg-muted"
            />
            <Button
              variant="destructive"
              size="icon"
              className="absolute top-2 right-2 h-7 w-7"
              onClick={() => {
                setReceiptFile(null);
                setReceiptPreview(null);
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        {ocrLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading receipt…
          </div>
        )}

        {/* Entity */}
        <div>
          <Label>Entity</Label>
          <SelectField
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            placeholder="Select entity"
            options={[
              { value: 'brix', label: 'Brix Beverage (CA)' },
              { value: 'freeflow', label: 'Freeflow (MA)' },
              { value: 'shared', label: 'Shared' },
            ]}
          />
        </div>

        {/* Vendor */}
        <div>
          <Label>Vendor / Payee</Label>
          <Input
            placeholder="e.g. Home Depot, AutoZone"
            value={vendorName}
            onChange={(e) => setVendorName(e.target.value)}
          />
        </div>

        {/* Amount + Date row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Amount ($)</Label>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={totalAmount}
              onChange={(e) => setTotalAmount(e.target.value)}
            />
          </div>
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              value={receiptDate}
              onChange={(e) => setReceiptDate(e.target.value)}
            />
          </div>
        </div>

        {/* Approval badge */}
        {totalNum > 0 && (
          <div className="text-xs">
            {needsApproval ? (
              <Badge variant="warning">
                Over {formatCurrency(threshold)} — manager approval required
              </Badge>
            ) : (
              <Badge variant="success">
                Under {formatCurrency(threshold)} — auto-approved
              </Badge>
            )}
          </div>
        )}

        {/* COGS account */}
        <div>
          <Label>COGS / Expense Account</Label>
          <SelectField
            value={cogsAccountLabel}
            onChange={(e) => handleCogsChange(e.target.value)}
            placeholder="Select account"
            options={(settings?.cogs_accounts ?? []).map((a) => ({
              value: a.label,
              label: a.label,
            }))}
          />
        </div>

        {/* Tag */}
        <div>
          <Label>Tag</Label>
          <SelectField
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Optional"
            options={[
              { value: '', label: 'None' },
              ...(settings?.tags ?? []).map((t) => ({ value: t, label: t })),
            ]}
          />
        </div>

        {/* Department (shown when tag is set) */}
        {tag && (
          <div>
            <Label>Department</Label>
            <SelectField
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="Select department"
              options={(settings?.departments ?? []).map((d) => ({
                value: d,
                label: d,
              }))}
            />
          </div>
        )}

        {/* Customer + Job row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Customer (optional)</Label>
            <Input
              placeholder="Customer name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
            />
          </div>
          <div>
            <Label>Job # (optional)</Label>
            <Input
              placeholder="Job number"
              value={jobNumber}
              onChange={(e) => setJobNumber(e.target.value)}
            />
          </div>
        </div>

        {/* Memo */}
        <div>
          <Label>Memo / Notes</Label>
          <Textarea
            placeholder="What was this for?"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={2}
          />
        </div>

        {/* Manager selector (shown when over threshold) */}
        {needsApproval && (
          <div>
            <Label>Manager for Approval</Label>
            <SelectField
              value={managerEmail}
              onChange={(e) => setManagerEmail(e.target.value)}
              placeholder="Select manager"
              options={(settings?.manager_emails ?? []).map((e) => ({
                value: e,
                label: e,
              }))}
            />
          </div>
        )}

        {/* Line items */}
        <Card>
          <CardHeader className="p-3 pb-0">
            <CardTitle className="text-sm font-medium">
              Line Items
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 space-y-3">
            {lineItems.map((li, idx) => (
              <div key={idx} className="flex items-start gap-2">
                <div className="flex-1 space-y-1">
                  <Input
                    placeholder="Description"
                    value={li.description}
                    onChange={(e) =>
                      updateLineItem(idx, 'description', e.target.value)
                    }
                    className="text-sm"
                  />
                  <div className="grid grid-cols-3 gap-1">
                    <Input
                      type="number"
                      placeholder="Qty"
                      value={li.qty || ''}
                      onChange={(e) =>
                        updateLineItem(idx, 'qty', e.target.value)
                      }
                      className="text-sm"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="Price"
                      value={li.unit_price || ''}
                      onChange={(e) =>
                        updateLineItem(idx, 'unit_price', e.target.value)
                      }
                      className="text-sm"
                    />
                    <div className="flex items-center justify-end text-sm font-medium tabular-nums pr-2">
                      {formatCurrency(li.amount)}
                    </div>
                  </div>
                </div>
                {lineItems.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive mt-1"
                    onClick={() => removeLineItem(idx)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={addLineItem}
            >
              <Plus className="h-4 w-4 mr-1" /> Add Line
            </Button>
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="fixed bottom-16 left-0 right-0 bg-background border-t px-4 py-3">
          <div className="max-w-lg mx-auto">
            <Button
              className="w-full"
              size="lg"
              disabled={!vendorName || totalNum <= 0 || (needsApproval && !managerEmail)}
              onClick={handleSubmit}
            >
              {needsApproval
                ? 'Submit for Approval'
                : `Submit — ${formatCurrency(totalNum)}`}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  /* Step: submitting */
  if (step === 'submitting') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">
          {needsApproval
            ? 'Submitting and notifying manager…'
            : 'Processing expense…'}
        </p>
      </div>
    );
  }

  /* Step: success */
  if (step === 'success') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
        <CheckCircle className="h-12 w-12 text-emerald-500" />
        <h2 className="text-lg font-semibold">{resultMessage}</h2>
        {resultBillId && (
          <p className="text-sm text-muted-foreground">
            QBO Bill ID: <span className="font-mono">{resultBillId}</span>
          </p>
        )}
        <div className="flex gap-2 mt-4">
          <Button variant="outline" onClick={() => navigate('/')}>
            Home
          </Button>
          <Button
            onClick={() => {
              setStep('upload');
              setReceiptFile(null);
              setReceiptPreview(null);
              setVendorName('');
              setTotalAmount('');
              setReceiptDate(new Date().toISOString().slice(0, 10));
              setEntity('brix');
              setCogsAccountLabel('');
              setCogsAccountId('');
              setTag('');
              setDepartment('');
              setCustomerName('');
              setJobNumber('');
              setMemo('');
              setManagerEmail('');
              setLineItems([{ description: '', qty: 1, unit_price: 0, amount: 0 }]);
              setResultMessage('');
              setResultBillId(null);
              setErrorMessage('');
            }}
          >
            Submit Another
          </Button>
        </div>
      </div>
    );
  }

  /* Step: error */
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h2 className="text-lg font-semibold">Submission Failed</h2>
      <p className="text-sm text-muted-foreground">{errorMessage}</p>
      <Button variant="outline" onClick={() => setStep('details')}>
        Try Again
      </Button>
    </div>
  );
}
