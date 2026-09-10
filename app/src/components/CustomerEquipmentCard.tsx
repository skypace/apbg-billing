import { useEffect, useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, RefreshCw, X } from 'lucide-react';
import {
  assetContract, assetIdentity, assetNote, assetSerial,
  fetchCustomerEquipment,
  type CustomerEquipment, type EquipmentRow,
} from '../lib/customerEquipment';

/**
 * Equipment under the customer, as the asset line — make/model · serial ·
 * contract number — with the machine one click away.
 *
 * Ask (Sky, 2026-09-09): "anywhere outside of the order module, I would like to
 * have the equipment show up as The asset line … and when you click on them,
 * they go into that actual piece of equipment that should be mirrored and SD
 * and in refractor under the customer".
 *
 * ⚠ ERLS OWNS THIS RECORD. `ops.equipment_assets` is the echo both this page
 * and BrixSD read; nothing here writes, and the one action is a link out to
 * ERLS. The card prints how OLD the echo is, because that mirror has frozen
 * twice in three months and nothing ever showed its age — a panel that looks
 * authoritative while being three weeks stale is worse than one that says so.
 *
 * ⚠ IT LOADS ON MOUNT, unlike CustomerBillingCard which loads on open — and
 * that difference is deliberate rather than inconsistent. The billing card's
 * read is three round trips including a LIVE QuickBooks probe, so deferring it
 * earns something; this is one small PostgREST read and the COUNT is the whole
 * collapsed summary. A card that has to be opened to find out whether there is
 * anything in it is a card nobody opens.
 */

const lbl: React.CSSProperties = {
  fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1,
};
const btn: React.CSSProperties = {
  fontSize: 11, padding: '5px 10px', borderRadius: 4, cursor: 'pointer',
  border: '1px solid var(--ctl-bd)', background: 'transparent', color: 'var(--tx2)',
};

const money = (v: number | string | null | undefined) =>
  v == null ? null
    : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ⚠ Mirror dates are date-only or timestamps we only ever show as a day —
 *  anchored at UTC so a Pacific browser does not render 2026-09-09 as the 8th,
 *  which brix-order paid for with a month of invoices dated a day early. */
