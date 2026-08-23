import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getAccessToken } from '@/lib/supabase';
import { AlertTriangle, CheckCircle2, FileUp, Loader2 } from 'lucide-react';

// Drop a document on a vendor and have it filed.
//
// The point is that you should not have to tell it what you dropped. You are
// holding a PDF and you know what it is; a dropdown you must set first is the
// friction that means the document never gets filed at all. It classifies,
// says what it decided, and asks only when it genuinely cannot tell.
//
// ⚠ A bill dropped here does NOT become a payable. It is read for what it says
// about the vendor, and the read is handed back for you to file with one more
// click. A drag gesture must not create money.

type Kind = 'w9' | 'coi' | 'bill';

interface BillDraft {
  vendor_name?: string | null;
  bill_number?: string | null;
  total_amount?: number | null;
  receipt_date?: string | null;
  payment_terms?: string | null;
  due_date?: string | null;
  [k: string]: unknown;
}

interface Result {
  file: string;
  ok: boolean;
  kind?: Kind;
  message?: string;
  warnings?: string[];
  billDraft?: BillDraft;
  /** Set when a W-9 created (or matched) a vendor — so we can link to them. */
  vendor?: { id: string; display_name: string };
  createdVendor?: boolean;
  /** Set when the server could not tell what the document was. */
  needsKind?: { message: string; base64: string; mediaType: string };
}

const KIND_LABEL: Record<Kind, string> = {
  w9: 'W-9',
  coi: 'Certificate of insurance',
  bill: 'Bill',
};

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
const MAX_BYTES = 4 * 1024 * 1024;

function toBase64(file: File): Promise<string> {
  return new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] ?? '');
    r.onerror = () => no(new Error('Could not read that file.'));
    r.readAsDataURL(file);
  });
}

