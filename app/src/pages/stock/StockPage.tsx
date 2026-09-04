import { useEffect, useMemo, useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import {
  InventoryLocation, InventoryLocationView,
  InventoryMovement,
  InventoryTransfer,
  InventoryTransferLineSummary,
  OnHandRow,
  fetchAllTransferLineSummaries,
  fetchLocations,
  fetchMovements,
  fetchOnHand,
  fetchTransfers,
} from '../../lib/inventoryControl';
import { fetchInventoryHealth, InventoryHealthRow } from '../../lib/inventory';
import { InventoryLaneSelector } from '../../components/InventoryLaneSelector';
import { filterItemsByLane, useInventoryLane } from '../../lib/inventoryLane';
import { TABS_SX } from './stockStyles';
import { StockLocationsTab } from './StockLocationsTab';
import { StockOnHandTab } from './StockOnHandTab';
import { StockTransfersTab } from './StockTransfersTab';
import { StockMovementsTab } from './StockMovementsTab';
import { StockAdjustmentsTab } from './StockAdjustmentsTab';
import { StockRepacksTab } from './StockRepacksTab';
import { OpenPOsTab } from '../inventory/OpenPOsTab';

type TabId = 'on_hand' | 'locations' | 'purchase_orders' | 'transfers' | 'adjustments' | 'repacks' | 'movements';

const TABS: { id: TabId; label: string }[] = [
  { id: 'on_hand',         label: 'On-Hand'         },
  { id: 'locations',       label: 'Locations'       },
  { id: 'purchase_orders', label: 'Purchase Orders' },
  { id: 'transfers',       label: 'Transfers'       },
  { id: 'adjustments',     label: 'Adjustments'     },
  { id: 'repacks',         label: 'Repacks'         },
  { id: 'movements',       label: 'Movements'       },
];

export interface ItemLookup {
  byId: Map<string, InventoryHealthRow>;
  options: { id: string; label: string }[];
}

export function StockPage() {
  const [tab, setTab] = useState<TabId>('on_hand');
  const [lane, setLane] = useInventoryLane();
  const [locations,  setLocations]  = useState<InventoryLocationView[] | null>(null);
  const [onHand,     setOnHand]     = useState<OnHandRow[]          | null>(null);
  const [transfers,  setTransfers]  = useState<InventoryTransfer[]  | null>(null);
  const [transferLines, setTransferLines] = useState<InventoryTransferLineSummary[] | null>(null);
  const [movements,  setMovements]  = useState<InventoryMovement[]  | null>(null);
  const [items,      setItems]      = useState<InventoryHealthRow[] | null>(null);

  function reloadAll() {
    setLocations(null); setOnHand(null); setTransfers(null); setTransferLines(null); setMovements(null);
    fetchLocations().then(setLocations).catch(() => setLocations([]));
    fetchOnHand().then(setOnHand).catch(() => setOnHand([]));
    fetchTransfers().then(setTransfers).catch(() => setTransfers([]));
    fetchAllTransferLineSummaries().then(setTransferLines).catch(() => setTransferLines([]));
    fetchMovements().then(setMovements).catch(() => setMovements([]));
    fetchInventoryHealth({ lookback: 90 }).then(setItems).catch(() => setItems([]));
  }
  useEffect(reloadAll, []);

  const laneItems = useMemo(
    () => filterItemsByLane(items, lane),
    [items, lane],
  );

  const allowedItemIds = useMemo(
    () => new Set(laneItems.map((it) => it.qbo_item_id)),
    [laneItems],
  );

  const itemLookup: ItemLookup = useMemo(() => {
    const byId = new Map<string, InventoryHealthRow>();
    const options: { id: string; label: string }[] = [];
    for (const it of items ?? []) {
      byId.set(it.qbo_item_id, it);
    }
    for (const it of laneItems) {
      if (it.track_locations) {
        options.push({ id: it.qbo_item_id, label: it.item_name });
      }
    }
    options.sort((a, b) => a.label.localeCompare(b.label));
    return { byId, options };
  }, [items, laneItems]);

  const laneOnHand = useMemo(
    () => onHand ? onHand.filter((row) => allowedItemIds.has(row.qbo_item_id)) : null,
    [onHand, allowedItemIds],
  );

  const laneMovements = useMemo(
    () => movements ? movements.filter((row) => allowedItemIds.has(row.qbo_item_id)) : null,
    [movements, allowedItemIds],
  );

  const laneTransferIds = useMemo(() => {
    const ids = new Set<string>();
    for (const line of transferLines ?? []) {
      if (allowedItemIds.has(line.qbo_item_id)) ids.add(line.transfer_id);
    }
    return ids;
  }, [transferLines, allowedItemIds]);

  const laneTransfers = useMemo(
    () => transfers ? transfers.filter((transfer) => laneTransferIds.has(transfer.id)) : null,
    [transfers, laneTransferIds],
  );

  const locationById = useMemo(() => {
    const m = new Map<string, InventoryLocationView>();
    for (const l of locations ?? []) m.set(l.id, l);
    return m;
  }, [locations]);

  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? 'Inventory';

  const physicalLocCount = (locations ?? []).filter((l) => l.is_active && l.is_physical).length;

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">On-Hand · Locations · Purchase Orders · Transfers · Movements</div>
          <h1 className="hero-title">Inventory</h1>
          <div className="hero-meta">
            {activeLabel} · {lane === 'bib_product' ? 'BIB Product' : 'Cans 24pks'} · {physicalLocCount} active location{physicalLocCount === 1 ? '' : 's'}
            {transfers ? ` · ${transfers.filter((t) => t.status === 'in_transit').length} in transit` : ''}
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          Operations
        </div>
      </div>

      <Tabs value={tab} onChange={(_, v) => setTab(v as TabId)} sx={TABS_SX}>
        {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </Tabs>

      {tab !== 'locations' && tab !== 'repacks' && (
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <div className="toolbar-row">
            <InventoryLaneSelector value={lane} onChange={setLane} />
            <div className="toolbar-spacer" />
            <span style={{ fontSize: 10, color: 'var(--mt)' }}>
              {laneItems.length} item{laneItems.length === 1 ? '' : 's'} in lane
            </span>
          </div>
        </div>
      )}

      {tab === 'on_hand' && (
        <StockOnHandTab
          rows={laneOnHand}
          locationById={locationById}
          itemLookup={itemLookup}
          onRefresh={reloadAll}
        />
      )}
      {tab === 'locations' && (
        <StockLocationsTab
          rows={locations}
          onChanged={reloadAll}
        />
      )}
      {tab === 'purchase_orders' && <OpenPOsTab lane={lane} itemLookup={itemLookup} />}
      {tab === 'transfers' && (
        <StockTransfersTab
          transfers={laneTransfers}
          locations={locations ?? []}
          locationById={locationById}
          itemLookup={itemLookup}
          onChanged={reloadAll}
        />
      )}
      {tab === 'adjustments' && (
        <StockAdjustmentsTab
          locations={locations ?? []}
          itemLookup={itemLookup}
          movements={laneMovements}
          locationById={locationById}
          onChanged={reloadAll}
        />
      )}
      {tab === 'repacks' && <StockRepacksTab />}
      {tab === 'movements' && (
        <StockMovementsTab
          rows={laneMovements}
          locationById={locationById}
          itemLookup={itemLookup}
        />
      )}
    </div>
  );
}
