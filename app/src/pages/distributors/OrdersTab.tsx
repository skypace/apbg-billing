import { useEffect, useMemo, useState } from 'react';
import { SearchSelect } from '../../components/SearchSelect';
import { ChevronDown, ChevronRight, Truck } from 'lucide-react';
import {
  InventoryLocation,
  InventoryTransfer,
  fetchTransfers,
} from '../../lib/inventoryControl';
import {
  DistributorOrderStatus,
  SubDistributor,
  SubDistributorOrder,
  SubDistributorOrderLine,
  fetchAllOrderLines,
  fetchDistributorOrders,
  fulfillDistributorOrder,
} from '../../lib/subDistributors';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import { Chip, errMsg, LField, Modal, Td, Th } from './common';

const ORDER_STATUS_COLOR: Record<DistributorOrderStatus, string> = {
  submitted: 'var(--am)',
  fulfilled: 'var(--gn)',
  cancelled: 'var(--mt)',
};

interface Props {
  dist: SubDistributor;
  locations: InventoryLocation[];
  itemNameById: Map<string, string>;
}

export function DistributorOrdersTab({ dist, locations, itemNameById }: Props) {
  const toast = useToast();
  const [orders, setOrders] = useState<SubDistributorOrder[] | null>(null);
  const [lines, setLines] = useState<SubDistributorOrderLine[] | null>(null);
  const [transfers, setTransfers] = useState<InventoryTransfer[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [fulfilling, setFulfilling] = useState<SubDistributorOrder | null>(null);

  function reload() {
    setOrders(null);
    setLines(null);
    fetchDistributorOrders(dist.id).then(setOrders).catch((e) => { setOrders([]); toast.error(errMsg(e)); });
    fetchAllOrderLines(dist.id).then(setLines).catch(() => setLines([]));
    fetchTransfers(300).then(setTransfers).catch(() => setTransfers([]));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [dist.id]);

  const linesByOrder = useMemo(() => {
    const m = new Map<string, SubDistributorOrderLine[]>();
    for (const l of lines ?? []) {
      const arr = m.get(l.order_id);
      if (arr) arr.push(l); else m.set(l.order_id, [l]);
    }
    return m;
  }, [lines]);

  const transferById = useMemo(() => {
    const m = new Map<string, InventoryTransfer>();
    for (const t of transfers ?? []) m.set(t.id, t);
    return m;
  }, [transfers]);

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--mt)', fontSize: 11 }}>
            {orders === null ? 'Loading…'
              : `${orders.length} order${orders.length === 1 ? '' : 's'} · ${orders.filter((o) => o.status === 'submitted').length} awaiting fulfillment`}
          </span>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <span style={{ color: 'var(--mt)', fontSize: 10 }}>
            Orders are placed by the partner in their portal.
          </span>
        </div>
      </div>

      <div className="cd" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th style={{ width: 26 }}> </Th>
              <Th>Order #</Th>
              <Th>Status</Th>
              <Th>Submitted by</Th>
              <Th>Requested</Th>
              <Th>Lines</Th>
              <Th>BOL</Th>
              <Th>Submitted</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {orders !== null && orders.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>
                No orders yet.
              </td></tr>
            )}
            {(orders ?? []).map((o) => {
              const orderLines = linesByOrder.get(o.id) ?? [];
              const transfer = o.transfer_id ? transferById.get(o.transfer_id) : undefined;
              const open = openId === o.id;
              return (
                <OrderRows
                  key={o.id}
                  order={o}
                  lines={orderLines}
                  linesLoading={lines === null}
                  transfer={transfer ?? null}
                  open={open}
                  itemNameById={itemNameById}
                  onToggle={() => setOpenId(open ? null : o.id)}
                  onFulfill={() => setFulfilling(o)}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {fulfilling && (
        <FulfillDialog
          dist={dist}
          order={fulfilling}
          locations={locations}
          onClose={() => setFulfilling(null)}
          onDone={() => { setFulfilling(null); reload(); }}
        />
      )}
    </div>
  );
}

function OrderRows({ order, lines, linesLoading, transfer, open, itemNameById, onToggle, onFulfill }: {
  order: SubDistributorOrder;
  lines: SubDistributorOrderLine[];
  linesLoading: boolean;
  transfer: { bol_number: string; status: string } | null;
  open: boolean;
  itemNameById: Map<string, string>;
  onToggle: () => void;
  onFulfill: () => void;
}) {
  return (
    <>
      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <Td>
          <button onClick={onToggle} aria-label={open ? 'Collapse' : 'Expand'} style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)', padding: 2,
          }}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        </Td>
        <Td>
          <button onClick={onToggle} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600, padding: 0, fontSize: 12,
          }}>{order.order_number}</button>
        </Td>
        <Td><Chip label={order.status} color={ORDER_STATUS_COLOR[order.status] ?? 'var(--mt)'} /></Td>
        <Td><span style={{ color: 'var(--mt)', fontSize: 11 }}>{order.submitted_by_email ?? '—'}</span></Td>
        <Td>{order.requested_date ?? '—'}</Td>
        <Td>{linesLoading ? '…' : lines.length}</Td>
        <Td>
          {transfer ? (
            <span>
              <code style={{ fontFamily: 'var(--ff-mono)', color: 'var(--ac)', fontSize: 11 }}>{transfer.bol_number}</code>
              <span style={{ marginLeft: 5, fontSize: 9.5, color: 'var(--mt)', textTransform: 'uppercase' }}>
                {transfer.status.replace('_', ' ')}
              </span>
            </span>
          ) : order.transfer_id ? <span style={{ color: 'var(--mt)' }}>linked</span> : '—'}
        </Td>
        <Td><span style={{ color: 'var(--mt)', fontSize: 11 }}>
          {new Date(order.submitted_at).toLocaleString()}
        </span></Td>
        <Td>
          {order.status === 'submitted' && (
            <button onClick={onFulfill} style={btnPrimary()}>
              <Truck size={11} style={{ marginRight: 4, verticalAlign: -1 }} /> Fulfill → create BOL
            </button>
          )}
        </Td>
      </tr>
      {open && (
        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <td colSpan={9} style={{ padding: '4px 14px 12px 40px', background: 'rgba(91,181,240,0.03)' }}>
            {order.notes && (
              <div style={{ fontSize: 11, color: 'var(--mt)', margin: '6px 0' }}>
                Notes: {order.notes}
              </div>
            )}
            {order.decision_notes && (
              <div style={{ fontSize: 11, color: 'var(--mt)', margin: '6px 0' }}>
                Decision: {order.decision_notes}
                {order.decided_at ? ` · ${new Date(order.decided_at).toLocaleString()}` : ''}
              </div>
            )}
            <table style={{ borderCollapse: 'collapse', fontSize: 11.5, minWidth: 420 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                  <Th>Item</Th>
                  <Th style={{ textAlign: 'right' }}>Qty</Th>
                  <Th style={{ textAlign: 'right' }}>Unit price</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: 10, color: 'var(--mt)' }}>
                    {linesLoading ? 'Loading…' : 'No lines'}
                  </td></tr>
                )}
                {lines.map((l) => (
                  <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <Td>{itemNameById.get(l.qbo_item_id) ?? l.qbo_item_id}</Td>
                    <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(l.qty)}</Td>
                    <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                      {l.unit_price == null ? '—' : `$${Number(l.unit_price).toFixed(2)}`}
                    </Td>
                    <Td><span style={{ color: 'var(--mt)' }}>{l.notes ?? '—'}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Fulfill dialog ────────────────────────────────────────────────────────

function FulfillDialog({ dist, order, locations, onClose, onDone }: {
  dist: SubDistributor;
  order: SubDistributorOrder;
  locations: InventoryLocation[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const warehouses = locations.filter((l) => l.kind === 'warehouse' && l.is_active);
  const [from, setFrom] = useState(warehouses.length === 1 ? warehouses[0].id : '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [createdTransferId, setCreatedTransferId] = useState<string | null>(null);

  async function run() {
    if (!from) return;
    setBusy(true);
    try {
      const transferId = await fulfillDistributorOrder(order.id, from, notes.trim() || null);
      setCreatedTransferId(transferId);
      toast.success(`${order.order_number} fulfilled — draft BOL created`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Fulfill ${order.order_number}`} onClose={createdTransferId ? onDone : onClose} maxWidth={520}>
      {createdTransferId ? (
        <div>
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            Draft BOL transfer created to <strong>{dist.name}</strong>.
          </div>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 4 }}>Transfer id</div>
          <code style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, color: 'var(--ac)' }}>{createdTransferId}</code>
          <div style={{
            marginTop: 12, padding: 10, fontSize: 11, color: 'var(--mt)',
            border: '1px solid var(--bd)', borderRadius: 4, background: 'rgba(91,181,240,0.04)',
          }}>
            Ship it from <strong>Inventory → Transfers</strong> — print the BOL, then Mark Shipped when it leaves the dock.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <button onClick={onDone} style={btnPrimary()}>Done</button>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--mt)', marginBottom: 12 }}>
            Creates a draft BOL transfer from the chosen warehouse to {dist.name}'s location and marks
            the order fulfilled.
          </div>
          <LField label="Ship from (warehouse)">
            <SearchSelect style={{ width: '100%' }} value={from} onChange={setFrom} placeholder="Type a warehouse…"
              options={warehouses.map((l) => ({ id: l.id, label: `${l.code} — ${l.name}` }))} />
          </LField>
          <div style={{ marginTop: 10 }}>
            <LField label="Notes (optional)">
              <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 40 }}
                value={notes} onChange={(e) => setNotes(e.target.value)} />
            </LField>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button onClick={onClose} style={btnSecondary()}>Cancel</button>
            <button onClick={run} disabled={!from || busy} style={btnPrimary()}>
              {busy ? 'Creating…' : 'Fulfill → create BOL'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
