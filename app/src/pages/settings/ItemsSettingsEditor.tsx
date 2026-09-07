// ⚠ CATEGORIES ARE NOT PUSHED TO QUICKBOOKS (2026-08-26, Sky).
// QBO item Categories were removed company-wide — every one of the 475 items
// in QuickBooks is now a bare name with no Category parent, and that is how
// it stays. The 'Push to QBO' button that lived here created QBO Category
// Items and set each item's ParentRef, so one click would have put all of
// them straight back; it and its review modal are gone.
//
// What REMAINS is deliberate: inventory_settings.category_override, 'Align
// all to P&L' and 'Smart suggest' are BRIX-LOCAL categorization used for
// margin reporting. They never touch QuickBooks. The red 'Clean up QBO
// categories' button also stays — it is the UNDO, useful if any category
// ever reappears.
//
// push-qbo-item's bulkSyncCategories action still exists server-side but has
// no caller. Do not wire a new one.
import { useEffect, useMemo, useState } from 'react';
import {
  DataGridPro,
  useGridApiRef,
  type GridColDef,
  type GridGroupNode,
  type GridValidRowModel,
} from '@mui/x-data-grid-pro';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { CheckCircle2, AlertTriangle, HelpCircle, Search, Sparkles, Zap, X, Eraser } from 'lucide-react';
import { QboCategoryCleanupModal } from './QboCategoryCleanupModal';
import { KPICard } from '../../components/KPICard';
import { QboConfirmModal } from '../../components/QboConfirmModal';
import { fm, fmtNum } from '../../lib/formatters';
import { inp } from '../../lib/styles';
import { sbrpc } from '../../lib/rpc';
import { useToast } from '../../lib/toast';
import {
  fetchCategoryList, setItemActiveAudited, logQboWritebackCancelled, logQboWriteback,
  pullQboItemsNow,
  fetchItemPlAudit, applyPlCategorySuggestions,
  fetchItemHygieneSummary,
  alignCategoriesToPl,
  fetchProductFamilies, fetchProductTypes, fetchSegmentOptions,
  setInventoryLane,
  setItemProductFamily, setItemProductType, setItemSegment,
  bulkSetItemProductFamily, bulkSetItemProductType, bulkSetItemSegment,
  type CategoryOption, type ItemPlAuditRow, type AlignmentStatus,
  type ItemHygieneRow, type HygieneBucket,
  type ProductFamily, type ProductType, type SegmentOption,
} from '../../lib/inventory';
import {
  INVENTORY_LANE_LABEL,
  INVENTORY_LANE_SIZE_LABEL,
  type InventoryLaneDb,
  type InventoryLaneSize,
} from '../../lib/inventoryLane';
import { fetchLocations, type InventoryLocation } from '../../lib/inventoryControl';

interface ItemMasterRow {
  qbo_item_id: string;
  item_name: string;
  fully_qualified_name: string | null;
  active: boolean;
  category_path: string | null;
  category_override: string | null;
  category_resolved: string;
  income_account_name: string | null;
  expense_account_name: string | null;
  on_hand: number;
  unit_price: number | null;
  purchase_cost: number | null;
  is_managed: boolean;
  is_planner: boolean;
  target_days_supply: number;
  lead_time_days: number;
  reorder_point: number | null;
  min_order_qty: number | null;
  notes: string | null;
  sold_qty: number;
  sold_revenue: number;
  customers_count: number;
  daily_velocity: number | null;
  days_of_supply: number | null;
  status: string;
  product_family_code: string | null;
  product_family_label: string | null;
  product_type_code: string | null;
  product_type_label: string | null;
  segment_code: string | null;
  segment_label: string | null;
  segment_source: 'item' | 'category' | null;
  track_locations: boolean;
  has_bom: boolean;
  inventory_lane: InventoryLaneDb;
  inventory_lane_size: InventoryLaneSize | null;
  inventory_lane_source: 'auto' | 'manual';
  inventory_lane_reviewed: boolean;
  default_receiving_location_id: string | null;
  weight_per_unit_lbs: number | null;
  units_per_pallet: number | null;
  freight_class: string | null;
  dim_l_in: number | null;
  dim_w_in: number | null;
  dim_h_in: number | null;
  unit_type: string | null;
  nmfc_code: string | null;
}

// GridRow combines the typed item shape with GridValidRowModel's loose
// index signature, which DataGridPro's `rows` prop requires.
type GridRow = ItemMasterRow & GridValidRowModel & {
  id: string;
  alignment_status?: AlignmentStatus;
  suggested_category?: string | null;
  account_category_consensus_pct?: number | null;
  dominant_category_for_account?: string | null;
};

const STATUS_COLOR: Record<string, string> = {
  reorder:  'var(--rd)', critical: 'var(--rd)',
  idle:     'var(--mt)', ok:       'var(--gn)',
  inactive: '#64748b',   overstock: '#a78bfa',
};

const ALIGNMENT_LABEL: Record<AlignmentStatus, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  aligned:              { label: 'Aligned',       color: 'var(--gn)', icon: CheckCircle2 },
  misaligned:           { label: 'Misaligned',    color: 'var(--am)', icon: AlertTriangle },
  isolated:             { label: 'Isolated',      color: 'var(--mt)', icon: HelpCircle },
  no_account:           { label: 'No account',    color: 'var(--mt)', icon: HelpCircle },
  unclassified_account: { label: 'Account TBD',   color: 'var(--mt)', icon: HelpCircle },
};

const INACTIVE_GROUP = 'INACTIVE';

import { GRID_SX as BASE_GRID_SX, GRID_DEFAULTS } from '../../lib/gridStyles';

// Shared grid skin + the tree-data grouping-toggle accent this editor needs.
const GRID_SX = {
  ...BASE_GRID_SX,
  '& .MuiDataGrid-groupingCriteriaCellToggle': { color: 'var(--ac)' },
};

const CAT_AC_SX = {
  width: '100%',
  '& .MuiOutlinedInput-root': {
    height: 26, minHeight: 26, fontFamily: 'inherit', fontSize: 11,
    background: 'var(--ctl-bg)', color: 'var(--tx)', padding: '0 6px',
    '& fieldset': { borderColor: 'var(--ctl-bd)' },
    '&:hover fieldset': { borderColor: 'var(--ac)' },
    '&.Mui-focused fieldset': { borderColor: 'var(--ac)' },
  },
  '& .MuiAutocomplete-input': { padding: '2px 0 !important', fontSize: 11, color: 'var(--tx)' },
  '& .MuiSvgIcon-root': { color: 'var(--mt)' },
};
const CAT_AC_PAPER = {
  paper: { sx: {
    background: 'var(--sf)', color: 'var(--tx)', border: '1px solid var(--bd)',
    fontSize: 11,
    '& .MuiAutocomplete-option': { fontSize: 11, color: 'var(--tx)' },
    '& .MuiAutocomplete-option.Mui-focused': { background: 'rgba(91,181,240,0.18)' },
  } },
};

