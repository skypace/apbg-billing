import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Camera, Upload, X, Plus, Trash2, Loader2,
  CheckCircle, AlertTriangle, Receipt, TrendingUp, TrendingDown,
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
import type { LineItem, PaymentAccount } from '@/types/expense';

type FormStep = 'upload' | 'details' | 'submitting' | 'success' | 'error';

interface MarginMatch {
  matched: boolean;
  job_number?: string;
  invoice?: {
    id: string;
    number: string;
    customerName: string | null;
    total: number;
  };
  margin?: number;
  marginPct?: number;
}

export default function ExpenseForm() {
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const isEditing = Boolean(id);
  const { session } = useSession();
  const { settings, loading: settingsLoading } = useExpenseSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<FormStep>(isEditing ? 'details' : 'upload');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  // Non-image attachments (PDFs) get rendered as a download link below the
  // image preview, since the form's previous &lt;img&gt; would just show a
  // broken-image icon.
  const [receiptDownloadUrl, setReceiptDownloadUrl] = useState<string | null>(null);
  const [receiptDownloadName, setReceiptDownloadName] = useState<string | null>(null);
  // Capture the row + storage path we loaded on edit so the X button can
  // actually remove it. Without this, clicking X cleared the local preview
  // but left the persisted attachment intact — it reappeared on the next
  // page load.
  const [originalAttachment, setOriginalAttachment] = useState<{ id: string; path: string } | null>(null);
  const [pendingAttachmentDelete, setPendingAttachmentDelete] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrModel, setOcrModel] = useState<string | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(isEditing);

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
  // Receipt expenses post as QBO Purchase entries; the submitter picks which
  // QBO account (corp card / bank / petty cash) was used so we can post
  // against it without needing a QBO Vendor record. The name + type are
  // cached on the row so reports / audit reads don't have to round-trip
  // QBO, and so PaymentType derivation on the notify path has a fallback
  // when the live QBO Account SELECT 5xx's.
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [paymentAccountName, setPaymentAccountName] = useState('');
  const [paymentAccountType, setPaymentAccountType] = useState('');
  const [paymentAccounts, setPaymentAccounts] = useState<PaymentAccount[]>([]);
  const [paymentAccountsError, setPaymentAccountsError] = useState<string | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { description: '', qty: 1, unit_price: 0, amount: 0 },
  ]);
  const [existingStatus, setExistingStatus] = useState<string | null>(null);

  const [, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [resultBillId] = useState<string | null>(null);
  const [marginMatch, setMarginMatch] = useState<MarginMatch | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const totalNum = parseFloat(totalAmount) || 0;
  const threshold = settings?.approval_threshold ?? 500;
  const needsApproval = totalNum > threshold;
  const readOnly = isEditing && existingStatus !== null && existingStatus !== 'draft';

  useEffect(() => {
    if (!id) return;
    // React Router v6 reuses the same ExpenseForm instance when navigating
    // between two /expense/edit/:id URLs (no `key` prop on the route), so
    // attachment + receipt state can survive a draft switch. Reset the
    // flags that the X-button delete path depends on, otherwise a pending
    // X-click against draft A could fire its delete against draft B's
    // attachment after navigation.
    setOriginalAttachment(null);
    setPendingAttachmentDelete(false);
    setReceiptPreview(null);
    setReceiptDownloadUrl(null);
    setReceiptDownloadName(null);
    setReceiptFile(null);

    let cancelled = false;
    (async () => {
      setLoadingExisting(true);
      const { data, error } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('id', id)
        .single();
      if (cancelled) return;
      if (error || !data) {
        setErrorMessage(
          error?.message ||
            "We couldn't load that submission. It may have been deleted, or you don't have access.",
        );
        setStep('error');
        setLoadingExisting(false);
        return;
      }
      setExistingStatus(data.status);
      setVendorName(data.vendor_name || '');
      setTotalAmount(data.total_amount != null ? String(data.total_amount) : '');
      setReceiptDate(data.receipt_date || new Date().toISOString().slice(0, 10));
      setEntity(data.entity || 'brix');
      setCogsAccountLabel(data.cogs_account_label || '');
      setCogsAccountId(data.cogs_account_id || '');
      setTag(data.tag || '');
      setDepartment(data.department || '');
      setCustomerName(data.customer_name || '');
      setJobNumber(data.job_number || '');
      setMemo(data.memo || '');
      setManagerEmail(data.manager_email || '');
      setPaymentAccountId(data.payment_account_id || '');
      // Restore the cached name + type too. Without these, a fast resubmit
      // of an edited draft (before the paymentAccounts mount-effect resolves)
      // would write nulls back over them, breaking reporting and the
      // notify-path PaymentType fallback chain.
      setPaymentAccountName(data.payment_account_name || '');
      setPaymentAccountType(data.payment_account_type || '');
      if (Array.isArray(data.line_items) && data.line_items.length > 0) {
        setLineItems(data.line_items as LineItem[]);
      }

      // Pull the first attachment for the receipt preview. Until now the
      // edit view showed a blank receipt slot even when the row had a real
      // image attached, so operators had no way to verify they were
      // editing the right submission.
      const { data: att } = await supabase
        .from('expense_request_attachments')
        .select('id, storage_path, file_type, file_name')
        .eq('request_id', id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!cancelled && att?.storage_path) {
        const { data: signed } = await supabase.storage
          .from('expense-attachments')
          .createSignedUrl(att.storage_path, 60 * 60);
        if (!cancelled && signed?.signedUrl) {
          setOriginalAttachment({ id: att.id, path: att.storage_path });
          // Only stuff the signed URL into receiptPreview when it's an
          // image — &lt;img src=...pdf&gt; would render a broken icon. PDFs
          // (and anything else uploaded via the .pdf accept) get a
          // download link instead.
          if (att.file_type?.startsWith('image/')) {
            setReceiptPreview(signed.signedUrl);
          } else {
            setReceiptDownloadUrl(signed.signedUrl);
            setReceiptDownloadName(att.file_name || 'receipt');
          }
        }
      }

      setStep('details');
      setLoadingExisting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Pull the "Paid with" account list from QBO once on mount. Bank + Credit
  // Card accounts only — the picker is for receipt-style expenses, not bills.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        const res = await fetch('/expense/api/expense-payment-accounts', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`Payment accounts ${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        setPaymentAccounts(Array.isArray(body.accounts) ? body.accounts : []);
        setPaymentAccountsError(null);
      } catch (e: any) {
        if (cancelled) return;
        setPaymentAccountsError(
          e?.message ||
            "Couldn't load payment accounts from QBO. The form will let you submit but the auto-post to QBO will be deferred until you pick one.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Match the OCR's free-form account guess against the configured COGS list. */
  const pickCogsAccount = useCallback(
    (guess: string | null | undefined) => {
      if (!guess || !settings?.cogs_accounts?.length) return null;
      const g = guess.toLowerCase().trim();
      const exact = settings.cogs_accounts.find((a) => a.label.toLowerCase() === g);
      if (exact) return exact;
      const partial = settings.cogs_accounts.find(
        (a) =>
          g.includes(a.label.toLowerCase()) || a.label.toLowerCase().includes(g),
      );
      return partial ?? null;
    },
    [settings],
  );

  const handleFileSelect = useCallback(
    async (file: File) => {
      setReceiptFile(file);
      setOcrError(null);
      setOcrModel(null);
      // Symmetric with the edit-load path: images render in the &lt;img&gt;
      // preview, anything else (PDFs are the only other accepted type)
      // renders as a download link. Without this, new-flow PDF uploads
      // left both states null and the entire preview block — including
      // the X button — failed to render, so the operator had no way to
      // verify or undo the attachment.
      if (file.type.startsWith('image/')) {
        setReceiptPreview(URL.createObjectURL(file));
        setReceiptDownloadUrl(null);
        setReceiptDownloadName(null);
      } else {
        setReceiptPreview(null);
        setReceiptDownloadUrl(URL.createObjectURL(file));
        setReceiptDownloadName(file.name);
      }

      setOcrLoading(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const token = await getAccessToken();
        const res = await fetch('/expense/api/expense-ocr', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        });

        if (!res.ok) {
          let detail = `OCR failed (${res.status})`;
          try {
            const errBody = await res.json();
            detail = errBody.error || detail;
          } catch {}
          setOcrError(`${detail} — fill the details in manually.`);
        } else {
          const ocr = await res.json();
          if (ocr.model) setOcrModel(ocr.model);
          if (ocr.vendor) setVendorName(ocr.vendor);
          if (ocr.total != null) setTotalAmount(String(ocr.total));
          if (ocr.date) setReceiptDate(ocr.date);
          if (Array.isArray(ocr.line_items) && ocr.line_items.length > 0) {
            setLineItems(
              ocr.line_items.map((li: any) => ({
                description: String(li.description ?? ''),
                qty: Number(li.qty ?? 1),
                unit_price: Number(li.unit_price ?? 0),
                amount: Number(li.amount ?? (li.qty ?? 1) * (li.unit_price ?? 0)),
              })),
            );
          }
          const matched = pickCogsAccount(ocr.account_guess);
          if (matched) {
            setCogsAccountLabel(matched.label);
            setCogsAccountId(matched.id);
          } else if (ocr.account_guess) {
            setCogsAccountLabel(ocr.account_guess);
          }
          if (ocr.job_number && !jobNumber) setJobNumber(ocr.job_number);
          if (ocr.customer_name && !customerName) setCustomerName(ocr.customer_name);
          if (ocr.memo && !memo) setMemo(ocr.memo);
          if (ocr.notes && !memo) setMemo((m) => (m ? `${m}\n${ocr.notes}` : ocr.notes));
        }
      } catch (e) {
        console.warn('OCR call failed', e);
        setOcrError('Could not reach the OCR service — fill the details in manually.');
      } finally {
        setOcrLoading(false);
        setStep('details');
      }
    },
    [pickCogsAccount, jobNumber, customerName, memo],
  );

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  };

  const handleCogsChange = (label: string) => {
    setCogsAccountLabel(label);
    const match = settings?.cogs_accounts.find((a) => a.label === label);
    setCogsAccountId(match?.id ?? '');
  };

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
    if (!session || readOnly) return;
    if (!paymentAccountId) {
      setErrorMessage('Pick a "Paid with" account before submitting — the receipt needs to post against a real QBO account.');
      setStep('error');
      return;
    }
    setStep('submitting');
    setSubmitting(true);
    setMarginMatch(null);
    try {
      const nonEmptyLines = lineItems.filter((li) => li.description.trim());
      const user = session.user;
      const userName = user.user_metadata?.full_name || user.email || 'Unknown';
      const pickedAcct = paymentAccounts.find((a) => a.id === paymentAccountId) || null;

      // Fields the operator can edit. Shared between INSERT (new submission)
      // and UPDATE (editing a draft) so the two paths can't drift.
      const editableFields = {
        entity,
        vendor_name: vendorName || null,
        total_amount: totalNum || 0,
        receipt_date: receiptDate || null,
        cogs_account_id: cogsAccountId || null,
        cogs_account_label: cogsAccountLabel || null,
        tag: tag || null,
        department: department || null,
        customer_name: customerName || null,
        job_number: jobNumber || null,
        memo: memo || null,
        manager_email: needsApproval ? managerEmail : null,
        payment_account_id: paymentAccountId,
        // Prefer the freshly-picked account, but fall back to the cached
        // values from loadExisting so re-submitting an edited draft before
        // the dropdown list resolves doesn't blank these columns.
        payment_account_name: pickedAcct?.name ?? paymentAccountName ?? null,
        payment_account_type: pickedAcct?.account_type ?? paymentAccountType ?? null,
        line_items: nonEmptyLines,
      };

      let req: { id: string } | null = null;
      if (isEditing && id) {
        // Editing an existing draft: UPDATE in place. Previously the form
        // always INSERTed, which silently created a duplicate row every
        // time an operator opened a draft to fix a typo.

        // Guard 1: refuse to UPDATE if the original load never succeeded.
        // existingStatus is set inside the load effect; if it's still null
        // here, the operator is staring at a default-state form (entity=
        // 'brix', empty fields) — pressing Submit would overwrite the real
        // row with nulls. Pre-PR the same path produced a benign duplicate
        // INSERT; the new UPDATE branch turns that into data loss.
        if (!existingStatus) {
          setErrorMessage(
            "We couldn't load the original submission, so editing is blocked. Refresh the page to retry, or go back to your dashboard.",
          );
          setStep('error');
          return;
        }

        // Guard 2: also key the UPDATE on status='draft'. RLS policy
        // expense_requests_update_self (20260512s) is intentionally
        // status-blind so the submitter retains row access post-decision,
        // but we don't want a stale tab to overwrite a row that another
        // session has already posted to QBO. If the row changed status
        // since load, .single() returns 0 rows → updateErr → throw.
        const { data: updated, error: updateErr } = await supabase
          .from('expense_requests')
          .update(editableFields)
          .eq('id', id)
          .eq('status', 'draft')
          .select()
          .single();
        if (updateErr || !updated) {
          throw new Error(
            updateErr?.message ??
              "Couldn't update this submission — it may have been posted from another tab. Reload and try again.",
          );
        }
        req = updated;
      } else {
        const { data: inserted, error: insertErr } = await supabase
          .from('expense_requests')
          .insert({
            request_type: 'expense',
            status: 'draft',
            submitted_by: user.id,
            submitter_name: userName,
            submitter_email: user.email || '',
            ...editableFields,
          })
          .select()
          .single();
        if (insertErr || !inserted) throw new Error(insertErr?.message ?? 'Insert failed');
        req = inserted;
      }
      // Both branches throw on failure, so req is guaranteed non-null
      // here — but TS can't narrow across the let-init-then-assign-in-
      // branches pattern. Explicit guard.
      if (!req) throw new Error('Save failed');

      // Honor an X-click against an originally-loaded attachment: actually
      // remove the row + storage object so it doesn't silently reappear on
      // the next page load. The supabase calls used to swallow errors;
      // when RLS denied the row delete it returned zero affected rows + no
      // error, so the UI thought it succeeded. Now we surface the error
      // from the row delete (the user-visible bit) and warn-only on
      // storage (a stranded object can be garbage-collected later).
      if (pendingAttachmentDelete && originalAttachment) {
        const { error: storageErr } = await supabase.storage
          .from('expense-attachments')
          .remove([originalAttachment.path]);
        if (storageErr) {
          // eslint-disable-next-line no-console
          console.warn('Receipt storage delete failed (non-fatal):', storageErr.message);
        }
        const { error: rowErr } = await supabase
          .from('expense_request_attachments')
          .delete()
          .eq('id', originalAttachment.id);
        if (rowErr) {
          throw new Error('Could not delete attachment: ' + rowErr.message);
        }
        setOriginalAttachment(null);
        setPendingAttachmentDelete(false);
      }

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

      const accessToken = await getAccessToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      };

      const notifyRes = await fetch('/expense/api/expense-request-notify', {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestId: req.id }),
      });

      if (notifyRes.ok) {
        const notifyData = await notifyRes.json();
        if (notifyData.margin_match) setMarginMatch(notifyData.margin_match);
        if (notifyData.auto_approved) {
          setResultMessage('Expense auto-approved and logged.');
        } else {
          setResultMessage(
            `Submitted for approval — ${notifyData.approver ?? 'the chosen approver'} has been notified.`,
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

  if (settingsLoading || loadingExisting) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

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
                Photo, scan, or PDF — Claude will read it and fill the form
              </p>
              <div className="flex items-center justify-center gap-2 mt-4">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    cameraInputRef.current?.click();
                  }}
                >
                  <Camera className="h-4 w-4 mr-1" /> Camera
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                >
                  <Upload className="h-4 w-4 mr-1" /> Upload
                </Button>
              </div>
            </div>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={onFileInput}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf"
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

  if (step === 'details') {
    return (
      <div className="space-y-4 pb-36">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold flex-1">
            {isEditing ? 'Submission Details' : 'Expense Details'}
          </h1>
          {isEditing && existingStatus && (
            <Badge variant="secondary">{existingStatus}</Badge>
          )}
        </div>

        {readOnly && (
          <div className="text-xs bg-secondary/40 border border-border rounded-md p-3">
            This submission has already been processed and is read-only.
            Use <strong>New Expense</strong> from the dashboard to file a new one.
          </div>
        )}

        {(receiptPreview || receiptDownloadUrl) && (
          <div className="relative">
            {receiptPreview ? (
              <img
                src={receiptPreview}
                alt="Receipt"
                className="w-full max-h-48 object-contain rounded-lg border bg-muted"
              />
            ) : (
              <a
                href={receiptDownloadUrl ?? '#'}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 w-full p-3 rounded-lg border bg-muted hover:bg-muted/70 text-sm"
              >
                <Receipt className="h-4 w-4 shrink-0" />
                <span className="truncate">{receiptDownloadName ?? 'Open receipt'}</span>
              </a>
            )}
            {!readOnly && (
              <Button
                variant="destructive"
                size="icon"
                className="absolute top-2 right-2 h-7 w-7"
                onClick={() => {
                  setReceiptFile(null);
                  setReceiptPreview(null);
                  setReceiptDownloadUrl(null);
                  setReceiptDownloadName(null);
                  // If the preview came from a persisted attachment (edit
                  // mode), mark it for deletion on submit — otherwise the
                  // X click was visually meaningless and the receipt would
                  // reappear on the next load.
                  if (originalAttachment) setPendingAttachmentDelete(true);
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}

        {ocrLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading receipt with Claude…
          </div>
        )}
        {!ocrLoading && ocrModel && !ocrError && (
          <div className="text-xs text-muted-foreground">
            Auto-filled from receipt by <span className="font-mono">{ocrModel}</span>. Double-check before submitting.
          </div>
        )}
        {ocrError && (
          <div className="text-sm rounded-lg p-3 border border-amber-500/40 bg-amber-500/10 text-amber-200">
            {ocrError}
          </div>
        )}

        <div>
          <Label>Vendor / Payee</Label>
          <Input
            disabled={readOnly}
            placeholder="e.g. Home Depot, AutoZone"
            value={vendorName}
            onChange={(e) => setVendorName(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Amount ($)</Label>
            <Input
              disabled={readOnly}
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
              disabled={readOnly}
              type="date"
              value={receiptDate}
              onChange={(e) => setReceiptDate(e.target.value)}
            />
          </div>
        </div>

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

        <div>
          <Label>COGS / Expense Account</Label>
          <SelectField
            disabled={readOnly}
            value={cogsAccountLabel}
            onChange={(e) => handleCogsChange(e.target.value)}
            placeholder="Select account"
            options={(settings?.cogs_accounts ?? []).map((a) => ({
              value: a.label,
              label: a.label,
            }))}
          />
        </div>

        <div>
          <Label>
            Paid with <span className="text-red-500">*</span>
          </Label>
          <SelectField
            disabled={readOnly}
            value={paymentAccountId}
            onChange={(e) => setPaymentAccountId(e.target.value)}
            placeholder={
              paymentAccounts.length === 0
                ? paymentAccountsError
                  ? 'Failed to load — see error below'
                  : 'Loading QBO accounts…'
                : 'Select the card or account this was paid from'
            }
            options={paymentAccounts.map((a) => ({
              value: a.id,
              label: `${a.name} (${a.account_type})`,
            }))}
          />
          {paymentAccountsError && (
            <p className="text-xs text-amber-600 mt-1">{paymentAccountsError}</p>
          )}
        </div>

        <div>
          <Label>Tag</Label>
          <SelectField
            disabled={readOnly}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Optional"
            options={[
              { value: '', label: 'None' },
              ...(settings?.tags ?? []).map((t) => ({ value: t, label: t })),
            ]}
          />
        </div>

        {tag && (
          <div>
            <Label>Department</Label>
            <SelectField
              disabled={readOnly}
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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Customer (optional)</Label>
            <Input
              disabled={readOnly}
              placeholder="Customer name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
            />
          </div>
          <div>
            <Label>Job # (optional)</Label>
            <Input
              disabled={readOnly}
              placeholder="SF / ResQ job #"
              value={jobNumber}
              onChange={(e) => setJobNumber(e.target.value)}
            />
          </div>
        </div>

        <div>
          <Label>Memo / Notes</Label>
          <Textarea
            disabled={readOnly}
            placeholder="What was this for?"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            rows={2}
          />
        </div>

        {needsApproval && (
          <div>
            <Label>Manager for Approval</Label>
            <SelectField
              disabled={readOnly}
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
                    disabled={readOnly}
                    placeholder="Description"
                    value={li.description}
                    onChange={(e) =>
                      updateLineItem(idx, 'description', e.target.value)
                    }
                    className="text-sm"
                  />
                  <div className="grid grid-cols-3 gap-1">
                    <Input
                      disabled={readOnly}
                      type="number"
                      placeholder="Qty"
                      value={li.qty || ''}
                      onChange={(e) =>
                        updateLineItem(idx, 'qty', e.target.value)
                      }
                      className="text-sm"
                    />
                    <Input
                      disabled={readOnly}
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
                {!readOnly && lineItems.length > 1 && (
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
            {!readOnly && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={addLineItem}
              >
                <Plus className="h-4 w-4 mr-1" /> Add Line
              </Button>
            )}
          </CardContent>
        </Card>

        {!readOnly && (
          <div className="form-submit-bar">
            <div className="max-w-lg mx-auto">
              <Button
                className="w-full"
                size="lg"
                disabled={!vendorName || totalNum <= 0 || !paymentAccountId || (needsApproval && !managerEmail)}
                onClick={handleSubmit}
              >
                {needsApproval
                  ? 'Submit for Approval'
                  : `Submit — ${formatCurrency(totalNum)}`}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

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

  if (step === 'success') {
    const margin = marginMatch?.margin ?? 0;
    const marginPct = marginMatch?.marginPct ?? 0;
    const positive = margin >= 0;

    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
        <CheckCircle className="h-12 w-12 text-emerald-500" />
        <h2 className="text-lg font-semibold">{resultMessage}</h2>
        {resultBillId && (
          <p className="text-sm text-muted-foreground">
            QBO Bill ID: <span className="font-mono">{resultBillId}</span>
          </p>
        )}

        {marginMatch?.matched && marginMatch.invoice && (
          <Card className="w-full max-w-sm text-left">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                {positive ? (
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                ) : (
                  <TrendingDown className="h-4 w-4 text-destructive" />
                )}
                Matched to invoice
              </div>
              <div className="text-2xl font-bold tabular-nums" style={{ color: positive ? 'var(--green)' : 'var(--danger)' }}>
                {marginPct.toFixed(1)}% — {formatCurrency(margin)}
              </div>
              <div className="text-xs text-muted-foreground space-y-1 pt-1">
                <div>Invoice <span className="font-mono">#{marginMatch.invoice.number}</span> · {marginMatch.invoice.customerName ?? '—'}</div>
                <div>Job # <span className="font-mono">{marginMatch.job_number}</span> · Invoice total {formatCurrency(marginMatch.invoice.total)}</div>
              </div>
            </CardContent>
          </Card>
        )}
        {marginMatch && !marginMatch.matched && marginMatch.job_number && (
          <div className="text-xs rounded-lg p-3 border border-amber-500/40 bg-amber-500/10 text-amber-200 max-w-sm">
            No QBO invoice found referencing Job #{marginMatch.job_number}. Either the invoice hasn't been created yet, or the job number doesn't appear on any recent invoice.
          </div>
        )}

        <div className="flex gap-2 mt-4">
          <Button variant="outline" onClick={() => navigate('/')}>
            Home
          </Button>
          <Button onClick={() => navigate('new')}>
            Submit Another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h2 className="text-lg font-semibold">Submission Failed</h2>
      <p className="text-sm text-muted-foreground">{errorMessage}</p>
      {/* If the load itself failed (edit mode with no existingStatus),
       *  there's nothing on the form to "try again" — Submit at that point
       *  would write defaults over the real row. Route back to the
       *  dashboard so the operator can re-open the draft fresh. */}
      {isEditing && !existingStatus ? (
        <Button variant="outline" onClick={() => navigate('/')}>
          Back to dashboard
        </Button>
      ) : (
        <Button variant="outline" onClick={() => setStep('details')}>
          Try Again
        </Button>
      )}
    </div>
  );
}
