// Vendor detail (Vendor Portal Phase 1): profile + payment preference +
// coverage requirements, the QuickBooks link, and the vendor's compliance-
// vault documents (read-only here — filing happens in Compliance & Safety;
// Phase 2's token-gated intake takes that over).
//
// Payment hard rule, repeated in the UI copy: only a HANDLE is stored
// (Venmo @name / PayPal email). Bank account numbers live with the payment
// rail, never in this database. Tax identity is last-4 only — the full EIN
// stays inside the W-9 PDF in the private compliance bucket.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SelectField } from '@/components/ui/select-field';
import { Archive, ArchiveRestore, ArrowLeft, ExternalLink, FileText, Link2, Loader2, Save, Search, ShieldCheck } from 'lucide-react';
import { formatDate } from '@/lib/utils';
import type { Vendor, VendorType, VendorPaymentPref, VendorRequirements, VendorComplianceDoc, QboVendorMirror } from '@/types/expense';
import {
  getVendor, updateVendor, archiveVendor, unarchiveVendor, partyDocuments,
  ensureInsuredParty, searchQboMirror, searchQboLive, vendorCompliance,
  VENDOR_TYPE_LABEL, PAYMENT_PREF_LABEL, ONBOARD_LABEL,
} from '@/lib/vendors';

const TYPE_OPTS = (Object.entries(VENDOR_TYPE_LABEL) as [VendorType, string][])
  .map(([value, label]) => ({ value, label }));
const PAY_OPTS = [
  { value: '', label: 'Not set' },
  ...Object.entries(PAYMENT_PREF_LABEL).map(([value, label]) => ({ value, label })),
];
const ONBOARD_OPTS = Object.entries(ONBOARD_LABEL).map(([value, label]) => ({ value, label }));

function DocExpiryChip({ d }: { d: VendorComplianceDoc }) {
  if (!d.expiration_date) return <Badge variant="secondary">No expiry</Badge>;
  const msLeft = new Date(`${d.expiration_date}T00:00:00`).getTime() - Date.now();
  if (msLeft < 0) return <Badge variant="destructive">Expired {d.expiration_date}</Badge>;
  if (msLeft <= 60 * 86400000) return <Badge variant="warning">Expires {d.expiration_date}</Badge>;
  return <Badge variant="success">Current → {d.expiration_date}</Badge>;
}

