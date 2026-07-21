import { useEffect, useMemo, useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { InventoryLaneSelector } from '../../components/InventoryLaneSelector';
import { fetchInventoryHealth, InventoryHealthRow } from '../../lib/inventory';
import {
  coerceInventoryLane,
  filterItemsByLane,
  useInventoryLane,
  type InventoryLane,
} from '../../lib/inventoryLane';
import {
  fetchLocations, InventoryLocation,
} from '../../lib/inventoryControl';
import {
  CopackOrderRow, ProductBom, WorkOrderView,
  fetchBoms, fetchCopackOrders, fetchWorkOrderViews,
} from '../../lib/production';
import { ProductFormula, fetchFormulas } from '../../lib/formulas';
import {
  PurchaseOrderLineSummary, PurchaseOrderRow, QboVendor,
  fetchAllPoLineSummaries, fetchPurchaseOrders, fetchVendors,
} from '../../lib/purchasing';
import { TABS_SX } from '../stock/stockStyles';
import { FormulasTab } from './FormulasTab';
import { BomsTab } from './BomsTab';
import { WorkOrdersTab } from './WorkOrdersTab';
import { PurchaseOrdersTab } from './PurchaseOrdersTab';
import { CopackOrdersTab } from './CopackOrdersTab';

type TabId = 'formulas' | 'boms' | 'work_orders' | 'purchase_orders' | 'copack_orders';

const TABS: { id: TabId; label: string }[] = [
  { id: 'formulas',        label: 'Formulas & Spec Sheets' },
  { id: 'boms',            label: 'Bills of Materials'     },
  { id: 'work_orders',     label: 'Work Orders'            },
  { id: 'purchase_orders', label: 'Purchase Orders'        },
  { id: 'copack_orders',   label: 'Co-Pack (Legacy)'       },
];

function coerceTab(value: unknown): TabId | null {
  return value === 'formulas' || value === 'boms' || value === 'work_orders'
    || value === 'copack_orders' || value === 'purchase_orders'
    ? value
    : null;
}

function readPrefillLane(): InventoryLane | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem('brix.po.prefill');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { inventory_lane?: unknown };
    return parsed.inventory_lane === 'bib_product' || parsed.inventory_lane === 'cans_24pk'
      ? coerceInventoryLane(parsed.inventory_lane)
      : null;
  } catch { return null; }
}

export interface ProductionItemLookup {
  byId: Map<string, InventoryHealthRow>;
  finishedOptions: { id: string; label: string }[];   // has_bom flagged
  componentOptions: { id: string; label: string }[];  // track_locations or active inv
}