export function VendorDocDrop({
  vendorId, onFiled, compact,
}: {
  /** Omit on the Vendors list — a W-9 then CREATES the vendor from the form. */
  vendorId?: string;
  onFiled: () => void | Promise<void>;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);

  const send = async (
    fileName: string, base64: string, mediaType: string, kind?: Kind,
  ): Promise<Result> => {
    const token = await getAccessToken();
    const res = await fetch('/expense/api/vendor-doc-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        ...(vendorId ? { vendor_id: vendorId } : {}),
        file_name: fileName, media_type: mediaType,
        file_base64: base64, ...(kind ? { kind } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 422 && data.error === 'not_recognised') {
      return { file: fileName, ok: false, message: data.message, needsKind: { message: data.message, base64, mediaType } };
    }
    if (!res.ok) {
      return { file: fileName, ok: false, message: data.message || data.error || `Upload failed (${res.status})` };
    }
    return {
      file: fileName, ok: true, kind: data.kind, message: data.message,
      warnings: data.warnings ?? [], billDraft: data.bill_draft ?? undefined,
      vendor: data.vendor ?? undefined, createdVendor: !!data.created_vendor,
    };
  };

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setResults([]);
    for (const f of list) {
      setBusy(f.name);
      try {
        if (f.size > MAX_BYTES) {
          setResults((r) => [...r, { file: f.name, ok: false, message: 'Too large — 4 MB is the limit for a document.' }]);
          continue;
        }
        const base64 = await toBase64(f);
        const result = await send(f.name, base64, f.type || 'application/pdf');
        setResults((r) => [...r, result]);
      } catch (e) {
        setResults((r) => [...r, { file: f.name, ok: false, message: e instanceof Error ? e.message : 'Upload failed.' }]);
      }
    }
    setBusy(null);
    await onFiled();
  };

  // The "I couldn't tell — you say" path.
  const retryAs = async (index: number, kind: Kind): Promise<void> => {
    const r = results[index];
    if (!r.needsKind) return;
    setBusy(r.file);
    const next = await send(r.file, r.needsKind.base64, r.needsKind.mediaType, kind);
    setResults((all) => all.map((x, i) => (i === index ? next : x)));
    setBusy(null);
    await onFiled();
  };

  // Hand the bill read to the expense form. Via sessionStorage rather than the
  // URL: line items do not fit in a query string, and an invoice's contents
  // have no business sitting in browser history.
  const fileAsBill = (draft: BillDraft) => {
    const key = `brixpense.prefill.${Date.now()}`;
    try {
      sessionStorage.setItem(key, JSON.stringify(draft));
      navigate(`/new?prefill=${encodeURIComponent(key)}`);
    } catch {
      navigate('/new');
    }
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void handleFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        className={`rounded-lg border-2 border-dashed text-center cursor-pointer transition-colors ${compact ? 'p-3.5' : 'p-5'} ${
          over ? 'border-sky-400 bg-sky-500/10' : 'border-white/15 hover:border-white/30 hover:bg-white/[0.03]'
        }`}
      >
        <input
          ref={inputRef} type="file" accept={ACCEPT} multiple className="hidden"
          onChange={(e) => { if (e.target.files?.length) void handleFiles(e.target.files); e.target.value = ''; }}
        />
        {busy ? (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading {busy}…
          </div>
        ) : (
          <>
            <FileUp className="h-6 w-6 mx-auto mb-2 opacity-50" />
            <div className="text-sm font-medium">
              {vendorId ? 'Drop a W-9, a certificate of insurance, or a bill' : 'Drop a W-9 to set a vendor up'}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1">
              {vendorId
                ? 'Several at once is fine. It works out what each one is and fills the vendor in from it. A bill is only read — nothing is posted.'
                : 'The form carries everything the record needs — name, entity type, TIN, address — so the vendor gets created from it. If we already have them, it files against the vendor you have rather than making a second one.'}
            </div>
          </>
        )}
      </div>

      {results.map((r, i) => (
        <div
          key={`${r.file}-${i}`}
          className={`rounded-lg p-3 text-sm ${r.ok ? 'bg-emerald-500/10' : 'bg-amber-500/10'}`}
        >
          <div className="flex items-start gap-2">
            {r.ok
              ? <CheckCircle2 className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
              : <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 flex-shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium truncate">{r.file}</span>
                {r.kind && <Badge variant="secondary">{KIND_LABEL[r.kind]}</Badge>}
              </div>
              {r.message && <p className="text-[13px] text-muted-foreground mt-0.5">{r.message}</p>}

              {(r.warnings ?? []).length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-[12px] text-amber-200/90">
                  {r.warnings!.map((w) => <li key={w}>⚠ {w}</li>)}
                </ul>
              )}

              {r.needsKind && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {(['w9', 'coi', 'bill'] as Kind[]).map((k) => (
                    <Button key={k} size="sm" variant="outline" disabled={!!busy} onClick={() => void retryAs(i, k)}>
                      It&rsquo;s a {KIND_LABEL[k].toLowerCase()}
                    </Button>
                  ))}
                </div>
              )}

              {r.vendor && (
                <div className="mt-2">
                  <Button size="sm" variant="outline" onClick={() => navigate(`/vendors/${r.vendor!.id}`)}>
                    {r.createdVendor ? 'Open the new vendor' : `Open ${r.vendor.display_name}`} →
                  </Button>
                </div>
              )}

              {r.billDraft && (
                <div className="mt-2 space-y-2">
                  <div className="text-[12px] text-muted-foreground">
                    {r.billDraft.bill_number ? `Bill #${r.billDraft.bill_number} · ` : ''}
                    {r.billDraft.total_amount != null ? `$${Number(r.billDraft.total_amount).toFixed(2)}` : 'no amount read'}
                    {r.billDraft.receipt_date ? ` · ${r.billDraft.receipt_date}` : ''}
                    {r.billDraft.payment_terms ? ` · ${r.billDraft.payment_terms}` : ''}
                    {r.billDraft.due_date ? ` · due ${r.billDraft.due_date}` : ''}
                  </div>
                  <Button size="sm" onClick={() => fileAsBill(r.billDraft!)}>
                    File this as a bill →
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