function Toggle(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}) {
  return (
    <label className="switch" title={props.title}>
      <input type="checkbox" checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)} />
      <span className="switch-slider" />
    </label>
  );
}

function getTreeDataPath(row: Record<string, unknown>): string[] {
  return [
    String(row.active === false ? INACTIVE_GROUP : (row.category_resolved ?? 'Uncategorized')),
    String(row.qbo_item_id ?? ''),
  ];
}

function sortRows(a: ItemMasterRow, b: ItemMasterRow): number {
  if (a.is_managed !== b.is_managed) return a.is_managed ? -1 : 1;
  return (Number(b.sold_revenue) || 0) - (Number(a.sold_revenue) || 0);
}

export function ItemsSettingsEditor() {
  const toast = useToast();
  const [rows, setRows] = useState<ItemMasterRow[] | null>(null);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [auditByItem, setAuditByItem] = useState<Map<string, ItemPlAuditRow>>(new Map());
  const [search, setSearch] = useState('');
  const [showAlignment, setShowAlignment] = useState(false);
  const [misalignedOnly, setMisalignedOnly] = useState(false);
  const [applying, setApplying] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [aligning, setAligning] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [hygiene, setHygiene] = useState<ItemHygieneRow[]>([]);
  const [hygieneFilter, setHygieneFilter] = useState<HygieneBucket | null>(null);
  const [families, setFamilies] = useState<ProductFamily[]>([]);
  const [productTypes, setProductTypes] = useState<ProductType[]>([]);
  const [segmentOpts, setSegmentOpts] = useState<SegmentOption[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkFamily, setBulkFamily] = useState<string>('');
  const [bulkType, setBulkType] = useState<string>('');
  const [bulkSegment, setBulkSegment] = useState<string>('');
  const [activePrompt, setActivePrompt] = useState<{
    qbo_item_id: string; item_name: string; current: boolean; next: boolean;
  } | null>(null);
  const [activeBusy, setActiveBusy] = useState(false);
  const [qboSyncing, setQboSyncing] = useState(false);

  async function pullFromQbo() {
    if (qboSyncing) return;
    setQboSyncing(true);
    try {
      const r = await pullQboItemsNow();
      const parts: string[] = [];
      if (r.synced != null) parts.push(`${r.synced} items`);
      if (r.active_in_qbo != null && r.inactive_in_qbo != null) {
        parts.push(`${r.active_in_qbo} active / ${r.inactive_in_qbo} inactive`);
      }
      if (r.reconciled_inactive) parts.push(`${r.reconciled_inactive} reconciled`);
      const secs = r.duration_ms ? (r.duration_ms / 1000).toFixed(1) : '?';
      toast.success(`Synced from QBO (${secs}s): ${parts.join(', ')}`);
      load();
    } catch (e) {
      toast.error('QBO sync failed: ' + (e as Error).message);
    } finally {
      setQboSyncing(false);
    }
  }

  // Column layout persistence (order + widths + visibility). Uses MUI X
  // Pro's built-in exportState/restoreState — much more reliable than
  // hand-rolling column reordering. Saved layout is restored via the
  // `initialState` prop on mount; further changes save on every order or
  // width change.
  const apiRef = useGridApiRef();
  const LAYOUT_KEY = 'brix.items-master.layout-v2';
  const [layoutInitialState] = useState<unknown>(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });

  function persistLayout() {
    if (!apiRef.current) return;
    try {
      const state = apiRef.current.exportState();
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(state));
    } catch { /* swallow — layout save is best-effort */ }
  }

  function resetLayout() {
    localStorage.removeItem(LAYOUT_KEY);
    localStorage.removeItem('brix.items-master.layout-v1');
    window.location.reload();
  }

  function load() {
    setRows(null);
    Promise.all([
      sbrpc<ItemMasterRow[]>('fn_items_master', { p_lookback_days: 90, p_search: null }),
      fetchCategoryList(),
      fetchItemPlAudit(3),
      fetchItemHygieneSummary(),
      fetchProductFamilies(),
      fetchProductTypes(),
      fetchSegmentOptions(),
      fetchLocations(),
    ])
      .then(([rs, cs, audit, hy, fams, types, segs, locs]) => {
        setRows([...rs].sort(sortRows));
        setCategories(cs);
        const m = new Map<string, ItemPlAuditRow>();
        for (const a of audit) m.set(a.qbo_item_id, a);
        setAuditByItem(m);
        setHygiene(hy ?? []);
        setFamilies(fams);
        setProductTypes(types);
        setSegmentOpts(segs);
        setLocations(locs);
      })
      .catch((e) => { toast.error('Load failed: ' + (e as Error).message); setRows([]); });
  }
  useEffect(load, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    let list = rows;
    if (q) {
      list = list.filter((r) =>
        r.item_name.toLowerCase().includes(q)
        || (r.fully_qualified_name?.toLowerCase().includes(q) ?? false)
        || r.category_resolved.toLowerCase().includes(q)
        || (r.income_account_name?.toLowerCase().includes(q) ?? false)
        || (r.notes?.toLowerCase().includes(q) ?? false),
      );
    }
    if (misalignedOnly) {
      list = list.filter((r) => auditByItem.get(r.qbo_item_id)?.alignment_status === 'misaligned');
    }
    if (hygieneFilter) {
      const bucket = hygiene.find((h) => h.bucket === hygieneFilter);
      const names = new Set<string>((bucket?.detail ?? []) as unknown as string[]);
      list = list.filter((r) => names.has(r.item_name));
    }
    return list;
  }, [rows, search, misalignedOnly, auditByItem, hygieneFilter, hygiene]);

  const gridRows: GridRow[] = useMemo(
    () => filtered.map((r) => {
      const a = auditByItem.get(r.qbo_item_id);
      return {
        ...r, id: r.qbo_item_id,
        alignment_status:               a?.alignment_status,
        suggested_category:             a?.suggested_category,
        account_category_consensus_pct: a?.account_category_consensus_pct,
        dominant_category_for_account:  a?.dominant_category_for_account,
      } as GridRow;
    }),
    [filtered, auditByItem],
  );

  const categoryLabels = useMemo(() => categories.map((c) => c.label), [categories]);
  const physicalLocations = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );

  async function patchSettings(
    qbo_item_id: string,
    patchData: Partial<Pick<ItemMasterRow, 'is_managed' | 'is_planner' | 'target_days_supply' | 'lead_time_days' | 'reorder_point' | 'min_order_qty' | 'notes' | 'category_override' | 'track_locations' | 'has_bom' | 'weight_per_unit_lbs' | 'units_per_pallet' | 'freight_class' | 'dim_l_in' | 'dim_w_in' | 'dim_h_in' | 'unit_type' | 'nmfc_code'>>,
  ) {
    // The grid is tree-grouped by category; group rows have no qbo_item_id.
    // If a control on a group row fires this, silently ignore.
    if (!qbo_item_id) return;
    try {
      await sbrpc<void>('fn_set_inventory_settings', {
        p_qbo_item_id:         qbo_item_id,
        p_is_managed:          patchData.is_managed ?? null,
        p_is_planner:          patchData.is_planner ?? null,
        p_target_days_supply:  patchData.target_days_supply ?? null,
        p_lead_time_days:      patchData.lead_time_days ?? null,
        p_reorder_point:       patchData.reorder_point ?? null,
        p_min_order_qty:       patchData.min_order_qty ?? null,
        p_notes:               patchData.notes ?? null,
        p_category_override:   patchData.category_override ?? null,
        p_track_locations:     patchData.track_locations ?? null,
        p_has_bom:             patchData.has_bom ?? null,
        p_weight_per_unit_lbs: patchData.weight_per_unit_lbs ?? null,
        p_units_per_pallet:    patchData.units_per_pallet ?? null,
        p_freight_class:       patchData.freight_class ?? null,
        p_dim_l_in:            patchData.dim_l_in ?? null,
        p_dim_w_in:            patchData.dim_w_in ?? null,
        p_dim_h_in:            patchData.dim_h_in ?? null,
        p_unit_type:           patchData.unit_type ?? null,
        p_nmfc_code:           patchData.nmfc_code ?? null,
      });
      setRows((cur) => cur?.map((r) => {
        if (r.qbo_item_id !== qbo_item_id) return r;
        const next = { ...r, ...patchData };
        if ('category_override' in patchData) {
          next.category_resolved = patchData.category_override ?? r.category_path ?? 'Uncategorized';
        }
        return next;
      }) ?? cur);
      if (patchData.category_override && !categoryLabels.includes(patchData.category_override)) {
        fetchCategoryList().then(setCategories).catch(() => undefined);
      }
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  async function patchLane(
    qbo_item_id: string,
    patchData: Partial<Pick<ItemMasterRow,
      'inventory_lane' | 'inventory_lane_size' | 'inventory_lane_reviewed' | 'default_receiving_location_id'
    >>,
  ) {
    if (!qbo_item_id) return;
    const current = rows?.find((r) => r.qbo_item_id === qbo_item_id);
    if (!current) return;

    const nextLane = patchData.inventory_lane ?? current.inventory_lane ?? 'excluded';
    let nextSize = patchData.inventory_lane_size !== undefined
      ? patchData.inventory_lane_size
      : current.inventory_lane_size;
    if (nextLane === 'excluded') nextSize = null;
    if (nextLane === 'cans_24pk') nextSize = '24pk';
    if (nextLane === 'cans_8pk') nextSize = '8pk';
    if (nextLane === 'bib_product' && nextSize !== '3g' && nextSize !== '5g') nextSize = '3g';

    const nextReceivingLocation = patchData.default_receiving_location_id !== undefined
      ? patchData.default_receiving_location_id
      : current.default_receiving_location_id;
    const nextReviewed = patchData.inventory_lane_reviewed ?? current.inventory_lane_reviewed ?? true;

    try {
      await setInventoryLane({
        qbo_item_id,
        inventory_lane: nextLane,
        inventory_lane_size: nextSize,
        default_receiving_location_id: nextReceivingLocation,
        inventory_lane_reviewed: nextReviewed,
      });
      setRows((cur) => cur?.map((r) => r.qbo_item_id === qbo_item_id
        ? {
            ...r,
            inventory_lane: nextLane,
            inventory_lane_size: nextSize,
            inventory_lane_source: 'manual',
            inventory_lane_reviewed: nextReviewed,
            default_receiving_location_id: nextReceivingLocation,
            is_managed: nextLane !== 'excluded' ? true : r.is_managed,
            track_locations: nextLane !== 'excluded' ? true : r.track_locations,
            has_bom: nextLane === 'cans_24pk' ? true : ((nextLane === 'bib_product' || nextLane === 'cans_8pk') ? false : r.has_bom),
          }
        : r) ?? null);
    } catch (e) {
      toast.error('Lane save failed: ' + (e as Error).message);
    }
  }

  // Active toggle pushes to QuickBooks. Don't fire the writeback until the
  // user explicitly confirms via the diff modal — too easy to misclick and
  // mass-deactivate (cf. the 31-item incident on 2026-05-12).
  function patchActive(qbo_item_id: string, next: boolean) {
    if (!qbo_item_id) return;
    const row = (rows ?? []).find((r) => r.qbo_item_id === qbo_item_id);
    setActivePrompt({
      qbo_item_id,
      item_name: row?.item_name ?? '(unknown)',
      current: row?.active ?? !next,
      next,
    });
  }

  async function confirmActiveToggle() {
    if (!activePrompt) return;
    setActiveBusy(true);
    try {
      await setItemActiveAudited({
        qbo_item_id:    activePrompt.qbo_item_id,
        item_name:      activePrompt.item_name,
        current_active: activePrompt.current,
        next_active:    activePrompt.next,
      });
      setRows((cur) => cur?.map((r) =>
        r.qbo_item_id === activePrompt.qbo_item_id ? { ...r, active: activePrompt.next } : r,
      ) ?? cur);
      toast.success(activePrompt.next ? 'Reactivated in QBO.' : 'Deactivated in QBO.');
      setActivePrompt(null);
    } catch (e) {
      toast.error('Push to QBO failed: ' + (e as Error).message);
    } finally {
      setActiveBusy(false);
    }
  }

  async function cancelActiveToggle() {
    if (activePrompt) {
      // Log the cancellation so the audit trail captures "user almost
      // pushed X but bailed" — useful when reconstructing intent later.
      logQboWritebackCancelled({
        qbo_item_id:     activePrompt.qbo_item_id,
        item_name:       activePrompt.item_name,
        current_active:  activePrompt.current,
        intended_active: activePrompt.next,
      }).catch(() => undefined);
    }
    setActivePrompt(null);
  }

  async function applySuggestion(qbo_item_id: string, suggested: string) {
    await patchSettings(qbo_item_id, { category_override: suggested });
    fetchItemPlAudit(3).then((audit) => {
      const m = new Map<string, ItemPlAuditRow>();
      for (const a of audit) m.set(a.qbo_item_id, a);
      setAuditByItem(m);
    }).catch(() => undefined);
    toast.success('Applied: ' + suggested);
  }

  async function patchFamily(qbo_item_id: string, family_code: string | null) {
    if (!qbo_item_id) return;
    try {
      await setItemProductFamily(qbo_item_id, family_code);
      const label = family_code ? (families.find((f) => f.family_code === family_code)?.label ?? null) : null;
      setRows((cur) => cur?.map((r) =>
        r.qbo_item_id === qbo_item_id
          ? { ...r, product_family_code: family_code, product_family_label: label }
          : r,
      ) ?? cur);
    } catch (e) { toast.error('Save failed: ' + (e as Error).message); load(); }
  }

  async function patchType(qbo_item_id: string, type_code: string | null) {
    if (!qbo_item_id) return;
    try {
      await setItemProductType(qbo_item_id, type_code);
      const label = type_code ? (productTypes.find((t) => t.type_code === type_code)?.label ?? null) : null;
      setRows((cur) => cur?.map((r) =>
        r.qbo_item_id === qbo_item_id
          ? { ...r, product_type_code: type_code, product_type_label: label }
          : r,
      ) ?? cur);
    } catch (e) { toast.error('Save failed: ' + (e as Error).message); load(); }
  }

  async function patchSegment(qbo_item_id: string, segment_code: string | null) {
    if (!qbo_item_id) return;
    try {
      await setItemSegment(qbo_item_id, segment_code);
      // Setting to null falls back to category default — easier to reload than
      // try to derive the new effective label on the client.
      if (!segment_code) { load(); return; }
      const label = segmentOpts.find((s) => s.segment_code === segment_code)?.label ?? null;
      setRows((cur) => cur?.map((r) =>
        r.qbo_item_id === qbo_item_id
          ? { ...r, segment_code, segment_label: label, segment_source: 'item' }
          : r,
      ) ?? cur);
    } catch (e) { toast.error('Save failed: ' + (e as Error).message); load(); }
  }

  async function applyBulkFamily() {
    if (!selectedIds.length || !bulkFamily) return;
    try {
      const n = await bulkSetItemProductFamily(selectedIds, bulkFamily);
      toast.success(`Set family on ${n} item${n === 1 ? '' : 's'}.`);
      setBulkFamily('');
      load();
    } catch (e) { toast.error('Bulk save failed: ' + (e as Error).message); }
  }

  async function applyBulkType() {
    if (!selectedIds.length || !bulkType) return;
    try {
      const n = await bulkSetItemProductType(selectedIds, bulkType);
      toast.success(`Set type on ${n} item${n === 1 ? '' : 's'}.`);
      setBulkType('');
      load();
    } catch (e) { toast.error('Bulk save failed: ' + (e as Error).message); }
  }

  async function applyBulkSegment() {
    if (!selectedIds.length || !bulkSegment) return;
    try {
      const n = await bulkSetItemSegment(selectedIds, bulkSegment);
      toast.success(`Set segment on ${n} item${n === 1 ? '' : 's'}.`);
      setBulkSegment('');
      load();
    } catch (e) { toast.error('Bulk save failed: ' + (e as Error).message); }
  }

  async function runBulkAutoCategorize() {
    setApplying(true);
    try {
      const dryRun = await applyPlCategorySuggestions({ dry_run: true });
      if (!dryRun.length) {
        toast.info('No high-confidence suggestions to apply.');
        setApplying(false);
        return;
      }
      const ok = confirm(
        `Apply ${dryRun.length} P&L-driven category changes?\n\n`
        + dryRun.slice(0, 8).map((d) => `• ${d.item_name}: ${d.from_category} → ${d.to_category}`).join('\n')
        + (dryRun.length > 8 ? `\n• … and ${dryRun.length - 8} more` : '')
        + '\n\nEvery change reflects items sharing a P&L income account where ≥60% '
        + 'already use the same category. You can review on the Items grid after.',
      );
      if (!ok) { setApplying(false); return; }
      const applied = await applyPlCategorySuggestions({ dry_run: false });
      toast.success(`Applied ${applied.length} category updates from P&L alignment.`);
      load();
    } catch (e) {
      toast.error('Auto-categorize failed: ' + (e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  async function alignCategoriesToPlAccounts() {
    setAligning(true);
    try {
      const dry = await alignCategoriesToPl(false);
      const updates = dry.filter((r) => r.status === 'updated');
      const noAccount = dry.filter((r) => r.status === 'skipped_no_account');
      if (updates.length === 0) {
        toast.info('All active items already match their P&L account.');
        setAligning(false);
        return;
      }
      const accountCounts: Record<string, number> = {};
      for (const u of updates) {
        const acc = u.to_category ?? '—';
        accountCounts[acc] = (accountCounts[acc] ?? 0) + 1;
      }
      const accountList = Object.entries(accountCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([acc, n]) => '• ' + acc + ' (' + n + ')')
        .join('\n');
      const ok = confirm(
        'Align all categories to P&L income accounts?\n\n'
        + updates.length + ' item(s) will be re-categorized to match their P&L flow.\n'
        + (noAccount.length > 0 ? noAccount.length + ' item(s) skipped (no income account in QBO).\n' : '')
        + '\nTop categories that will be set:\n' + accountList
        + (Object.keys(accountCounts).length > 8 ? '\n• … and ' + (Object.keys(accountCounts).length - 8) + ' more' : '')
        + '\n\nThis overwrites every existing category_override. After this you can push back to QBO so the catalog matches.',
      );
      if (!ok) { setAligning(false); return; }
      const result = await alignCategoriesToPl(true);
      const applied = result.filter((r) => r.applied).length;
      toast.success('Aligned ' + applied + ' item(s) to P&L accounts. Run "Push to QBO" to sync the catalog.');
      load();
    } catch (e) {
      toast.error('Align failed: ' + (e as Error).message);
    } finally {
      setAligning(false);
    }
  }




  const alignmentSummary = useMemo(() => {
    const summary: Record<AlignmentStatus, number> = {
      aligned: 0, misaligned: 0, isolated: 0, no_account: 0, unclassified_account: 0,
    };
    let suggestions = 0;
    auditByItem.forEach((a) => {
      summary[a.alignment_status] = (summary[a.alignment_status] ?? 0) + 1;
      if (a.suggested_category) suggestions += 1;
    });
    return { ...summary, suggestions };
  }, [auditByItem]);

  const columns: GridColDef[] = useMemo(() => {
    const cols: GridColDef[] = [
      {
        field: 'active', headerName: 'Active', width: 70, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <Toggle
              checked={!!p.value}
              onChange={(v) => patchActive(p.row.qbo_item_id, v)}
              title="Active in QBO. Toggling here pushes to QuickBooks via push-qbo-item edge function."
            />
          );
        },
      },
      {
        field: 'is_managed', headerName: 'Managed', width: 90, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <Toggle
              checked={!!p.value}
              onChange={(v) => patchSettings(p.row.qbo_item_id, { is_managed: v })}
              title="If on, this item appears in the Inventory health view with velocity, reorder, days-of-supply."
            />
          );
        },
      },
      {
        field: 'is_planner', headerName: 'In planner', width: 90, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <Toggle
              checked={!!p.value}
              onChange={(v) => patchSettings(p.row.qbo_item_id, { is_planner: v })}
              title="If on, this item appears in the Plan Builder (item × customer × month grid). Use for SKUs you actively budget."
            />
          );
        },
      },
      {
        field: 'track_locations', headerName: 'Stock', width: 80, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <Toggle
              checked={!!p.value}
              onChange={(v) => patchSettings(p.row.qbo_item_id, { track_locations: v })}
              title="If on, this item participates in the Stock multi-location ledger (#/stock). On-hand by warehouse, transfers, movement audit. Default off — opt in per SKU."
            />
          );
        },
      },
      {
        field: 'has_bom', headerName: 'BOM', width: 80, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <Toggle
              checked={!!p.value}
              onChange={(v) => patchSettings(p.row.qbo_item_id, { has_bom: v })}
              title="If on, this item is treated as a manufactured/assembled SKU built from components. Drives the Phase 2 BOM editor + work-order cost rollup."
            />
          );
        },
      },
      {
        field: 'inventory_lane', headerName: 'Lane', width: 140, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          const value = (p.value ?? 'excluded') as InventoryLaneDb;
          return (
            <select
              value={value}
              onChange={(e) => patchLane(p.row.qbo_item_id, { inventory_lane: e.target.value as InventoryLaneDb })}
              style={{ ...inp(), width: 120 }}
              title="Daily inventory lane. Only BIB Product, Cans 24pks and Cans 8pks appear in operator inventory screens."
            >
              <option value="bib_product">{INVENTORY_LANE_LABEL.bib_product}</option>
              <option value="cans_24pk">{INVENTORY_LANE_LABEL.cans_24pk}</option>
              <option value="cans_8pk">{INVENTORY_LANE_LABEL.cans_8pk}</option>
              <option value="excluded">{INVENTORY_LANE_LABEL.excluded}</option>
            </select>
          );
        },
      },
      {
        field: 'inventory_lane_size', headerName: 'Lane Size', width: 105, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          const lane = (p.row.inventory_lane ?? 'excluded') as InventoryLaneDb;
          const value = (p.value ?? '') as InventoryLaneSize | '';
          if (lane === 'excluded') return <span style={{ color: 'var(--mt)' }}>—</span>;
          return (
            <select
              value={value}
              onChange={(e) => patchLane(p.row.qbo_item_id, { inventory_lane_size: e.target.value as InventoryLaneSize })}
              style={{ ...inp(), width: 82 }}
            >
              {lane === 'bib_product' && (
                <>
                  <option value="3g">{INVENTORY_LANE_SIZE_LABEL['3g']}</option>
                  <option value="5g">{INVENTORY_LANE_SIZE_LABEL['5g']}</option>
                </>
              )}
              {lane === 'cans_24pk' && <option value="24pk">{INVENTORY_LANE_SIZE_LABEL['24pk']}</option>}
              {lane === 'cans_8pk' && <option value="8pk">{INVENTORY_LANE_SIZE_LABEL['8pk']}</option>}
            </select>
          );
        },
      },
      {
        field: 'inventory_lane_source', headerName: 'Lane Src', width: 90, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <span style={{
              color: p.value === 'manual' ? 'var(--ac)' : 'var(--mt)',
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}>
              {String(p.value ?? 'auto')}
            </span>
          );
        },
      },
      {
        field: 'inventory_lane_reviewed', headerName: 'Reviewed', width: 90, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <Toggle
              checked={!!p.value}
              onChange={(v) => patchLane(p.row.qbo_item_id, { inventory_lane_reviewed: v })}
              title="Marks this lane classification as reviewed. Manual reviewed rows are protected from future auto-classification sweeps."
            />
          );
        },
      },
      {
        field: 'default_receiving_location_id', headerName: 'Recv Loc', width: 150, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          const lane = (p.row.inventory_lane ?? 'excluded') as InventoryLaneDb;
          if (lane === 'excluded') return <span style={{ color: 'var(--mt)' }}>—</span>;
          return (
            <select
              value={String(p.value ?? '')}
              onChange={(e) => patchLane(p.row.qbo_item_id, { default_receiving_location_id: e.target.value || null })}
              style={{ ...inp(), width: 130 }}
              title="Suggested destination location for POs generated from inventory planning."
            >
              <option value="">—</option>
              {physicalLocations.map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.code} — {loc.name}</option>
              ))}
            </select>
          );
        },
      },
      {
        field: 'weight_per_unit_lbs', headerName: 'Wt/Unit (lb)', type: 'number', width: 110, cellClassName: 'mn', sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="number" step="any" defaultValue={p.value ?? ''}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { weight_per_unit_lbs: v });
              }}
              style={{ ...inp(), width: 80, textAlign: 'right' }} />
          );
        },
      },
      {
        field: 'units_per_pallet', headerName: 'Units/Pallet', type: 'number', width: 110, cellClassName: 'mn', sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="number" step="any" defaultValue={p.value ?? ''}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { units_per_pallet: v });
              }}
              style={{ ...inp(), width: 80, textAlign: 'right' }} />
          );
        },
      },
      {
        field: 'freight_class', headerName: 'Freight Cls', width: 100, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <select
              defaultValue={p.value ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? null : e.target.value;
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { freight_class: v });
              }}
              style={{ ...inp(), width: 80 }}
            >
              <option value="">—</option>
              {['50','55','60','65','70','77.5','85','92.5','100','110','125','150','175','200','250','300','400','500'].map((c) =>
                <option key={c} value={c}>{c}</option>
              )}
            </select>
          );
        },
      },
      {
        field: 'nmfc_code', headerName: 'NMFC #', width: 90, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="text" defaultValue={p.value ?? ''} maxLength={20}
              onBlur={(e) => {
                const v = e.target.value.trim() === '' ? null : e.target.value.trim();
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { nmfc_code: v });
              }}
              style={{ ...inp(), width: 70, fontFamily: 'var(--ff-mono)' }}
              placeholder="—" />
          );
        },
      },
      {
        field: 'unit_type', headerName: 'Unit Type', width: 95, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <select defaultValue={p.value ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? null : e.target.value;
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { unit_type: v });
              }}
              style={{ ...inp(), width: 80 }}
            >
              <option value="">—</option>
              {['case','pallet','drum','each','bag','crate','box','tote','keg','barrel'].map((u) =>
                <option key={u} value={u}>{u}</option>
              )}
            </select>
          );
        },
      },
      {
        field: 'dim_l_in', headerName: 'L (in)', type: 'number', width: 75, cellClassName: 'mn', sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="number" min={0} step="any" defaultValue={p.value ?? ''}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { dim_l_in: v });
              }}
              style={{ ...inp(), width: 55, textAlign: 'right' }} />
          );
        },
      },
      {
        field: 'dim_w_in', headerName: 'W (in)', type: 'number', width: 75, cellClassName: 'mn', sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="number" min={0} step="any" defaultValue={p.value ?? ''}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { dim_w_in: v });
              }}
              style={{ ...inp(), width: 55, textAlign: 'right' }} />
          );
        },
      },
      {
        field: 'dim_h_in', headerName: 'H (in)', type: 'number', width: 75, cellClassName: 'mn', sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="number" min={0} step="any" defaultValue={p.value ?? ''}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { dim_h_in: v });
              }}
              style={{ ...inp(), width: 55, textAlign: 'right' }} />
          );
        },
      },
      {
        field: 'category_override', headerName: 'Category', width: 220,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          const cur = p.row.category_override as string | null;
          const inherited = p.row.category_path as string | null;
          const value = cur ?? '';
          return (
            <Autocomplete
              size="small" freeSolo
              options={categoryLabels}
              value={value}
              onChange={(_, v) => {
                const next = (v ?? '').toString().trim();
                if (next !== (cur ?? '')) patchSettings(p.row.qbo_item_id, { category_override: next || null });
              }}
              onBlur={(e) => {
                const next = (e.target as HTMLInputElement).value.trim();
                if (next !== (cur ?? '')) patchSettings(p.row.qbo_item_id, { category_override: next || null });
              }}
              sx={CAT_AC_SX} slotProps={CAT_AC_PAPER}
              renderInput={(params) => <TextField {...params} placeholder={inherited ?? 'set category'} />}
            />
          );
        },
      },
      {
        field: 'segment_label', headerName: 'Segment', width: 180, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          const curCode = p.row.segment_code as string | null;
          const curLabel = p.row.segment_label as string | null;
          const source = p.row.segment_source as 'item' | 'category' | null;
          const selected = curCode ? (segmentOpts.find((s) => s.segment_code === curCode) ?? null) : null;
          return (
            <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 4 }}>
              <Autocomplete<SegmentOption, false, false, false>
                size="small"
                options={segmentOpts}
                value={selected}
                getOptionLabel={(o) => o.label}
                isOptionEqualToValue={(a, b) => a.segment_code === b.segment_code}
                onChange={(_, v) => {
                  const next = v?.segment_code ?? null;
                  if (next !== (curCode ?? null)) patchSegment(p.row.qbo_item_id, next);
                }}
                sx={{ ...CAT_AC_SX, flex: 1 }} slotProps={CAT_AC_PAPER}
                renderInput={(params) => <TextField {...params} placeholder={curLabel ?? 'set segment'} />}
              />
              {source === 'category' && (
                <span title="Inherited from category default (no per-item override)" style={{
                  fontSize: 9, color: 'var(--mt)', letterSpacing: 0.4,
                }}>cat</span>
              )}
            </div>
          );
        },
      },
      {
        field: 'product_family_label', headerName: 'Family', width: 170, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          const curCode = p.row.product_family_code as string | null;
          const curLabel = p.row.product_family_label as string | null;
          const selected = curCode ? (families.find((f) => f.family_code === curCode) ?? null) : null;
          return (
            <Autocomplete<ProductFamily, false, false, false>
              size="small"
              options={families}
              value={selected}
              getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(a, b) => a.family_code === b.family_code}
              onChange={(_, v) => {
                const next = v?.family_code ?? null;
                if (next !== (curCode ?? null)) patchFamily(p.row.qbo_item_id, next);
              }}
              sx={CAT_AC_SX} slotProps={CAT_AC_PAPER}
              renderInput={(params) => <TextField {...params} placeholder={curLabel ?? 'set family'} />}
            />
          );
        },
      },
      {
        field: 'product_type_label', headerName: 'Type', width: 160, sortable: true,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          const curCode = p.row.product_type_code as string | null;
          const curLabel = p.row.product_type_label as string | null;
          const selected = curCode ? (productTypes.find((t) => t.type_code === curCode) ?? null) : null;
          return (
            <Autocomplete<ProductType, false, false, false>
              size="small"
              options={productTypes}
              value={selected}
              getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(a, b) => a.type_code === b.type_code}
              onChange={(_, v) => {
                const next = v?.type_code ?? null;
                if (next !== (curCode ?? null)) patchType(p.row.qbo_item_id, next);
              }}
              sx={CAT_AC_SX} slotProps={CAT_AC_PAPER}
              renderInput={(params) => <TextField {...params} placeholder={curLabel ?? 'set type'} />}
            />
          );
        },
      },
    ];

    if (showAlignment) {
      cols.push(
        {
          field: 'alignment_status', headerName: 'P&L Align', width: 130, sortable: true,
          renderCell: (p) => {
            const s = p.value as AlignmentStatus | undefined;
            if (!s) return <span style={{ color: 'var(--mt)' }}>—</span>;
            const meta = ALIGNMENT_LABEL[s];
            const Icon = meta.icon;
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: meta.color, fontWeight: 600 }}>
                <Icon size={11} strokeWidth={2.4} aria-hidden="true" />
                {meta.label}
              </span>
            );
          },
        },
        {
          field: 'suggested_category', headerName: 'Suggested', flex: 1, minWidth: 220,
          renderCell: (p) => {
            if (p.rowNode.type === 'group') return null;
            const s = p.value as string | null | undefined;
            if (!s) {
              const dom = p.row.dominant_category_for_account as string | null | undefined;
              const pct = p.row.account_category_consensus_pct as number | null | undefined;
              if (dom && pct != null && pct < 60) {
                return <span style={{ color: 'var(--mt)', fontSize: 10 }}>account split — manual review</span>;
              }
              return <span style={{ color: 'var(--mt)' }}>—</span>;
            }
            const pct = p.row.account_category_consensus_pct as number | null | undefined;
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span style={{ color: 'var(--ac)', fontWeight: 600 }}>{s}</span>
                {pct != null && (
                  <span style={{ color: 'var(--mt)', fontSize: 9 }}>{pct.toFixed(0)}% consensus</span>
                )}
                <button
                  onClick={() => applySuggestion(p.row.qbo_item_id, s)}
                  className="tb-btn tb-btn--primary"
                  style={{ padding: '2px 8px', fontSize: 10, fontWeight: 600 }}
                  title={'Apply suggested category: ' + s}
                >Apply</button>
              </span>
            );
          },
        },
        {
          field: 'income_account_name', headerName: 'P&L Account', width: 180,
          renderCell: (p) => (
            <span style={{ color: p.value ? 'var(--tx2)' : 'var(--mt)', fontSize: 10.5,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block',
            }}>{p.value || '—'}</span>
          ),
        },
      );
    }

    cols.push(
      { field: 'on_hand', headerName: 'On Hand', type: 'number', width: 90, cellClassName: 'mn',
        valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
      { field: 'daily_velocity', headerName: 'Vel/day', type: 'number', width: 90, cellClassName: 'mn',
        valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
      {
        field: 'days_of_supply', headerName: 'Days Supply', type: 'number', width: 110, cellClassName: 'mn',
        valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0)),
      },
      {
        field: 'status', headerName: 'Status', width: 110,
        renderCell: (p) => {
          if (!p.value) return null;
          const c = STATUS_COLOR[p.value as string] ?? 'var(--mt)';
          return (
            <span style={{
              background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
              padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
            }}>{String(p.value).toUpperCase()}</span>
          );
        },
      },
      {
        field: 'target_days_supply', headerName: 'Target Days', type: 'number', width: 100, cellClassName: 'mn',
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="number" defaultValue={p.value ?? 30}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { target_days_supply: v });
              }}
              style={{ ...inp(), width: 60, textAlign: 'right' }} />
          );
        },
      },
      {
        field: 'lead_time_days', headerName: 'Lead Time', type: 'number', width: 100, cellClassName: 'mn',
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="number" defaultValue={p.value ?? 7}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { lead_time_days: v });
              }}
              style={{ ...inp(), width: 60, textAlign: 'right' }} />
          );
        },
      },
      {
        field: 'reorder_point', headerName: 'Reorder Pt', type: 'number', width: 110, cellClassName: 'mn',
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="number" defaultValue={p.value ?? ''}
              placeholder="auto"
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { reorder_point: v });
              }}
              style={{ ...inp(), width: 70, textAlign: 'right' }} />
          );
        },
      },
      {
        field: 'min_order_qty', headerName: 'Min Order', type: 'number', width: 100, cellClassName: 'mn',
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="number" defaultValue={p.value ?? ''}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== p.value) patchSettings(p.row.qbo_item_id, { min_order_qty: v });
              }}
              style={{ ...inp(), width: 70, textAlign: 'right' }} />
          );
        },
      },
      { field: 'sold_revenue', headerName: 'Rev 90d', type: 'number', width: 110, cellClassName: 'mn',
        valueFormatter: (v) => fm(Number(v ?? 0)) },
      {
        field: 'notes', headerName: 'Notes', flex: 1, minWidth: 200,
        renderCell: (p) => {
          if (p.rowNode.type === 'group') return null;
          return (
            <input type="text" defaultValue={p.value ?? ''}
              placeholder="—"
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== (p.value ?? '')) patchSettings(p.row.qbo_item_id, { notes: v || null });
              }}
              style={{ ...inp(), width: '100%', fontSize: 11 }} />
          );
        },
      },
    );

    return cols;
    // Column order + widths are restored by MUI X via initialState —
    // not here. Don't add the saved state to deps; otherwise we'd
    // re-render columns on every persist and lose the user's in-flight
    // drag.
  }, [categoryLabels, showAlignment, families, productTypes, segmentOpts, physicalLocations]); // eslint-disable-line react-hooks/exhaustive-deps

  // Make group rows span the whole grid (no toggles, no "0"s in numeric
  // cells, no autocomplete dropdowns) — the category header sits alone.
  const groupingColDef = useMemo(() => ({
    headerName: 'Category / Item', width: 360, hideDescendantCount: false,
    colSpan: (_value: unknown, row: Record<string, unknown>) => {
      // MUI X v7: when colSpan returns > 1, that cell occupies adjacent
      // columns. We use it for group rows (active===undefined on the
      // synthetic group row) to span across all data columns.
      const isGroup = row?.qbo_item_id == null;
      return isGroup ? columns.length + 1 : 1;
    },
    renderCell: (params: {
      rowNode: { type: string; groupingKey?: string | number | null };
      row: { item_name?: string };
    }) => {
      if (params.rowNode.type === 'group') {
        const key = params.rowNode.groupingKey;
        return <strong style={{ color: 'var(--ac)' }}>{key == null ? '—' : String(key)}</strong>;
      }
      return <span style={{ fontWeight: 600 }}>{String(params.row.item_name ?? '')}</span>;
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any, [columns.length]);

  if (!rows) return <div className="ld">Loading items…</div>;

  const activeCount      = rows.filter((r) => r.active).length;
  const inactiveCount    = rows.filter((r) => !r.active).length;
  const managedCount     = rows.filter((r) => r.is_managed).length;
  const withOverrideCount = rows.filter((r) => r.category_override).length;

  const pushPassword = (import.meta.env.VITE_QBO_PUSH_PASSWORD as string | undefined) ?? 'BRIX-CONFIRM';

  return (
    <div>
      <QboConfirmModal
        open={!!activePrompt}
        title={activePrompt?.next ? 'Reactivate item in QuickBooks?' : 'Deactivate item in QuickBooks?'}
        subtitle={activePrompt?.item_name ?? undefined}
        fields={activePrompt ? [
          {
            label: 'Active',
            before: activePrompt.current ? 'Active' : 'Inactive',
            after:  activePrompt.next    ? 'Active' : 'Inactive',
          },
          {
            label: 'Name',
            before: activePrompt.item_name,
            after:  activePrompt.next
              ? activePrompt.item_name.replace(/\s*\(deleted\)\s*$/i, '')
              : (activePrompt.item_name.endsWith(' (deleted)')
                  ? activePrompt.item_name
                  : activePrompt.item_name + ' (deleted)'),
            warn: activePrompt.next
              ? "Reactivating doesn't auto-strip the suffix on QBO's side; we'll rename it for you in the same push."
              : 'QuickBooks automatically appends " (deleted)" to the item name on deactivation. Reactivating later does NOT strip it back unless we explicitly rename.',
          },
        ] : []}
        confirmLabel={activePrompt?.next ? 'Reactivate in QBO' : 'Deactivate in QBO'}
        confirmDanger={!activePrompt?.next}
        onCancel={cancelActiveToggle}
        onConfirm={confirmActiveToggle}
        busy={activeBusy}
      />

      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="ITEMS TOTAL"     value={rows.length} sub={`${activeCount} active · ${inactiveCount} inactive`} />
        <KPICard title="MANAGED"          value={managedCount} accent="var(--ac)" sub="velocity-driven reorder" />
        <KPICard title="CATEGORIES"      value={categories.length} sub={withOverrideCount + ' overrides'} />
        <KPICard
          title="P&L ALIGNMENT"
          value={alignmentSummary.misaligned}
          accent={alignmentSummary.misaligned > 0 ? 'var(--am)' : 'var(--gn)'}
          sub={alignmentSummary.suggestions > 0
            ? alignmentSummary.suggestions + ' high-confidence fixes ready'
            : `${alignmentSummary.aligned} aligned · ${alignmentSummary.isolated} isolated`}
        />
      </div>

      {hygiene.some((h) => h.item_count > 0) && (
        <div className="cd" style={{
          padding: '10px 12px', marginBottom: 12, display: 'flex',
          gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
          borderColor: 'var(--bd)',
        }}>
          <span style={{ color: 'var(--mt)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 600 }}>
            Data hygiene
          </span>
          {hygiene.filter((h) => h.item_count > 0).map((h) => {
            const active = hygieneFilter === h.bucket;
            const color = h.bucket === 'no_income_account' ? 'var(--rd)'
              : h.bucket === 'no_category' ? 'var(--am)'
              : 'var(--mt)';
            return (
              <button
                key={h.bucket}
                onClick={() => setHygieneFilter(active ? null : h.bucket)}
                className={'tb-btn' + (active ? ' tb-btn--primary' : '')}
                style={{
                  fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6,
                  color: active ? undefined : color,
                  borderColor: active ? undefined : color,
                }}
                title={h.label}
              >
                <strong style={{ fontFamily: 'var(--ff-mono)' }}>{h.item_count}</strong>
                <span>{h.label}</span>
              </button>
            );
          })}
          {hygieneFilter && (
            <button onClick={() => setHygieneFilter(null)} className="tb-btn" style={{ marginLeft: 6, color: 'var(--mt)' }}>
              clear filter
            </button>
          )}
        </div>
      )}

      <div className="cd" style={{
        padding: '10px 12px', marginBottom: 14, display: 'flex',
        gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', height: 30, borderRadius: 4,
          background: 'var(--ctl-bg)', border: '1px solid var(--ctl-bd)', minWidth: 260,
        }}>
          <Search size={13} strokeWidth={2.2} color="var(--mt)" aria-hidden="true" />
          <input type="text" value={search} placeholder="Search name, category, account, notes…"
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--tx)', fontFamily: 'var(--ff-mono)', fontSize: 12,
              flex: 1, padding: 0,
            }} />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex' }}>
              <X size={12} strokeWidth={2.4} color="var(--mt)" />
            </button>
          )}
        </div>
        <span style={{ color: 'var(--mt)', marginLeft: 6 }}>
          {filtered.length} of {rows.length} items
        </span>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 10, cursor: 'pointer', color: 'var(--mt)' }}>
          <input type="checkbox" checked={showAlignment} onChange={(e) => setShowAlignment(e.target.checked)}
            style={{ accentColor: 'var(--ac)' }} />
          P&amp;L alignment cols
        </label>
        {showAlignment && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--am)' }}>
            <input type="checkbox" checked={misalignedOnly} onChange={(e) => setMisalignedOnly(e.target.checked)}
              style={{ accentColor: 'var(--am)' }} />
            misaligned only
          </label>
        )}

        <button
          onClick={alignCategoriesToPlAccounts}
          disabled={aligning}
          className="tb-btn"
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          title="Force every active item's category to match its P&L income account name. Overwrites every override."
        >
          <Zap size={12} strokeWidth={2.4} aria-hidden="true" />
          {aligning ? 'Aligning…' : 'Align all to P&L'}
        </button>
        <button
          onClick={runBulkAutoCategorize}
          disabled={applying || alignmentSummary.suggestions === 0}
          className="tb-btn tb-btn--primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          title={alignmentSummary.suggestions === 0 ? 'Nothing to auto-categorize' : 'Auto-apply only high-confidence P&L category suggestions (60%+ consensus)'}
        >
          <Sparkles size={12} strokeWidth={2.4} aria-hidden="true" />
          {applying ? 'Applying…' : `Smart suggest (${alignmentSummary.suggestions})`}
        </button>
        <button
          onClick={() => setCleanupOpen(true)}
          className="tb-btn"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            color: 'var(--rd)', borderColor: 'var(--rd)',
          }}
          title="One-shot QBO cleanup — flatten every sub-item and inactivate the QBO Category items. Removes the Category:Item prefix from QBO transactions, reports, and invoices. BRIX categories stay intact."
        >
          <Eraser size={12} strokeWidth={2.4} aria-hidden="true" />
          Cleanup QBO categories
        </button>
        <button onClick={load} className="tb-btn">Refresh</button>
        <button onClick={pullFromQbo} disabled={qboSyncing}
          className={'tb-btn' + (qboSyncing ? '' : ' tb-btn--primary')}
          title="Pull the latest item master + active/inactive from QuickBooks now (otherwise waits for the 1:30 AM PT nightly sync)">
          {qboSyncing ? 'Pulling from QBO…' : 'Pull from QBO'}
        </button>
        <button onClick={resetLayout} className="tb-btn"
          title="Reset column order, widths, and visibility to defaults">
          Reset layout
        </button>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {filtered.length === 0 ? (
          <div className="ld">No items match.</div>
        ) : (
          <DataGridPro
            apiRef={apiRef}
            rows={gridRows} columns={columns}
            treeData getTreeDataPath={getTreeDataPath}
            groupingColDef={groupingColDef}
            density="compact" pagination disableRowSelectionOnClick
            checkboxSelection
            // Group rows shouldn't show a checkbox — only leaf rows are selectable.
            isRowSelectable={(params) => params.row?.qbo_item_id != null}
            onRowSelectionModelChange={(model) => {
              setSelectedIds(model.map(String).filter((id) => !id.startsWith('auto-generated-row-')));
            }}
            // Persist column order, widths, visibility, pinning on
            // every change. MUI X handles the in-grid state itself —
            // we just snapshot to localStorage.
            onColumnOrderChange={persistLayout}
            onColumnWidthChange={persistLayout}
            onColumnVisibilityModelChange={persistLayout}
            onPinnedColumnsChange={persistLayout}
            pageSizeOptions={[20, 40, 60, 100, 250, { value: -1, label: 'All' }]}
            defaultGroupingExpansionDepth={1}
            // Restore saved layout (column order, widths, visibility,
            // filters) on top of our defaults. The saved state wins for
            // any key it specifies; the rest fall through to defaults.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            initialState={{
              pagination: { paginationModel: { pageSize: 60, page: 0 } },
              sorting: { sortModel: [{ field: 'is_managed', sort: 'desc' }] },
              ...(typeof layoutInitialState === 'object' && layoutInitialState ? (layoutInitialState as Record<string, unknown>) : {}),
            }}
            isGroupExpandedByDefault={(node: GridGroupNode) => node.groupingKey !== INACTIVE_GROUP}
            {...GRID_DEFAULTS}
            sx={GRID_SX}
          />
        )}
      </div>

      {selectedIds.length > 0 && (
        <div className="cd" style={{
          padding: '10px 12px', marginTop: 10, display: 'flex',
          gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
        }}>
          <span style={{ color: 'var(--mt)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 600 }}>
            Bulk assign · {selectedIds.length} selected
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--mt)' }}>segment:</span>
            <select value={bulkSegment} onChange={(e) => setBulkSegment(e.target.value)}
              style={{ ...inp(), padding: '4px 6px', minWidth: 180 }}>
              <option value="">— pick —</option>
              {segmentOpts.map((s) => <option key={s.segment_code} value={s.segment_code}>{s.label}</option>)}
            </select>
            <button className="tb-btn tb-btn--primary" onClick={applyBulkSegment}
              disabled={!bulkSegment}>Apply</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--mt)' }}>family:</span>
            <select value={bulkFamily} onChange={(e) => setBulkFamily(e.target.value)}
              style={{ ...inp(), padding: '4px 6px', minWidth: 160 }}>
              <option value="">— pick —</option>
              {families.map((f) => <option key={f.family_code} value={f.family_code}>{f.label}</option>)}
            </select>
            <button className="tb-btn tb-btn--primary" onClick={applyBulkFamily}
              disabled={!bulkFamily}>Apply</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--mt)' }}>type:</span>
            <select value={bulkType} onChange={(e) => setBulkType(e.target.value)}
              style={{ ...inp(), padding: '4px 6px', minWidth: 160 }}>
              <option value="">— pick —</option>
              {productTypes.map((t) => <option key={t.type_code} value={t.type_code}>{t.label}</option>)}
            </select>
            <button className="tb-btn tb-btn--primary" onClick={applyBulkType}
              disabled={!bulkType}>Apply</button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 8, lineHeight: 1.4 }}>
        <strong style={{ color: 'var(--tx)' }}>P&amp;L alignment.</strong> Each item flows revenue into a
        QBO income account. The audit groups items by account and surfaces categories where ≥60% of items
        already agree. Apply individual suggestions or click <em>Smart suggest</em> to commit
        high-confidence ones. <em>Align all to P&amp;L</em> force-sets every category to its income account name.
      </div>
      <QboCategoryCleanupModal open={cleanupOpen} onClose={() => setCleanupOpen(false)} />
    </div>
  );
}
