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
import { LicensingTab } from './LicensingTab';
import { RunsTab } from './RunsTab';
import { ProductionRun, fetchRuns } from '../../lib/runs';

type TabId = 'orders' | 'formulas' | 'raw_materials' | 'boms' | 'work_orders' | 'purchase_orders' | 'licensing' | 'compliance' | 'guide';

const TABS: { id: TabId; label: string }[] = [
  { id: 'orders',          label: 'Production Orders'      },
  { id: 'formulas',        label: 'Formulas & Spec Sheets' },
  { id: 'raw_materials',   label: 'Materials & Pricing'    },
  { id: 'boms',            label: 'Bills of Materials'     },
  { id: 'work_orders',     label: 'Work Orders'            },
  { id: 'purchase_orders', label: 'Purchase Orders'        },
  { id: 'licensing',       label: 'Licensing'              },
  { id: 'compliance',      label: 'Compliance & Safety'    },
  { id: 'guide',           label: 'Run Guide'              },
];

function coerceTab(value: unknown): TabId | null {
  return value === 'orders' || value === 'formulas' || value === 'raw_materials' || value === 'boms'
    || value === 'work_orders' || value === 'purchase_orders' || value === 'compliance'
    || value === 'guide' || value === 'licensing'
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
      : 'orders');
  const [lane, setLane] = useInventoryLane();
  const [tab, setTab] = useState<TabId>(initialTab);
  const [formulas, setFormulas] = useState<ProductFormula[] | null>(null);
  const [boms, setBoms] = useState<ProductBom[] | null>(null);
  const [wos, setWos] = useState<WorkOrderView[] | null>(null);
  const [runs, setRuns] = useState<ProductionRun[] | null>(null);
  // Cross-tab focus: a PO or WO opened from the run detail lands on its own tab.
  const [poFocus, setPoFocus] = useState<string | null>(null);
  const [woFocus, setWoFocus] = useState<string | null>(null);
  const [items, setItems] = useState<InventoryHealthRow[] | null>(null);
  const [locations, setLocations] = useState<InventoryLocation[] | null>(null);
  const [vendors, setVendors] = useState<QboVendor[] | null>(null);
  const [pos, setPos] = useState<PurchaseOrderRow[] | null>(null);
  const [poLines, setPoLines] = useState<PurchaseOrderLineSummary[] | null>(null);

  function reloadAll() {
    setFormulas(null); setBoms(null); setWos(null); setPos(null); setPoLines(null); setRuns(null);
    fetchRuns().then(setRuns).catch(() => setRuns([]));
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

  // The BIB lane is purchasing only — but the Run Guide is documentation, not a
  // pipeline stage. Hiding it on a lane switch is exactly the "my guide has
  // disappeared" complaint chapter 10 exists to answer, so it shows on both.
  const visibleTabs = useMemo(
    () => lane === 'cans_24pk'
      ? TABS
      : TABS.filter((t) => t.id === 'purchase_orders' || t.id === 'guide' || t.id === 'licensing'),
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

  const filteredBoms = useMemo(
    () => boms ? boms.filter((b) => itemLookup.byId.get(b.finished_qbo_item_id)?.inventory_lane === lane) : null,
    [boms, itemLookup, lane],
  );
  const filteredWos = useMemo(
    () => wos ? wos.filter((w) => itemLookup.byId.get(w.finished_qbo_item_id)?.inventory_lane === lane) : null,
    [wos, itemLookup, lane],
  );
  const lanePoIds = useMemo(() => {
    const ids = new Set<string>();
    for (const line of poLines ?? []) {
      if (itemLookup.byId.get(line.qbo_item_id)?.inventory_lane === lane) ids.add(line.po_id);
    }
    return ids;
  }, [poLines, itemLookup, lane]);
  const laneWoIds = useMemo(
    () => new Set((filteredWos ?? []).map((w) => w.id)),
    [filteredWos],
  );
  // A run belongs to the lane its work orders are in (every flavour on a run is
  // a cans BOM today; the filter is here so the BIB lane never shows one).
  const laneRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const w of filteredWos ?? []) if (w.run_id) ids.add(w.run_id);
    return ids;
  }, [filteredWos]);
  const filteredRuns = useMemo(
    () => runs ? runs.filter((r) => r.wo_count === 0 || laneRunIds.has(r.id)) : null,
    [runs, laneRunIds],
  );
  // A PO belongs to this lane if it carries a lane item OR it was raised by a work
  // order in this lane. The second half matters: an ingredient PO is all `excluded`
  // items (a gallon of syrup and a run fee are not finished goods), so on lines
  // alone the AC Calderoni half of every run would be invisible and unopenable.
  const filteredPos = useMemo(
    () => pos && poLines
      ? pos.filter((po) => lanePoIds.has(po.id)
          || (po.work_order_id ? laneWoIds.has(po.work_order_id) : false)
          || (po.production_run_id ? laneRunIds.has(po.production_run_id) : false))
      : null,
    [pos, poLines, lanePoIds, laneWoIds, laneRunIds],
  );

  const activeLabel = visibleTabs.find((t) => t.id === tab)?.label ?? 'Production';
  const openCount = (filteredWos ?? []).filter((w) => !['closed', 'void', 'consumed'].includes(w.status)).length;
  const openRunCount = (filteredRuns ?? []).filter((r) => r.status === 'ordered' || r.status === 'in_progress').length;
  const openPoCount = (filteredPos ?? []).filter((p) => p.status === 'open' || p.status === 'partial').length;

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Production Orders · Formulas · BOM · Work Orders · POs · Licensing · Compliance · Run Guide</div>
          <h1 className="hero-title">Production</h1>
          <div className="hero-meta">
            {activeLabel} · {lane === 'bib_product' ? 'BIB Product' : 'Cans 24pks'} · {formulas?.length ?? 0} formula{(formulas?.length ?? 0) === 1 ? '' : 's'} · {filteredBoms?.length ?? 0} BOM{(filteredBoms?.length ?? 0) === 1 ? '' : 's'} · {openRunCount} open order{openRunCount === 1 ? '' : 's'} · {openCount} open WO{openCount === 1 ? '' : 's'} · {openPoCount} open PO{openPoCount === 1 ? '' : 's'}
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
            {lane === 'bib_product' ? 'Purchasing only' : 'Formula → raw materials → BOM → production order (one PO per vendor) → co-packer → yield → one BOL → receive'}
          </span>
        </div>
      </div>

      {tab === 'orders' && (
        <RunsTab
          runs={filteredRuns}
          boms={filteredBoms ?? []}
          vendors={vendors ?? []}
          locations={locations ?? []}
          itemLookup={itemLookup}
          initialRunId={routeParams.run ?? null}
          onChanged={reloadAll}
          onOpenPo={(id) => { setPoFocus(id); setTab('purchase_orders'); }}
          onOpenWo={(id) => { setWoFocus(id); setTab('work_orders'); }}
        />
      )}
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
          initialWoId={woFocus}
          onChanged={reloadAll}
        />
      )}
      {tab === 'raw_materials' && (
        <RawMaterialsTab vendors={vendors} onChanged={reloadAll} />
      )}
      {tab === 'compliance' && <ComplianceTab />}
      {tab === 'guide' && <RunGuideTab />}
      {tab === 'licensing' && <LicensingTab vendors={vendors} formulas={formulas} />}
      {tab === 'purchase_orders' && (
        <PurchaseOrdersTab
          vendors={vendors}
          purchaseOrders={filteredPos}
          locations={locations ?? []}
          locById={locById}
          itemLookup={itemLookup}
          lane={lane}
          initialPoId={routeParams.po ?? poFocus}
          onChanged={reloadAll}
        />
      )}
    </div>
  );
}
