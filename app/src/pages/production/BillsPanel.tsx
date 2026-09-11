// Bills against a production order and against a closed purchase order
// (migration 20260903h). The rule in one sentence: every payable is a Brixpense
// expense request, posting is a human click in Brixpense (the 2026-08-14 gate),
// and a final invoice that replaces a deposit UPDATES the deposit's request —
// one QuickBooks bill, re-sent with "Update in QuickBooks", the deposit payment
// still applied. This file only records and reads; nothing here touches QBO.
import { useCallback, useEffect, useState } from 'react';
import { Receipt, ExternalLink } from 'lucide-react';
import type { ProductionRun } from '../../lib/runs';
import type { QboVendor, PurchaseOrderRow } from '../../lib/purchasing';
import {
  BILL_STATE_COPY, brixpenseHistoryUrl, createPoBill, fetchPoBills, fetchRunBills, recordDeposit, recordFinalBill,
  type BillKind, type RunBill,
} from '../../lib/runBills';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import { LField, StageChip, cellTh, cellTd, sectionLabel, errMsg } from './productionUi';

// Money always prints cents: fmtNum(v, 2) caps at two decimals but drops trailing zeros ($500, $25,878.6) — a bill total is read against paper.
const money = (v: number | null | undefined) => v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const KIND_LABEL: Record<BillKind, string> = { deposit: 'Deposit', final: 'Final invoice', po: 'PO bill' };

export function BillStateChip({ bill }: { bill: RunBill }) {
  const c = BILL_STATE_COPY[bill.bill_state] ?? BILL_STATE_COPY.to_post;
  return <span title={c.detail}><StageChip status={bill.bill_state} color={c.color} label={c.label} /></span>;
}

/** Where the human finishes: post, or re-send the changed total onto the same bill. */
function BrixpenseLink({ bill }: { bill: RunBill }) {
  const url = brixpenseHistoryUrl();
  if (bill.bill_state === 'to_post') return <a href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--am)', fontSize: 10.5 }}>Post from Brixpense <ExternalLink size={9} style={{ verticalAlign: -1 }} /></a>;
  if (bill.bill_state === 'needs_update') return <a href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--am)', fontSize: 10.5 }}>Update in QuickBooks <ExternalLink size={9} style={{ verticalAlign: -1 }} /></a>;
  if (bill.qbo_bill_id) return <span style={{ color: 'var(--gn)', fontSize: 10.5 }}>QBO bill {bill.qbo_bill_id}{bill.qbo_balance != null && bill.bill_state === 'posted' ? ` · ${money(bill.qbo_balance)} due` : ''}</span>;
  return <span style={{ color: 'var(--mt)' }}>—</span>;
}

