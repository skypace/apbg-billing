import { useState } from 'react';
import { Plus, Loader2, Send, XCircle, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useDistributor } from '@/lib/distributor';
import { useLoad, useItemNames } from '@/lib/hooks';
import { fmtDate, fmtMoney, fmtQty } from '@/lib/format';
import { Spinner, ErrorNote, EmptyNote, OrderStatusChip } from '@/components/ui';
import { ItemSearch } from '@/components/ItemSearch';
import type { CatalogItem, DistributorOrder, DistributorOrderLine } from '@/lib/types';

interface DraftLine {
  qbo_item_id: string;
  name: string;
  qty: number;
  notes: string;
}

interface OrdersData {
  orders: DistributorOrder[];
  linesByOrder: Map<string, DistributorOrderLine[]>;
}

export default function Orders() {
  const { distributor } = useDistributor();
  const distId = distributor?.id ?? null;

  const { data, loading, error, reload } = useLoad<OrdersData>(async () => {
    if (!distId) return { orders: [], linesByOrder: new Map() };
    const or = await supabase
      .from('sub_distributor_orders')
      .select(
        'id, sub_distributor_id, order_number, status, requested_date, notes, submitted_by_email, submitted_at, decided_at, decision_notes, transfer_id, created_at'
      )
      .eq('sub_distributor_id', distId)
      .order('submitted_at', { ascending: false })
      .limit(200);
    if (or.error) throw new Error(or.error.message);
    const orders = (or.data ?? []) as DistributorOrder[];

    const linesByOrder = new Map<string, DistributorOrderLine[]>();
    if (orders.length) {
      const ids = orders.map((o) => o.id);
      for (let i = 0; i < ids.length; i += 100) {
        const ln = await supabase
          .from('sub_distributor_order_lines')
          .select('id, order_id, qbo_item_id, qty, unit_price, notes')
          .in('order_id', ids.slice(i, i + 100));
        if (ln.error) throw new Error(ln.error.message);
        for (const row of (ln.data ?? []) as DistributorOrderLine[]) {
          const arr = linesByOrder.get(row.order_id) ?? [];
          arr.push(row);
          linesByOrder.set(row.order_id, arr);
        }
      }
    }
    return { orders, linesByOrder };
  }, [distId]);

  const allLineItemIds = Array.from(data?.linesByOrder.values() ?? [])
    .flat()
    .map((l) => l.qbo_item_id);
  const itemName = useItemNames(allLineItemIds);

  // ── New-order builder ──
  const [showNew, setShowNew] = useState(false);
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [requestedDate, setRequestedDate] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function addItem(it: CatalogItem) {
    setDraftLines((ls) => {
      if (ls.some((l) => l.qbo_item_id === it.qbo_item_id)) {
        return ls.map((l) =>
          l.qbo_item_id === it.qbo_item_id ? { ...l, qty: l.qty + 1 } : l
        );
      }
      return [...ls, { qbo_item_id: it.qbo_item_id, name: it.name, qty: 1, notes: '' }];
    });
  }

  function setQty(id: string, qty: number) {
    setDraftLines((ls) => ls.map((l) => (l.qbo_item_id === id ? { ...l, qty } : l)));
  }

  async function submitOrder() {
    if (!distId || draftLines.length === 0) return;
    if (draftLines.some((l) => !(l.qty > 0))) {
      setSubmitError('Every line needs a quantity greater than zero.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const { error: err } = await supabase.rpc('fn_distributor_create_order', {
      p_sub_distributor_id: distId,
      p_lines: draftLines.map((l) => ({
        qbo_item_id: l.qbo_item_id,
        qty: l.qty,
        ...(l.notes.trim() ? { notes: l.notes.trim() } : {}),
      })),
      p_requested_date: requestedDate || null,
      p_notes: orderNotes.trim() || null,
    });
    setSubmitting(false);
    if (err) {
      setSubmitError(err.message);
      return;
    }
    setDraftLines([]);
    setRequestedDate('');
    setOrderNotes('');
    setShowNew(false);
    reload();
  }

  async function cancelOrder(o: DistributorOrder) {
    if (!window.confirm(`Cancel order ${o.order_number}?`)) return;
    const reason = window.prompt('Reason (optional):') ?? null;
    setCancelling(o.id);
    setActionError(null);
    const { error: err } = await supabase.rpc('fn_distributor_cancel_order', {
      p_order_id: o.id,
      p_reason: reason && reason.trim() ? reason.trim() : null,
    });
    setCancelling(null);
    if (err) {
      setActionError(err.message);
      return;
    }
    reload();
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;

  const orders = data?.orders ?? [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Orders</h1>
          <p>
            Request restock from Brix Beverage. Submitted orders are fulfilled
            as BOL shipments to your warehouse.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setShowNew((s) => !s)}>
          <Plus size={16} /> New order
        </button>
      </div>

      {showNew && (
        <div className="glass-card">
          <h3 style={{ marginBottom: 12 }}>New restock order</h3>
          <label className="fld">Add items</label>
          <ItemSearch onPick={addItem} />

          {draftLines.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {draftLines.map((l) => (
                <div key={l.qbo_item_id} className="line-row">
                  <span className="line-name">{l.name}</span>
                  <span className="qty-stepper">
                    <button type="button" onClick={() => setQty(l.qbo_item_id, Math.max(1, l.qty - 1))} aria-label="Decrease">−</button>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={l.qty}
                      onChange={(e) => setQty(l.qbo_item_id, Math.max(0, Number(e.target.value)))}
                      aria-label={`Quantity for ${l.name}`}
                    />
                    <button type="button" onClick={() => setQty(l.qbo_item_id, l.qty + 1)} aria-label="Increase">+</button>
                  </span>
                  <input
                    type="text"
                    className="compact"
                    placeholder="Line note (optional)"
                    value={l.notes}
                    onChange={(e) =>
                      setDraftLines((ls) =>
                        ls.map((x) =>
                          x.qbo_item_id === l.qbo_item_id ? { ...x, notes: e.target.value } : x
                        )
                      )
                    }
                    style={{ flex: '1 1 160px' }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setDraftLines((ls) => ls.filter((x) => x.qbo_item_id !== l.qbo_item_id))
                    }
                    aria-label={`Remove ${l.name}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="form-grid" style={{ marginTop: 16 }}>
            <div className="field-col">
              <label className="fld" htmlFor="req-date">Requested date (optional)</label>
              <input
                id="req-date"
                type="date"
                value={requestedDate}
                onChange={(e) => setRequestedDate(e.target.value)}
              />
            </div>
            <div className="field-col full">
              <label className="fld" htmlFor="order-notes">Order notes (optional)</label>
              <textarea
                id="order-notes"
                rows={2}
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                placeholder="Anything the Brix warehouse should know…"
              />
            </div>
          </div>

          {submitError && <div className="err-note">{submitError}</div>}

          <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting || draftLines.length === 0}
              onClick={submitOrder}
            >
              {submitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
              Submit order
            </button>
            <button type="button" className="btn btn-outline" onClick={() => setShowNew(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {actionError && <div className="err-note">{actionError}</div>}

      {orders.length === 0 ? (
        <div className="glass-card">
          <EmptyNote>No orders yet — start with &ldquo;New order&rdquo; above.</EmptyNote>
        </div>
      ) : (
        orders.map((o) => {
          const lines = data?.linesByOrder.get(o.id) ?? [];
          const showPrice = lines.some((l) => l.unit_price !== null && l.unit_price !== undefined);
          return (
            <div key={o.id} className="glass-card">
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  flexWrap: 'wrap', marginBottom: 10,
                }}
              >
                <h3 className="mt-0">{o.order_number}</h3>
                <OrderStatusChip status={o.status} />
                <span style={{ fontSize: 13, color: 'var(--mt)' }}>
                  Submitted {fmtDate(o.submitted_at.slice(0, 10))}
                  {o.submitted_by_email ? ` · ${o.submitted_by_email}` : ''}
                </span>
                {o.status === 'submitted' && (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ marginLeft: 'auto' }}
                    disabled={cancelling === o.id}
                    onClick={() => cancelOrder(o)}
                  >
                    {cancelling === o.id ? <Loader2 size={14} className="spin" /> : <XCircle size={14} />}
                    Cancel order
                  </button>
                )}
              </div>
              <div className="def-grid" style={{ marginBottom: 12 }}>
                <div>
                  <span className="def-label">Requested date</span>
                  <span className="def-value">{fmtDate(o.requested_date)}</span>
                </div>
                {o.notes && (
                  <div>
                    <span className="def-label">Notes</span>
                    <span className="def-value" style={{ fontWeight: 500 }}>{o.notes}</span>
                  </div>
                )}
                {o.decision_notes && (
                  <div>
                    <span className="def-label">Brix notes</span>
                    <span className="def-value" style={{ fontWeight: 500 }}>{o.decision_notes}</span>
                  </div>
                )}
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="r">Qty</th>
                      {showPrice && <th className="r">Unit price</th>}
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id}>
                        <td>{itemName(l.qbo_item_id)}</td>
                        <td className="r">{fmtQty(l.qty)}</td>
                        {showPrice && (
                          <td className="r">
                            {l.unit_price === null || l.unit_price === undefined ? '—' : fmtMoney(l.unit_price)}
                          </td>
                        )}
                        <td style={{ color: 'var(--tx2)' }}>{l.notes ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
