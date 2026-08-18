import { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useDistributor } from '@/lib/distributor';
import { useLoad } from '@/lib/hooks';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Spinner, ErrorNote, EmptyNote, InvoiceStatusChip } from '@/components/ui';
import type { QboInvoice } from '@/lib/types';

type Filter = 'all' | 'open' | 'paid';

function isOpen(inv: QboInvoice): boolean {
  return inv.balance !== null && Number(inv.balance) > 0;
}

export default function Billing() {
  const { distributor } = useDistributor();
  const qboId = distributor?.qbo_customer_id ?? null;
  const [filter, setFilter] = useState<Filter>('all');

  const { data, loading, error } = useLoad<QboInvoice[]>(async () => {
    if (!qboId) return [];
    // RLS scopes ops.qbo_invoices to our own QBO customer already.
    const { data: rows, error: err } = await supabase
      .from('qbo_invoices')
      .select(
        'qbo_invoice_id, doc_number, txn_date, due_date, customer_name, total_amount, balance, status, txn_type'
      )
      .order('txn_date', { ascending: false })
      .limit(500);
    if (err) throw new Error(err.message);
    return (rows ?? []) as QboInvoice[];
  }, [qboId]);

  const invoices = useMemo(() => data ?? [], [data]);
  const filtered = useMemo(() => {
    if (filter === 'open') return invoices.filter(isOpen);
    if (filter === 'paid') return invoices.filter((i) => !isOpen(i));
    return invoices;
  }, [invoices, filter]);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;

  const noBilling = !qboId || invoices.length === 0;
  const totalAmount = filtered.reduce((s, i) => s + Number(i.total_amount ?? 0), 0);
  const totalBalance = filtered.reduce((s, i) => s + Number(i.balance ?? 0), 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Billing</h1>
          <p>Invoices from Brix Beverage on your account.</p>
        </div>
      </div>

      {noBilling ? (
        <div className="glass-card">
          <EmptyNote>
            No invoices yet — billing is handled by Brix Beverage. Reach out to
            your rep with any billing questions.
          </EmptyNote>
        </div>
      ) : (
        <div className="glass-card">
          <div className="pill-row">
            {(['all', 'open', 'paid'] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`pill${filter === f ? ' active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Paid'}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <EmptyNote>No {filter === 'all' ? '' : filter + ' '}invoices.</EmptyNote>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Doc #</th>
                    <th>Type</th>
                    <th>Date</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th className="r">Total</th>
                    <th className="r">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((inv) => (
                    <tr key={inv.qbo_invoice_id}>
                      <td style={{ fontWeight: 700 }}>{inv.doc_number ?? inv.qbo_invoice_id}</td>
                      <td style={{ color: 'var(--tx2)' }}>{inv.txn_type ?? 'Invoice'}</td>
                      <td>{fmtDate(inv.txn_date)}</td>
                      <td>{fmtDate(inv.due_date)}</td>
                      <td><InvoiceStatusChip status={inv.status} balance={inv.balance} /></td>
                      <td className="r">{fmtMoney(inv.total_amount)}</td>
                      <td className="r">{fmtMoney(inv.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>
                      Totals ({filtered.length} invoice{filtered.length === 1 ? '' : 's'})
                    </td>
                    <td className="r">{fmtMoney(totalAmount)}</td>
                    <td className="r">{fmtMoney(totalBalance)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
