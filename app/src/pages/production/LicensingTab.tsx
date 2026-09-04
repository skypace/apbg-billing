import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, History, Plus, RefreshCw, ScrollText } from 'lucide-react';
import type { QboVendor } from '../../lib/purchasing';
import type { ProductFormula } from '../../lib/formulas';
import {
  BASIS_LABELS, type LicensingBasis, type LicensingCalc, type LicensingPeriodBasis,
  type LicensingProgram, type LicensingRule, type LicensingRuleRate, type LicensingSettlement,
  backfillLicensing, calculateLicensing, createLicensingProgram, createLicensingRule,
  createLicensingSettlement, listLicensingPrograms, listLicensingRules, listLicensingSettlements,
  listRuleRates, periodBounds, periodHasEnded, periodLabel, recentPeriods, recomputeLicensing,
  updateLicensingProgram, updateLicensingRule, voidLicensingSettlement,
} from '../../lib/licensing';
import { useToast } from '../../lib/toast';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../../lib/styles';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
const money = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const qty = (n: number | null | undefined, dp = 2) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: dp });
const rate4 = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d.length === 10 ? d + 'T00:00:00Z' : d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: d.length === 10 ? 'UTC' : undefined }) : '—';
const today = () => new Date().toISOString().slice(0, 10);

const label: React.CSSProperties = { fontSize: 10.5, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 };
const th: React.CSSProperties = { textAlign: 'left', fontSize: 10.5, color: 'var(--mt)', fontWeight: 600, padding: '8px 10px', borderBottom: '1px solid var(--bd)', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--bd)', fontSize: 12, verticalAlign: 'top' };
const tdNum: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const chip = (bg: string, fg = '#fff'): React.CSSProperties =>
  ({ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 10.5, fontWeight: 600, background: bg, color: fg, whiteSpace: 'nowrap' });

/**
 * Licensing agreements — a licensor's royalty accrued per production run.
 *
 * AC Calderoni's compounding fee used to ride every BOM as a flat per-run
 * Service line (item 1391, $1,173.33) that nobody could receive. It is now
 * RATE × FINAL CASES PRODUCED, written onto each work order the moment its
 * yield is recorded (`fn_wo_advance` → `fn_licensing_accrue_wo`), and settled
 * per period into a Brixpense payable — the check itself posts to QuickBooks
 * only when a human clicks "Post to QuickBooks" there (the 2026-08-14 rule).
 *
 * A rate change is forward-only: the accrual carries the rate in force on the
 * yield date, so editing the rate never reprices a run already made. The
 * history table underneath says what was in force when.
 */