export default function VendorDetail() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [docs, setDocs] = useState<VendorComplianceDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');

  // Draft form state (single Save covers profile + payment + requirements)
  const [draft, setDraft] = useState<Partial<Vendor>>({});
  const [req, setReq] = useState<VendorRequirements>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // QBO link editor
  const [linking, setLinking] = useState(false);
  const [linkTerm, setLinkTerm] = useState('');
  const [linkHits, setLinkHits] = useState<QboVendorMirror[]>([]);
  const [linkSearching, setLinkSearching] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? ''));
  }, []);

  useEffect(() => {
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      try {
        const v = await getVendor(id);
        if (!v) { setError('Vendor not found.'); return; }
        setVendor(v);
        setDraft({
          display_name: v.display_name,
          legal_name: v.legal_name,
          vendor_type: v.vendor_type,
          contact_name: v.contact_name,
          contact_email: v.contact_email,
          contact_phone: v.contact_phone,
          payment_method_pref: v.payment_method_pref,
          payment_handle: v.payment_handle,
          default_terms: v.default_terms,
          w9_status: v.w9_status,
          ein_last4: v.ein_last4,
          onboard_status: v.onboard_status,
          notes: v.notes,
        });
        setReq(v.requirements ?? {});
        if (v.insured_party_id) setDocs(await partyDocuments(v.insured_party_id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the vendor.');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const set = <K extends keyof Vendor>(k: K, val: Vendor[K]) =>
    setDraft((d) => ({ ...d, [k]: val }));

  const save = async () => {
    if (!vendor) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const ein = (draft.ein_last4 || '').trim();
      if (ein && !/^\d{4}$/.test(ein)) throw new Error('EIN last-4 must be exactly four digits (the full number stays on the W-9 PDF).');
      const updated = await updateVendor(vendor.id, {
        ...draft,
        display_name: (draft.display_name || '').trim() || vendor.display_name,
        payment_method_pref: (draft.payment_method_pref as string) === '' ? null : draft.payment_method_pref,
        payment_handle: (draft.payment_handle || '').trim() || null,
        ein_last4: ein || null,
        requirements: req,
      });
      setVendor(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const enableFiling = async () => {
    if (!vendor) return;
    setBusy('party');
    setError(null);
    try {
      const partyId = await ensureInsuredParty(vendor);
      setVendor({ ...vendor, insured_party_id: partyId });
      setDocs(await partyDocuments(partyId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set up document filing.');
    } finally {
      setBusy(null);
    }
  };

  const toggleArchive = async () => {
    if (!vendor) return;
    const archiving = !vendor.archived_at;
    if (archiving && !window.confirm(`Archive ${vendor.display_name}? It stays on record (nothing is deleted) and can be restored any time.`)) return;
    setBusy('archive');
    try {
      if (archiving) {
        await archiveVendor(vendor.id, userEmail || 'staff');
        setVendor({ ...vendor, archived_at: new Date().toISOString(), archived_by: userEmail });
      } else {
        await unarchiveVendor(vendor.id);
        setVendor({ ...vendor, archived_at: null, archived_by: null });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Archive failed.');
    } finally {
      setBusy(null);
    }
  };

  const runLinkSearch = async () => {
    const term = linkTerm.trim();
    if (term.length < 2) return;
    setLinkSearching(true);
    try {
      const mirror = await searchQboMirror(term);
      if (mirror.length > 0) { setLinkHits(mirror); return; }
      const live = await searchQboLive(term);
      setLinkHits(live.map((h) => ({
        qbo_vendor_id: h.id, display_name: h.name, company_name: h.company,
        active: true, email: h.email, phone: h.phone,
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'QuickBooks search failed.');
    } finally {
      setLinkSearching(false);
    }
  };

  const linkQbo = async (qboId: string) => {
    if (!vendor) return;
    setBusy(`link:${qboId}`);
    try {
      const updated = await updateVendor(vendor.id, { qbo_vendor_id: qboId });
      setVendor(updated);
      setLinking(false);
      setLinkHits([]);
      setLinkTerm('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Link failed.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!vendor) {
    return (
      <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">{error || 'Vendor not found.'}</CardContent></Card>
    );
  }

  const compliance = vendorCompliance(vendor, docs);
  const handleNeeded = draft.payment_method_pref === 'paypal' || draft.payment_method_pref === 'venmo';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/vendors')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold tracking-tight truncate">{vendor.display_name}</h1>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <Badge variant="secondary">{VENDOR_TYPE_LABEL[vendor.vendor_type]}</Badge>
            <Badge variant="secondary">{ONBOARD_LABEL[vendor.onboard_status]}</Badge>
            {vendor.archived_at && <Badge variant="outline">Archived {formatDate(vendor.archived_at)}</Badge>}
          </div>
        </div>
        <Button
          variant="ghost"
          disabled={busy === 'archive'}
          onClick={toggleArchive}
          title={vendor.archived_at ? 'Restore this vendor' : 'Archive — hide from the roster; nothing is deleted'}
        >
          {busy === 'archive'
            ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            : vendor.archived_at ? <ArchiveRestore className="h-4 w-4 mr-1" /> : <Archive className="h-4 w-4 mr-1" />}
          {vendor.archived_at ? 'Restore' : 'Archive'}
        </Button>
      </div>

      {error && (
        <div className="text-sm rounded-lg p-3 border border-destructive/40 bg-destructive/10 text-destructive">
          {error}
        </div>
      )}

      {/* ── Profile ── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="text-sm font-bold tracking-tight">Profile</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Display name</Label>
              <Input value={draft.display_name ?? ''} onChange={(e) => set('display_name', e.target.value)} />
            </div>
            <div>
              <Label>Legal name (as on the W-9)</Label>
              <Input value={draft.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value || null)} />
            </div>
            <div>
              <Label>Type</Label>
              <SelectField options={TYPE_OPTS} value={draft.vendor_type ?? 'supplier'} onChange={(e) => set('vendor_type', e.target.value as VendorType)} />
            </div>
            <div>
              <Label>Onboarding</Label>
              <SelectField options={ONBOARD_OPTS} value={draft.onboard_status ?? 'new'} onChange={(e) => set('onboard_status', e.target.value as Vendor['onboard_status'])} />
            </div>
            <div>
              <Label>Contact name</Label>
              <Input value={draft.contact_name ?? ''} onChange={(e) => set('contact_name', e.target.value || null)} />
            </div>
            <div>
              <Label>Contact email</Label>
              <Input type="email" value={draft.contact_email ?? ''} onChange={(e) => set('contact_email', e.target.value || null)} />
            </div>
            <div>
              <Label>Contact phone</Label>
              <Input value={draft.contact_phone ?? ''} onChange={(e) => set('contact_phone', e.target.value || null)} />
            </div>
            <div>
              <Label>Default terms</Label>
              <Input placeholder="e.g. Net 30" value={draft.default_terms ?? ''} onChange={(e) => set('default_terms', e.target.value || null)} />
            </div>
            <div>
              <Label>W-9</Label>
              <SelectField
                options={[{ value: 'missing', label: 'Missing' }, { value: 'on_file', label: 'On file' }]}
                value={draft.w9_status ?? 'missing'}
                onChange={(e) => set('w9_status', e.target.value as Vendor['w9_status'])}
              />
            </div>
            <div>
              <Label>EIN last-4 only</Label>
              <Input
                maxLength={4} inputMode="numeric" placeholder="1234"
                value={draft.ein_last4 ?? ''}
                onChange={(e) => set('ein_last4', e.target.value.replace(/\D/g, '') || null)}
              />
              <p className="text-[11px] text-muted-foreground mt-1">The full EIN/SSN stays inside the W-9 PDF — never in a field.</p>
            </div>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea rows={2} value={draft.notes ?? ''} onChange={(e) => set('notes', e.target.value || null)} />
          </div>
        </CardContent>
      </Card>

      {/* ── Payment preference ── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="text-sm font-bold tracking-tight">Payment</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Preferred method</Label>
              <SelectField
                options={PAY_OPTS}
                value={(draft.payment_method_pref as string) ?? ''}
                onChange={(e) => set('payment_method_pref', (e.target.value || null) as VendorPaymentPref | null)}
              />
            </div>
            <div>
              <Label>{draft.payment_method_pref === 'venmo' ? 'Venmo @handle' : draft.payment_method_pref === 'paypal' ? 'PayPal email' : 'Payment handle'}</Label>
              <Input
                placeholder={draft.payment_method_pref === 'venmo' ? '@vendor-handle' : draft.payment_method_pref === 'paypal' ? 'vendor@example.com' : '—'}
                disabled={!handleNeeded}
                value={draft.payment_handle ?? ''}
                onChange={(e) => set('payment_handle', e.target.value || null)}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Bank details are never stored here — ACH is set up with the payment provider, and Zelle/check payments are sent by hand and recorded. Only a Venmo @handle or PayPal email lives in this record.
          </p>
        </CardContent>
      </Card>

      {/* ── Coverage requirements ── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-bold tracking-tight">Insurance requirements</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>GL each-occurrence minimum ($)</Label>
              <Input
                inputMode="numeric" placeholder="e.g. 1000000"
                value={req.gl_each_occurrence != null ? String(req.gl_each_occurrence) : ''}
                onChange={(e) => {
                  const n = e.target.value.replace(/[^\d]/g, '');
                  setReq((r) => ({ ...r, gl_each_occurrence: n ? Number(n) : null }));
                }}
              />
            </div>
            <div className="flex flex-col justify-end gap-1.5 pb-1">
              {([
                ['wc_required', "Workers' comp required"],
                ['auto_required', 'Auto liability required'],
                ['additional_insured_required', 'Additional-insured endorsement required'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={Boolean(req[key])}
                    onChange={(e) => setReq((r) => ({ ...r, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Requirements drive the COI chip on the roster (a vendor with requirements and no certificate shows red). A certificate that falls short still gets filed — flagged, never bounced.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          Save changes
        </Button>
        {saved && <span className="text-xs text-emerald-500">Saved ✓</span>}
      </div>

      {/* ── QuickBooks link ── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-bold tracking-tight flex-1">QuickBooks</h2>
            {vendor.qbo_vendor_id && !linking && (
              <Button size="sm" variant="ghost" onClick={() => setLinking(true)}>Change link</Button>
            )}
          </div>
          {vendor.qbo_vendor_id && !linking ? (
            <p className="text-sm">
              Linked to QBO Vendor <span className="font-semibold">#{vendor.qbo_vendor_id}</span> — bills post against this vendor.
            </p>
          ) : (
            <div className="space-y-2">
              {!vendor.qbo_vendor_id && (
                <p className="text-sm text-amber-500">Not linked to a QuickBooks vendor yet — link it so bills post against the right vendor.</p>
              )}
              <div className="flex gap-2">
                <Input
                  placeholder="Search QuickBooks vendors…"
                  value={linkTerm}
                  onChange={(e) => setLinkTerm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runLinkSearch(); }}
                  className="max-w-xs"
                />
                <Button size="sm" variant="outline" disabled={linkTerm.trim().length < 2 || linkSearching} onClick={runLinkSearch}>
                  {linkSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                </Button>
                {linking && (
                  <Button size="sm" variant="ghost" onClick={() => { setLinking(false); setLinkHits([]); }}>Cancel</Button>
                )}
              </div>
              {linkHits.map((h) => (
                <div key={h.qbo_vendor_id} className="flex items-center gap-2 text-sm rounded-md border border-border p-2">
                  <span className="flex-1 min-w-0 truncate">
                    {h.display_name}
                    <span className="ml-1 text-xs text-muted-foreground">#{h.qbo_vendor_id}</span>
                  </span>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => linkQbo(h.qbo_vendor_id)}>
                    {busy === `link:${h.qbo_vendor_id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Link'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Documents (compliance vault, read-only) ── */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-bold tracking-tight flex-1">Documents</h2>
            {vendor.insured_party_id && (
              <>
                {compliance.coi === 'missing' && <Badge variant="destructive">COI missing</Badge>}
                {compliance.coi === 'expired' && <Badge variant="destructive">COI expired</Badge>}
                {compliance.coi === 'expiring' && <Badge variant="warning">COI expiring {compliance.coiExpires}</Badge>}
                {compliance.coi === 'current' && <Badge variant="success">COI current</Badge>}
                <Badge variant={compliance.w9OnFile ? 'success' : 'warning'}>{compliance.w9OnFile ? 'W-9 on file' : 'W-9 missing'}</Badge>
              </>
            )}
          </div>

          {!vendor.insured_party_id ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Document filing isn&rsquo;t set up for this vendor yet. Enabling it creates their party in the
                compliance vault so COIs and W-9s file under their name and the expiry digest watches them.
              </p>
              <Button size="sm" variant="outline" disabled={busy === 'party'} onClick={enableFiling}>
                {busy === 'party' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                Enable document filing
              </Button>
            </div>
          ) : (
            <>
              {docs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No documents filed yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {docs.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 text-sm rounded-md border border-border p-2">
                      <span className="flex-1 min-w-0 truncate">
                        <span className="font-medium">{d.doc_type}</span>
                        {d.issuer ? <span className="text-muted-foreground"> · {d.issuer}</span> : null}
                        {d.reference_number ? <span className="text-muted-foreground"> · #{d.reference_number}</span> : null}
                      </span>
                      <DocExpiryChip d={d} />
                    </div>
                  ))}
                </div>
              )}
              <a
                href="https://alamedapointbg.com/compliance"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                File documents in Compliance &amp; Safety <ExternalLink className="h-3.5 w-3.5" />
              </a>
              <p className="text-[11px] text-muted-foreground">
                Filing is read-only here — upload the actual PDFs in the Compliance &amp; Safety app under this
                vendor&rsquo;s party. A vendor-facing upload link is coming in Phase 2.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
