import { useEffect, useMemo, useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { fetchInventoryHealth, InventoryHealthRow } from '../../lib/inventory';
import {
  fetchLocations, InventoryLocation,
} from '../../lib/inventoryControl';
import {
  ProductBom, WorkOrder,
  fetchBoms, fetchWorkOrders,
} from '../../lib/production';
import {
  PurchaseOrderRow, QboVendor,
  fetchPurchaseOrders, fetchVendors,
} from '../../lib/purchasing';
import { TABS_SX } from '../stock/stockStyles';
import { BomsTab } from './BomsTab';
import { WorkOrdersTab } from './WorkOrdersTab';
import { PurchaseOrdersTab } from './PurchaseOrdersTab';

type TabId = 'boms' | 'work_orders' | 'purchase_orders';

const TABS: { id: TabId; label: string }[] = [
  { id: 'boms',            label: 'Bills of Materials' },
  { id: 'work_orders',     label: 'Work Orders'        },
  { id: 'purchase_orders', label: 'Purchase Orders'    },
];

export interface ProductionItemLookup {
  byId: Map<string, InventoryHealthRow>;
  finishedOptions: { id: string; label: string }[];   // has_bom flagged
  componentOptions: { id: string; label: string }[];  // track_locations or active inv
}

export function ProductionPage() {
  // If an Inventory → Reorder click stashed a PO prefill, open that tab
  // immediately so the prefilled Create-PO form is visible on mount.
  const initialTab: TabId =
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem('brix.po.prefill')
      ? 'purchase_orders'
      : 'boms';
  const [tab, setTab] = useState<TabId>(initialTab);
  const [boms, setBoms] = useState<ProductBom[] | null>(null);
  const [wos, setWos] = useState<WorkOrder[] | null>(null);
  const [items, setItems] = useState<InventoryHealthRow[] | null>(null);
  const [locations, setLocations] = useState<InventoryLocation[] | null>(null);
  const [vendors, setVendors] = useState<QboVendor[] | null>(null);
  const [pos, setPos] = useState<PurchaseOrderRow[] | null>(null);

  function reloadAll() {
    setBoms(null); setWos(null); setPos(null);
    fetchBoms().then(setBoms).catch(() => setBoms([]));
    fetchWorkOrders().then(setWos).catch(() => setWos([]));
    fetchInventoryHealth({ lookback: 90 }).then(setItems).catch(() => setItems([]));
    fetchLocations().then(setLocations).catch(() => setLocations([]));
    fetchVendors().then(setVendors).catch(() => setVendors([]));
    fetchPurchaseOrders().then(setPos).catch(() => setPos([]));
  }
  useEffect(reloadAll, []);

  const itemLookup: ProductionItemLookup = useMemo(() => {
    const byId = new Map<string, InventoryHealthRow>();
    const finishedOptions: { id: string; label: string }[] = [];
    const componentOptions: { id: string; label: string }[] = [];
    for (const it of items ?? []) {
      byId.set(it.qbo_item_id, it);
      if (it.has_bom) finishedOptions.push({ id: it.qbo_item_id, label: it.item_name });
      if (it.track_locations) componentOptions.push({ id: it.qbo_item_id, label: it.item_name });
    }
    finishedOptions.sort((a, b) => a.label.localeCompare(b.label));
    componentOptions.sort((a, b) => a.label.localeCompare(b.label));
    return { byId, finishedOptions, componentOptions };
  }, [items]);

  const locById = useMemo(() => {
    const m = new Map<string, InventoryLocation>();
    for (const l of locations ?? []) m.set(l.id, l);
    return m;
  }, [locations]);

  const bomById = useMemo(() => {
    const m = new Map<string, ProductBom>();
    for (const b of boms ?? []) m.set(b.id, b);
    return m;
  }, [boms]);

  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? 'Production';
  const openCount = (wos ?? []).filter((w) => w.status === 'draft' || w.status === 'consumed').length;
  const openPoCount = (pos ?? []).filter((p) => p.status === 'open' || p.status === 'partial').length;

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">BOM · Work Orders · Purchase Orders · Cost Rollup</div>
          <h1 className="hero-title">Production</h1>
          <div className="hero-meta">
            {activeLabel} · {boms?.length ?? 0} BOM{(boms?.length ?? 0) === 1 ? '' : 's'} · {openCount} open WO{openCount === 1 ? '' : 's'} · {openPoCount} open PO{openPoCount === 1 ? '' : 's'}
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          Phase 2
        </div>
      </div>

      <Tabs value={tab} onChange={(_, v) => setTab(v as TabId)} sx={TABS_SX}>
        {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </Tabs>

      {tab === 'boms' && (
        <BomsTab
          boms={boms}
          itemLookup={itemLookup}
          onChanged={reloadAll}
        />
      )}
      {tab === 'work_orders' && (
        <WorkOrdersTab
          workOrders={wos}
          boms={boms ?? []}
          bomById={bomById}
          locations={locations ?? []}
          locById={locById}
          itemLookup={itemLookup}
          onChanged={reloadAll}
        />
      )}
      {tab === 'purchase_orders' && (
        <PurchaseOrdersTab
          vendors={vendors}
          purchaseOrders={pos}
          locations={locations ?? []}
          locById={locById}
          itemLookup={itemLookup}
          onChanged={reloadAll}
        />
      )}
    </div>
  );
}