export function ProductionPage({ routeParams = {} }: { routeParams?: Record<string, string> }) {
  // If an Inventory → Reorder click stashed a PO prefill, open that tab
  // immediately so the prefilled Create-PO form is visible on mount.
  const initialTab: TabId =
    coerceTab(routeParams.tab)
    ?? (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('brix.po.prefill')
      ? 'purchase_orders'
      : 'formulas');
  const [lane, setLane] = useInventoryLane();
  const [tab, setTab] = useState<TabId>(initialTab);
  const [formulas, setFormulas] = useState<ProductFormula[] | null>(null);
  const [boms, setBoms] = useState<ProductBom[] | null>(null);
  const [wos, setWos] = useState<WorkOrderView[] | null>(null);
  const [copacks, setCopacks] = useState<CopackOrderRow[] | null>(null);
  const [items, setItems] = useState<InventoryHealthRow[] | null>(null);
  const [locations, setLocations] = useState<InventoryLocation[] | null>(null);
  const [vendors, setVendors] = useState<QboVendor[] | null>(null);
  const [pos, setPos] = useState<PurchaseOrderRow[] | null>(null);
  const [poLines, setPoLines] = useState<PurchaseOrderLineSummary[] | null>(null);

  function reloadAll() {
    setFormulas(null); setBoms(null); setWos(null); setCopacks(null); setPos(null); setPoLines(null);
    fetchFormulas().then(setFormulas).catch(() => setFormulas([]));
    fetchBoms().then(setBoms).catch(() => setBoms([]));
    fetchWorkOrderViews().then(setWos).catch(() => setWos([]));
    fetchCopackOrders().then(setCopacks).catch(() => setCopacks([]));
    fetchInventoryHealth({ lookback: 90 }).then(setItems).catch(() => setItems([]));
    fetchLocations().then(setLocations).catch(() => setLocations([]));
    fetchVendors().then(setVendors).catch(() => setVendors([]));
    fetchPurchaseOrders().then(setPos).catch(() => setPos([]));
    fetchAllPoLineSummaries().then(setPoLines).catch(() => setPoLines([]));
  }
  useEffect(reloadAll, []);

  useEffect(() => {
    setLane(readPrefillLane() ?? 'cans_24pk');
    // Production defaults to cans unless opened from a lane-specific PO prefill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lane === 'bib_product' && tab !== 'purchase_orders') setTab('purchase_orders');
  }, [lane, tab]);

  useEffect(() => {
    const nextTab = coerceTab(routeParams.tab);
    if (nextTab) setTab(nextTab);
  }, [routeParams.tab]);

  const visibleTabs = useMemo(
    () => lane === 'cans_24pk'
      ? TABS
      : TABS.filter((t) => t.id === 'purchase_orders'),
    [lane],
  );

  const laneItems = useMemo(
    () => filterItemsByLane(items, lane),
    [items, lane],
  );

  const itemLookup: ProductionItemLookup = useMemo(() => {
    const byId = new Map<string, InventoryHealthRow>();
    const finishedOptions: { id: string; label: string }[] = [];
    const componentOptions: { id: string; label: string }[] = [];
    for (const it of items ?? []) {
      byId.set(it.qbo_item_id, it);
      if (it.track_locations) componentOptions.push({ id: it.qbo_item_id, label: it.item_name });
    }
    for (const it of laneItems) {
      if (lane === 'cans_24pk' && it.has_bom) finishedOptions.push({ id: it.qbo_item_id, label: it.item_name });
    }
    finishedOptions.sort((a, b) => a.label.localeCompare(b.label));
    componentOptions.sort((a, b) => a.label.localeCompare(b.label));
    return { byId, finishedOptions, componentOptions };
  }, [items, laneItems, lane]);

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

  const filteredBoms = useMemo(
    () => boms ? boms.filter((b) => itemLookup.byId.get(b.finished_qbo_item_id)?.inventory_lane === lane) : null,
    [boms, itemLookup, lane],
  );
  const filteredWos = useMemo(
    () => wos ? wos.filter((w) => itemLookup.byId.get(w.finished_qbo_item_id)?.inventory_lane === lane) : null,
    [wos, itemLookup, lane],
  );
  const filteredCopacks = useMemo(
    () => copacks ? copacks.filter((o) => itemLookup.byId.get(o.finished_qbo_item_id)?.inventory_lane === lane) : null,
    [copacks, itemLookup, lane],
  );
  const lanePoIds = useMemo(() => {
    const ids = new Set<string>();
    for (const line of poLines ?? []) {
      if (itemLookup.byId.get(line.qbo_item_id)?.inventory_lane === lane) ids.add(line.po_id);
    }
    return ids;
  }, [poLines, itemLookup, lane]);
  const filteredPos = useMemo(
    () => pos && poLines ? pos.filter((po) => lanePoIds.has(po.id)) : null,
    [pos, poLines, lanePoIds],
  );

  const activeLabel = visibleTabs.find((t) => t.id === tab)?.label ?? 'Production';
  const openCount = (filteredWos ?? []).filter((w) => !['closed', 'void', 'consumed'].includes(w.status)).length;
  const openPoCount = (filteredPos ?? []).filter((p) => p.status === 'open' || p.status === 'partial').length;

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Formulas · BOM · Work Orders · POs · Co-Packer Pipeline</div>
          <h1 className="hero-title">Production</h1>
          <div className="hero-meta">
            {activeLabel} · {lane === 'bib_product' ? 'BIB Product' : 'Cans 24pks'} · {formulas?.length ?? 0} formula{(formulas?.length ?? 0) === 1 ? '' : 's'} · {filteredBoms?.length ?? 0} BOM{(filteredBoms?.length ?? 0) === 1 ? '' : 's'} · {openCount} open WO{openCount === 1 ? '' : 's'} · {openPoCount} open PO{openPoCount === 1 ? '' : 's'}
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          Pipeline
        </div>
      </div>

      <Tabs value={tab} onChange={(_, v) => setTab(v as TabId)} sx={TABS_SX}>
        {visibleTabs.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </Tabs>

      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row">
          <InventoryLaneSelector value={lane} onChange={setLane} />
          <div className="toolbar-spacer" />
          <span style={{ fontSize: 10, color: 'var(--mt)' }}>
            {lane === 'bib_product' ? 'Purchasing only' : 'Formula → BOM → work order → POs → co-packer → yield → ship → receive'}
          </span>
        </div>
      </div>

      {tab === 'formulas' && (
        <FormulasTab
          formulas={formulas}
          onChanged={reloadAll}
        />
      )}
      {tab === 'boms' && (
        <BomsTab
          boms={filteredBoms}
          formulas={formulas}
          vendors={vendors}
          itemLookup={itemLookup}
          onChanged={reloadAll}
        />
      )}
      {tab === 'work_orders' && (
        <WorkOrdersTab
          workOrders={filteredWos}
          boms={filteredBoms ?? []}
          formulas={formulas}
          vendors={vendors}
          locations={locations ?? []}
          itemLookup={itemLookup}
          onChanged={reloadAll}
        />
      )}
      {tab === 'copack_orders' && (
        <CopackOrdersTab
          orders={filteredCopacks}
          boms={filteredBoms ?? []}
          bomById={bomById}
          vendors={vendors}
          locations={locations ?? []}
          locById={locById}
          itemLookup={itemLookup}
          onChanged={reloadAll}
        />
      )}
      {tab === 'purchase_orders' && (
        <PurchaseOrdersTab
          vendors={vendors}
          purchaseOrders={filteredPos}
          locations={locations ?? []}
          locById={locById}
          itemLookup={itemLookup}
          lane={lane}
          initialPoId={routeParams.po ?? null}
          onChanged={reloadAll}
        />
      )}
    </div>
  );
}
