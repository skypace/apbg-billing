import { useEffect, useMemo, useState } from 'react';
import {
  DataGridPro,
  type GridColDef,
  type GridGroupNode,
  type GridValidRowModel,
} from '@mui/x-data-grid-pro';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { CheckCircle2, AlertTriangle, HelpCircle, Search, Sparkles, UploadCloud, Zap, X } from 'lucide-react';
import { KPICard } from '../../components/KPICard';
import { fm, fmtNum } from '../../lib/formatters';
import { inp } from '../../lib/styles';
import { sbrpc } from '../../lib/rpc';
import { useToast } from '../../lib/toast';
import {
  fetchCategoryList, setItemActive,
  fetchItemPlAudit, applyPlCategorySuggestions,
  bulkSyncCategoriesToQbo,
  fetchItemHygieneSummary,
  alignCategoriesToPl,
  fetchProductFamilies, fetchProductTypes,
  setItemProductFamily, setItemProductType,
  bulkSetItemProductFamily, bulkSetItemProductType,
  type CategoryOption, type ItemPlAuditRow, type AlignmentStatus,
  type ItemHygieneRow, type HygieneBucket,
  type ProductFamily, type ProductType,
} from '../../lib/inventory';

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

const GRID_SX = {
  height: '64vh', border: 'none', background: 'transparent', color: 'var(--ink)',
  fontFamily: 'inherit', fontSize: 12,
  '--DataGrid-rowBorderColor': 'rgba(255,255,255,0.04)',
  '--DataGrid-containerBackground': 'var(--sf)',
  '& .MuiDataGrid-columnHeaders': { background: 'var(--sf)', borderBottom: '1px solid var(--bd)' },
  '& .MuiDataGrid-columnHeader': {
    fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
    fontSize: 10.5, color: 'var(--mt)',
  },
  '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },
  '& .MuiDataGrid-cell': { borderBottom: '1px solid rgba(255,255,255,0.04)', py: 0.5 },
  '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
  '& .MuiDataGrid-row:hover': { background: 'rgba(91, 181, 240, 0.05)' },
  '& .MuiDataGrid-groupingCriteriaCellToggle': { color: 'var(--ac)' },
  '& .MuiDataGrid-footerContainer': { borderTop: '1px solid var(--bd)', background: 'var(--sf)', minHeight: 40 },
  '& .MuiTablePagination-root': { color: 'var(--tx)', fontFamily: 'inherit', fontSize: 12 },
  '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
    color: 'var(--mt)', fontSize: 11, fontFamily: 'inherit', letterSpacing: 0.3,
  },
  '& .MuiTablePagination-select': { color: 'var(--ac)', fontWeight: 700, fontFamily: 'var(--ff-mono)', fontSize: 12 },
  '& .MuiTablePagination-actions .MuiIconButton-root': {
    color: 'var(--tx2)',
    '&:hover': { background: 'rgba(91, 181, 240, 0.08)', color: 'var(--ac)' },
    '&.Mui-disabled': { color: 'var(--mt)', opacity: 0.4 },
  },
  '& .MuiDataGrid-overlay': { background: 'var(--sf)', color: 'var(--mt)' },
  '& .mn': { fontFeatureSettings: '"tnum" on, "lnum" on' },
  '& .MuiDataGrid-menuIconButton, & .MuiDataGrid-sortIcon': { color: 'var(--mt)' },
  '& .MuiDataGrid-columnSeparator': { color: 'rgba(255,255,255,0.06)' },
  '& .MuiDataGrid-scrollbar': { background: 'transparent' },
  '& .MuiDataGrid-scrollbar::-webkit-scrollbar': { width: 10, height: 10 },
  '& .MuiDataGrid-scrollbar::-webkit-scrollbar-thumb': { background: 'rgba(91, 181, 240, 0.20)', borderRadius: 6 },
};