function BillsTable({ bills, showRunOrPo }: { bills: RunBill[]; showRunOrPo?: 'po' | 'run' }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--bd)' }}>
          <th style={cellTh}>Kind</th>
          {showRunOrPo === 'po' && <th style={cellTh}>PO</th>}
          <th style={cellTh}>Vendor</th><th style={cellTh}>Invoice #</th><th style={cellTh}>Date</th>
          <th style={{ ...cellTh, textAlign: 'right' }}>Invoice total</th><th style={{ ...cellTh, textAlign: 'right' }}>Balance due</th>
          <th style={cellTh}>State</th><th style={cellTh}>QuickBooks</th>
        </tr>
      </thead>
      <tbody>
        {bills.map((b) => {
          const replacesDeposit = b.kind === 'final' && b.linked_deposit_bill_id != null;
          const deposit = replacesDeposit && b.amount_net != null ? Number(b.amount_gross) - Number(b.amount_net) : null;
          return (
            <tr key={b.id} data-testid="bill-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: b.bill_state === 'archived' ? 0.5 : 1 }}>
              <td style={cellTd}>
                <span style={{ fontWeight: 600 }}>{KIND_LABEL[b.kind] ?? b.kind}</span>
                {replacesDeposit && <div style={{ fontSize: 9.5, color: 'var(--mt)' }}>replaces the deposit{deposit != null ? ` (${money(deposit)} on the same bill)` : ''}</div>}
              </td>
              {showRunOrPo === 'po' && <td style={{ ...cellTd, fontFamily: 'var(--ff-mono)' }}>{b.po_number ?? '—'}</td>}
              <td style={cellTd}>{b.vendor_name ?? b.qbo_vendor_id}</td>
              <td style={{ ...cellTd, fontFamily: 'var(--ff-mono)' }}>{b.vendor_invoice_number ?? <span style={{ color: 'var(--mt)' }}>—</span>}</td>
              <td style={cellTd}>{b.invoice_date ?? '—'}</td>
              <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{money(b.request_total)}</td>
              <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{b.kind === 'deposit' ? money(b.amount_gross) : money(b.amount_net)}</td>
              <td style={cellTd}><BillStateChip bill={b} /></td>
              <td style={cellTd}><BrixpenseLink bill={b} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Production order: deposit + final ────────────────────────────────────────
export function RunBillsSection({ run, vendors, onChanged }: { run: ProductionRun; vendors: QboVendor[]; onChanged: () => void }) {
  const toast = useToast();
  const [bills, setBills] = useState<RunBill[] | null>(null);
  const [dialog, setDialog] = useState<'deposit' | 'final' | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => { fetchRunBills(run.id).then(setBills).catch(() => setBills([])); }, [run.id]);
  useEffect(() => { reload(); }, [reload, run.status]);

  const live = (bills ?? []).filter((b) => b.bill_state !== 'archived');
  const deposits = live.filter((b) => b.kind === 'deposit');
  const canRecord = run.status !== 'void' && run.status !== 'draft';

  async function submitDeposit(v: { vendorId: string; amount: number; invoice: string | null; date: string | null; memo: string | null }) {
    setBusy(true);
    try {
      const r = await recordDeposit(run.id, v.vendorId, v.amount, v.invoice, v.date, v.memo);
      toast.success(`Deposit recorded · ${money(r.amount)} — post it from Brixpense so it can be paid against`);
      setDialog(null); reload(); onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  async function submitFinal(v: { vendorId: string; amount: number; invoice: string | null; date: string | null; depositBillId: string | null }) {
    setBusy(true);
    try {
      const r = await recordFinalBill(run.id, v.vendorId, v.amount, v.invoice, v.date, v.depositBillId);
      if (v.depositBillId) {
        toast.success(r.updates_existing_qbo_bill
          ? `Final invoice recorded on the deposit's bill (QBO ${r.qbo_bill_id}) · balance due ${money(r.amount_net)} — press Update in QuickBooks in Brixpense`
          : `Final invoice recorded on the deposit's bill · balance due ${money(r.amount_net)} — post it from Brixpense`);
      } else toast.success(`Final invoice recorded · ${money(r.amount_gross)} — post it from Brixpense`);
      setDialog(null); reload(); onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginBottom: 14 }} data-testid="run-bills">
      <div style={{ ...sectionLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span><Receipt size={11} style={{ verticalAlign: -1, marginRight: 4 }} /> Bills — the co-packer's deposit and final invoice</span>
        {canRecord && (
          <span style={{ display: 'flex', gap: 6 }}>
            <button style={btnSecondary()} disabled={busy} onClick={() => setDialog('deposit')}>Record deposit…</button>
            <button style={btnSecondary()} disabled={busy} onClick={() => setDialog('final')}>Record final invoice…</button>
          </span>
        )}
      </div>
      {bills === null ? <div style={{ fontSize: 11, color: 'var(--mt)' }}>Loading…</div>
        : bills.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--mt)' }}>
            None yet. A deposit invoice from the co-packer is recorded here and posted from Brixpense as a bill you can pay against; the final invoice then replaces it on the SAME QuickBooks bill.
            {' '}Each vendor's PO bill is created from the purchase order once it closes.
          </div>
        ) : <BillsTable bills={bills} showRunOrPo="po" />}
      {dialog === 'deposit' && (
        <BillDialog title={`Record a deposit invoice on ${run.run_number}`} verb="Record deposit" busy={busy} vendors={vendors} defaultVendorId={run.copacker_qbo_vendor_id}
          note="Creates the bill in Brixpense (approved, tag Production). Post it from Expense History and it becomes a QuickBooks bill a payment can be applied to. When the final invoice arrives, record it against this deposit and the same bill is updated — the payment stays applied."
          onCancel={() => setDialog(null)} onSubmit={(v) => void submitDeposit({ vendorId: v.vendorId, amount: v.amount, invoice: v.invoice, date: v.date, memo: v.memo })} />
      )}
      {dialog === 'final' && (
        <BillDialog title={`Record the final invoice on ${run.run_number}`} verb="Record final invoice" busy={busy} vendors={vendors} defaultVendorId={run.copacker_qbo_vendor_id}
          deposits={deposits}
          note="The invoice total is the GROSS amount on the vendor's invoice. Against a deposit, the deposit's bill is updated in place to this total (balance due = total − deposit) and Brixpense lights Update in QuickBooks; with no deposit a new bill is created."
          onCancel={() => setDialog(null)} onSubmit={(v) => void submitFinal({ vendorId: v.vendorId, amount: v.amount, invoice: v.invoice, date: v.date, depositBillId: v.depositBillId })} />
      )}
    </div>
  );
}

// ── Closed purchase order: the vendor's bill ─────────────────────────────────
export function PoBillsSection({ po, onChanged }: { po: PurchaseOrderRow; onChanged: () => void }) {
  const toast = useToast();
  const [bills, setBills] = useState<RunBill[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invoice, setInvoice] = useState(''); const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); const [override, setOverride] = useState('');
  const reload = useCallback(() => { fetchPoBills(po.id).then(setBills).catch(() => setBills([])); }, [po.id]);
  useEffect(() => { reload(); }, [reload, po.status]);

  const liveBill = (bills ?? []).find((b) => b.bill_state !== 'archived');
  const canCreate = po.status === 'closed' && !liveBill;
  if (po.status !== 'closed' && (bills ?? []).length === 0) return null;

  async function create() {
    setBusy(true);
    try {
      const r = await createPoBill(po.id, invoice.trim() || null, date || null, override.trim() ? Number(override) : null);
      toast.success(`Bill created · ${money(r.total)} · ${r.lines} line${r.lines === 1 ? '' : 's'} — post it from Brixpense and attach the vendor's PDF there`);
      setOpen(false); reload(); onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 12, marginBottom: 8 }} data-testid="po-bills">
      <div style={{ ...sectionLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span><Receipt size={11} style={{ verticalAlign: -1, marginRight: 4 }} /> Vendor bill</span>
        {canCreate && !open && <button style={btnPrimary()} disabled={busy} onClick={() => setOpen(true)}>Create bill…</button>}
      </div>
      {liveBill || (bills ?? []).length > 0
        ? <BillsTable bills={bills ?? []} />
        : !open && <div style={{ fontSize: 11, color: 'var(--mt)' }}>The PO is closed — create the vendor's bill from its lines (services included: billed though never received), then post it from Brixpense and attach the invoice PDF there.</div>}
      {open && (
        <div className="cd" style={{ padding: 12, marginTop: 8, border: '1px solid var(--ac)' }}>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 10 }}>
            Lines come from the purchase order at the ordered quantity and price ({money(po.subtotal)}). If the vendor's invoice total differs, type it — the difference lands as one "Invoice variance vs PO" line so the bill matches the paper. Nothing is posted to QuickBooks from here.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <LField label="Vendor invoice #"><input style={inp()} value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="on the vendor's invoice" /></LField>
            <LField label="Invoice date"><input type="date" style={inp()} value={date} onChange={(e) => setDate(e.target.value)} /></LField>
            <LField label="Invoice total (blank = PO subtotal)"><input type="number" min={0} step="0.01" style={inp()} value={override} onChange={(e) => setOverride(e.target.value)} placeholder={fmtNum(po.subtotal, 2)} /></LField>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button style={btnSecondary()} onClick={() => setOpen(false)}>Cancel</button>
            <button style={btnPrimary()} disabled={busy} onClick={() => void create()}><Receipt size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Create the bill</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── the one form for deposit + final ─────────────────────────────────────────
function BillDialog({ title, verb, note, busy, vendors, defaultVendorId, deposits, onCancel, onSubmit }: {
  title: string; verb: string; note: string; busy: boolean; vendors: QboVendor[]; defaultVendorId: string;
  deposits?: RunBill[];
  onCancel: () => void;
  onSubmit: (v: { vendorId: string; amount: number; invoice: string | null; date: string | null; memo: string | null; depositBillId: string | null }) => void;
}) {
  const [vendorId, setVendorId] = useState(defaultVendorId);
  const [amount, setAmount] = useState(''); const [invoice, setInvoice] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); const [memo, setMemo] = useState('');
  const vendorDeposits = (deposits ?? []).filter((d) => d.qbo_vendor_id === vendorId);
  const [depositId, setDepositId] = useState<string>(vendorDeposits[0]?.id ?? '');
  const dep = vendorDeposits.find((d) => d.id === depositId) ?? null;
  const gross = Number(amount);
  const ok = !!vendorId && gross > 0;
  const belowDeposit = dep && dep.paid_at && gross > 0 && gross < Number(dep.amount_gross);
  return (
    <div className="cd" style={{ padding: 12, marginTop: 8, border: '1px solid var(--ac)' }} data-testid="bill-dialog">
      <div style={{ fontSize: 10.5, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 10 }}>{note}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <LField label="Vendor">
          <select style={inp()} value={vendorId} onChange={(e) => { setVendorId(e.target.value); setDepositId(''); }}>
            {vendors.map((v) => <option key={v.qbo_vendor_id} value={v.qbo_vendor_id}>{v.display_name}</option>)}
          </select>
        </LField>
        <LField label="Invoice total"><input type="number" min={0} step="0.01" style={inp()} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Invoice total" /></LField>
        <LField label="Vendor invoice #"><input style={inp()} value={invoice} onChange={(e) => setInvoice(e.target.value)} /></LField>
        <LField label="Invoice date"><input type="date" style={inp()} value={date} onChange={(e) => setDate(e.target.value)} /></LField>
        {deposits ? (
          <LField label="Against deposit">
            <select style={inp()} value={depositId} onChange={(e) => setDepositId(e.target.value)}>
              <option value="">No deposit — new bill</option>
              {vendorDeposits.map((d) => <option key={d.id} value={d.id}>{d.vendor_invoice_number ?? '(no number)'} · {money(d.amount_gross)}{d.paid_at ? ' · paid' : d.qbo_bill_id ? ' · in QuickBooks' : ' · not posted yet'}</option>)}
            </select>
          </LField>
        ) : (
          <LField label="Memo"><input style={inp()} value={memo} onChange={(e) => setMemo(e.target.value)} /></LField>
        )}
      </div>
      {dep && gross > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: belowDeposit ? 'var(--rd)' : 'var(--tx)' }}>
          {belowDeposit
            ? `The final total is below the deposit already paid (${money(dep.amount_gross)}) — that is refused; check the invoice.`
            : `Balance due after the deposit: ${money(gross - Number(dep.amount_gross))}. ${dep.qbo_bill_id ? `QuickBooks bill ${dep.qbo_bill_id} is updated to ${money(gross)} when you press Update in QuickBooks in Brixpense.` : 'The deposit was never posted, so one bill at the final total posts from Brixpense.'}`}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
        <button style={btnSecondary()} onClick={onCancel}>Cancel</button>
        <button style={btnPrimary()} disabled={busy || !ok || !!belowDeposit} onClick={() => onSubmit({ vendorId, amount: gross, invoice: invoice.trim() || null, date: date || null, memo: memo.trim() || null, depositBillId: depositId || null })}>
          <Receipt size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> {verb}
        </button>
      </div>
    </div>
  );
}
