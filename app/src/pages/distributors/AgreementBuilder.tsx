/**
 * The contract builder — Refractor → Sub-Distributors → Agreements.
 *
 * Two paths exist on that tab and they are deliberately distinct:
 *   • Upload a signed PDF — paper that already exists, filed against the partner.
 *   • Build an agreement  — our template, filled in here, emailed for signature.
 *
 * What this screen is really editing is the FEE AND TERRITORY SCHEDULE: the
 * body of the agreement is fixed wording, and every per-partner number —
 * territory, accounts, fees, the payment term, the notice addresses and the
 * insurance limits §23 obliges them to carry — lives on that Schedule. So the
 * form is laid out as the Schedule, not as a database row.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  DealTerms, FeeLine, InsuranceLine, ServiceLevel, SubDistributor, SubDistributorAgreement,
} from '../../lib/subDistributors';
import {
  AgreementTemplate, DEFAULT_INSURANCE, DEFAULT_SERVICE_LEVELS,
  buildAgreement, fetchAgreementTemplates, previewAgreement, resendAgreement,
  revokeAgreement, sendAgreementForSignature,
} from '../../lib/subdistAgreements';
import { useToast } from '../../lib/toast';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { errMsg, LField, Modal } from './common';

// The shared inp() does not stretch, which is fine in a narrow panel and wrong
// here: a legal name and a street address are read back as they are typed, and
// a field clipped at "1400 J Street, Sacramento, C" cannot be proofread.
const fi = () => ({ ...inp(), width: '100%' });

const row = { display: 'grid', gap: 10, marginBottom: 12 } as const;
const two = { ...row, gridTemplateColumns: '1fr 1fr' } as const;
const hint = {
  fontSize: 10.5, color: 'var(--mt)', marginTop: 4, lineHeight: 1.45,
} as const;
const sectionHead = {
  fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' as const,
  fontWeight: 700, margin: '18px 0 8px', paddingBottom: 5, borderBottom: '1px solid var(--bd)',
};

/** The deal a new agreement starts from: the partner's own record where it has
 *  an answer, the shipped defaults where it does not. */
function initialTerms(dist: SubDistributor): DealTerms {
  return {
    model: dist.model ?? 'consignment',
    territory: dist.territory ?? '',
    accounts: '',
    per_case_fee: dist.per_case_delivery_fee ?? null,
    per_case_unit: 'per case delivered',
    other_fees: [],
    service_rate: '',
    settlement_day: 'the 10th day of the following month',
    payment_term: 'Net 30 from the settlement date',
    notice_company_email: 'ap@alamedapointbg.com',
    notice_distributor_email: dist.contact_email ?? '',
    service_levels: DEFAULT_SERVICE_LEVELS.map((s) => ({ ...s })),
    insurance: DEFAULT_INSURANCE.map((i) => ({ ...i })),
    extra: '',
  };
}

