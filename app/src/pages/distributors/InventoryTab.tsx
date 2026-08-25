import { useEffect, useMemo, useState } from 'react';
import {
  InventoryLocation,
  InventoryTransfer,
  fetchTransfers,
} from '../../lib/inventoryControl';
import {
  OnHandAtLocationRow,
  SubDistributor,
  fetchOnHandAtLocation,
} from '../../lib/subDistributors';
import { useToast } from '../../lib/toast';
import { fmtNum } from '../../lib/formatters';
import { Chip, errMsg, Td, Th } from './common';

const TRANSFER_STATUS_COLOR: Record<string, string> = {
  draft:      'var(--mt)',
  in_transit: 'var(--am)',
  received:   'var(--gn)',
  void:       '#64748b',
};

interface Props {
  dist: SubDistributor;
  locationById: Map<string, InventoryLocation>;
  itemNameById: Map<string, string>;
}

export function DistributorInventoryTab({ dist, locationById, itemNameById }: Props) {
  const toast = useToast();
  const locId = dist.inventory_location_id;
  const [onHand, setOnHand] = useState<OnHandAtLocationRow[] | null>(null);
  const [transfers, setTransfers] = useState<InventoryTransfer[] | null>(null);

  useEffect(() => {
    setOnHand(null);
    setTransfers(null);
    if (!locId) { setOnHand([]); setTransfers([]); return; }
    fetchOnHandAtLocation(locId).then(setOnHand).catch((e) => { setOnHand([]); toast.error(errMsg(e)); });
    fetchTransfers(300).then(setTransfers).catch(() => setTransfers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locId]);

  const rows = useMemo(
    () => (onHand ?? [])
      .filter((r) => Number(r.on_hand) !== 0)
      .map((r) => ({ ...r, name: itemNameById.get(r.qbo_item_id) ?? r.qbo_item_id }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [onHand, itemNameById],
  );

  const relatedTransfers = useMemo(
    () => (transfers ?? []).filter((t) => t.from_location_id === locId || t.to_location_id === locId),
    [transfers, locId],
  );

  if (!locId) {
    return (
      <div className="cd" style={{ padding: 18, fontSize: 12, color: 'var(--mt)' }}>
        No inventory location is linked to this sub-distributor yet — link one on the Overview tab.
      </div>
    );
  }

  const loc = locationById.get(locId);
  const totalCases = rows.reduce((s, r) => s + Number(r.on_hand), 0);

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--mt)', fontSize: 11 }}>
            On hand at <code style={{ color: 'var(--ac)', fontFamily: 'var(--ff-mono)' }}>{loc?.code ?? locId}</code>
            {onHand !== null && ` · ${rows.length} item${rows.length === 1 ? '' : 's'} · ${fmtNum(totalCases)} total units`}
          </span>
        </div>
      </div>

      <div className="cd" style={{ padding: 0, overflowX: 'auto', marginBottom: 20 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th>Item</Th>
              <Th style={{ textAlign: 'right', width: 120 }}>On hand</Th>
            </tr>
          </thead>
          <tbody>
            {onHand === null && (
              <tr><td colSpan={2} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>Loading…</td></tr>
            )}
            {onHand !== null && rows.length === 0 && (
              <tr><td colSpan={2} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>
                Nothing on hand at this location.
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.qbo_item_id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <Td><span style={{ fontWeight: 600 }}>{r.name}</span></Td>
                <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(r.on_hand)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8 }}>
        Recent transfers to / from this location
      </div>
      <div className="cd" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th>BOL #</Th>
              <Th>Status</Th>
              <Th>Direction</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th>Shipped</Th>
              <Th>Received</Th>
            </tr>
          </thead>
          <tbody>
            {transfers === null && (
              <tr><td colSpan={7} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>Loading…</td></tr>
            )}
            {transfers !== null && relatedTransfers.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>
                No transfers involving this location yet.
              </td></tr>
            )}
            {relatedTransfers.map((t) => (
              <tr key={t.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <Td><code style={{ fontFamily: 'var(--ff-mono)', color: 'var(--ac)', fontSize: 11.5 }}>{t.bol_number}</code></Td>
                <Td><Chip label={t.status} color={TRANSFER_STATUS_COLOR[t.status] ?? 'var(--mt)'} /></Td>
                <Td><span style={{ color: 'var(--mt)', fontSize: 10.5 }}>
                  {t.to_location_id === locId ? 'Inbound' : 'Outbound'}
                </span></Td>
                <Td><span style={{ color: 'var(--mt)' }}>{locationById.get(t.from_location_id)?.code ?? '?'}</span></Td>
                <Td><span style={{ color: 'var(--mt)' }}>{locationById.get(t.to_location_id)?.code ?? '?'}</span></Td>
                <Td>{t.ship_date ?? '—'}</Td>
                <Td>{t.received_date ?? '—'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