const day = (d: string | null | undefined) => {
  if (!d) return null;
  const s = String(d);
  const iso = s.length <= 10 ? `${s}T00:00:00Z` : s;
  const t = new Date(iso);
  return Number.isNaN(+t) ? null
    : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

const human = (v: string | null | undefined) => String(v || '').replace(/_/g, ' ');

function ageOf(iso: string | null): string | null {
  if (!iso) return null;
  const hours = (Date.now() - +new Date(iso)) / 36e5;
  if (!Number.isFinite(hours)) return null;
  if (hours < 36) return 'today';
  return `${Math.round(hours / 24)} days ago`;
}

/** A key/value row that PRINTS its blank rather than dropping itself, so the
 *  panel says which facts we do not hold. A dropped empty row is how the
 *  sub-distribution PDF hid a missing notice address. */
function KV({ k, v, mono, blank = 'not on file' }:
{ k: string; v: string | null; mono?: boolean; blank?: string }) {
  return (
    <div style={{
      display: 'flex', gap: 12, padding: '5px 0', borderBottom: '1px solid var(--bd)',
    }}>
      <div style={{ ...lbl, width: 128, flexShrink: 0, paddingTop: 1 }}>{k}</div>
      <div style={{
        fontSize: 12, minWidth: 0, flex: 1, color: v ? 'var(--tx)' : 'var(--mt)',
        fontFamily: mono && v ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
      }}>
        {v || blank}
      </div>
    </div>
  );
}

/** The asset line as styled parts. The serial is monospaced (it is read off a
 *  plate and compared digit by digit) and the contract is emphasised because it
 *  is the half nobody could see before today. */
function AssetLine({ a }: { a: EquipmentRow }) {
  const s = assetSerial(a);
  const c = assetContract(a);
  const dot = <span style={{ color: 'var(--bd)', margin: '0 6px' }}>·</span>;
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return (
    <span style={{ fontSize: 12 }}>
      <span style={{ fontWeight: 600, color: 'var(--tx)' }}>{assetIdentity(a)}</span>
      {dot}
      {s
        ? <span style={{ fontFamily: mono, color: 'var(--tx2)' }}>#{s}</span>
        : <span style={{ color: 'var(--mt)' }}>no serial on file</span>}
      {dot}
      {c
        ? <span style={{ fontFamily: mono, fontWeight: 600, color: 'var(--tx2)' }}>{c}</span>
        : <span style={{ color: 'var(--mt)' }}>not on a contract</span>}
    </span>
  );
}

const ERLS = 'https://brix-equipment.netlify.app';

function AssetDialog({ a, onClose }: { a: EquipmentRow | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!a}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { background: 'var(--sf)', color: 'var(--tx)', border: '1px solid var(--bd)' } } }}
    >
      {a && (
        <>
          <DialogTitle sx={{ p: 0 }}>
            <div style={{
              padding: '12px 16px', borderBottom: '1px solid var(--bd)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ ...lbl, fontWeight: 600 }}>Equipment</div>
                <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{assetIdentity(a)}</div>
                <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 1 }}>
                  {[assetSerial(a) ? `#${assetSerial(a)}` : 'no serial on file',
                    assetContract(a) || 'not on a contract',
                    a.store ? `at ${a.store}` : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button onClick={onClose} style={btn} aria-label="Close">
                <X size={12} style={{ verticalAlign: -2 }} />
              </button>
            </div>
          </DialogTitle>
          <DialogContent sx={{ p: 2, background: 'var(--bg)' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              <Chip tone={a.on_site ? 'ok' : 'bad'}>
                {a.on_site ? 'On site' : `Removed${a.removed_at ? ' ' + day(a.removed_at) : ''}`}
              </Chip>
              {a.is_loaner ? <Chip tone="am">Loaner</Chip> : null}
              {a.status ? <Chip tone="plain">{human(a.status)}</Chip> : null}
            </div>

            <KV k="Make" v={a.make || null} />
            <KV k="Model" v={a.model_number || null} mono />
            <KV k="Serial" v={assetSerial(a)} mono
              blank="no serial on file — ERLS has none either" />
            <KV k="Asset tag" v={a.asset_tag || null} mono />
            <KV k="Category" v={human(a.category) || null} />
            <KV k="Catalog item" v={a.catalog_name || a.qbo_item_name || null} />
            <KV k="Vendor" v={a.vendor || null} />
            <KV k="Quantity" v={a.qty != null ? String(a.qty) : null} mono />
            <KV k="Installed" v={day(a.installed_at)} />
            {/* ⚠ ERLS's own note, and on an ice machine it is usually the
                SITE — "OSION OCM-500 -- 3137 MISSION ST SF". Dropping it is
                what made three of EL PHAROS's rows indistinguishable. */}
            <KV k="Note from ERLS" v={a.description || null} />

            {/* ⚠ THE EQUIPMENT CONTRACT, not a pricing contract. Refractor's
                Pricing screens and `ops.pricing_contracts` are price books;
                these are ERLS rental/lease agreements. They share one English
                word and nothing else, and confusing them on a customer page is
                how somebody goes looking for a rate card. */}
            <div style={{ ...lbl, marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
              Equipment contract
            </div>
            <div style={{ fontSize: 10, color: 'var(--mt)', margin: '3px 0 6px' }}>
              The ERLS rental agreement — not a pricing contract.
            </div>
            <KV k="Number" v={assetContract(a)} mono
              blank="not on a contract — company-owned kit that is not rented" />
            <KV k="Kind" v={human(a.contract_type) || null} />
            <KV k="Status" v={human(a.contract_status) || null} />
            <KV k="Runs" v={[day(a.contract_start), day(a.contract_end)].filter(Boolean).join(' → ') || null} />
            <KV k="Monthly rent" v={money(a.monthly_rent)} mono blank="no rent on this asset" />
            <KV k="Ownership" v={human(a.ownership_type) || null} />

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
              {a.contract_document_url && (
                <a href={a.contract_document_url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--ac)' }}>The signed contract ↗</a>
              )}
              {a.spec_sheet_url && (
                <a href={a.spec_sheet_url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--ac)' }}>Spec sheet ↗</a>
              )}
              {a.image_url && (
                <a href={a.image_url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--ac)' }}>Photograph ↗</a>
              )}
            </div>

            {/* Where the record lives, said out loud. */}
            <div style={{
              marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--bd)',
              fontSize: 11, color: 'var(--mt)', lineHeight: 1.5,
            }}>
              ERLS owns this record. What you see here is the copy Refractor and BrixSD read
              {a.synced_at ? `, last synced ${day(a.synced_at)}` : ''}. Change it in ERLS and it
              lands here on the next sync.
              <div style={{ marginTop: 6 }}>
                <a href={`${ERLS}/assets`} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 11, fontWeight: 600, color: 'var(--ac)' }}>
                  Open ERLS <ExternalLink size={10} style={{ verticalAlign: -1 }} />
                </a>
              </div>
            </div>
          </DialogContent>
        </>
      )}
    </Dialog>
  );
}

function Chip({ tone, children }: { tone: 'ok' | 'bad' | 'am' | 'plain'; children: React.ReactNode }) {
  const c = tone === 'ok' ? 'var(--gn)' : tone === 'bad' ? 'var(--rd)'
    : tone === 'am' ? 'var(--am)' : 'var(--mt)';
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8,
      padding: '2px 6px', borderRadius: 3, color: c, border: `1px solid ${c}`,
    }}>{children}</span>
  );
}