export function LicensingTab({ vendors, formulas }: {
  vendors: QboVendor[] | null;
  formulas: ProductFormula[] | null;
}) {
  const toast = useToast();
  const [programs, setPrograms] = useState<LicensingProgram[] | null>(null);
  const [programId, setProgramId] = useState<string>('');
  const [rules, setRules] = useState<LicensingRule[]>([]);
  const [settlements, setSettlements] = useState<LicensingSettlement[]>([]);
  const [calc, setCalc] = useState<LicensingCalc | null>(null);
  const [calcBusy, setCalcBusy] = useState(false);
  const [periodKey, setPeriodKey] = useState<string>('');
  const [editProgram, setEditProgram] = useState<'new' | 'edit' | null>(null);
  const [addingRule, setAddingRule] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const program = useMemo(() => programs?.find((p) => p.id === programId) ?? null, [programs, programId]);
  const vendorById = useMemo(() => new Map((vendors ?? []).map((v) => [v.qbo_vendor_id, v.display_name])), [vendors]);
  const formulaById = useMemo(() => new Map((formulas ?? []).map((f) => [f.id, f.name])), [formulas]);

  async function loadPrograms(keep?: string) {
    try {
      const rows = await listLicensingPrograms();
      setPrograms(rows);
      const next = keep && rows.some((r) => r.id === keep) ? keep
        : rows.some((r) => r.id === programId) ? programId
        : (rows.find((r) => r.status === 'active') ?? rows[0])?.id ?? '';
      setProgramId(next);
    } catch (e) { toast.error(errMsg(e)); setPrograms([]); }
  }
  useEffect(() => { void loadPrograms(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadProgramDetail() {
    if (!program) { setRules([]); setSettlements([]); setCalc(null); return; }
    try {
      const [r, s] = await Promise.all([listLicensingRules(program.id), listLicensingSettlements(program.id)]);
      setRules(r); setSettlements(s);
    } catch (e) { toast.error(errMsg(e)); }
  }
  useEffect(() => { void loadProgramDetail(); }, [program?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default the period to the current one whenever the program (and so its
  // basis) changes; the operator can look back from there.
  useEffect(() => {
    if (!program) return;
    setPeriodKey(recentPeriods(program.period_basis, 1)[0]);
  }, [program?.id, program?.period_basis]);

  async function runCalc() {
    if (!program || !periodKey) return;
    setCalcBusy(true);
    try {
      const b = periodBounds(program.period_basis, periodKey);
      setCalc(await calculateLicensing(program.id, b.start, b.end));
    } catch (e) { toast.error(errMsg(e)); setCalc(null); }
    finally { setCalcBusy(false); }
  }
  useEffect(() => { void runCalc(); }, [program?.id, periodKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const periods = useMemo(() => program ? recentPeriods(program.period_basis, 18) : [], [program]);
  const openSettlementForPeriod = settlements.find((s) => s.period_key === periodKey && s.status !== 'void');
  const canSettle = !!program && !!calc && !openSettlementForPeriod
    && periodHasEnded(program.period_basis, periodKey) && (calc.unsettled_total ?? 0) > 0;
  const settleWhy = !program ? '' : openSettlementForPeriod
    ? `Already settled as ${openSettlementForPeriod.reference} — void it to re-run.`
    : !periodHasEnded(program.period_basis, periodKey)
      ? `${periodLabel(program.period_basis, periodKey)} has not ended — a run can still yield in it.`
      : (calc?.unsettled_total ?? 0) <= 0 ? 'Nothing unsettled accrued in this period.' : '';

  async function settle() {
    if (!program || !canSettle) return;
    const ok = window.confirm(
      `Settle ${periodLabel(program.period_basis, periodKey)} for ${program.name}?\n\n`
      + `${money(calc?.unsettled_total)} across ${new Set((calc?.rules ?? []).flatMap((r) => r.work_orders.filter((w) => !w.settlement_id).map((w) => w.wo_id))).size} run(s) → one Brixpense payable to ${calc?.vendor_name ?? vendorById.get(program.qbo_vendor_id) ?? program.qbo_vendor_id}.\n`
      + `Nothing reaches QuickBooks until someone posts it from Brixpense.`);
    if (!ok) return;
    setBusy('settle');
    try {
      const r = await createLicensingSettlement(program.id, periodKey);
      toast.success(`${r.reference} created — ${money(r.total_amount)} for ${r.runs} run(s). Post it from Brixpense when ready.`);
      await loadProgramDetail(); await runCalc();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(null); }
  }

  async function voidSettlement(s: LicensingSettlement) {
    const reason = window.prompt(`Void ${s.reference}? The runs go back to unsettled and the Brixpense request is archived. Reason:`);
    if (reason === null) return;
    setBusy(s.id);
    try {
      await voidLicensingSettlement(s.id, reason || undefined);
      toast.success(`${s.reference} voided`);
      await loadProgramDetail(); await runCalc();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(null); }
  }

  async function reprice() {
    if (!program) return;
    setBusy('reprice');
    try {
      const b = periodBounds(program.period_basis, periodKey);
      const n = await recomputeLicensing(program.id, b.start, b.end);
      toast.success(n === 0 ? 'Every unsettled run already carries the rate in force on its yield date.' : `${n} unsettled run(s) re-priced from the rate history.`);
      await runCalc();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(null); }
  }

  async function backfill() {
    if (!program) return;
    setBusy('backfill');
    try {
      const n = await backfillLicensing(program.id);
      toast.success(n === 0 ? 'No yielded runs since the program start were missing an accrual.' : `${n} accrual(s) written for runs yielded since ${fmtDate(program.starts_on)}.`);
      await runCalc();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(null); }
  }

  if (programs === null) return <div className="ld">Loading licensing programs…</div>;

  return (
    <div>
      {/* ── Program picker ─────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <ScrollText size={16} style={{ color: 'var(--ac)' }} />
          <div style={{ fontWeight: 600, fontSize: 13 }}>Licensing agreements</div>
          <div style={{ flex: 1, minWidth: 8 }} />
          {programs.length > 0 && (
            <select value={programId} onChange={(e) => { setProgramId(e.target.value); setEditProgram(null); }} style={{ ...inp(), width: 'auto', minWidth: 240 }}>
              {programs.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status === 'ended' ? ' (ended)' : ''}</option>)}
            </select>
          )}
          <button style={btnSecondary()} onClick={() => setEditProgram('new')}><Plus size={12} /> New program</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--mt)', marginTop: 8, lineHeight: 1.5 }}>
          A licensor's fee accrued per production run — rate × the cases made — and settled per period into a Brixpense payable.
          The rate is editable; a change applies to runs yielded from its effective date onward and never reprices a run already made.
        </div>
      </div>

      {editProgram && (
        <ProgramEditor
          initial={editProgram === 'edit' ? program : null}
          vendors={vendors}
          onCancel={() => setEditProgram(null)}
          onSaved={async (id) => { setEditProgram(null); await loadPrograms(id); }}
        />
      )}

      {!program && programs.length === 0 && !editProgram && (
        <div className="card" style={{ color: 'var(--mt)', fontSize: 12 }}>
          No licensing programs yet. Create one for the licensor you pay, then add a rule with its rate.
        </div>
      )}

      {program && (
        <>
          {/* ── Program header ───────────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{program.name}</div>
                  <span style={chip('var(--sf2)', 'var(--tx)')}>{program.code}</span>
                  <span style={chip('var(--sf2)', 'var(--tx)')}>{program.entity}</span>
                  <span style={chip('var(--sf2)', 'var(--tx)')}>settles {program.period_basis === 'month' ? 'monthly' : 'quarterly'}</span>
                  {program.status === 'ended' && <span style={chip('#64748b')}>ended</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--mt)', marginTop: 6 }}>
                  Licensor / payee: <strong style={{ color: 'var(--tx)' }}>{vendorById.get(program.qbo_vendor_id) ?? `QBO vendor ${program.qbo_vendor_id}`}</strong>
                  {' · '}accrues on runs yielded from {fmtDate(program.starts_on)}
                </div>
                {program.notes && <div style={{ fontSize: 11.5, color: 'var(--mt)', marginTop: 6, whiteSpace: 'pre-wrap' }}>{program.notes}</div>}
              </div>
              <button style={btnSecondary()} onClick={() => setEditProgram('edit')}>Edit program</button>
            </div>
          </div>

          {/* ── Rules ────────────────────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Rates</div>
              <div style={{ fontSize: 11, color: 'var(--mt)' }}>what is charged, on what, per run</div>
              <div style={{ flex: 1 }} />
              <button style={btnSecondary()} onClick={() => setAddingRule(true)}><Plus size={12} /> Add rule</button>
            </div>
            {addingRule && (
              <RuleEditor programId={program.id} formulas={formulas} sort={rules.length + 1}
                onCancel={() => setAddingRule(false)}
                onSaved={async () => { setAddingRule(false); await loadProgramDetail(); }} />
            )}
            {rules.length === 0 && !addingRule ? (
              <div style={{ padding: 14, fontSize: 12, color: 'var(--am)' }}>
                <AlertTriangle size={12} style={{ verticalAlign: -2 }} /> No rules — nothing accrues until a rate is set.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>Rule</th><th style={th}>Basis</th><th style={{ ...th, textAlign: 'right' }}>Rate</th>
                  <th style={th}>Applies to</th><th style={th}>Since</th><th style={th}></th>
                </tr></thead>
                <tbody>
                  {rules.map((r) => (
                    <RuleRow key={r.id} rule={r} formulaById={formulaById} formulas={formulas}
                      onChanged={async () => { await loadProgramDetail(); await runCalc(); }} />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Accrual for a period ─────────────────────────────────── */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Accrued this period</div>
              <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} style={{ ...inp(), width: 'auto' }}>
                {periods.map((k) => <option key={k} value={k}>{periodLabel(program.period_basis, k)}</option>)}
              </select>
              <button style={btnSecondary()} onClick={runCalc} disabled={calcBusy}><RefreshCw size={12} /> {calcBusy ? 'Calculating…' : 'Recalculate'}</button>
              <div style={{ flex: 1 }} />
              <button style={btnSecondary()} onClick={reprice} disabled={busy !== null} title="Re-price unsettled runs in this period from the rate history (after a rate typo or a back-dated change). Settled runs never move.">
                Re-price unsettled
              </button>
              <button style={btnSecondary()} onClick={backfill} disabled={busy !== null} title="Write accruals for runs yielded since the program start that have none (a program added after runs were made).">
                Backfill
              </button>
              <span title={settleWhy}>
                <button style={{ ...btnPrimary(), opacity: canSettle ? 1 : 0.55 }} onClick={settle} disabled={!canSettle || busy !== null}>
                  <Check size={12} /> Run {periodLabel(program.period_basis, periodKey)} settlement
                </button>
              </span>
            </div>
            {settleWhy && <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 6 }}>{settleWhy}</div>}

            {calc && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
                  <Stat label="Accrued" value={money(calc.grand_total)} />
                  <Stat label="Unsettled" value={money(calc.unsettled_total)} accent={calc.unsettled_total > 0} />
                  <Stat label="Runs" value={String(new Set(calc.rules.flatMap((r) => r.work_orders.map((w) => w.wo_id))).size)} />
                  <Stat label="Not yet yielded" value={String(calc.pending.length)} muted />
                </div>
                {calc.rules.map((r) => (
                  <div key={r.rule_id} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                      {r.label} <span style={{ color: 'var(--mt)', fontWeight: 400 }}>· {BASIS_LABELS[r.basis]} · now {rate4(r.current_rate)} {r.rate_unit}</span>
                    </div>
                    {r.work_orders.length === 0 ? (
                      <div style={{ fontSize: 11.5, color: 'var(--mt)', padding: '4px 0 8px' }}>No runs yielded in this period.</div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead><tr>
                            <th style={th}>Batch</th><th style={th}>Flavour</th><th style={th}>Yield date</th>
                            <th style={{ ...th, textAlign: 'right' }}>Cases</th>
                            {r.basis !== 'cases_produced' && <th style={{ ...th, textAlign: 'right' }}>Basis qty</th>}
                            <th style={{ ...th, textAlign: 'right' }}>Rate</th><th style={{ ...th, textAlign: 'right' }}>Amount</th>
                            <th style={th}>Settlement</th>
                          </tr></thead>
                          <tbody>
                            {r.work_orders.map((w) => (
                              <tr key={w.accrual_id}>
                                <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{w.batch_code ?? '—'}</td>
                                <td style={td}>{w.flavour ?? w.finished_item ?? '—'}</td>
                                <td style={td}>{fmtDate(w.basis_date)}</td>
                                <td style={tdNum}>{qty(w.cases, 0)}</td>
                                {r.basis !== 'cases_produced' && <td style={tdNum}>{qty(w.basis_qty)}</td>}
                                <td style={tdNum}>{rate4(w.rate)} <span style={{ color: 'var(--mt)' }}>{w.rate_unit}</span></td>
                                <td style={tdNum}>{money(w.amount)}</td>
                                <td style={td}>{w.settlement_reference
                                  ? <span style={chip('var(--gn)')}>{w.settlement_reference}</span>
                                  : <span style={chip('var(--sf2)', 'var(--mt)')}>unsettled</span>}</td>
                              </tr>
                            ))}
                            <tr>
                              <td style={{ ...td, fontWeight: 600 }} colSpan={3}>Total</td>
                              <td style={{ ...tdNum, fontWeight: 600 }}>{r.basis === 'cases_produced' ? qty(r.total_basis_qty, 0) : ''}</td>
                              {r.basis !== 'cases_produced' && <td style={{ ...tdNum, fontWeight: 600 }}>{qty(r.total_basis_qty)}</td>}
                              <td style={td}></td>
                              <td style={{ ...tdNum, fontWeight: 600 }}>{money(r.total)}</td>
                              <td style={{ ...td, color: 'var(--mt)', fontSize: 11 }}>{r.unsettled_total !== r.total ? `${money(r.unsettled_total)} unsettled` : ''}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
                {calc.pending.length > 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--mt)', borderTop: '1px dashed var(--bd)', paddingTop: 8 }}>
                    <strong style={{ color: 'var(--tx)' }}>Not yet accrued</strong> — runs under way that will accrue when their yield is recorded:{' '}
                    {calc.pending.map((p) => `${p.batch_code} (${p.flavour ?? 'unknown'} · ${qty(p.qty_to_produce, 0)} planned · ${p.status.replace('_', ' ')})`).join(' · ')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Settlements ──────────────────────────────────────────── */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)', fontWeight: 600, fontSize: 13 }}>Settlements</div>
            {settlements.length === 0 ? (
              <div style={{ padding: 14, fontSize: 12, color: 'var(--mt)' }}>None yet. A settlement bundles a finished period's runs into one Brixpense payable.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={th}>Reference</th><th style={th}>Period</th>
                    <th style={{ ...th, textAlign: 'right' }}>Basis qty</th><th style={{ ...th, textAlign: 'right' }}>Amount</th>
                    <th style={th}>Status</th><th style={th}>Created</th><th style={th}>Brixpense</th><th style={th}></th>
                  </tr></thead>
                  <tbody>
                    {settlements.map((s) => (
                      <tr key={s.id}>
                        <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{s.reference}</td>
                        <td style={td}>{periodLabel(program.period_basis, s.period_key)}</td>
                        <td style={tdNum}>{qty(s.total_basis_qty)}</td>
                        <td style={tdNum}>{money(s.total_amount)}</td>
                        <td style={td}>{s.status === 'void'
                          ? <span style={chip('#64748b')} title={s.void_reason ?? ''}>void</span>
                          : <span style={chip('var(--gn)')}>open</span>}</td>
                        <td style={td}>{fmtDate(s.created_at)}</td>
                        <td style={td}>{s.expense_request_id && s.status !== 'void'
                          ? <a href="/expense/pending" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ac)', fontSize: 12 }}>Post from Brixpense →</a>
                          : <span style={{ color: 'var(--mt)' }}>—</span>}</td>
                        <td style={td}>{s.status !== 'void' && (
                          <button style={{ ...btnDanger(), fontSize: 11, padding: '3px 9px' }} onClick={() => voidSettlement(s)} disabled={busy !== null}>Void</button>
                        )}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label: l, value, accent, muted }: { label: string; value: string; accent?: boolean; muted?: boolean }) {
  return (
    <div>
      <div style={label}>{l}</div>
      <div style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: accent ? 'var(--ac)' : muted ? 'var(--mt)' : 'var(--tx)' }}>{value}</div>
    </div>
  );
}

// ── Program editor ───────────────────────────────────────────────────────────

function ProgramEditor({ initial, vendors, onCancel, onSaved }: {
  initial: LicensingProgram | null;
  vendors: QboVendor[] | null;
  onCancel: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [vendorId, setVendorId] = useState(initial?.qbo_vendor_id ?? '');
  const [entity, setEntity] = useState<string>(initial?.entity ?? 'brix');
  const [basis, setBasis] = useState<LicensingPeriodBasis>(initial?.period_basis ?? 'month');
  const [startsOn, setStartsOn] = useState(initial?.starts_on ?? today());
  const [status, setStatus] = useState<'active' | 'ended'>(initial?.status ?? 'active');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const vendorOptions = useMemo(() => (vendors ?? []).slice().sort((a, b) => a.display_name.localeCompare(b.display_name)), [vendors]);

  async function save() {
    const c = code.trim().toUpperCase();
    if (!name.trim()) return toast.error('Name the program.');
    if (c.length < 2 || c.length > 10 || !/^[A-Z0-9]+$/.test(c)) return toast.error('Code: 2–10 letters/digits — it becomes the bill number, LIC-<CODE>-YYYYMM.');
    if (!vendorId) return toast.error('Pick the licensor — the payable needs a payee.');
    setSaving(true);
    try {
      if (initial) {
        await updateLicensingProgram(initial.id, { name: name.trim(), code: c, qbo_vendor_id: vendorId, entity: entity as LicensingProgram['entity'], period_basis: basis, starts_on: startsOn, status, notes: notes.trim() || null });
        await onSaved(initial.id);
      } else {
        const row = await createLicensingProgram({ name: name.trim(), code: c, qbo_vendor_id: vendorId, entity, period_basis: basis, starts_on: startsOn, notes: notes.trim() || null });
        await onSaved(row.id);
      }
      toast.success(initial ? 'Program saved' : 'Program created — add a rule with its rate');
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 12, borderColor: 'var(--ac)' }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>{initial ? 'Edit program' : 'New licensing program'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <div style={{ gridColumn: 'span 2' }}><div style={label}>Name</div><input style={inp()} value={name} onChange={(e) => setName(e.target.value)} placeholder="AC Calderoni syrup licensing" /></div>
        <div><div style={label}>Code</div><input style={inp()} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CALDERONI" maxLength={10} /></div>
        <div style={{ gridColumn: 'span 2' }}><div style={label}>Licensor (QBO vendor — the payee)</div>
          <select style={inp()} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">— pick a vendor —</option>
            {vendorOptions.map((v) => <option key={v.qbo_vendor_id} value={v.qbo_vendor_id}>{v.display_name}</option>)}
          </select></div>
        <div><div style={label}>Entity</div>
          <select style={inp()} value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="brix">brix</option><option value="freeflow">freeflow</option><option value="shared">shared</option>
          </select></div>
        <div><div style={label}>Settle</div>
          <select style={inp()} value={basis} onChange={(e) => setBasis(e.target.value as LicensingPeriodBasis)}>
            <option value="month">monthly</option><option value="quarter">quarterly</option>
          </select></div>
        <div><div style={label}>Accrue runs yielded from</div><input type="date" style={inp()} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></div>
        {initial && <div><div style={label}>Status</div>
          <select style={inp()} value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'ended')}>
            <option value="active">active</option><option value="ended">ended</option>
          </select></div>}
        <div style={{ gridColumn: '1 / -1' }}><div style={label}>Notes</div><textarea style={{ ...inp(), minHeight: 56 }} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button style={btnSecondary()} onClick={onCancel} disabled={saving}>Cancel</button>
        <button style={btnPrimary()} onClick={save} disabled={saving}>{saving ? 'Saving…' : initial ? 'Save' : 'Create program'}</button>
      </div>
    </div>
  );
}

// ── Rule editor (new) ────────────────────────────────────────────────────────

function RuleEditor({ programId, formulas, sort, onCancel, onSaved }: {
  programId: string; formulas: ProductFormula[] | null; sort: number;
  onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [labelText, setLabelText] = useState('');
  const [basis, setBasis] = useState<LicensingBasis>('cases_produced');
  const [rate, setRate] = useState('');
  const [unit, setUnit] = useState('per case');
  const [from, setFrom] = useState(today());
  const [scope, setScope] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function save() {
    const r = Number(rate);
    if (!labelText.trim()) return toast.error('Give the rule a label — it prints on the bill line.');
    if (!Number.isFinite(r) || r < 0) return toast.error('Rate must be a number ≥ 0.');
    setSaving(true);
    try {
      await createLicensingRule({ program_id: programId, label: labelText.trim(), basis, rate: r, rate_unit: unit.trim() || 'per unit', rate_effective_from: from, formula_ids: scope, sort });
      toast.success('Rule added');
      await onSaved();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ padding: 14, borderBottom: '1px solid var(--bd)', background: 'var(--sf2)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <div style={{ gridColumn: 'span 2' }}><div style={label}>Label (prints on the bill)</div><input style={inp()} value={labelText} onChange={(e) => setLabelText(e.target.value)} placeholder="Syrup licensing royalty — per case produced" /></div>
        <div><div style={label}>Basis</div>
          <select style={inp()} value={basis} onChange={(e) => { const b = e.target.value as LicensingBasis; setBasis(b); setUnit(b === 'cases_produced' ? 'per case' : b === 'concentrate_gal_produced' ? 'per raw gallon' : 'per finished gallon'); }}>
            {(Object.keys(BASIS_LABELS) as LicensingBasis[]).map((b) => <option key={b} value={b}>{BASIS_LABELS[b]}</option>)}
          </select></div>
        <div><div style={label}>Rate ($)</div><input style={inp()} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.50" /></div>
        <div><div style={label}>Rate reads as</div><input style={inp()} value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
        <div><div style={label}>Effective from</div><input type="date" style={inp()} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={label}>Applies to (leave empty = every flavour)</div>
          <FormulaScope formulas={formulas} value={scope} onChange={setScope} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <button style={btnSecondary()} onClick={onCancel} disabled={saving}>Cancel</button>
        <button style={btnPrimary()} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add rule'}</button>
      </div>
    </div>
  );
}

function FormulaScope({ formulas, value, onChange }: { formulas: ProductFormula[] | null; value: string[]; onChange: (v: string[]) => void }) {
  const list = (formulas ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0) return <div style={{ fontSize: 11.5, color: 'var(--mt)' }}>No formulas loaded — the rule applies to every flavour.</div>;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {list.map((f) => {
        const on = value.includes(f.id);
        return (
          <button key={f.id} type="button" onClick={() => onChange(on ? value.filter((x) => x !== f.id) : [...value, f.id])}
            style={{ ...(on ? btnPrimary() : btnSecondary()), fontSize: 11, padding: '3px 10px' }}>{f.name}</button>
        );
      })}
    </div>
  );
}

// ── Rule row: inline rate change + history ───────────────────────────────────

function RuleRow({ rule, formulaById, formulas, onChanged }: {
  rule: LicensingRule; formulaById: Map<string, string>; formulas: ProductFormula[] | null;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  const [rate, setRate] = useState(String(rule.rate));
  const [unit, setUnit] = useState(rule.rate_unit);
  const [from, setFrom] = useState(today());
  const [note, setNote] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<LicensingRuleRate[] | null>(null);
  const [scopeEdit, setScopeEdit] = useState(false);
  const [scope, setScope] = useState<string[]>(rule.formula_ids);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (showHistory) listRuleRates(rule.id).then(setHistory).catch(() => setHistory([])); }, [showHistory, rule.id, rule.rate]);

  async function saveRate() {
    const r = Number(rate);
    if (!Number.isFinite(r) || r < 0) return toast.error('Rate must be a number ≥ 0.');
    if (!from) return toast.error('Pick the date the new rate takes effect.');
    setSaving(true);
    try {
      await updateLicensingRule(rule.id, { rate: r, rate_unit: unit.trim() || rule.rate_unit, rate_effective_from: from, rate_note: note.trim() || null });
      toast.success(`Rate is ${rate4(r)} ${unit} from ${fmtDate(from)} — runs yielded before that keep their old rate.`);
      setChanging(false); setNote('');
      await onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }
  async function toggleActive() {
    setSaving(true);
    try { await updateLicensingRule(rule.id, { active: !rule.active }); await onChanged(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }
  async function saveScope() {
    setSaving(true);
    try { await updateLicensingRule(rule.id, { formula_ids: scope }); setScopeEdit(false); await onChanged(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  const scopeText = rule.formula_ids.length === 0 ? 'every flavour'
    : rule.formula_ids.map((id) => formulaById.get(id) ?? '?').join(', ');

  return (
    <>
      <tr style={{ opacity: rule.active ? 1 : 0.55 }}>
        <td style={td}><div style={{ fontWeight: 600 }}>{rule.label}</div>{!rule.active && <span style={chip('#64748b')}>inactive</span>}</td>
        <td style={td}>{BASIS_LABELS[rule.basis]}</td>
        <td style={tdNum}><strong>{rate4(rule.rate)}</strong> <span style={{ color: 'var(--mt)' }}>{rule.rate_unit}</span></td>
        <td style={td}>{scopeText} <button onClick={() => setScopeEdit((v) => !v)} style={{ ...btnSecondary(), fontSize: 10.5, padding: '1px 7px', marginLeft: 6 }}>edit</button></td>
        <td style={td}>{fmtDate(rule.rate_effective_from)}</td>
        <td style={{ ...td, whiteSpace: 'nowrap' }}>
          <button style={{ ...btnSecondary(), fontSize: 11, padding: '3px 9px' }} onClick={() => setChanging((v) => !v)}>Change rate…</button>{' '}
          <button style={{ ...btnSecondary(), fontSize: 11, padding: '3px 9px' }} onClick={() => setShowHistory((v) => !v)} title="Rate history"><History size={11} /></button>{' '}
          <button style={{ ...btnSecondary(), fontSize: 11, padding: '3px 9px' }} onClick={toggleActive} disabled={saving}>{rule.active ? 'Deactivate' : 'Reactivate'}</button>
        </td>
      </tr>
      {changing && (
        <tr><td colSpan={6} style={{ ...td, background: 'var(--sf2)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div><div style={label}>New rate ($)</div><input style={{ ...inp(), width: 110 }} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
            <div><div style={label}>Reads as</div><input style={{ ...inp(), width: 150 }} value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
            <div><div style={label}>Effective from</div><input type="date" style={{ ...inp(), width: 160 }} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div style={{ flex: 1, minWidth: 200 }}><div style={label}>Why (optional)</div><input style={inp()} value={note} onChange={(e) => setNote(e.target.value)} placeholder="new agreement, correction…" /></div>
            <button style={btnPrimary()} onClick={saveRate} disabled={saving}>Save rate</button>
            <button style={btnSecondary()} onClick={() => setChanging(false)} disabled={saving}>Cancel</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 6 }}>
            Runs yielded on or after the effective date accrue at the new rate. Runs already yielded keep the rate they were made under; use <em>Re-price unsettled</em> only to fix a rate that was entered wrong.
          </div>
        </td></tr>
      )}
      {scopeEdit && (
        <tr><td colSpan={6} style={{ ...td, background: 'var(--sf2)' }}>
          <FormulaScope formulas={formulas} value={scope} onChange={setScope} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={btnPrimary()} onClick={saveScope} disabled={saving}>Save scope</button>
            <button style={btnSecondary()} onClick={() => { setScope(rule.formula_ids); setScopeEdit(false); }}>Cancel</button>
          </div>
        </td></tr>
      )}
      {showHistory && (
        <tr><td colSpan={6} style={{ ...td, background: 'var(--sf2)', fontSize: 11.5 }}>
          <div style={{ ...label, marginBottom: 6 }}>Rate history</div>
          {history === null ? 'Loading…' : history.length === 0 ? 'No history yet.' : (
            <table style={{ borderCollapse: 'collapse' }}>
              <tbody>{history.map((h) => (
                <tr key={h.id}>
                  <td style={{ padding: '2px 12px 2px 0' }}>from {fmtDate(h.effective_from)}</td>
                  <td style={{ padding: '2px 12px 2px 0', fontVariantNumeric: 'tabular-nums' }}><strong>{rate4(h.rate)}</strong> {h.rate_unit}</td>
                  <td style={{ padding: '2px 0', color: 'var(--mt)' }}>{h.note ?? ''}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </td></tr>
      )}
    </>
  );
}
