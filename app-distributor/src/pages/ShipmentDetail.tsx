import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Printer, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useDistributor } from '@/lib/distributor';
import { useLoad, useItemNames } from '@/lib/hooks';
import { fmtDate, fmtQty, todayISO } from '@/lib/format';
import { printBol } from '@/lib/bol';
import { Spinner, ErrorNote, TransferStatusChip, Chip, AmberCallout } from '@/components/ui';
import type { InventoryLocation, InventoryTransfer, InventoryTransferLine } from '@/lib/types';
import { TRANSFER_COLS } from './Shipments';

const LOCATION_COLS =
  'id, code, name, kind, address_line1, address_line2, city, state, postal_code, contact_name, contact_phone';

interface DetailData {
  transfer: InventoryTransfer;
  lines: InventoryTransferLine[];
  fromLoc: InventoryLocation | null;
  toLoc: InventoryLocation | null;
}

export default function ShipmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { distributor } = useDistributor();
  const myLocId = distributor?.inventory_location_id ?? null;

  const { data, loading, error, reload } = useLoad<DetailData | null>(async () => {
    if (!id) return null;
    const tr = await supabase
      .from('inventory_transfers')
      .select(TRANSFER_COLS)
      .eq('id', id)
      .maybeSingle();
    if (tr.error) throw new Error(tr.error.message);
    if (!tr.data) return null;
    const transfer = tr.data as InventoryTransfer;

    // ⚠ unit_cost deliberately NOT selected — never shown in this portal.
    const ln = await supabase
      .from('inventory_transfer_lines')
      .select('id, transfer_id, qbo_item_id, qty, qty_received, notes')
      .eq('transfer_id', id)
      .order('created_at', { ascending: true });
    // Some deployments lack created_at on lines — fall back unordered.
    let lines: InventoryTransferLine[];
    if (ln.error) {
      const ln2 = await supabase
        .from('inventory_transfer_lines')
        .select('id, transfer_id, qbo_item_id, qty, qty_received, notes')
        .eq('transfer_id', id);
      if (ln2.error) throw new Error(ln2.error.message);
      lines = (ln2.data ?? []) as InventoryTransferLine[];
    } else {
      lines = (ln.data ?? []) as InventoryTransferLine[];
    }

    const locIds = [transfer.from_location_id, transfer.to_location_id].filter(
      (x): x is string => Boolean(x)
    );
    let fromLoc: InventoryLocation | null = null;
    let toLoc: InventoryLocation | null = null;
    if (locIds.length) {
      const lc = await supabase
        .from('inventory_locations')
        .select(LOCATION_COLS)
        .in('id', locIds);
      if (!lc.error) {
        const locs = (lc.data ?? []) as InventoryLocation[];
        fromLoc = locs.find((l) => l.id === transfer.from_location_id) ?? null;
        toLoc = locs.find((l) => l.id === transfer.to_location_id) ?? null;
      }
    }

    return { transfer, lines, fromLoc, toLoc };
  }, [id]);

  const itemName = useItemNames((data?.lines ?? []).map((l) => l.qbo_item_id));

  // ── Receive panel state ──
  const [received, setReceived] = useState<Record<string, string>>({});
  const [receiverName, setReceiverName] = useState('');
  const [receiverNotes, setReceiverNotes] = useState('');
  const [receivedDate, setReceivedDate] = useState(todayISO());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justReceived, setJustReceived] = useState(false);

  const canReceive = useMemo(() => {
    if (!data?.transfer) return false;
    return (
      data.transfer.status === 'in_transit' &&
      !!myLocId &&
      data.transfer.to_location_id === myLocId
    );
  }, [data, myLocId]);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;
  if (!data) {
    return (
      <div className="glass-card">
        <p className="empty-note">Shipment not found (or not visible to your account).</p>
        <button type="button" className="btn btn-outline" onClick={() => navigate('/shipments')}>
          <ArrowLeft size={16} /> Back to shipments
        </button>
      </div>
    );
  }

  const { transfer: t, lines, fromLoc, toLoc } = data;

  function recvValue(line: InventoryTransferLine): number {
    const raw = received[line.id];
    if (raw === undefined || raw === '') return Number(line.qty);
    const n = Number(raw);
    return Number.isNaN(n) ? Number(line.qty) : n;
  }

  const anyShort = lines.some((l) => recvValue(l) !== Number(l.qty));
  const invalid = lines.some((l) => {
    const v = recvValue(l);
    return v < 0 || v > Number(l.qty);
  });

  async function submitReceive() {
    if (!id) return;
    if (!receiverName.trim()) {
      setSubmitError('Type your full name as the receiving signature first.');
      return;
    }
    if (invalid) {
      setSubmitError('Received quantities must be between 0 and the shipped quantity.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const payloadLines = lines.map((l) => ({ line_id: l.id, qty_received: recvValue(l) }));
    const { error: err } = await supabase.rpc('fn_distributor_receive_transfer', {
      p_transfer_id: id,
      p_received_date: receivedDate || todayISO(),
      p_receiver_signature_name: receiverName.trim(),
      p_lines: payloadLines,
      p_receiver_notes: receiverNotes.trim() || null,
    });
    setSubmitting(false);
    if (err) {
      setSubmitError(err.message);
      return;
    }
    setJustReceived(true);
    reload();
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigate('/shipments')}
            style={{ marginBottom: 10, paddingLeft: 0 }}
          >
            <ArrowLeft size={15} /> All shipments
          </button>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            BOL {t.bol_number ?? t.id.slice(0, 8)}
            <TransferStatusChip status={t.status} />
            {t.has_discrepancy && (
              <Chip tone="warning">
                <AlertTriangle size={12} /> Discrepancy
              </Chip>
            )}
          </h1>
        </div>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => printBol({ transfer: t, lines, fromLoc, toLoc, itemName })}
        >
          <Printer size={16} /> Print BOL
        </button>
      </div>

      {justReceived && (
        <div className="callout callout-info" style={{ margin: 0 }}>
          <CheckCircle2 size={18} />
          <div>
            <strong>Shipment received.</strong> Your on-hand inventory has been updated.
          </div>
        </div>
      )}

      <div className="glass-card">
        <h3 style={{ marginBottom: 14 }}>Bill of lading</h3>
        <div className="def-grid">
          <div><span className="def-label">Ship date</span><span className="def-value">{fmtDate(t.ship_date)}</span></div>
          <div><span className="def-label">Received date</span><span className="def-value">{fmtDate(t.received_date)}</span></div>
          <div><span className="def-label">Carrier</span><span className="def-value">{t.carrier ?? '—'}</span></div>
          <div><span className="def-label">Tracking #</span><span className="def-value">{t.tracking_number ?? '—'}</span></div>
          <div><span className="def-label">PRO #</span><span className="def-value">{t.pro_number ?? '—'}</span></div>
          <div><span className="def-label">Freight terms</span><span className="def-value">{t.freight_terms ?? '—'}</span></div>
          <div><span className="def-label">Weight (lbs)</span><span className="def-value">{t.total_weight_lbs ?? '—'}</span></div>
          <div><span className="def-label">Pallets</span><span className="def-value">{t.total_pallets ?? '—'}</span></div>
          <div><span className="def-label">Ship from</span><span className="def-value">{fromLoc?.name ?? '—'}</span></div>
          <div><span className="def-label">Ship to</span><span className="def-value">{toLoc?.name ?? '—'}</span></div>
          {t.shipper_signature_name && (
            <div><span className="def-label">Shipper signature</span><span className="def-value">{t.shipper_signature_name}</span></div>
          )}
          {t.receiver_signature_name && (
            <div><span className="def-label">Receiver signature</span><span className="def-value">{t.receiver_signature_name}</span></div>
          )}
        </div>
        {t.special_instructions && (
          <div className="callout callout-info">
            <div><strong>Special instructions:</strong> {t.special_instructions}</div>
          </div>
        )}
        {t.receiver_notes && (
          <div className="callout callout-info">
            <div><strong>Receiver notes:</strong> {t.receiver_notes}</div>
          </div>
        )}
      </div>

      <div className="glass-card">
        <h3 style={{ marginBottom: 12 }}>Items</h3>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">Qty shipped</th>
                <th className="r">Qty received</th>
                {canReceive && <th className="r">Receiving now</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const rv = recvValue(l);
                const short = canReceive && rv !== Number(l.qty);
                return (
                  <tr key={l.id}>
                    <td>
                      {itemName(l.qbo_item_id)}
                      {l.notes && <div style={{ fontSize: 12, color: 'var(--mt)' }}>{l.notes}</div>}
                    </td>
                    <td className="r">{fmtQty(l.qty)}</td>
                    <td className="r">
                      {l.qty_received === null || l.qty_received === undefined ? '—' : fmtQty(l.qty_received)}
                    </td>
                    {canReceive && (
                      <td className="r">
                        <input
                          type="number"
                          className="compact"
                          min={0}
                          max={Number(l.qty)}
                          step="any"
                          value={received[l.id] ?? String(l.qty)}
                          onChange={(e) =>
                            setReceived((m) => ({ ...m, [l.id]: e.target.value }))
                          }
                          style={{
                            width: 96,
                            textAlign: 'right',
                            borderColor: short ? 'var(--warning)' : undefined,
                          }}
                          aria-label={`Received quantity for ${itemName(l.qbo_item_id)}`}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {canReceive && (
        <div className="glass-card">
          <h3 style={{ marginBottom: 6 }}>Receive this shipment</h3>
          <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--tx2)' }}>
            Count what actually arrived, adjust any line that differs, and sign
            with your typed name to confirm receipt.
          </p>

          {anyShort && (
            <AmberCallout>
              <strong>One or more lines differ from the BOL.</strong> That&rsquo;s
              fine — record what you actually counted. Shortages are flagged to
              Brix Beverage automatically and resolved on our side.
            </AmberCallout>
          )}

          <div className="form-grid" style={{ marginTop: 12 }}>
            <div className="field-col">
              <label className="fld" htmlFor="recv-date">Received date</label>
              <input
                id="recv-date"
                type="date"
                value={receivedDate}
                onChange={(e) => setReceivedDate(e.target.value)}
              />
            </div>
            <div className="field-col">
              <label className="fld" htmlFor="recv-name">
                Receiver signature (type your full name) *
              </label>
              <input
                id="recv-name"
                type="text"
                placeholder="Full name"
                value={receiverName}
                onChange={(e) => setReceiverName(e.target.value)}
              />
            </div>
            <div className="field-col full">
              <label className="fld" htmlFor="recv-notes">Notes (optional)</label>
              <textarea
                id="recv-notes"
                rows={2}
                placeholder="Damage, shortages, anything worth noting…"
                value={receiverNotes}
                onChange={(e) => setReceiverNotes(e.target.value)}
              />
            </div>
          </div>

          {submitError && <div className="err-note">{submitError}</div>}

          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn-green"
              disabled={submitting || !receiverName.trim() || invalid}
              onClick={submitReceive}
            >
              {submitting ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />}
              Confirm receipt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
