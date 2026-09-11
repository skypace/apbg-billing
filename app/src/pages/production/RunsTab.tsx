// Production Orders — the run list. A run is the ORDER: several flavours, one
// purchase order per vendor, one truck home. Buckets + selection + bulk void /
// delete drafts / reopen, the New order form, and the run detail.
import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus } from 'lucide-react';
import type { ProductBom } from '../../lib/production';
import type { QboVendor } from '../../lib/purchasing';
import type { InventoryLocation } from '../../lib/inventoryControl';
import type { ProductionRun } from '../../lib/runs';
import { useToast } from '../../lib/toast';
import { btnPrimary } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import { GRID_SX, GRID_DEFAULTS } from '../stock/stockStyles';
import type { ProductionItemLookup } from './ProductionPage';
import { StatusBuckets } from '../../components/StatusBuckets';
import { BulkActionBar } from '../../components/BulkActionBar';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useGridSelection } from '../../lib/useGridSelection';
import { countBuckets, rowBucket, type Bucket } from '../../lib/lifecycleBuckets';
import { deleteDrafts, reopenDocs, summarizeBulk, voidDocs, type BulkResult } from '../../lib/bulkActions';
import { NewOrderForm } from './NewOrderForm';
import { RunDetailModal, runStageChip } from './RunDetailModal';
import { errMsg } from './productionUi';

// Inventory Planning → Reorder (24-pack lane) stashes the flavours it wants under
// `brix.wo.prefill` (the key predates production orders and is kept so the planner
// needs no change). They open here as ONE production order with a line per flavour
// — Sky (2026-09-11): the order is the only door; a one-flavour run is still an order.
interface RunPrefill { qbo_item_id: string; item_name: string; qty: number }
function readRunPrefill(): RunPrefill[] {
  if (typeof sessionStorage === 'undefined') return [];
  const raw = sessionStorage.getItem('brix.wo.prefill');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { runs?: RunPrefill[] };
    return Array.isArray(parsed.runs) ? parsed.runs.filter((r) => r && r.qbo_item_id && Number(r.qty) > 0) : [];
  } catch { return []; }
}

