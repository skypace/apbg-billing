import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, FileText, X as XIcon, Trash2 } from 'lucide-react';
import {
  InventoryLocation,
  InventoryTransfer,
  InventoryTransferLine,
  InventoryTransferLineInput,
  TransferStatus,
  createTransfer,
  fetchTransferLines,
  receiveTransfer,
  shipTransfer,
  voidTransfer,
} from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import { GRID_SX, STATUS_COLOR } from './stockStyles';
import type { ItemLookup } from './StockPage';

interface Props {
  transfers: InventoryTransfer[] | null;
  locations: InventoryLocation[];
  locationById: Map<string, InventoryLocation>;
  itemLookup: ItemLookup;
  onChanged: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function StockTransfersTab({ transfers, locations, locationById, itemLookup, onChanged }: Props) {
  const [creating, setCreating] = useState(false);
  const [openTransferId, setOpenTransferId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | TransferStatus>('all');

  const physicalLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );

  const filtered = useMemo(() => {
    const list = transfers ?? [];
    if (statusFilter === 'all') return list;
    return list.filter((t) => t.status === statusFilter);
  }, [transfers, statusFilter]);

  const enriched = useMemo(() => filtered.map((t) => ({
    ...t,
    id: t.id,
    from_label: locationById.get(t.from_location_id)?.code ?? '?',
    to_label:   locationById.get(t.to_location_id)?.code   ?? '?',
  })), [filtered, locationById]);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'bol_number',
      headerName: 'BOL #',
      width: 160,
      renderCell: (p) => (
        <button
          onClick={() => setOpenTransferId(String(p.row.id))}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600,
            padding: 0, fontSize: 12,
          }}
        >{String(p.value ?? '')}</button>
      ),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      renderCell: (p) => {
        const v = String(p.value ?? '');
        const c = STATUS_COLOR[v] ?? 'var(--mt)';
        return (
          <span style={{
            background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
            padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
          }}>{v.replace('_', ' ').toUpperCase()}</span>
        );
      },
    },
    { field: 'from_label', headerName: 'From',     width: 140 },
    { field: 'to_label',   headerName: 'To',       width: 140 },
    { field: 'carrier',    headerName: 'Carrier',  flex: 1, minWidth: 140,
      valueFormatter: (v) => (v ? String(v) : '—') },
    { field: 'ship_date',  headerName: 'Shipped',  width: 110,
      valueFormatter: (v) => (v ? String(v) : '—') },
    { field: 'received_date', headerName: 'Received', width: 110,
      valueFormatter: (v) => (v ? String(v) : '—') },
    { field: 'created_at', headerName: 'Created',  width: 160,
      valueFormatter: (v) => v ? new Date(String(v)).toLocaleString() : '—' },
  ], []);

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="toolbar-section" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="toolbar-label">Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | TransferStatus)}
              style={inp()}>
              <option value="all">All</option>
              <option value="draft">Draft</option>
              <option value="in_transit">In Transit</option>
              <option value="received">Received</option>
              <option value="void">Void</option>
            </select>
          </div>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setCreating(true)} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New Transfer
          </button>
        </div>
      </div>

      {creating && (
        <CreateTransferForm
          locations={physicalLocs}
          itemLookup={itemLookup}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); onChanged(); }}
        />
      )}

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={enriched}
          columns={columns}
          sx={GRID_SX}
          density="compact"
          loading={transfers === null}
          initialState={{ sorting: { sortModel: [{ field: 'created_at', sort: 'desc' }] } }}
          disableRowSelectionOnClick
        />
      </div>

      {openTransferId && (
        <TransferDetailModal
          transferId={openTransferId}
          transfer={(transfers ?? []).find((t) => t.id === openTransferId) ?? null}
          locationById={locationById}
          itemLookup={itemLookup}
          onClose={() => setOpenTransferId(null)}
          onChanged={() => { setOpenTransferId(null); onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Create form ─────────────────────────────────────────────────────────

function CreateTransferForm({ locations, itemLookup, onCancel, onCreated }: {
  locations: InventoryLocation[];
  itemLookup: ItemLookup;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<InventoryTransferLineInput[]>([
    { qbo_item_id: '', qty: 1, unit_cost: null, notes: null },
  ]);
  const [saving, setSaving] = useState(false);

  const canSave =
    from && to && from !== to &&
    lines.length > 0 &&
    lines.every((l) => l.qbo_item_id && Number(l.qty) > 0);

  function addLine() {
    setLines([...lines, { qbo_item_id: '', qty: 1, unit_cost: null, notes: null }]);
  }
  function rmLine(i: number) {
    setLines(lines.filter((_, idx) => idx !== i));
  }
  function patchLine(i: number, patch: Partial<InventoryTransferLineInput>) {
    setLines(lines.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      await createTransfer({
        from_location_id: from,
        to_location_id: to,
        lines,
        carrier: carrier || null,
        tracking_number: tracking || null,
        notes: notes || null,
      });
      toast.success('Transfer created');
      onCreated();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          New Transfer
        </div>
        <button onClick={onCancel} style={{
          background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)',
        }} aria-label="Cancel">
          <XIcon size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <LField label="From">
          <select style={inp()} value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">—</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </LField>
        <LField label="To">
          <select style={inp()} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">—</option>
            {locations.filter((l) => l.id !== from).map((l) =>
              <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
            )}
          </select>
        </LField>
        <LField label="Carrier">
          <input style={inp()} value={carrier} onChange={(e) => setCarrier(e.target.value)}
            placeholder="Internal / UPS Freight / XPO" />
        </LField>
        <LField label="Tracking #">
          <input style={inp()} value={tracking} onChange={(e) => setTracking(e.target.value)} />
        </LField>
      </div>

      <div style={{ marginTop: 14, fontSize: 10, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>
        Lines
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bd)' }}>
            <th style={cellTh}>Item</th>
            <th style={{ ...cellTh, width: 90, textAlign: 'right' }}>Qty</th>
            <th style={{ ...cellTh, width: 110, textAlign: 'right' }}>Unit Cost</th>
            <th style={{ ...cellTh, width: 180 }}>Notes</th>
            <th style={{ ...cellTh, width: 36 }}> </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <td style={cellTd}>
                <ItemPicker
                  value={l.qbo_item_id}
                  options={itemLookup.options}
                  onChange={(id) => patchLine(i, { qbo_item_id: id })}
                />
              </td>
              <td style={{ ...cellTd, textAlign: 'right' }}>
                <input type="number" min={0.0001} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                  value={l.qty} onChange={(e) => patchLine(i, { qty: Number(e.target.value) })} />
              </td>
              <td style={{ ...cellTd, textAlign: 'right' }}>
                <input type="number" min={0} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                  value={l.unit_cost ?? ''} onChange={(e) => patchLine(i, { unit_cost: e.target.value === '' ? null : Number(e.target.value) })} />
              </td>
              <td style={cellTd}>
                <input style={inp()} value={l.notes ?? ''}
                  onChange={(e) => patchLine(i, { notes: e.target.value || null })} />
              </td>
              <td style={{ ...cellTd, textAlign: 'right' }}>
                <button onClick={() => rmLine(i)} aria-label="Remove line"
                  disabled={lines.length === 1}
                  style={{
                    background: 'transparent', border: 'none',
                    cursor: lines.length === 1 ? 'not-allowed' : 'pointer',
                    color: lines.length === 1 ? 'var(--mt)' : 'var(--rd)',
                    opacity: lines.length === 1 ? 0.4 : 1, padding: 4,
                  }}><Trash2 size={13} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button onClick={addLine} style={{ ...btnSecondary(), marginTop: 8 }}>+ Add line</button>

      <div style={{ marginTop: 14 }}>
        <LField label="Notes (header)">
          <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 40 }}
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </LField>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onCancel} style={btnSecondary()}>Cancel</button>
        <button onClick={submit} disabled={!canSave || saving} style={btnPrimary()}>
          {saving ? 'Creating…' : 'Create as Draft'}
        </button>
      </div>
    </div>
  );
}

// ── Detail modal (view + ship/receive/void) ────────────────────────────

function TransferDetailModal({
  transferId, transfer, locationById, itemLookup, onClose, onChanged,
}: {
  transferId: string;
  transfer: InventoryTransfer | null;
  locationById: Map<string, InventoryLocation>;
  itemLookup: ItemLookup;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [lines, setLines] = useState<InventoryTransferLine[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLines(null);
    fetchTransferLines(transferId)
      .then((ls) => { if (alive) setLines(ls); })
      .catch(() => { if (alive) setLines([]); });
    return () => { alive = false; };
  }, [transferId]);

  if (!transfer) {
    return null;
  }

  const fromLoc = locationById.get(transfer.from_location_id);
  const toLoc   = locationById.get(transfer.to_location_id);
  const status  = transfer.status;

  async function doShip() {
    if (!confirm('Mark this transfer as shipped? This will decrement the source location.')) return;
    setBusy(true);
    try {
      await shipTransfer(transferId);
      toast.success('Marked shipped');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  async function doReceive() {
    if (!confirm('Mark this transfer as received? This will increment the destination location.')) return;
    setBusy(true);
    try {
      await receiveTransfer(transferId);
      toast.success('Marked received');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  async function doVoid() {
    const reason = prompt('Void reason?');
    if (!reason) return;
    setBusy(true);
    try {
      await voidTransfer(transferId, reason);
      toast.success('Voided');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  function printBol() {
    const t = transfer;
    if (!t) return;
    const w = window.open('', '_blank');
    if (!w) return;
    const rowsHtml = (lines ?? []).map((l) => {
      const it = itemLookup.byId.get(l.qbo_item_id);
      return `<tr>
        <td>${escapeHtml(it?.item_name ?? l.qbo_item_id)}</td>
        <td style="text-align:right">${fmtNum(Number(l.qty))}</td>
        <td>${escapeHtml(l.notes ?? '')}</td>
      </tr>`;
    }).join('');
    w.document.write(`<html><head><title>BOL ${t.bol_number}</title>
      <style>
        body{font-family:system-ui,-apple-system,sans-serif;color:#0a0e17;max-width:980px;margin:24px auto;padding:0 24px}
        h1{font-size:20px;border-bottom:2px solid #0ea5b8;padding-bottom:6px;margin:0}
        .meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0;font-size:12px}
        .meta div{padding:6px 0}
        .meta strong{display:block;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.5px}
        table{width:100%;border-collapse:collapse;font-size:12px;margin-top:14px}
        td,th{padding:7px 10px;border-bottom:1px solid #e2e8f0;text-align:left}
        th{background:#f1f5f9;font-size:9px;text-transform:uppercase;letter-spacing:1px}
        .sig{margin-top:40px;display:grid;grid-template-columns:1fr 1fr;gap:30px;font-size:11px}
        .sig div{border-top:1px solid #0a0e17;padding-top:6px}
        @media print{body{margin:0}}
      </style></head><body>
      <h1>Bill of Lading — ${escapeHtml(t.bol_number)}</h1>
      <div class="meta">
        <div><strong>From</strong>${escapeHtml(fromLoc?.name ?? '?')}<br>${escapeHtml(fromLoc?.code ?? '')}</div>
        <div><strong>To</strong>${escapeHtml(toLoc?.name ?? '?')}<br>${escapeHtml(toLoc?.code ?? '')}</div>
        <div><strong>Carrier</strong>${escapeHtml(t.carrier ?? '—')}</div>
        <div><strong>Tracking #</strong>${escapeHtml(t.tracking_number ?? '—')}</div>
        <div><strong>Ship Date</strong>${escapeHtml(t.ship_date ?? '—')}</div>
        <div><strong>Received Date</strong>${escapeHtml(t.received_date ?? '—')}</div>
      </div>
      <table><thead><tr><th>Item</th><th style="text-align:right">Qty</th><th>Notes</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>
      ${t.notes ? `<div style="margin-top:14px;font-size:11px"><strong style="display:block;color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.5px">Notes</strong>${escapeHtml(t.notes)}</div>` : ''}
      <div class="sig">
        <div>Shipped by (sign + date)</div>
        <div>Received by (sign + date)</div>
      </div>
      <script>setTimeout(function(){window.print()},350);</script>
    </body></html>`);
    w.document.close();
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 820, width: '100%', maxHeight: '88vh', overflowY: 'auto',
        padding: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              BOL · {status.replace('_', ' ').toUpperCase()}
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>
              {transfer.bol_number}
            </h2>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)',
          }}><XIcon size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, fontSize: 12, marginBottom: 14 }}>
          <Meta label="From" value={fromLoc ? `${fromLoc.code} — ${fromLoc.name}` : '?'} />
          <Meta label="To"   value={toLoc   ? `${toLoc.code} — ${toLoc.name}`     : '?'} />
          <Meta label="Carrier"  value={transfer.carrier ?? '—'} />
          <Meta label="Tracking" value={transfer.tracking_number ?? '—'} />
          <Meta label="Shipped"  value={transfer.ship_date ?? '—'} />
          <Meta label="Received" value={transfer.received_date ?? '—'} />
        </div>

        <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>Lines</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bd)' }}>
              <th style={cellTh}>Item</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Qty</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Received</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Unit $</th>
              <th style={cellTh}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {(lines ?? []).map((l) => {
              const it = itemLookup.byId.get(l.qbo_item_id);
              return (
                <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={cellTd}><strong>{it?.item_name ?? l.qbo_item_id}</strong></td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(l.qty))}</td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {l.qty_received == null ? '—' : fmtNum(Number(l.qty_received))}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {l.unit_cost == null ? '—' : `$${Number(l.unit_cost).toFixed(2)}`}
                  </td>
                  <td style={cellTd}>{l.notes ?? '—'}</td>
                </tr>
              );
            })}
            {lines && lines.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 14, textAlign: 'center', color: 'var(--mt)' }}>No lines</td></tr>
            )}
          </tbody>
        </table>

        {transfer.notes && (
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--mt)' }}>
            <div style={{ fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase' }}>Notes</div>
            {transfer.notes}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          <button onClick={printBol} style={btnSecondary()}>
            <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Print BOL
          </button>
          {status === 'draft' && (
            <>
              <button onClick={doVoid} disabled={busy} style={btnDanger()}>Void</button>
              <button onClick={doShip} disabled={busy} style={btnPrimary()}>Mark Shipped</button>
            </>
          )}
          {status === 'in_transit' && (
            <button onClick={doReceive} disabled={busy} style={btnPrimary()}>Mark Received</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── tiny helpers ───────────────────────────────────────────────────────

function ItemPicker({ value, options, onChange }: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inp(), width: '100%' }}>
      <option value="">— Select item —</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ marginTop: 3 }}>{value}</div>
    </div>
  );
}

function LField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const cellTh: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px',
  fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)',
};
const cellTd: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'middle' };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
