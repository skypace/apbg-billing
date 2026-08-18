import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useDistributor } from '@/lib/distributor';
import { useLoad } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Spinner, ErrorNote, EmptyNote, TransferStatusChip, Chip } from '@/components/ui';
import type { InventoryTransfer } from '@/lib/types';

const TRANSFER_COLS =
  'id, bol_number, from_location_id, to_location_id, status, carrier, tracking_number, pro_number, freight_terms, ship_date, received_date, total_weight_lbs, total_pallets, declared_value_usd, special_instructions, shipper_signature_name, receiver_signature_name, receiver_notes, has_discrepancy, notes, created_at';

export { TRANSFER_COLS };

export default function Shipments() {
  const { distributor } = useDistributor();
  const navigate = useNavigate();
  const locId = distributor?.inventory_location_id ?? null;

  const { data, loading, error } = useLoad<InventoryTransfer[]>(async () => {
    if (!locId) return [];
    // RLS already narrows to transfers touching our location; the or-filter
    // keeps the result deterministic if this login ever gains wider access.
    const { data: rows, error: err } = await supabase
      .from('inventory_transfers')
      .select(TRANSFER_COLS)
      .or(`from_location_id.eq.${locId},to_location_id.eq.${locId}`)
      .order('created_at', { ascending: false })
      .limit(300);
    if (err) throw new Error(err.message);
    return (rows ?? []) as InventoryTransfer[];
  }, [locId]);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;

  const transfers = data ?? [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Shipments</h1>
          <p>
            Every BOL transfer to or from your warehouse. Open a shipment to
            see the full bill of lading — and to receive it when it arrives.
          </p>
        </div>
      </div>

      <div className="glass-card">
        {!locId ? (
          <EmptyNote>
            No warehouse location is linked to your account yet — contact your
            Brix Beverage rep.
          </EmptyNote>
        ) : transfers.length === 0 ? (
          <EmptyNote>No shipments yet.</EmptyNote>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>BOL #</th>
                  <th>Status</th>
                  <th>Ship date</th>
                  <th>Received</th>
                  <th>Carrier</th>
                  <th>Tracking</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr
                    key={t.id}
                    className="rowlink"
                    onClick={() => navigate(`/shipments/${t.id}`)}
                  >
                    <td style={{ fontWeight: 700 }}>{t.bol_number ?? t.id.slice(0, 8)}</td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <TransferStatusChip status={t.status} />
                        {t.has_discrepancy && (
                          <Chip tone="warning">
                            <AlertTriangle size={12} /> Discrepancy
                          </Chip>
                        )}
                      </span>
                    </td>
                    <td>{fmtDate(t.ship_date)}</td>
                    <td>{fmtDate(t.received_date)}</td>
                    <td>{t.carrier ?? '—'}</td>
                    <td>{t.tracking_number ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