export function BuildAgreementDialog({ dist, onClose, onBuilt }: {
  dist: SubDistributor;
  onClose: () => void;
  onBuilt: (a: SubDistributorAgreement) => void;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<AgreementTemplate[] | null>(null);
  const [code, setCode] = useState('subdist-agreement');
  const [busy, setBusy] = useState(false);

  const [terms, setTerms] = useState<DealTerms>(() => initialTerms(dist));
  const [legalName, setLegalName] = useState(dist.name ?? '');
  const [entityType, setEntityType] = useState('');
  const [state, setState] = useState('California');
  const [address, setAddress] = useState('');
  const [signerName, setSignerName] = useState(dist.contact_name ?? '');
  const [signerEmail, setSignerEmail] = useState(dist.contact_email ?? '');
  const [signerTitle, setSignerTitle] = useState('');
  const [effective, setEffective] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    fetchAgreementTemplates()
      .then((t) => {
        setTemplates(t);
        const active = t.find((x) => x.active);
        if (active) setCode(active.code);
      })
      .catch((e) => { setTemplates([]); toast.error(errMsg(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof DealTerms>(k: K, v: DealTerms[K]) =>
    setTerms((t) => ({ ...t, [k]: v }));

  const setLevel = (i: number, patch: Partial<ServiceLevel>) =>
    setTerms((t) => ({
      ...t,
      service_levels: (t.service_levels ?? []).map((s, j) => (j === i ? { ...s, ...patch } : s)),
    }));
  const setIns = (i: number, patch: Partial<InsuranceLine>) =>
    setTerms((t) => ({
      ...t,
      insurance: (t.insurance ?? []).map((s, j) => (j === i ? { ...s, ...patch } : s)),
    }));
  const setFee = (i: number, patch: Partial<FeeLine>) =>
    setTerms((t) => ({
      ...t,
      other_fees: (t.other_fees ?? []).map((s, j) => (j === i ? { ...s, ...patch } : s)),
    }));

  const activeTpl = useMemo(
    () => (templates ?? []).find((t) => t.code === code && t.active) ?? null,
    [templates, code],
  );

  async function submit() {
    if (!legalName.trim()) { toast.error('Their legal name is what the agreement is made with.'); return; }
    setBusy(true);
    try {
      const a = await buildAgreement({
        sub_distributor_id: dist.id,
        template_code: code,
        effective_date: effective || null,
        counterparty_legal_name: legalName.trim(),
        counterparty_entity_type: entityType.trim() || null,
        counterparty_state: state.trim() || null,
        counterparty_address: address.trim() || null,
        signer_name: signerName.trim() || null,
        signer_email: signerEmail.trim() || null,
        signer_title: signerTitle.trim() || null,
        deal_terms: terms,
      });
      toast.success(`Built ${a.agreement_number ?? `v${a.version}`} as a draft — preview it before sending.`);
      onBuilt(a);
    } catch (e) {
      toast.error(errMsg(e));
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`Build an agreement — ${dist.name}`} onClose={onClose} maxWidth={780}>
      <div style={{ ...hint, marginTop: 0, marginBottom: 14 }}>
        The wording is fixed; what you fill in here is the <b>Fee and Territory Schedule</b> the
        agreement refers to. Nothing is sent yet — this builds a draft you can read first.
      </div>

      {templates && templates.length > 1 && (
        <div style={row}>
          <LField label="Template">
            <select value={code} onChange={(e) => setCode(e.target.value)} style={fi()}>
              {templates.filter((t) => t.active).map((t) => (
                <option key={t.id} value={t.code}>{t.title} · v{t.version}</option>
              ))}
            </select>
          </LField>
        </div>
      )}
      {activeTpl && (
        <div style={hint}>Using <b>{activeTpl.title}</b> version {activeTpl.version}. The text is
          copied onto the agreement now, so editing the template later cannot change what they sign.</div>
      )}

      <div style={sectionHead}>Who we are contracting with</div>
      <div style={two}>
        <LField label="Their legal name">
          <input value={legalName} onChange={(e) => setLegalName(e.target.value)} style={fi()}
            placeholder="ORIGINS CRAFT SODA, LLC" />
        </LField>
        <LField label="Entity type">
          <input value={entityType} onChange={(e) => setEntityType(e.target.value)} style={fi()}
            placeholder="limited liability company" />
        </LField>
      </div>
      <div style={two}>
        <LField label="State of organisation">
          <input value={state} onChange={(e) => setState(e.target.value)} style={fi()} />
        </LField>
        <LField label="Effective date">
          <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} style={fi()} />
        </LField>
      </div>
      <div style={row}>
        <LField label="Their address">
          <input value={address} onChange={(e) => setAddress(e.target.value)} style={fi()}
            placeholder="1400 J Street, Sacramento, CA 95814" />
        </LField>
      </div>
      <div style={hint}>
        Leave any of these blank and the agreement prints a rule for them to complete — they fill
        their own details in on the signing page, which is usually the more accurate answer.
      </div>

      <div style={sectionHead}>Who signs for them</div>
      <div style={two}>
        <LField label="Signer name"><input value={signerName} onChange={(e) => setSignerName(e.target.value)} style={fi()} /></LField>
        <LField label="Signer title"><input value={signerTitle} onChange={(e) => setSignerTitle(e.target.value)} style={fi()} placeholder="Managing Member" /></LField>
      </div>
      <div style={row}>
        <LField label="Signer email — this is where the signing link goes">
          <input value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} style={fi()} />
        </LField>
      </div>

      <div style={sectionHead}>Territory and accounts</div>
      <div style={two}>
        <LField label="Distribution model">
          <select value={terms.model ?? 'consignment'} onChange={(e) => set('model', e.target.value)} style={fi()}>
            <option value="consignment">Consignment — title stays with us (§2)</option>
            <option value="sell_in">Sell-in — they buy the stock</option>
          </select>
        </LField>
        <LField label="Territory">
          <input value={terms.territory ?? ''} onChange={(e) => set('territory', e.target.value)} style={fi()}
            placeholder="Sacramento Valley" />
        </LField>
      </div>
      <div style={row}>
        <LField label="Accounts they service">
          <input value={terms.accounts ?? ''} onChange={(e) => set('accounts', e.target.value)} style={fi()}
            placeholder="The Melt and Starbird locations listed in Schedule 1" />
        </LField>
      </div>
      <div style={hint}>
        The appointment is <b>non-exclusive</b> either way (§1) — we can appoint others, sell direct,
        and move accounts. Naming a territory here does not reserve it.
      </div>

      <div style={sectionHead}>What we pay them</div>
      <div style={two}>
        <LField label="Delivery fee per case">
          <input type="number" step="0.01" min="0" value={terms.per_case_fee ?? ''}
            onChange={(e) => set('per_case_fee', e.target.value === '' ? null : Number(e.target.value))}
            style={fi()} />
        </LField>
        <LField label="Basis">
          <input value={terms.per_case_unit ?? ''} onChange={(e) => set('per_case_unit', e.target.value)} style={fi()} />
        </LField>
      </div>
      {(terms.other_fees ?? []).map((f, i) => (
        <div key={i} style={{ ...row, gridTemplateColumns: '1.4fr 0.8fr 1.2fr auto', alignItems: 'end' }}>
          <LField label="Fee"><input value={f.label} onChange={(e) => setFee(i, { label: e.target.value })} style={fi()} /></LField>
          <LField label="Rate"><input value={String(f.rate ?? '')} onChange={(e) => setFee(i, { rate: e.target.value })} style={fi()} /></LField>
          <LField label="Basis"><input value={f.unit} onChange={(e) => setFee(i, { unit: e.target.value })} style={fi()} /></LField>
          <button onClick={() => set('other_fees', (terms.other_fees ?? []).filter((_, j) => j !== i))}
            style={btnSecondary()}>Remove</button>
        </div>
      ))}
      <button onClick={() => set('other_fees', [...(terms.other_fees ?? []), { label: '', rate: '', unit: '' }])}
        style={{ ...btnSecondary(), marginBottom: 10 }}>+ Another fee</button>
      <div style={row}>
        <LField label="Service labour rate (leave blank if they do no service work)">
          <input value={terms.service_rate ?? ''} onChange={(e) => set('service_rate', e.target.value)} style={fi()}
            placeholder="$95 per hour, portal to portal" />
        </LField>
      </div>
      <div style={two}>
        <LField label="Settlement run"><input value={terms.settlement_day ?? ''} onChange={(e) => set('settlement_day', e.target.value)} style={fi()} /></LField>
        <LField label="Payment term"><input value={terms.payment_term ?? ''} onChange={(e) => set('payment_term', e.target.value)} style={fi()} /></LField>
      </div>
      <div style={hint}>
        §12 says our records decide what is owed, and they have 15 days to dispute a settlement.
        Their fees are calculated from what is recorded in Service Fusion and the portal.
      </div>

      <div style={sectionHead}>Response times (§13)</div>
      {(terms.service_levels ?? []).map((s, i) => (
        <div key={i} style={{ ...row, gridTemplateColumns: '0.7fr 2.2fr 0.7fr', marginBottom: 8 }}>
          <LField label={`Level ${s.level}`}><input value={s.name} onChange={(e) => setLevel(i, { name: e.target.value })} style={fi()} /></LField>
          <LField label="What it means"><input value={s.description} onChange={(e) => setLevel(i, { description: e.target.value })} style={fi()} /></LField>
          <LField label="Hours">
            <input type="number" min="1" value={s.hours} onChange={(e) => setLevel(i, { hours: Number(e.target.value) })} style={fi()} />
          </LField>
        </div>
      ))}
      <div style={hint}>
        Response means a qualified technician <b>on site and working</b>, not a returned call.
        {(terms.service_levels ?? []).length > 0 && (
          <> Clear all three if this partner does no service work — the agreement then says so
          rather than committing them to hours nobody agreed. </>
        )}
      </div>
      {(terms.service_levels ?? []).length > 0 ? (
        <button onClick={() => set('service_levels', [])} style={{ ...btnSecondary(), marginTop: 6 }}>
          They do no service work
        </button>
      ) : (
        <button onClick={() => set('service_levels', DEFAULT_SERVICE_LEVELS.map((s) => ({ ...s })))}
          style={{ ...btnSecondary(), marginTop: 6 }}>Add the response times back</button>
      )}

      <div style={sectionHead}>Insurance — the minimum limits §23 requires</div>
      <div style={{ ...hint, marginTop: 0, marginBottom: 8 }}>
        §23 obliges them to carry insurance "in the minimum limits Company specifies in writing".
        <b> This Schedule is that writing</b> — leave it blank and the obligation has no number on it.
      </div>
      {(terms.insurance ?? []).map((l, i) => (
        <div key={i} style={{ ...row, gridTemplateColumns: '1.2fr 1.4fr auto', marginBottom: 8, alignItems: 'end' }}>
          <LField label="Coverage"><input value={l.line} onChange={(e) => setIns(i, { line: e.target.value })} style={fi()} /></LField>
          <LField label="Minimum limit"><input value={l.limit} onChange={(e) => setIns(i, { limit: e.target.value })} style={fi()} /></LField>
          <button onClick={() => set('insurance', (terms.insurance ?? []).filter((_, j) => j !== i))} style={btnSecondary()}>Remove</button>
        </div>
      ))}
      <button onClick={() => set('insurance', [...(terms.insurance ?? []), { line: '', limit: '' }])}
        style={btnSecondary()}>+ Another coverage</button>

      <div style={sectionHead}>Notices (§30)</div>
      <div style={two}>
        <LField label="Us"><input value={terms.notice_company_email ?? ''} onChange={(e) => set('notice_company_email', e.target.value)} style={fi()} /></LField>
        <LField label="Them"><input value={terms.notice_distributor_email ?? ''} onChange={(e) => set('notice_distributor_email', e.target.value)} style={fi()} /></LField>
      </div>
      <div style={row}>
        <LField label="Anything else on the Schedule (optional)">
          <textarea value={terms.extra ?? ''} onChange={(e) => set('extra', e.target.value)} rows={3}
            style={{ ...fi(), resize: 'vertical' }} />
        </LField>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--bd)' }}>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={btnSecondary()}>Cancel</button>
        <button onClick={submit} disabled={busy} style={btnPrimary()}>
          {busy ? 'Building…' : 'Build the draft'}
        </button>
      </div>
    </Modal>
  );
}

/** The document exactly as the signer will see it. Renders server-side HTML —
 *  the same renderer the signing page and the PDF use, so a preview cannot
 *  disagree with what goes out. */
export function AgreementPreviewModal({ agreement, onClose }: {
  agreement: SubDistributorAgreement;
  onClose: () => void;
}) {
  const toast = useToast();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    previewAgreement(agreement.id)
      .then((r) => setHtml(r.html))
      .catch((e) => { setHtml(''); toast.error(errMsg(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agreement.id]);

  return (
    <Modal title={`${agreement.agreement_number ?? `v${agreement.version}`} — preview`} onClose={onClose} maxWidth={900}>
      <div style={{ ...hint, marginTop: 0, marginBottom: 12 }}>
        This is the document they will read. Nothing here is editable — change the Schedule on the
        draft, or publish a new template version, and build again.
      </div>
      {html === null ? (
        <div style={{ color: 'var(--mt)', fontSize: 12, padding: 20 }}>Rendering…</div>
      ) : (
        <div className="agreement-doc" style={{
          background: '#fff', color: '#16191d', padding: '28px 32px', borderRadius: 4,
          fontFamily: 'Georgia, serif', fontSize: 13.5, lineHeight: 1.6, maxHeight: '62vh', overflowY: 'auto',
        }} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </Modal>
  );
}

/** Send (or re-send) the signing link. */
export function SendAgreementDialog({ agreement, resend, onClose, onSent }: {
  agreement: SubDistributorAgreement;
  resend: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const toast = useToast();
  const [to, setTo] = useState(agreement.signer_email ?? agreement.sent_to ?? '');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    try {
      const fn = resend ? resendAgreement : sendAgreementForSignature;
      const r = await fn(agreement.id, { to: to.trim(), expires_days: days });
      setUrl(r.url);
      if (r.emailed) toast.success(`Sent to ${to.trim()}`);
      else toast.error(`Not emailed: ${r.email_error ?? 'unknown reason'} — copy the link below and send it yourself.`);
      onSent();
    } catch (e) {
      toast.error(errMsg(e));
    } finally { setBusy(false); }
  }

  return (
    <Modal title={resend ? 'Send the agreement again' : 'Send for signature'} onClose={onClose} maxWidth={560}>
      {url ? (
        <div>
          <div style={{ fontSize: 12.5, marginBottom: 10 }}>
            {resend ? 'A new link is live and the old one has stopped working.' : 'The link is live.'}
          </div>
          <div style={{
            fontFamily: 'var(--ff-mono)', fontSize: 11, background: 'var(--bg)', border: '1px solid var(--bd)',
            borderRadius: 4, padding: 10, wordBreak: 'break-all', marginBottom: 8,
          }}>{url}</div>
          <div style={hint}>
            ⚠ This is the only time the link is shown — only its hash is stored, so it cannot be read
            back. If it goes astray, use <b>Send again</b>, which issues a new one and kills this.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <div style={{ flex: 1 }} />
            <button onClick={() => navigator.clipboard?.writeText(url)} style={btnSecondary()}>Copy the link</button>
            <button onClick={onClose} style={btnPrimary()}>Done</button>
          </div>
        </div>
      ) : (
        <div>
          {resend && (
            <div style={{ ...hint, marginTop: 0, marginBottom: 12 }}>
              This mints a <b>new</b> link and stops the old one working, which is the honest
              behaviour — a link that needs re-sending has usually gone astray.
            </div>
          )}
          <div style={row}>
            <LField label="Send to"><input value={to} onChange={(e) => setTo(e.target.value)} style={fi()} /></LField>
          </div>
          <div style={row}>
            <LField label="Link expires in (days)">
              <input type="number" min={1} max={365} value={days}
                onChange={(e) => setDays(Number(e.target.value))} style={fi()} />
            </LField>
          </div>
          <div style={hint}>
            Sending executes our side of the agreement with the signature on file, so what they
            open is already signed by us and waiting on them.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <div style={{ flex: 1 }} />
            <button onClick={onClose} style={btnSecondary()}>Cancel</button>
            <button onClick={go} disabled={busy || !to.trim()} style={btnPrimary()}>
              {busy ? 'Sending…' : resend ? 'Issue a new link' : 'Send it'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Switch off an unsigned link. An executed agreement is terminated in writing
 *  under §25, not revoked here — the server refuses that too. */
export function useRevokeAgreement(reload: () => void) {
  const toast = useToast();
  return async function revoke(a: SubDistributorAgreement) {
    if (!window.confirm(
      `Switch off the signing link for ${a.agreement_number ?? `v${a.version}`}?\n\n`
      + 'Anyone holding it will be told to ask for a new one.',
    )) return;
    try {
      await revokeAgreement(a.id);
      toast.success('Link switched off');
      reload();
    } catch (e) { toast.error(errMsg(e)); }
  };
}

export { btnDanger };
