import { useEffect, useMemo, useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { InventoryLaneSelector } from '../../components/InventoryLaneSelector';
import { fetchInventoryHealth, InventoryHealthRow } from '../../lib/inventory';
import {
  coerceInventoryLane,
  describeLanes,
  filterItemsByLanes,
  laneSelected,
  useInventoryLanes,
  PRODUCTION_LANES,
  type InventoryLane,
} from '../../lib/inventoryLane';
import {
  fetchLocations, InventoryLocation,
} from '../../lib/inventoryControl';
import {
  ProductBom, WorkOrderView,
  fetchBoms, fetchWorkOrderViews,
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
import { ComplianceTab } from './ComplianceTab';
import { RawMaterialsTab } from './RawMaterialsTab';
import { RunGuideTab } from './RunGuideTab';

type TabId = 'formulas' | 'raw_materials' | 'boms' | 'work_orders' | 'purchase_orders' | 'compliance' | 'guide';

const TABS: { id: TabId; label: string }[] = [
  { id: 'formulas',        label: 'Formulas & Spec Sheets' },
  { id: 'raw_materials',   label: 'Materials & Pricing'    },
  { id: 'boms',            label: 'Bills of Materials'     },
  { id: 'work_orders',     label: 'Work Orders'            },
  { id: 'purchase_orders', label: 'Purchase Orders'        },
  { id: 'compliance',      label: 'Compliance & Safety'    },
  { id: 'guide',           label: 'Run Guide'              },
];

function coerceTab(value: unknown): TabId | null {
  return value === 'formulas' || value === 'raw_materials' || value === 'boms'
    || value === 'work_orders' || value === 'purchase_orders' || value === 'compliance'
    || value === 'guide'
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
      ? coerceInventoryLane(parsed.inventory_lane, PRODUCTION_LANES)
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
      : typeof sessionStorage !== 'undefined' && sessionStorage.getItem('brix.wo.prefill')
        ? 'work_orders'
        : 'formulas');
  // Lanes are a multi-select (Sky, 2026-09-04) — none picked means both.
  const [lanes, setLanes, toggleLane] = useInventoryLanes(PRODUCTION_LANES);
  // "BIB only" is the one selection that changes the page shape: purchasing only.
  const bibOnly = lanes.length === 1 && lanes[0] === 'bib_product';
  const [tab, setTab] = useState<TabId>(initialTab);
  const [formulas, setFormulas] = useState<ProductFormula[] | null>(null);
  const [boms, setBoms] = useState<ProductBom[] | null>(null);
  const [wos, setWos] = useState<WorkOrderView[] | null>(null);
  const [items, setItems] = useState<InventoryHealthRow[] | null>(null);
  const [locations, setLocations] = useState<InventoryLocation[] | null>(null);
  const [vendors, setVendors] = useState<QboVendor[] | null>(null);
  const [pos, setPos] = useState<PurchaseOrderRow[] | null>(null);
  const [poLines, setPoLines] = useState<PurchaseOrderLineSummary[] | null>(null);

  function reloadAll() {
    setFormulas(null); setBoms(null); setWos(null); setPos(null); setPoLines(null);
    fetchFormulas().then(setFormulas).catch(() => setFormulas([]));
    fetchBoms().then(setBoms).catch(() => setBoms([]));
    fetchWorkOrderViews().then(setWos).catch(() => setWos([]));
    fetchInventoryHealth({ lookback: 90 }).then(setItems).catch(() => setItems([]));
    fetchLocations().then(setLocations).catch(() => setLocations([]));
    fetchVendors().then(setVendors).catch(() => setVendors([]));
    fetchPurchaseOrders().then(setPos).catch(() => setPos([]));
    fetchAllPoLineSummaries().then(setPoLines).catch(() => setPoLines([]));
  }
  useEffect(reloadAll, []);

  useEffect(() => {
    // A lane-specific PO prefill (Inventory → Reorder → Create PO) narrows the
    // page to that lane so the form it opens matches; otherwise the selection
    // the person left is respected (a queued work order is a case run, and
    // "all lanes" or "cans" both show the Work Orders tab).
    const pre = readPrefillLane();
    if (pre) setLanes([pre]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (bibOnly && tab !== 'purchase_orders' && tab !== 'guide') setTab('purchase_orders');
  }, [bibOnly, tab]);

  useEffect(() => {
    const nextTab = coerceTab(routeParams.tab);
    if (nextTab) setTab(nextTab);
  }, [routeParams.tab]);

  // The BIB lane is purchasing only — but the Run Guide is documentation, not a
  // pipeline stage. Hiding it on a lane switch is exactly the "my guide has
  // disappeared" complaint chapter 10 exists to answer, so it shows on both.
  const visibleTabs = useMemo(
    () => bibOnly
      ? TABS.filter((t) => t.id === 'purchase_orders' || t.id === 'guide')
      : TABS,
    [bibOnly],
  );

  const laneItems = useMemo(
    () => filterItemsByLanes(items, lanes, PRODUCTION_LANES),
    [items, lanes],
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
      // a BOM is only ever a case run — BIB is bought, not made
      if (it.inventory_lane === 'cans_24pk' && it.has_bom) finishedOptions.push({ id: it.qbo_item_id, label: it.item_name });
    }
    finishedOptions.sort((a, b) => a.label.localeCompare(b.label));
    componentOptions.sort((a, b) => a.label.localeCompare(b.label));
    return { byId, finishedOptions, componentOptions };
  }, [items, laneItems]);

  const locById = useMemo(() => {
    const m = new Map<string, InventoryLocation>();
    for (const l of locations ?? []) m.set(l.id, l);
    return m;
  }, [locations]);

  const inLanes = (id: string | null | undefined) => laneSelected(lanes, itemLookup.byId.get(id ?? '')?.inventory_lane);
  const filteredBoms = useMemo(
    () => boms ? boms.filter((b) => inLanes(b.finished_qbo_item_id)) : null,
    [boms, itemLookup, lanes],   // eslint-disable-line react-hooks/exhaustive-deps
  );
  const filteredWos = useMemo(
    () => wos ? wos.filter((w) => inLanes(w.finished_qbo_item_id)) : null,
    [wos, itemLookup, lanes],   // eslint-disable-line react-hooks/exhaustive-deps
  );
  const lanePoIds = useMemo(() => {
    const ids = new Set<string>();
    for (const line of poLines ?? []) {
      if (inLanes(line.qbo_item_id)) ids.add(line.po_id);
    }
    return ids;
  }, [poLines, itemLookup, lanes]);   // eslint-disable-line react-hooks/exhaustive-deps
  const laneWoIds = useMemo(
    () => new Set((filteredWos ?? []).map((w) => w.id)),
    [filteredWos],
  );
  // A PO belongs to this lane if it carries a lane item OR it was raised by a work
  // order in this lane. The second half matters: an ingredient PO is all `excluded`
  // items (a gallon of syrup and a run fee are not finished goods), so on lines
  // alone the AC Calderoni half of every run would be invisible and unopenable.
  const filteredPos = useMemo(
    () => pos && poLines
      ? pos.filter((po) => lanePoIds.has(po.id) || (po.work_order_id ? laneWoIds.has(po.work_order_id) : false))
      : null,
    [pos, poLines, lanePoIds, laneWoIds],
  );

  const activeLabel = visibleTabs.find((t) => t.id === tab)?.label ?? 'Production';
  const openCount = (filteredWos ?? []).filter((w) => !['closed', 'void', 'consumed'].includes(w.status)).length;
  const openPoCount = (filteredPos ?? []).filter((p) => p.status === 'open' || p.status === 'partial').length;

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Formulas · BOM · Work Orders · POs · Compliance · Run Guide</div>
          <h1 className="hero-title">Production</h1>
          <div className="hero-meta">
            {activeLabel} · {describeLanes(lanes, PRODUCTION_LANES)} · {formulas?.length ?? 0} formula{(formulas?.length ?? 0) === 1 ? '' : 's'} · {filteredBoms?.length ?? 0} BOM{(filteredBoms?.length ?? 0) === 1 ? '' : 's'} · {openCount} open WO{openCount === 1 ? '' : 's'} · {openPoCount} open PO{openPoCount === 1 ? '' : 's'}
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
          <InventoryLaneSelector value={lanes} onToggle={toggleLane} lanes={PRODUCTION_LANES} />
          <div className="toolbar-spacer" />
          <span style={{ fontSize: 10, color: 'var(--mt)' }}>
            {bibOnly ? 'Purchasing only' : 'Formula → raw materials → BOM → work order → POs → co-packer → yield → production PO → receive'}
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
      {tab === 'raw_materials' && (
        <RawMaterialsTab vendors={vendors} onChanged={reloadAll} />
      )}
      {tab === 'compliance' && <ComplianceTab />}
      {tab === 'guide' && <RunGuideTab />}
      {tab === 'purchase_orders' && (
        <PurchaseOrdersTab
          vendors={vendors}
          purchaseOrders={filteredPos}
          locations={locations ?? []}
          locById={locById}
          itemLookup={itemLookup}
          lanes={lanes}
          initialPoId={routeParams.po ?? null}
          onChanged={reloadAll}
        />
      )}
    </div>
  );
}