export function CustomerEquipmentCard({ qboCustomerId, customerName }:
{ qboCustomerId: string; customerName?: string }) {
  const [open, setOpen] = useState(false);
  /** undefined = not loaded yet · a value = loaded (possibly with zero rows).
   *  Three states, three renders — a failed read, an empty result and a
   *  customer with no equipment must never look the same. */
  const [data, setData] = useState<CustomerEquipment | undefined>(undefined);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<EquipmentRow | null>(null);

  async function load() {
    setErr('');
    setData(undefined);
    try {
      setData(await fetchCustomerEquipment(qboCustomerId));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => { void load(); }, [qboCustomerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const age = useMemo(() => ageOf(data?.syncedAt ?? null), [data?.syncedAt]);
  /* ⚠ 36 hours, not 24: the echo is a NIGHTLY sync, so a day-old copy is the
     normal resting state and colouring it would cry wolf every morning. */
  const stale = !!data?.syncedAt && (Date.now() - +new Date(data.syncedAt)) / 36e5 > 36;

  /** Which asset lines appear more than once, so the rows that need telling
   *  apart can carry ERLS's note and the rest stay clean. */
  const ambiguous = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of data?.rows ?? []) {
      const k = r.asset_line || '';
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  }, [data]);

  const summary = err ? 'could not load'
    : data === undefined ? 'loading…'
      : data.rows.length === 0 ? 'no equipment on file'
        : [`${data.rows.length} asset${data.rows.length === 1 ? '' : 's'}`,
          data.monthlyOnSite > 0 ? `${money(data.monthlyOnSite)}/mo` : null,
          data.atSubs ? `${data.atSubs} at stores` : null,
        ].filter(Boolean).join(' · ');

  return (
    <div className="cd" style={{ padding: '10px 14px', marginBottom: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center',
          gap: 8, width: '100%', boxSizing: 'border-box',
        }}
        aria-expanded={open}
      >
        {open
          ? <ChevronDown size={14} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />
          : <ChevronRight size={14} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />}
        <span style={{ ...lbl, color: 'var(--tx2)' }}>Equipment</span>
        {/* The summary carries the state whether the card is folded or not —
            unlike the billing card, whose open form repeats it two lines
            lower. Here the count and the rent are not restated anywhere. */}
        <span style={{ fontSize: 10, color: stale ? 'var(--am)' : 'var(--mt)', marginLeft: 'auto' }}>
          {summary}
        </span>
      </button>

      {!open ? null : err ? (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', marginTop: 8,
          borderRadius: 4, fontSize: 11, color: 'var(--tx2)',
          border: '1px solid var(--rd)', background: 'rgba(234,67,53,0.07)',
        }}>
          <AlertTriangle size={14} strokeWidth={2.3} color="var(--rd)" aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: 'var(--rd)' }}>Could not load the equipment</div>
            <div style={{ marginTop: 2 }}>{err}</div>
            <button type="button" style={{ ...btn, marginTop: 6 }} onClick={() => void load()}>
              <RefreshCw size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Try again
            </button>
          </div>
        </div>
      ) : data === undefined ? (
        <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 10 }}>Loading…</div>
      ) : data.rows.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--tx2)', marginTop: 10, lineHeight: 1.5 }}>
          <strong>{customerName ?? 'This customer'}</strong> has no equipment in the records —
          neither on this account nor at any store under it. ERLS owns the asset record
          (154 assets across 67 customers today), so if there is a machine on site it is added
          there and lands here on the next nightly sync.
          <div style={{ marginTop: 6 }}>
            <a href={`${ERLS}/assets`} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 11, fontWeight: 600, color: 'var(--ac)' }}>
              Open ERLS <ExternalLink size={10} style={{ verticalAlign: -1 }} />
            </a>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginBottom: 8, lineHeight: 1.5 }}>
            ERLS owns these records; this is the copy Refractor and BrixSD read
            {age ? <> — last synced <strong style={{ color: stale ? 'var(--am)' : 'var(--tx2)' }}>{age}</strong></> : null}.
            {' '}Click an asset for the machine.
          </div>

          {data.rows.map((a, i) => {
            const first = i === 0 || !!a.store !== !!data.rows[i - 1].store;
            /* ⚠ FOUND BY LOOKING AT IT, not by 31 passing assertions: EL PHAROS
               has three OSION OCM-500s with no serial on one contract, so all
               three rows read the same string and an operator cannot tell which
               machine is which — while the data says exactly which ("OSION
               OCM-500 -- 3137 MISSION ST SF"). The rule is a LIST question, not
               a row one: show ERLS's note on the rows whose line is not unique,
               and leave a unique row clean rather than padding every row with
               boilerplate ("REFRIGERATED EQUIPMENT RENTAL … SERIAL #14404572"
               says nothing the line has not already said). */
            const note = ambiguous.has(a.asset_line || '') ? assetNote(a) : null;
            return (
              <div key={a.id}>
                {/* ⚠ A chain MASTER's page shows its stores' equipment, or a
                    parent with 11 machines at 4 stores reads "no equipment on
                    file" — measured, TAQUERIAS EL FAROLITOS MASTER is exactly
                    that. Labelled, never merged: whose machine it is matters. */}
                {first && a.store && (
                  <div style={{ ...lbl, marginTop: i ? 10 : 0, paddingTop: 8, borderTop: '1px solid var(--bd)' }}>
                    At stores under this account
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setPicked(a)}
                  style={{
                    all: 'unset', cursor: 'pointer', display: 'block', width: '100%',
                    boxSizing: 'border-box', padding: '6px 0',
                    borderBottom: '1px solid var(--bd)',
                  }}
                  title={a.asset_line || undefined}
                >
                  <AssetLine a={a} />
                  <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>
                    {[note, a.store, human(a.category) || null,
                      money(a.monthly_rent) ? `${money(a.monthly_rent)}/mo` : null,
                      a.is_loaner ? 'loaner' : null,
                      a.on_site ? null : 'removed',
                    ].filter(Boolean).join(' · ') || ' '}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}

      <AssetDialog a={picked} onClose={() => setPicked(null)} />
    </div>
  );
}
