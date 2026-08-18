import { useNavigate } from 'react-router-dom';
import { Boxes, Truck, ClipboardList, Info } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useDistributor } from '@/lib/distributor';
import { useLoad, useItemNames } from '@/lib/hooks';
import { fmtQty } from '@/lib/format';
import { Spinner, ErrorNote, EmptyNote } from '@/components/ui';
import type { OnHandRow } from '@/lib/types';

interface DashData {
  onHand: OnHandRow[];
  inTransitCount: number;
  openOrderCount: number;
}

export default function Dashboard() {
  const { distributor } = useDistributor();
  const navigate = useNavigate();
  const locId = distributor?.inventory_location_id ?? null;
  const distId = distributor?.id ?? null;

  const { data, loading, error } = useLoad<DashData>(async () => {
    let onHand: OnHandRow[] = [];
    let inTransitCount = 0;

    if (locId) {
      const oh = await supabase
        .from('v_inventory_on_hand')
        .select('qbo_item_id, location_id, on_hand')
        .eq('location_id', locId);
      if (oh.error) throw new Error(oh.error.message);
      onHand = ((oh.data ?? []) as OnHandRow[]).filter((r) => Number(r.on_hand) !== 0);

      const tr = await supabase
        .from('inventory_transfers')
        .select('id', { count: 'exact', head: true })
        .eq('to_location_id', locId)
        .eq('status', 'in_transit');
      if (tr.error) throw new Error(tr.error.message);
      inTransitCount = tr.count ?? 0;
    }

    let openOrderCount = 0;
    if (distId) {
      const or = await supabase
        .from('sub_distributor_orders')
        .select('id', { count: 'exact', head: true })
        .eq('sub_distributor_id', distId)
        .eq('status', 'submitted');
      if (or.error) throw new Error(or.error.message);
      openOrderCount = or.count ?? 0;
    }

    return { onHand, inTransitCount, openOrderCount };
  }, [locId, distId]);

  const itemName = useItemNames((data?.onHand ?? []).map((r) => r.qbo_item_id));

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;

  const onHand = (data?.onHand ?? [])
    .slice()
    .sort((a, b) => Number(b.on_hand) - Number(a.on_hand));
  const totalCases = onHand.reduce((s, r) => s + Number(r.on_hand || 0), 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Inventory and activity for {distributor?.name}.</p>
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 0 }}>
        <div className="glass-card stat-card">
          <div className="stat-label"><Boxes size={13} /> Cases on hand</div>
          <div className="stat-value">{fmtQty(totalCases)}</div>
          <div className="stat-sub">{onHand.length} item{onHand.length === 1 ? '' : 's'} in stock</div>
        </div>
        <div
          className="glass-card stat-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/shipments')}
          role="button"
        >
          <div className="stat-label"><Truck size={13} /> Shipments in transit</div>
          <div className="stat-value">{data?.inTransitCount ?? 0}</div>
          <div className="stat-sub">Headed to your warehouse</div>
        </div>
        <div
          className="glass-card stat-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/orders')}
          role="button"
        >
          <div className="stat-label"><ClipboardList size={13} /> Open orders</div>
          <div className="stat-value">{data?.openOrderCount ?? 0}</div>
          <div className="stat-sub">Submitted, awaiting fulfillment</div>
        </div>
      </div>

      {distributor?.model === 'consignment' && (
        <div className="callout callout-info" style={{ margin: 0 }}>
          <Info size={18} />
          <div>
            This inventory is owned by Brix Beverage and held on consignment.
          </div>
        </div>
      )}

      <div className="glass-card">
        <h3 style={{ marginBottom: 12 }}>Inventory on hand</h3>
        {!locId ? (
          <EmptyNote>
            No warehouse location is linked to your account yet — contact your
            Brix Beverage rep.
          </EmptyNote>
        ) : onHand.length === 0 ? (
          <EmptyNote>Nothing on hand yet. Stock lands here once a shipment is received.</EmptyNote>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="r">On hand</th>
                </tr>
              </thead>
              <tbody>
                {onHand.map((r) => (
                  <tr key={r.qbo_item_id}>
                    <td>{itemName(r.qbo_item_id)}</td>
                    <td className="r">{fmtQty(r.on_hand)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="r">{fmtQty(totalCases)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
