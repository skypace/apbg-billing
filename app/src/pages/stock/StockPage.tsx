import { useEffect, useMemo, useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import {
  InventoryLocation,
  InventoryMovement,
  InventoryTransfer,
  OnHandRow,
  fetchLocations,
  fetchMovements,
  fetchOnHand,
  fetchTransfers,
} from '../../lib/inventoryControl';
import { fetchInventoryHealth, InventoryHealthRow } from '../../lib/inventory';
import { TABS_SX } from './stockStyles';
import { StockLocationsTab } from './StockLocationsTab';
import { StockOnHandTab } from './StockOnHandTab';
import { StockTransfersTab } from './StockTransfersTab';
import { StockMovementsTab } from './StockMovementsTab';
import { StockAdjustmentsTab } from './StockAdjustmentsTab';
import { StockReconcileTab } from './StockReconcileTab';

type TabId = 'on_hand' | 'locations' | 'transfers' | 'adjustments' | 'movements' | 'reconcile';

const TABS: { id: TabId; label: string }[] = [
  { id: 'on_hand',     label: 'On-Hand'     },
  { id: 'locations',   label: 'Locations'   },
  { id: 'transfers',   label: 'Transfers'   },
  { id: 'adjustments', label: 'Adjustments' },
  { id: 'movements',   label: 'Movements'   },
  { id: 'reconcile',   label: 'Reconcile vs QBO' },
];

export interface ItemLookup {
  byId: Map<string, InventoryHealthRow>;
  options: { id: string; label: string }[];
}

export function StockPage() {
  const [tab, setTab] = useState<TabId>('on_hand');
  const [locations,  setLocations]  = useState<InventoryLocation[]  | null>(null);
  const [onHand,     setOnHand]     = useState<OnHandRow[]          | null>(null);
  const [transfers,  setTransfers]  = useState<InventoryTransfer[]  | null>(null);
  const [movements,  setMovements]  = useState<InventoryMovement[]  | null>(null);
  const [items,      setItems]      = useState<InventoryHealthRow[] | null>(null);

  function reloadAll() {
    setLocations(null); setOnHand(null); setTransfers(null); setMovements(null);
    fetchLocations().then(setLocations).catch(() => setLocations([]));
    fetchOnHand().then(setOnHand).catch(() => setOnHand([]));
    fetchTransfers().then(setTransfers).catch(() => setTransfers([]));
    fetchMovements().then(setMovements).catch(() => setMovements([]));
    // Items master is the lookup source for item names + costs across tabs.
    fetchInventoryHealth({ lookback: 90 }).then(setItems).catch(() => setItems([]));
  }
  useEffect(reloadAll, []);

  const itemLookup: ItemLookup = useMemo(() => {
    // byId maps every item so the On-Hand / Movements / Transfers tabs can
    // resolve names for legacy rows even after an item is opted out. The
    // `options` list (used by the New Transfer picker) only contains items
    // the operator has flagged track_locations = true.
    const byId = new Map<string, InventoryHealthRow>();
    const options: { id: string; label: string }[] = [];
    for (const it of items ?? []) {
      byId.set(it.qbo_item_id, it);
      if (it.track_locations) {
        options.push({ id: it.qbo_item_id, label: it.item_name });
      }
    }
    options.sort((a, b) => a.label.localeCompare(b.label));
    return { byId, options };
  }, [items]);

  const locationById = useMemo(() => {
    const m = new Map<string, InventoryLocation>();
    for (const l of locations ?? []) m.set(l.id, l);
    return m;
  }, [locations]);

  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? 'Stock';

  const physicalLocCount = (locations ?? []).filter(
    (l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment',
  ).length;

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Locations · Transfers · Movement Ledger</div>
          <h1 className="hero-title">Stock</h1>
          <div className="hero-meta">
            {activeLabel} · {physicalLocCount} active location{physicalLocCount === 1 ? '' : 's'}
            {transfers ? ` · ${transfers.filter((t) => t.status === 'in_transit').length} in transit` : ''}
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          Phase 1
        </div>
      </div>

      <Tabs value={tab} onChange={(_, v) => setTab(v as TabId)} sx={TABS_SX}>
        {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </Tabs>

      {tab === 'on_hand' && (
        <StockOnHandTab
          rows={onHand}
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
      {tab === 'transfers' && (
        <StockTransfersTab
          transfers={transfers}
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
          movements={movements}
          locationById={locationById}
          onChanged={reloadAll}
        />
      )}
      {tab === 'movements' && (
        <StockMovementsTab
          rows={movements}
          locationById={locationById}
          itemLookup={itemLookup}
        />
      )}
      {tab === 'reconcile' && <StockReconcileTab onRefresh={reloadAll} />}
    </div>
  );
}