const CAT_AC_SX = {
  width: '100%',
  '& .MuiOutlinedInput-root': {
    height: 26, minHeight: 26, fontFamily: 'inherit', fontSize: 11,
    background: 'var(--bg)', color: 'var(--tx)', padding: '0 6px',
    '& fieldset': { borderColor: 'var(--bd)' },
    '&:hover fieldset': { borderColor: 'var(--bd2)' },
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
  const [hygiene, setHygiene] = useState<ItemHygieneRow[]>([]);
  const [hygieneFilter, setHygieneFilter] = useState<HygieneBucket | null>(null);
  const [families, setFamilies] = useState<ProductFamily[]>([]);
  const [productTypes, setProductTypes] = useState<ProductType[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkFamily, setBulkFamily] = useState<string>('');
  const [bulkType, setBulkType] = useState<string>('');

  function load() {
    setRows(null);
    Promise.all([
      sbrpc<ItemMasterRow[]>('fn_items_master', { p_lookback_days: 90, p_search: null }),
      fetchCategoryList(),
      fetchItemPlAudit(3),
      fetchItemHygieneSummary(),
      fetchProductFamilies(),
      fetchProductTypes(),
    ])
      .then(([rs, cs, audit, hy, fams, types]) => {
        setRows([...rs].sort(sortRows));
        setCategories(cs);
        const m = new Map<string, ItemPlAuditRow>();
        for (const a of audit) m.set(a.qbo_item_id, a);
        setAuditByItem(m);
        setHygiene(hy ?? []);
        setFamilies(fams);
        setProductTypes(types);
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

  async function patchSettings(
    qbo_item_id: string,
    patchData: Partial<Pick<ItemMasterRow, 'is_managed' | 'is_planner' | 'target_days_supply' | 'lead_time_days' | 'reorder_point' | 'min_order_qty' | 'notes' | 'category_override'>>,
  ) {
    // The grid is tree-grouped by category; group rows have no qbo_item_id.
    // If a control on a group row fires this, silently ignore.
    if (!qbo_item_id) return;
    try {
      await sbrpc<void>('fn_set_inventory_settings', {
        p_qbo_item_id:        qbo_item_id,
        p_is_managed:         patchData.is_managed ?? null,
        p_is_planner:         patchData.is_planner ?? null,
        p_target_days_supply: patchData.target_days_supply ?? null,
        p_lead_time_days:     patchData.lead_time_days ?? null,
        p_reorder_point:      patchData.reorder_point ?? null,
        p_min_order_qty:      patchData.min_order_qty ?? null,
        p_notes:              patchData.notes ?? null,
        p_category_override:  patchData.category_override ?? null,
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

  async function patchActive(qbo_item_id: string, active: boolean) {
    if (!qbo_item_id) return;
    try {
      await setItemActive(qbo_item_id, active);
      setRows((cur) => cur?.map((r) =>
        r.qbo_item_id === qbo_item_id ? { ...r, active } : r,
      ) ?? cur);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
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

  async function pushCategoriesToQbo() {
    setPushing(true);
    try {
      const dryRun = await bulkSyncCategoriesToQbo(false);
      const s = dryRun.summary;
      if (!s || (s.would_update === 0 && (dryRun.categories_created?.length ?? 0) === 0)) {
        toast.info('Everything in QBO already matches.');
        setPushing(false);
        return;
      }
      const creating = dryRun.categories_created ?? [];
      const ok = confirm(
        'Sync category overrides to QuickBooks?\n\n'
        + (creating.length > 0
            ? `New Category items in QBO: ${creating.length}\n${creating.slice(0, 6).join(', ')}${creating.length > 6 ? '…' : ''}\n\n`
            : '')
        + `Items to re-parent: ${s.would_update}\n`
        + `Already correct: ${s.already_correct}\n\n`
        + 'This creates any missing QBO Category items and points each item to its category. '
        + 'No item names or accounts are modified.',
      );
      if (!ok) { setPushing(false); return; }
      const result = await bulkSyncCategoriesToQbo(true);
      const u = result.summary?.updated ?? 0;
      const c = result.categories_created?.length ?? 0;
      toast.success(`QBO sync complete: ${u} items updated, ${c} categories created.`);
      load();
    } catch (e) {
      toast.error('QBO sync failed: ' + (e as Error).message);
    } finally {
      setPushing(false);
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
  }, [categoryLabels, showAlignment, families, productTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupingColDef = useMemo(() => ({
    headerName: 'Category / Item', width: 360, hideDescendantCount: false,
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
  }) as any, []);

  if (!rows) return <div className="ld">Loading items…</div>;

  const activeCount      = rows.filter((r) => r.active).length;
  const inactiveCount    = rows.filter((r) => !r.active).length;
  const managedCount     = rows.filter((r) => r.is_managed).length;
  const withOverrideCount = rows.filter((r) => r.category_override).length;

  return (
    <div>
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
          background: 'var(--bg)', border: '1px solid var(--bd)', minWidth: 260,
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
          onClick={pushCategoriesToQbo}
          disabled={pushing || withOverrideCount === 0}
          className="tb-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          title={withOverrideCount === 0 ? 'No category overrides to push' : 'Sync all category overrides back to QuickBooks (creates missing Category Items + sets each item ParentRef)'}
        >
          <UploadCloud size={12} strokeWidth={2.4} aria-hidden="true" />
          {pushing ? 'Syncing…' : `Push to QBO (${withOverrideCount})`}
        </button>
        <button onClick={load} className="tb-btn">Refresh</button>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {filtered.length === 0 ? (
          <div className="ld">No items match.</div>
        ) : (
          <DataGridPro
            rows={gridRows} columns={columns}
            treeData getTreeDataPath={getTreeDataPath}
            groupingColDef={groupingColDef}
            density="compact" pagination disableRowSelectionOnClick
            checkboxSelection
            onRowSelectionModelChange={(model) => {
              setSelectedIds(model.map(String).filter((id) => !id.startsWith('auto-generated-row-')));
            }}
            pageSizeOptions={[20, 40, 60, 100, 250, { value: -1, label: 'All' }]}
            defaultGroupingExpansionDepth={1}
            initialState={{
              pagination: { paginationModel: { pageSize: 60, page: 0 } },
              sorting: { sortModel: [{ field: 'is_managed', sort: 'desc' }] },
            }}
            isGroupExpandedByDefault={(node: GridGroupNode) => node.groupingKey !== INACTIVE_GROUP}
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
    </div>
  );
}
