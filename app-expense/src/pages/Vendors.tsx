// Vendors roster (Vendor Portal Phase 1).
//
// One card per vendor: type, payable-via badge, and the compliance chips
// (COI current / expiring ≤30d / expired / missing · W-9) computed live from
// the compliance vault — nothing stored. Click a card → the vendor detail.
//
// Adding a vendor starts from QuickBooks so the registry never drifts from
// the books: type a name → instant matches from the ops.qbo_vendors mirror →
// or search QuickBooks live / create the QBO Vendor on the spot (both via
// /expense/api/expense-vendors through the hardened billing token chain).
// A no-QBO add is still allowed (link later from the detail page).
//
// Staff-only: superadmin OR admin — mirrored client-side (CardMatch pattern);
// ops.vendors RLS (fn_is_staff) is the real gate.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select-field';
import { Building2, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { Vendor, VendorType, VendorComplianceDoc, QboVendorMirror } from '@/types/expense';
import {
  listVendors, createVendor, documentsForParties, searchQboMirror,
  searchQboLive, createQboVendor, vendorCompliance,
  VENDOR_TYPE_LABEL, PAYMENT_PREF_LABEL, type QboLiveVendor,
} from '@/lib/vendors';

const TYPE_OPTS = (Object.entries(VENDOR_TYPE_LABEL) as [VendorType, string][])
  .map(([value, label]) => ({ value, label }));

function CoiChip({ vendor, docs }: { vendor: Vendor; docs: VendorComplianceDoc[] }) {
  const c = vendorCompliance(vendor, docs);
  if (!vendor.insured_party_id && c.coi === 'untracked') {
    return <Badge variant="secondary">No docs filed</Badge>;
  }
  switch (c.coi) {
    case 'current': return <Badge variant="success">COI current{c.coiExpires ? ` → ${c.coiExpires}` : ''}</Badge>;
    case 'expiring': return <Badge variant="warning">COI expiring {c.coiExpires}</Badge>;
    case 'expired': return <Badge variant="destructive">COI expired {c.coiExpires}</Badge>;
    case 'missing': return <Badge variant="destructive">COI missing</Badge>;
    default: return <Badge variant="secondary">No COI on file</Badge>;
  }
}

function W9Chip({ vendor, docs }: { vendor: Vendor; docs: VendorComplianceDoc[] }) {
  const c = vendorCompliance(vendor, docs);
  return c.w9OnFile
    ? <Badge variant="success">W-9 on file</Badge>
    : <Badge variant="warning">W-9 missing</Badge>;
}

export default function Vendors() {
  const navigate = useNavigate();
  const [isStaff, setIsStaff] = useState<boolean | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [docsByParty, setDocsByParty] = useState<Map<string, VendorComplianceDoc[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  // Add-vendor form (inline expanding — no dialog primitives in this app)
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [addType, setAddType] = useState<VendorType>('supplier');
  const [mirrorHits, setMirrorHits] = useState<QboVendorMirror[]>([]);
  const [liveHits, setLiveHits] = useState<QboLiveVendor[] | null>(null);
  const [liveSearching, setLiveSearching] = useState(false);
  const [addBusy, setAddBusy] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const role =
        (data.user?.app_metadata as { role?: string } | undefined)?.role ||
        (data.user?.user_metadata as { role?: string } | undefined)?.role ||
        '';
      setIsStaff(role === 'superadmin' || role === 'admin');
    });
  }, []);

  const load = async (includeArchived: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listVendors(includeArchived);
      setVendors(rows);
      const partyIds = rows.map((v) => v.insured_party_id).filter(Boolean) as string[];
      setDocsByParty(await documentsForParties(partyIds));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load vendors.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isStaff) load(showArchived);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff, showArchived]);

  // Debounced mirror search as the add-form name is typed.
  useEffect(() => {
    if (!adding) return;
    const term = addName.trim();
    setLiveHits(null);
    if (term.length < 2) { setMirrorHits([]); return; }
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      try {
        const hits = await searchQboMirror(term);
        if (searchSeq.current === seq) setMirrorHits(hits);
      } catch { /* mirror search is best-effort — live search still works */ }
    }, 250);
    return () => clearTimeout(t);
  }, [addName, adding]);

  const runLiveSearch = async () => {
    const term = addName.trim();
    if (term.length < 2) return;
    setLiveSearching(true);
    setAddError(null);
    try {
      setLiveHits(await searchQboLive(term));
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'QuickBooks search failed.');
    } finally {
      setLiveSearching(false);
    }
  };

  const finishAdd = (v: Vendor) => {
    setAdding(false);
    setAddName('');
    setMirrorHits([]);
    setLiveHits(null);
    navigate(`/vendors/${v.id}`);
  };

  const addFromQbo = async (qboId: string, name: string, email?: string | null, phone?: string | null, company?: string | null) => {
    setAddBusy(`qbo:${qboId}`);
    setAddError(null);
    try {
      finishAdd(await createVendor({
        display_name: name,
        legal_name: company || null,
        vendor_type: addType,
        qbo_vendor_id: qboId,
        contact_email: email || null,
        contact_phone: phone || null,
      }));
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Could not add the vendor.');
    } finally {
      setAddBusy(null);
    }
  };

  const addCreatingInQbo = async () => {
    const name = addName.trim();
    if (!name) return;
    setAddBusy('create');
    setAddError(null);
    try {
      const { vendor: qv, existed } = await createQboVendor({ display_name: name });
      if (existed) setAddError(null); // duplicate resolved to the existing QBO vendor — link to it
      finishAdd(await createVendor({
        display_name: qv.name,
        vendor_type: addType,
        qbo_vendor_id: qv.id,
        contact_email: qv.email,
        contact_phone: qv.phone,
      }));
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Could not create the vendor in QuickBooks.');
    } finally {
      setAddBusy(null);
    }
  };

  const addWithoutQbo = async () => {
    const name = addName.trim();
    if (!name) return;
    setAddBusy('bare');
    setAddError(null);
    try {
      finishAdd(await createVendor({ display_name: name, vendor_type: addType }));
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Could not add the vendor.');
    } finally {
      setAddBusy(null);
    }
  };

  const filtered = useMemo(() => {
    const t = filter.trim().toLowerCase();
    if (!t) return vendors;
    return vendors.filter((v) =>
      v.display_name.toLowerCase().includes(t)
      || (v.legal_name ?? '').toLowerCase().includes(t)
      || (v.contact_email ?? '').toLowerCase().includes(t));
  }, [vendors, filter]);

  if (isStaff === null) {
    return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!isStaff) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          The Vendors module is available to admins only.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-bold tracking-tight">Vendors</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Insurance, W-9 and payment preferences per vendor — linked to QuickBooks and the compliance vault.
          </p>
        </div>
        <Button variant="ghost" size="icon" title="Reload" onClick={() => load(showArchived)}>
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button onClick={() => { setAdding((a) => !a); setAddError(null); }}>
          {adding ? <X className="h-4 w-4 mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
          {adding ? 'Close' : 'Add vendor'}
        </Button>
      </div>

      {adding && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                autoFocus
                placeholder="Vendor name — matches from QuickBooks appear as you type"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                className="flex-1"
              />
              <SelectField
                options={TYPE_OPTS}
                value={addType}
                onChange={(e) => setAddType(e.target.value as VendorType)}
                className="sm:w-40"
              />
            </div>

            {addError && (
              <div className="text-sm rounded-lg p-2.5 border border-destructive/40 bg-destructive/10 text-destructive">
                {addError}
              </div>
            )}

            {(mirrorHits.length > 0 || liveHits) && (
              <div className="space-y-1">
                {(liveHits ?? []).map((h) => (
                  <div key={`live-${h.id}`} className="flex items-center gap-2 text-sm rounded-md border border-border p-2">
                    <span className="flex-1 min-w-0 truncate">
                      {h.name}
                      {h.email ? <span className="text-muted-foreground"> · {h.email}</span> : null}
                      <span className="ml-1 text-xs text-sky-400">QuickBooks (live)</span>
                    </span>
                    <Button
                      size="sm" variant="outline"
                      disabled={addBusy !== null}
                      onClick={() => addFromQbo(h.id, h.name, h.email, h.phone, h.company)}
                    >
                      {addBusy === `qbo:${h.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Add'}
                    </Button>
                  </div>
                ))}
                {liveHits === null && mirrorHits.map((h) => (
                  <div key={h.qbo_vendor_id} className="flex items-center gap-2 text-sm rounded-md border border-border p-2">
                    <span className="flex-1 min-w-0 truncate">
                      {h.display_name}
                      {h.email ? <span className="text-muted-foreground"> · {h.email}</span> : null}
                      <span className="ml-1 text-xs text-muted-foreground">QuickBooks #{h.qbo_vendor_id}</span>
                    </span>
                    <Button
                      size="sm" variant="outline"
                      disabled={addBusy !== null}
                      onClick={() => addFromQbo(h.qbo_vendor_id, h.display_name, h.email, h.phone, h.company_name)}
                    >
                      {addBusy === `qbo:${h.qbo_vendor_id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Add'}
                    </Button>
                  </div>
                ))}
                {liveHits !== null && liveHits.length === 0 && (
                  <p className="text-xs text-muted-foreground">No live QuickBooks match for &ldquo;{addName.trim()}&rdquo;.</p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm" variant="outline"
                disabled={addName.trim().length < 2 || liveSearching || addBusy !== null}
                onClick={runLiveSearch}
                title="The mirror refreshes daily — this searches QuickBooks right now"
              >
                {liveSearching ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Search className="h-3.5 w-3.5 mr-1" />}
                Search QuickBooks live
              </Button>
              <Button
                size="sm"
                disabled={!addName.trim() || addBusy !== null}
                onClick={addCreatingInQbo}
                title="Creates the vendor in QuickBooks, then adds it here linked"
              >
                {addBusy === 'create' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                Create in QuickBooks + add
              </Button>
              <Button
                size="sm" variant="ghost"
                disabled={!addName.trim() || addBusy !== null}
                onClick={addWithoutQbo}
                title="Adds only to the registry — link the QuickBooks vendor later from the detail page"
              >
                {addBusy === 'bare' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                Add without QuickBooks link
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter vendors…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        {!loading && (
          <span className="ml-auto text-xs text-muted-foreground">
            {filtered.length} vendor{filtered.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {error && (
        <div className="text-sm rounded-lg p-3 border border-destructive/40 bg-destructive/10 text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Building2 className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {vendors.length === 0 ? 'No vendors yet.' : 'No vendors match the filter.'}
            </p>
            {vendors.length === 0 && (
              <p className="text-xs text-muted-foreground/70 mt-1">
                Add your first one — pick it from QuickBooks or create it there on the spot.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((v) => {
            const docs = (v.insured_party_id && docsByParty.get(v.insured_party_id)) || [];
            return (
              <Card
                key={v.id}
                className={`cursor-pointer hover:shadow-sm transition-shadow${v.archived_at ? ' opacity-60' : ''}`}
                onClick={() => navigate(`/vendors/${v.id}`)}
              >
                <CardContent className="flex flex-wrap items-center gap-2 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[15px] font-semibold truncate">{v.display_name}</p>
                      <Badge variant="secondary">{VENDOR_TYPE_LABEL[v.vendor_type]}</Badge>
                      {v.archived_at && <Badge variant="outline">Archived</Badge>}
                    </div>
                    <p className="text-[13px] text-muted-foreground mt-1 truncate">
                      {v.contact_name || v.contact_email || 'No contact'}
                      {v.qbo_vendor_id ? ` · QBO #${v.qbo_vendor_id}` : ' · not linked to QuickBooks'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                    {v.payment_method_pref && (
                      <Badge variant="info">{PAYMENT_PREF_LABEL[v.payment_method_pref]}</Badge>
                    )}
                    <CoiChip vendor={v} docs={docs} />
                    <W9Chip vendor={v} docs={docs} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
