import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { postToQuickBooks as postExpenseToQbo } from '@/lib/postToQbo';
import { dueDateFromTerms } from '@/lib/dueDate';
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
  // `?fromPR=<uuid>` — when present, ExpenseForm is being used to log the
  // receipt for an already-approved Purchase Request. We pre-fill vendor /
  // amount / account routing from that PR and set linkedPRId so the new
  // expense carries linked_pr_id back to the original request. Set by the
  // "Log Receipt" CTA on PendingList for awaiting_invoice PR rows.
  const [searchParams] = useSearchParams();
  const fromPRId = searchParams.get('fromPR') || null;
  // A bill read off a document elsewhere (a drop on the vendor page) is handed
  // over through sessionStorage rather than the URL: line items don't fit in a
  // query string, and an invoice's contents have no business in browser history.
  const prefillKey = searchParams.get('prefill') || null;
  const isEditing = Boolean(id);
  const { session } = useSession();
  const { settings, loading: settingsLoading } = useExpenseSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<FormStep>(isEditing ? 'details' : 'upload');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrModel, setOcrModel] = useState<string | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(isEditing);

  const [vendorName, setVendorName] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [dueDate, setDueDate] = useState('');
  // 'printed' once a human or the invoice itself fixed the date, so the
  // terms→date derivation stops overwriting it.
  const [dueDateSource, setDueDateSource] = useState<'printed' | 'terms' | 'manual' | null>(null);
  // SF-landed drafts only: why the automated OCR gate held this one back from
  // auto-posting (null once it's cleared, or for any non-SF expense). Purely
  // informational — editing/submitting here always posts gate-free, since a
  // human is looking at it.
  const [sfOcrStatus, setSfOcrStatus] = useState<string | null>(null);
  const [sfOcrErrorMsg, setSfOcrErrorMsg] = useState<string | null>(null);
  const [totalAmount, setTotalAmount] = useState('');
  const [receiptDate, setReceiptDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [entity, setEntity] = useState('brix');
  const [cogsAccountLabel, setCogsAccountLabel] = useState('');
  const [cogsAccountId, setCogsAccountId] = useState('');
  const [tag, setTag] = useState('');
  const [department, setDepartment] = useState('');
  // QBO Department (Location tracking) — dropdown sourced from QBO + add-new.
  const [qboDepartmentId, setQboDepartmentId] = useState('');
  const [qboDepartmentName, setQboDepartmentName] = useState('');
  const [qboDepartments, setQboDepartments] = useState<{ id: string; name: string }[]>([]);
  const [addingDept, setAddingDept] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');
  const [deptSaving, setDeptSaving] = useState(false);
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
  // Explicit "was this already paid?" control. false = unpaid → QBO Bill (no
  // payment account asked); true = paid → QBO Expense against a payment account.
  // Drives `as_bill` on submit; backend routing (expense-request-notify) is
  // unchanged. Default unpaid so we never demand an account for a bill.
  const [isPaid, setIsPaid] = useState(false);

  // Per-user "sticky defaults": remember the submitter's usual entity /
  // department / COGS / payment choice on each successful submit and pre-fill
  // the NEXT new expense with them — on a phone the form becomes photo → OCR →
  // submit. localStorage keyed by user id (per-device, zero-backend; a wrong
  // guess is a one-tap fix). Never applied when editing or logging a PR.
  const defaultsKey = (uid: string) => `brixpense_defaults_v1_${uid}`;
  const appliedDefaultsRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultsRef.current || isEditing || fromPRId || !session) return;
    appliedDefaultsRef.current = true;
    try {
      const raw = localStorage.getItem(defaultsKey(session.user.id));
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.entity) setEntity(d.entity);
      if (d.tag) setTag(d.tag);
      if (d.department) setDepartment(d.department);
      if (d.qboDepartmentId) setQboDepartmentId(d.qboDepartmentId);
      if (d.qboDepartmentName) setQboDepartmentName(d.qboDepartmentName);
      if (d.cogsAccountId) setCogsAccountId(d.cogsAccountId);
      if (d.cogsAccountLabel) setCogsAccountLabel(d.cogsAccountLabel);
      if (typeof d.isPaid === 'boolean') setIsPaid(d.isPaid);
      if (d.isPaid && d.paymentAccountId) {
        setPaymentAccountId(d.paymentAccountId);
        if (d.paymentAccountName) setPaymentAccountName(d.paymentAccountName);
        if (d.paymentAccountType) setPaymentAccountType(d.paymentAccountType);
      }
    } catch { /* corrupt defaults are ignored */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, isEditing, fromPRId]);
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { description: '', qty: 1, unit_price: 0, amount: 0 },
  ]);
  const [existingStatus, setExistingStatus] = useState<string | null>(null);
  // Posted rows only: the QBO transaction id, so a late-arriving document can
  // still be attached and pushed onto the existing QBO Bill/Purchase
  // (mode=attach — the row itself stays read-only).
  const [existingQboBillId, setExistingQboBillId] = useState<string | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const postedAttachInputRef = useRef<HTMLInputElement>(null);
  // Set when this expense fulfills an approved Purchase Request. The insert
  // payload below carries this in `linked_pr_id` so the PR-side row can be
  // flipped to 'fulfilled' by expense-request-notify after the QBO post.
  const [linkedPRId, setLinkedPRId] = useState<string | null>(null);
  const [linkedPRVendor, setLinkedPRVendor] = useState<string | null>(null);

  const [, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const [resultBillId] = useState<string | null>(null);
  const [marginMatch, setMarginMatch] = useState<MarginMatch | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  // Gate (Sky, 2026-08-13): Submit only auto-approves — it never touches QBO.
  // readyToPost tracks whether THIS request is still waiting on the separate,
  // explicit "Post to QuickBooks" click.
  const [readyToPostId, setReadyToPostId] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postedInfo, setPostedInfo] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  const totalNum = parseFloat(totalAmount) || 0;
  const threshold = settings?.approval_threshold ?? 500;
  const needsApproval = totalNum > threshold;
  // 'approved' (auto-approved, not yet posted to QuickBooks) stays editable —
  // that's exactly the state where a human catches a bad field (wrong date,
  // wrong vendor) before it becomes a real QBO transaction. Everything past
  // that (posted/denied/fulfilled/awaiting_invoice) is locked; QBO or a
  // manager decision is the source of truth at that point.
  const readOnly = isEditing && existingStatus !== null && !['draft', 'approved'].includes(existingStatus);

  useEffect(() => {
    if (!id) return;
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
      setExistingQboBillId(data.qbo_bill_id || null);
      setEntity(data.entity || 'brix');
      setVendorName(data.vendor_name || '');
      setBillNumber(data.bill_number || '');
      setPaymentTerms(data.payment_terms || '');
      setDueDate(data.due_date || '');
      setDueDateSource(data.due_date_source || null);
      setSfOcrStatus(data.ocr_status || null);
      setSfOcrErrorMsg(data.ocr_error || null);
      setTotalAmount(data.total_amount != null ? String(data.total_amount) : '');
      setReceiptDate(data.receipt_date || new Date().toISOString().slice(0, 10));
      setCogsAccountLabel(data.cogs_account_label || '');
      setCogsAccountId(data.cogs_account_id || '');
      setTag(data.tag || '');
      setDepartment(data.department || '');
      setQboDepartmentId(data.qbo_department_id || '');
      setQboDepartmentName(data.qbo_department_name || '');
      setCustomerName(data.customer_name || '');
      setJobNumber(data.job_number || '');
      setMemo(data.memo || '');
      setManagerEmail(data.manager_email || '');
      // SF-staged drafts are unpaid bills (as_bill) with no payment account —
      // default the picker to "create bill" so submit posts a QBO Bill.
      setPaymentAccountId(data.payment_account_id || (data.as_bill ? '__bill__' : ''));
      // Restore the cached name + type too. Without these, a fast resubmit
      // of an edited draft (before the paymentAccounts mount-effect resolves)
      // would write nulls back over them, breaking reporting and the
      // notify-path PaymentType fallback chain.
      setPaymentAccountName(data.payment_account_name || '');
      setPaymentAccountType(data.payment_account_type || '');
      // Paid = it was booked against a real account (not an unpaid bill).
      setIsPaid(!data.as_bill && !!data.payment_account_id);
      if (Array.isArray(data.line_items) && data.line_items.length > 0) {
        setLineItems(data.line_items as LineItem[]);
      }
      setStep('details');
      setLoadingExisting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // "Log Receipt for PR" pre-fill — fired when the URL is /expense/new?fromPR=<uuid>.
  // Reads the approved PR's row, copies the vendor + amount + account routing
  // (cogs/dept/customer/job/tag/memo) into the form, and remembers the source
  // PR id so the insert below writes linked_pr_id back. Only runs when we're
  // NOT in edit mode (id is undefined). The PR's manager-approval audit
  // travels separately: expense-request-notify reads it server-side from
  // ops.expense_approvals at QBO Purchase post time.
  useEffect(() => {
    if (id || !fromPRId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('expense_requests')
        .select('id, request_type, status, vendor_name, total_amount, cogs_account_id, cogs_account_label, tag, department, customer_name, job_number, memo, line_items')
        .eq('id', fromPRId)
        .single();
      if (cancelled) return;
      if (error || !data) return;
      if (data.request_type !== 'purchase_request') return;
      // Pre-fill — only fields the user explicitly entered on the PR; date,
      // payment account, and signature are receipt-specific and stay blank
      // for the user to fill in.
      setLinkedPRId(data.id);
      setLinkedPRVendor(data.vendor_name || null);
      setVendorName(data.vendor_name || '');
      setTotalAmount(data.total_amount != null ? String(data.total_amount) : '');
      setCogsAccountId(data.cogs_account_id || '');
      setCogsAccountLabel(data.cogs_account_label || '');
      setTag(data.tag || '');
      setDepartment(data.department || '');
      setCustomerName(data.customer_name || '');
      setJobNumber(data.job_number || '');
      setMemo(data.memo || '');
      if (Array.isArray(data.line_items) && data.line_items.length > 0) {
        setLineItems(data.line_items as LineItem[]);
      }
      // Skip the upload step — the user already approved this purchase;
      // they just need to attach the receipt + pick a payment account.
      setStep('details');
    })();
    return () => { cancelled = true; };
  }, [id, fromPRId]);

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

  // Load QBO Departments (Location tracking) for the Location picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        const res = await fetch('/expense/api/expense-departments', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        setQboDepartments(Array.isArray(body.departments) ? body.departments : []);
      } catch {
        /* non-fatal — Location picker just stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleQboDepartmentChange = (val: string) => {
    if (val === '__add__') {
      setAddingDept(true);
      return;
    }
    setQboDepartmentId(val);
    setQboDepartmentName(qboDepartments.find((d) => d.id === val)?.name ?? '');
  };

  const createQboDepartment = async () => {
    const name = newDeptName.trim();
    if (!name) return;
    setDeptSaving(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/expense/api/expense-departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (res.ok && body.id) {
        setQboDepartments((prev) =>
          [...prev, { id: body.id, name: body.name }].sort((a, b) => a.name.localeCompare(b.name)),
        );
        setQboDepartmentId(body.id);
        setQboDepartmentName(body.name);
        setAddingDept(false);
        setNewDeptName('');
      }
    } finally {
      setDeptSaving(false);
    }
  };

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

  // Prefill from a document somebody already had us read. Deliberately a
  // DRAFT, not a submission: every field lands in the form for a human to look
  // at, exactly as if they had typed it. Nothing here posts anything.
  useEffect(() => {
    if (id || !prefillKey) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(prefillKey);
      // One-shot — a back-button return should not silently refill a form the
      // user has since edited.
      sessionStorage.removeItem(prefillKey);
    } catch { /* private window: no prefill, the form is just blank */ }
    if (!raw) return;
    try {
      const d = JSON.parse(raw) as Record<string, unknown>;
      const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
      if (str('vendor_name')) setVendorName(str('vendor_name'));
      if (str('bill_number')) setBillNumber(str('bill_number'));
      if (typeof d.total_amount === 'number') setTotalAmount(String(d.total_amount));
      if (str('receipt_date')) setReceiptDate(str('receipt_date'));
      if (str('payment_terms')) setPaymentTerms(str('payment_terms'));
      if (str('due_date')) {
        setDueDate(str('due_date'));
        setDueDateSource((str('due_date_source') as 'printed' | 'terms' | 'manual') || 'printed');
      }
      if (str('memo')) setMemo(str('memo'));
      if (str('job_number')) setJobNumber(str('job_number'));
      if (str('cogs_account_label')) {
        // Resolve through the same picker the receipt-upload path uses. A label
        // set on its own would sit next to whatever GL id the remembered
        // defaults put there — a row showing one account and posting to
        // another, which is the exact failure the bill rules guard against.
        const matched = pickCogsAccount(str('cogs_account_label'));
        setCogsAccountLabel(matched ? matched.label : str('cogs_account_label'));
        setCogsAccountId(matched ? matched.id : '');
      }
      if (Array.isArray(d.line_items) && d.line_items.length > 0) setLineItems(d.line_items as LineItem[]);
      // Straight to the details step — the document has been read, what's left
      // is checking it and attaching the file.
      setStep('details');
    } catch { /* a malformed handoff is just an empty form, never a crash */ }
  }, [id, prefillKey, pickCogsAccount]);


  const handleFileSelect = useCallback(
    async (file: File) => {
      setReceiptFile(file);
      setOcrError(null);
      setOcrModel(null);
      if (file.type.startsWith('image/')) {
        setReceiptPreview(URL.createObjectURL(file));
      } else {
        setReceiptPreview(null);
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
          if (ocr.bill_number) setBillNumber(ocr.bill_number);
          if (ocr.payment_terms) setPaymentTerms(ocr.payment_terms);
          if (ocr.due_date) { setDueDate(ocr.due_date); setDueDateSource('printed'); }
          // A fresh attachment + a fresh OCR pass supersedes whatever held this
          // draft before — clear the old hold reason so the banner disappears.
          setSfOcrStatus(null);
          setSfOcrErrorMsg(null);
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

  // Attach a late-arriving document to a POSTED expense: saves it on the
  // Brixpense record AND files it onto the existing QBO Bill/Purchase in one
  // step (mode=attach pushes only this one file, so it can't duplicate what
  // QBO already has). No OCR, no Submit — the row is read-only; only the
  // document was missing.
  const attachToPosted = async (file: File) => {
    if (!session || !id) return;
    setAttachBusy(true);
    setAttachNote(null);
    setAttachErr(null);
    try {
      const storagePath = `${session.user.id}/${id}/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage
        .from('expense-attachments')
        .upload(storagePath, file, { contentType: file.type, upsert: false });
      if (upErr) throw new Error(upErr.message);
      const { data: att, error: insErr } = await supabase
        .from('expense_request_attachments')
        .insert({
          request_id: id,
          file_name: file.name,
          file_type: file.type,
          file_size: file.size,
          storage_path: storagePath,
        })
        .select('id')
        .single();
      if (insErr || !att) throw new Error(insErr?.message || 'Could not save the attachment');
      const token = await getAccessToken();
      const res = await fetch('/expense/api/expense-request-link-bill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ requestId: id, mode: 'attach', attachmentId: att.id }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        // The file IS saved in Brixpense — only the QBO push failed.
        setAttachErr(data.message || data.error || 'Saved here, but pushing to QuickBooks failed — try again.');
        return;
      }
      setAttachNote(`Attached and filed on QuickBooks ${data.kind} ${data.qbo_txn_id}.`);
    } catch (e) {
      setAttachErr(e instanceof Error ? e.message : 'Could not attach the file.');
    } finally {
      setAttachBusy(false);
    }
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

  // Cascade: entity → department → COGS. Picking a department pre-selects its
  // mapped default COGS account (configured in Settings → Organization). The
  // user can still override the COGS account afterward; switching department
  // re-applies the mapping.
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

  // Pre-fill the approver from the default routing once settings load, unless
  // one is already set (edit-load, fromPR, or a department already picked).
  useEffect(() => {
    if (!settings) return;
    setManagerEmail((cur) => {
      if (cur) return cur;
      return (
        settings.approval_routing?.by_department?.[department] ||
        settings.approval_routing?.default_approver ||
        ''
      );
    });
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
    if (!session || readOnly) return;
    if (isPaid && (!paymentAccountId || paymentAccountId === '__bill__')) {
      setErrorMessage('This expense is marked as already paid — pick the account it was paid from before submitting.');
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
      // "Not paid — create bill" flips the downstream QBO post from Purchase
      // to Bill. We don't persist payment_account_id in this case since the
      // user picked a synthetic option; expense-request-notify routes on
      // as_bill instead.
      const asBill = !isPaid;

      // Fields written on both insert and update so the two paths can't drift.
      const fields = {
        entity,
        vendor_name: vendorName || null,
        bill_number: billNumber || null,
        payment_terms: paymentTerms || null,
        due_date: dueDate || null,
        due_date_source: dueDate ? (dueDateSource ?? 'manual') : null,
        total_amount: totalNum || 0,
        receipt_date: receiptDate || null,
        cogs_account_id: cogsAccountId || null,
        cogs_account_label: cogsAccountLabel || null,
        tag: tag || null,
        department: department || null,
        qbo_department_id: qboDepartmentId || null,
        qbo_department_name: qboDepartmentName || null,
        customer_name: customerName || null,
        job_number: jobNumber || null,
        memo: memo || null,
        manager_email: needsApproval ? managerEmail : null,
        payment_account_id: asBill ? null : paymentAccountId,
        payment_account_name: asBill ? null : (pickedAcct?.name ?? paymentAccountName ?? null),
        payment_account_type: asBill ? null : (pickedAcct?.account_type ?? paymentAccountType ?? null),
        as_bill: asBill,
        line_items: nonEmptyLines,
      };

      // Editing an existing row (e.g. a Service Fusion draft) UPDATEs in place
      // so we never leave a duplicate; otherwise INSERT a fresh draft. Either
      // way expense-request-notify (below) is what posts it to QBO.
      let req: { id: string } | null = null;
      if (isEditing && id) {
        const { data, error } = await supabase
          .from('expense_requests')
          .update(fields)
          .eq('id', id)
          .select()
          .single();
        if (error || !data) throw new Error(error?.message ?? 'Update failed');
        req = data;
      } else {
        const { data, error } = await supabase
          .from('expense_requests')
          .insert({
            request_type: 'expense',
            status: 'draft',
            submitted_by: user.id,
            submitter_name: userName,
            submitter_email: user.email || '',
            ...fields,
            // Carries back to the approved PR this expense fulfills, if any.
            linked_pr_id: linkedPRId,
          })
          .select()
          .single();
        if (error || !data) throw new Error(error?.message ?? 'Insert failed');
        req = data;
      }
      if (!req) throw new Error('Save failed');

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
        if (notifyData.ready_to_post && notifyData.mode === 'purchase') {
          // Already paid — nothing left to double-check that Submit didn't
          // already validate (payment account on file), so post it to
          // QuickBooks right now instead of making the user come back for a
          // second click. A failed post still lands exactly like a manual
          // one would (autopost_error stamped + REPORT_TO emailed) and this
          // row stays approved + editable, with the same "Post to
          // QuickBooks" button as a retry.
          try {
            const postData = await attemptPostToQuickBooks(req.id);
            if (postData.margin_match) setMarginMatch(postData.margin_match as MarginMatch);
            setResultMessage(
              `Posted to QuickBooks as Purchase ${postData.qbo_doc_number || postData.qbo_purchase_id}.`,
            );
          } catch (e) {
            setResultMessage('Approved, but the QuickBooks post failed — fix the issue below and try again.');
            setReadyToPostId(req.id);
            setPostError(e instanceof Error ? e.message : 'Could not reach the server.');
          }
        } else if (notifyData.ready_to_post) {
          // Unpaid bill — approve now, post whenever it's actually ready
          // (e.g. once it's paid); that's a deliberate separate click.
          setResultMessage('Approved — review the bill below, then post it to QuickBooks.');
          setReadyToPostId(req.id);
        } else if (notifyData.auto_approved) {
          setResultMessage('Expense auto-approved and logged.');
        } else {
          setResultMessage(
            `Submitted for approval — ${notifyData.approver ?? 'the chosen approver'} has been notified.`,
          );
        }
      } else {
        const notifyErr = await notifyRes.json().catch(() => ({}));
        setResultMessage(notifyErr.error || 'Request saved but could not be approved.');
      }

      // Remember this submitter's choices as the pre-fill for their next expense.
      try {
        localStorage.setItem(defaultsKey(user.id), JSON.stringify({
          entity, tag, department, qboDepartmentId, qboDepartmentName,
          cogsAccountId, cogsAccountLabel,
          isPaid,
          paymentAccountId: isPaid ? paymentAccountId : '',
          paymentAccountName: isPaid ? paymentAccountName : '',
          paymentAccountType: isPaid ? paymentAccountType : '',
        }));
      } catch { /* storage full/blocked — skip */ }

      setStep('success');
    } catch (err: any) {
      console.error('Submission error:', err);
      setErrorMessage(err.message || 'Something went wrong');
      setStep('error');
    } finally {
      setSubmitting(false);
    }
  };

  // Shared with the auto-post-on-submit path above (paid expenses) — this is
  // the one place that actually calls expense-request-link-bill. Throws on
  // any failure so both callers can each decide how to surface it.
  //
  // The auto-post path (Submit on an already-paid expense) declines a duplicate
  // rather than prompting: that post is a side effect of Submit, and a browser
  // confirm() appearing on top of the success screen for a decision the user
  // did not ask to make is the wrong moment. Declining leaves the row approved
  // with a visible "Post to QuickBooks" button, which is where the question
  // gets asked properly.
  const attemptPostToQuickBooks = (id: string, opts: { prompt?: boolean } = {}) =>
    postExpenseToQbo(id, opts.prompt ? {} : { onDuplicate: () => false });

  // The manual fallback — unpaid bills wait here deliberately ("post later,
  // once it's actually paid"); paid expenses only land here as a retry after
  // an auto-post attempt failed.
  const postToQuickBooks = async () => {
    if (!readyToPostId) return;
    setPosting(true);
    setPostError(null);
    try {
      const data = await attemptPostToQuickBooks(readyToPostId, { prompt: true });
      setPostedInfo(`Posted to QuickBooks as ${data.kind === 'purchase' ? 'Purchase' : 'Bill'} ${data.qbo_doc_number || data.qbo_bill_id || data.qbo_purchase_id}.`);
      if (data.margin_match) setMarginMatch(data.margin_match as MarginMatch);
      setReadyToPostId(null);
    } catch (e) {
      setPostError(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally {
      setPosting(false);
    }
  };

  if (settingsLoading || loadingExisting) {
    return (
      <div className="feedback-state min-h-[60vh]">
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
          <h1 className="page-title">New Expense</h1>
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
          <h1 className="page-title flex-1">
            {isEditing ? 'Submission Details' : 'Expense Details'}
          </h1>
          {isEditing && existingStatus && (
            <Badge variant="secondary">{existingStatus}</Badge>
          )}
        </div>

        {readOnly && (
          <div className="text-xs bg-secondary/40 border border-border rounded-md p-3">
            This submission has already been processed and is read-only.
            {existingStatus === 'posted' && existingQboBillId
              ? ' You can still attach the bill document below — it files onto the QuickBooks transaction too.'
              : <> Use <strong>New Expense</strong> from the dashboard to file a new one.</>}
          </div>
        )}

        {/* Attach-after-post: the fields are locked, but a late-arriving bill
            document can still be filed — saved here AND pushed onto the
            existing QBO Bill/Purchase. Without this, a bill posted before its
            document arrived could never get the file into QuickBooks. */}
        {isEditing && existingStatus === 'posted' && existingQboBillId && (
          <div className="space-y-2">
            <div
              className="border border-dashed rounded-lg p-3 flex items-center justify-between gap-3 cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => !attachBusy && postedAttachInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f && !attachBusy) void attachToPosted(f);
              }}
            >
              <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
                {attachBusy
                  ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  : <Receipt className="h-4 w-4 shrink-0" />}
                <span className="truncate">
                  {attachBusy ? 'Attaching and filing to QuickBooks…' : 'Attach the bill — it will be filed on the QuickBooks transaction too'}
                </span>
              </div>
              <Button size="sm" variant="outline" type="button" disabled={attachBusy}
                onClick={(e) => { e.stopPropagation(); postedAttachInputRef.current?.click(); }}>
                <Upload className="h-4 w-4 mr-1" /> Upload
              </Button>
            </div>
            <input
              ref={postedAttachInputRef}
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void attachToPosted(f);
                e.target.value = '';
              }}
            />
            {attachNote && (
              <div className="text-xs rounded-md p-2.5 border border-emerald-500/30 bg-emerald-500/10 text-emerald-200">{attachNote}</div>
            )}
            {attachErr && (
              <div className="text-xs rounded-md p-2.5 border border-amber-500/40 bg-amber-500/10 text-amber-200">{attachErr}</div>
            )}
          </div>
        )}

        {isEditing && existingStatus === 'approved' && (
          <div className="text-xs rounded-md p-3 border border-amber-500/40 bg-amber-500/10 text-amber-200">
            {isPaid
              ? "Approved, but the QuickBooks post hasn't gone through yet. Fix whatever's wrong (date, vendor, account) and hit Submit — it will try posting to QuickBooks again right away."
              : 'Approved, but nothing has been sent to QuickBooks yet. If something\'s wrong (date, vendor, amount), fix it and hit Submit to re-check it — then use "Post to QuickBooks" wherever this expense is listed once it\'s ready.'}
          </div>
        )}

        {linkedPRId && !isEditing && (
          <div className="text-xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 rounded-md p-3">
            Logging the receipt for your approved Purchase Request
            {linkedPRVendor ? ` (${linkedPRVendor})` : ''}.
            Vendor, amount, and accounts are pre-filled from the PR — just attach the receipt and pick the "Paid with" account.
          </div>
        )}

        {sfOcrStatus && sfOcrStatus !== 'processed' && (
          <div className="text-sm rounded-lg p-3 border border-amber-500/40 bg-amber-500/10 text-amber-200">
            {sfOcrStatus === 'no_attachment' &&
              "No bill attached yet — the vendor, amount, and job came over from Service Fusion, but the document is yours to add. Attach the bill below (or fill in the details and Bill # by hand), then Submit."}
            {sfOcrStatus === 'failed' &&
              `Held from auto-posting — the attached receipt couldn't be read${sfOcrErrorMsg ? `: ${sfOcrErrorMsg}` : '.'} Double-check the details below and submit to post it now.`}
          </div>
        )}

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

        {/* A picked PDF has no image preview — show it as a named chip instead,
            so the user can tell the bill is attached (and un-pick it). */}
        {receiptFile && !receiptPreview && (
          <div className="flex items-center gap-2 text-sm rounded-lg p-3 border border-emerald-500/30 bg-emerald-500/10 text-emerald-200">
            <Receipt className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{receiptFile.name}</span>
            <button type="button" onClick={() => { setReceiptFile(null); setReceiptPreview(null); }} title="Remove">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Attach-here controls. The upload step only exists on the New Expense
            flow, so without this an OPEN draft (e.g. an SF-landed bill waiting
            for its document — receipts no longer auto-scrape from SF) had no way
            to take a file at all. Saved to the draft on Submit; OCR fills in
            whatever it can read (bill #, date, line items) on pick. */}
        {!readOnly && !receiptFile && (
          <div
            className="border border-dashed rounded-lg p-3 flex items-center justify-between gap-3 cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
              <Receipt className="h-4 w-4 shrink-0" />
              <span className="truncate">Attach the bill or receipt (photo, scan, or PDF)</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={(e) => { e.stopPropagation(); cameraInputRef.current?.click(); }}
              >
                <Camera className="h-4 w-4 mr-1" /> Camera
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
              >
                <Upload className="h-4 w-4 mr-1" /> Upload
              </Button>
            </div>
          </div>
        )}
        {!readOnly && (
          <>
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
          </>
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

        <div>
          <Label>Bill / Invoice #</Label>
          <Input
            disabled={readOnly}
            placeholder="From the vendor's invoice — auto-filled by OCR when a receipt is attached"
            value={billNumber}
            onChange={(e) => setBillNumber(e.target.value)}
          />
        </div>

        {/* Terms and due date only mean something on an unpaid bill. On a
            receipt you have already paid there is nothing left to be due. */}
        {!isPaid && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Payment terms</Label>
              <Input
                disabled={readOnly}
                placeholder="e.g. Net 30"
                value={paymentTerms}
                onChange={(e) => {
                  setPaymentTerms(e.target.value);
                  // Typing terms fills the due date — unless someone has
                  // already set one deliberately, in which case theirs stands.
                  if (dueDateSource === 'printed' || dueDateSource === 'manual') return;
                  const derived = dueDateFromTerms(receiptDate, e.target.value);
                  setDueDate(derived || '');
                  setDueDateSource(derived ? 'terms' : null);
                }}
              />
            </div>
            <div>
              <Label>Due date</Label>
              <Input
                disabled={readOnly}
                type="date"
                value={dueDate}
                onChange={(e) => { setDueDate(e.target.value); setDueDateSource(e.target.value ? 'manual' : null); }}
              />
              {dueDateSource === 'terms' && dueDate && (
                <p className="text-[11px] text-muted-foreground mt-1">Worked out from the terms — change it if the invoice says otherwise.</p>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Entity</Label>
            <SelectField
              disabled={readOnly}
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
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
              disabled={readOnly}
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
          {department && settings?.department_cogs_map?.[department] && (
            <p className="text-xs text-muted-foreground mt-1">
              Defaulted from the <span className="font-medium">{department}</span> department — change it if this expense belongs elsewhere.
            </p>
          )}
        </div>

        <div>
          <Label>Location (QBO Department)</Label>
          {addingDept ? (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                placeholder="New location name"
                value={newDeptName}
                onChange={(e) => setNewDeptName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    createQboDepartment();
                  }
                }}
              />
              <Button type="button" onClick={createQboDepartment} disabled={!newDeptName.trim() || deptSaving}>
                {deptSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAddingDept(false);
                  setNewDeptName('');
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <SelectField
              disabled={readOnly}
              value={qboDepartmentId}
              onChange={(e) => handleQboDepartmentChange(e.target.value)}
              placeholder="Select location"
              options={[
                { value: '', label: 'None' },
                ...qboDepartments.map((d) => ({ value: d.id, label: d.name })),
                { value: '__add__', label: '+ Add new location…' },
              ]}
            />
          )}
          <p className="text-xs text-muted-foreground mt-1">
            Tags this expense to a QBO Department (Location) — posted as the
            DEPARTMENT on the bill.
          </p>
        </div>

        <div>
          <Label>Was this already paid?</Label>
          <div className="flex gap-2 mt-1" role="radiogroup" aria-label="Payment status">
            <button
              type="button"
              disabled={readOnly}
              role="radio"
              aria-checked={!isPaid}
              onClick={() => { setIsPaid(false); setPaymentAccountId('__bill__'); }}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${!isPaid ? 'border-amber-400 bg-amber-400/10 text-amber-300' : 'border-white/10 text-muted-foreground hover:border-white/20'}`}
            >
              No — unpaid (create Bill)
            </button>
            <button
              type="button"
              disabled={readOnly}
              role="radio"
              aria-checked={isPaid}
              onClick={() => { setIsPaid(true); if (paymentAccountId === '__bill__') setPaymentAccountId(''); }}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${isPaid ? 'border-emerald-400 bg-emerald-400/10 text-emerald-300' : 'border-white/10 text-muted-foreground hover:border-white/20'}`}
            >
              Yes — already paid (Expense)
            </button>
          </div>

          {!isPaid ? (
            <p className="text-xs text-amber-400 mt-2">
              Posts as an unpaid <strong>Bill</strong> in QBO (vendor required) — pay it from QBO
              later. No payment account needed.
            </p>
          ) : (
            <div className="mt-3">
              <Label>
                Paid with <span className="text-red-500">*</span>
              </Label>
              <SelectField
                disabled={readOnly}
                value={paymentAccountId === '__bill__' ? '' : paymentAccountId}
                onChange={(e) => setPaymentAccountId(e.target.value)}
                placeholder={
                  paymentAccounts.length === 0
                    ? paymentAccountsError
                      ? 'Failed to load — see error below'
                      : 'Loading accounts…'
                    : 'Select the card or account this was paid from'
                }
                options={paymentAccounts
                  .filter((a) => a.id !== '__bill__')
                  .map((a) => ({ value: a.id, label: `${a.name} (${a.account_type})` }))}
              />
            </div>
          )}
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-medium">
              Line Items
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2 space-y-4">
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
                  : isPaid
                    ? `Submit & Post to QuickBooks — ${formatCurrency(totalNum)}`
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
      <div className="feedback-state min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">
          {needsApproval
            ? 'Submitting and notifying manager…'
            : isPaid
              ? 'Submitting and posting to QuickBooks…'
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
      <div className="feedback-state min-h-[60vh]">
        <CheckCircle className="h-12 w-12 text-emerald-500" />
        <h2 className="feedback-title">{resultMessage}</h2>
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

        {readyToPostId && !postedInfo && (
          <div className="w-full max-w-sm text-left space-y-2">
            <p className="text-xs text-muted-foreground">
              Nothing has been sent to QuickBooks yet. Double-check the vendor, amount, and line items above, then post it.
            </p>
            {postError && (
              <div className="text-sm rounded-lg p-3 border border-destructive/40 bg-destructive/10 text-destructive">
                {postError}
              </div>
            )}
            <Button className="w-full" disabled={posting} onClick={postToQuickBooks}>
              {posting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Post to QuickBooks
            </Button>
          </div>
        )}
        {postedInfo && (
          <p className="text-sm text-emerald-500 font-medium">{postedInfo}</p>
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
    <div className="feedback-state min-h-[60vh]">
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h2 className="feedback-title">Submission Failed</h2>
      <p className="text-sm text-muted-foreground">{errorMessage}</p>
      <Button variant="outline" onClick={() => setStep('details')}>
        Try Again
      </Button>
    </div>
  );
}