export function RunsTab({ runs, boms, vendors, locations, itemLookup, initialRunId = null, onChanged, onOpenPo, onOpenWo }: {
  runs: ProductionRun[] | null;
  boms: ProductBom[];
  vendors: QboVendor[];
  locations: InventoryLocation[];
  itemLookup: ProductionItemLookup;
  initialRunId?: string | null;
  onChanged: () => void;
  onOpenPo: (poId: string) => void;
  onOpenWo: (woId: string) => void;
}) {
  const toast = useToast();
  const [prefill] = useState<RunPrefill[]>(() => readRunPrefill());
  useEffect(() => {
    // consumed on mount: a stale list reappearing days later is worse than none
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('brix.wo.prefill');
  }, []);
  const prefillLines = useMemo(() => prefill.map((r) => ({ r, bom: boms.find((b) => b.is_active && b.finished_qbo_item_id === r.qbo_item_id) ?? null })), [prefill, boms]);
  const [creating, setCreating] = useState(prefill.length > 0);
  const [openId, setOpenId] = useState<string | null>(initialRunId);
  const [bucket, setBucket] = useState<Bucket>('open');
  const [bulk, setBulk] = useState<'void' | 'delete' | 'reopen' | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = useGridSelection([bucket]);

  const counts = useMemo(() => countBuckets('run', runs ?? []), [runs]);
  const filtered = useMemo(() => (runs ?? []).filter((r) => rowBucket('run', r) === bucket), [runs, bucket]);
  const selectedRows = useMemo(() => filtered.filter((r) => sel.selected.includes(r.id)), [filtered, sel.selected]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runBulk(verb: string, fn: () => Promise<BulkResult>) {
    setBusy(true);
    try { const r = await fn(); (r.skipped.length ? toast.info : toast.success)(summarizeBulk(r, verb)); setBulk(null); sel.clear(); onChanged(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  const voidItems = selectedRows.map((r) => ({
    id: r.id, number: r.run_number, eligible: r.status === 'draft' || r.status === 'ordered',
    why: r.status === 'void' ? 'already void' : r.status === 'closed' ? 'closed — nothing to void' : 'production has started — close it out instead',
  }));
  const deleteItems = selectedRows.map((r) => ({
    id: r.id, number: r.run_number, eligible: r.status === 'draft' && r.po_count === 0,
    why: r.status !== 'draft' ? 'not a draft — void it instead' : 'has purchase orders — void it instead',
  }));
  const reopenItems = selectedRows.map((r) => ({ id: r.id, number: r.run_number, eligible: r.status === 'closed', why: 'not closed' }));

  const columns: GridColDef[] = useMemo(() => [
    { field: 'run_number', headerName: 'Order #', width: 150,
      renderCell: (p) => <button onClick={() => setOpenId(String(p.row.id))} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600, padding: 0, fontSize: 12 }}>{String(p.value ?? '')}</button> },
    { field: 'status', headerName: 'Stage', width: 120, renderCell: (p) => runStageChip(String(p.value ?? '')) },
    { field: 'flavours', headerName: 'Flavours', flex: 1, minWidth: 240,
      renderCell: (p) => <span style={{ fontWeight: 600 }} title={String(p.value ?? '')}>{String(p.value ?? '—')}</span> },
    { field: 'wo_live_count', headerName: 'WOs', width: 70, cellClassName: 'mn' },
    { field: 'cases_planned', headerName: 'Cases', width: 100, cellClassName: 'mn', valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    { field: 'cases_produced', headerName: 'Produced', width: 100, cellClassName: 'mn',
      renderCell: (p) => p.value == null ? <span style={{ color: 'var(--mt)' }}>—</span> : <span>{fmtNum(Number(p.value))}</span> },
    { field: 'stages', headerName: 'WO stages', width: 170, valueFormatter: (v) => v ? String(v).replace(/_/g, ' ') : '—' },
    { field: 'po_count', headerName: 'POs', width: 90, cellClassName: 'mn',
      renderCell: (p) => Number(p.value ?? 0) === 0 ? <span style={{ color: 'var(--mt)' }}>—</span>
        : <span>{Number(p.value)}{Number(p.row.po_open_count) > 0 && <span style={{ color: 'var(--am)' }}> ({p.row.po_open_count} open)</span>}</span> },
    { field: 'po_total', headerName: 'PO total', width: 110, cellClassName: 'mn', valueFormatter: (v) => Number(v ?? 0) ? fm(Number(v)) : '—' },
    { field: 'total_cost', headerName: 'Measured cost', width: 120, cellClassName: 'mn', valueFormatter: (v) => v == null ? '—' : fm(Number(v)) },
    { field: 'copacker_vendor_name', headerName: 'Co-packer', width: 150, valueFormatter: (v) => v ? String(v) : '—' },
    { field: 'scheduled_date', headerName: 'Scheduled', width: 110, valueFormatter: (v) => v ? String(v) : '—' },
    { field: 'created_at', headerName: 'Created', width: 150, valueFormatter: (v) => v ? new Date(String(v)).toLocaleString() : '—' },
  ], []);

  const activeBoms = boms.filter((b) => b.is_active);
  const openRun = (runs ?? []).find((r) => r.id === openId) ?? null;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusBuckets kind="run" value={bucket} counts={counts} onChange={setBucket} />
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setCreating(true)} style={btnPrimary()} disabled={activeBoms.length === 0}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New production order
          </button>
        </div>
      </div>

      {creating && prefill.length > 0 && (
        <div className="cd" style={{ padding: '8px 14px', marginBottom: 8, border: '1px solid var(--ac)', fontSize: 11 }}>
          <strong style={{ color: 'var(--ac)', letterSpacing: 0.4 }}>SUGGESTED BY INVENTORY PLANNING</strong> — {prefillLines.filter((x) => x.bom).length} flavour{prefillLines.filter((x) => x.bom).length === 1 ? '' : 's'} on one order:{' '}
          {prefillLines.filter((x) => x.bom).map((x) => `${x.r.item_name} ${Math.ceil(Number(x.r.qty)).toLocaleString()}`).join(' · ')}.
          Change the quantities to the run you actually want before creating it.
          {prefillLines.some((x) => !x.bom) && (
            <span style={{ color: 'var(--am)', marginLeft: 6 }}>Left off — no active bill of materials: {prefillLines.filter((x) => !x.bom).map((x) => x.r.item_name).join(', ')}.</span>
          )}
        </div>
      )}
      {creating && (
        <NewOrderForm key={prefill.length ? 'prefill' : 'blank'} boms={activeBoms} vendors={(vendors ?? []).filter((v) => v.active !== false)} locations={locations} itemLookup={itemLookup}
          initialLines={prefillLines.filter((x) => x.bom).map((x) => ({ bomId: x.bom!.id, qty: Math.ceil(Number(x.r.qty)) }))}
          onCancel={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); onChanged(); setOpenId(id); }} />
      )}

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro rows={filtered} columns={columns} {...GRID_DEFAULTS} sx={GRID_SX} density="compact" loading={runs === null}
          initialState={{ sorting: { sortModel: [{ field: 'created_at', sort: 'desc' }] } }} {...sel.gridProps} />
      </div>

      <BulkActionBar count={sel.selected.length} noun="production order" onClear={sel.clear}>
        {bucket === 'closed' && <button type="button" className="tb-btn tb-btn--primary" disabled={busy} onClick={() => setBulk('reopen')}>Reopen…</button>}
        {(bucket === 'open' || bucket === 'pending') && <button type="button" className="tb-btn" disabled={busy} style={{ color: 'var(--rd)' }} onClick={() => setBulk('void')}>Void…</button>}
        {bucket === 'pending' && <button type="button" className="tb-btn" disabled={busy} style={{ color: 'var(--rd)' }} onClick={() => setBulk('delete')}>Delete drafts…</button>}
      </BulkActionBar>
      {bulk === 'void' && (
        <ReasonDialog title="Void production orders" verb={`Void ${voidItems.filter((i) => i.eligible).length} order${voidItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={voidItems} busy={busy}
          note="The master void: every work order on the order goes, its purchase orders are voided (or short-closed where goods were already received), and reserved stock is released. Refused once production has started on any flavour."
          onCancel={() => setBulk(null)} onConfirm={(reason, ids) => runBulk('voided', () => voidDocs('run', ids, reason))} />
      )}
      {bulk === 'delete' && (
        <ReasonDialog title="Delete draft production orders" verb={`Delete ${deleteItems.filter((i) => i.eligible).length} draft${deleteItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={deleteItems} needReason={false} busy={busy}
          note="Only a draft with no purchase orders can be deleted — its draft work orders go with it. Anything further along is voided instead."
          onCancel={() => setBulk(null)} onConfirm={(_r, ids) => runBulk('deleted', () => deleteDrafts('run', ids))} />
      )}
      {bulk === 'reopen' && (
        <ReasonDialog title="Reopen production orders" verb={`Reopen ${reopenItems.filter((i) => i.eligible).length} order${reopenItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={reopenItems} busy={busy}
          note="Every closed work order on the order goes back to Received so a receipt can be corrected."
          onCancel={() => setBulk(null)} onConfirm={(reason, ids) => runBulk('reopened', () => reopenDocs('run', ids, reason))} />
      )}

      {openRun && (
        <RunDetailModal run={openRun} boms={activeBoms} vendors={vendors ?? []} itemLookup={itemLookup}
          onClose={() => setOpenId(null)} onChanged={onChanged} onOpenPo={onOpenPo} onOpenWo={onOpenWo} />
      )}
    </div>
  );
}
