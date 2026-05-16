// "Pull POs from QBO" modal — operator-driven import of QBO-direct
// PurchaseOrders into the ops.qbo_purchase_orders shadow tables, so the
// inventory page's On Order column reflects QBO POs that were never created
// through BRIX.

import { useEffect, useMemo, useState } from 'react';
import { X as XIcon, Loader2, RefreshCw, Download } from 'lucide-react';
import { fetchQboPosPreview, importQboPos, type QboPoPickerItem } from '../../lib/qboPosPicker';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary } from '../../lib/styles';
import { fm } from '../../lib/formatters';

interface Props {
  onClose: () => void;
  /** Bubble up so the parent can refresh inventory / PO views after import. */
  onImported: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function QboPosPickerModal({ onClose, onImported }: Props) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [items, setItems] = useState<QboPoPickerItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false); // hide already-imported by default

  async function load() {
    setLoading(true);
    try {
      const data = await fetchQboPosPreview();
      setItems(data.items);
      setSelected(new Set());
    } catch (e) {
      toast.error('Failed to load QBO POs: ' + errMsg(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return items.filter((i) => {
      // Always hide BRIX-native rows — re-importing would double-count.
      if (i.brix_native) return false;
      if (!showAll && i.already_imported) return false;
      if (!q) return true;
      return (
        (i.doc_number || '').toLowerCase().includes(q) ||
        (i.vendor_name || '').toLowerCase().includes(q) ||
        (i.memo || '').toLowerCase().includes(q)
      );
    });
  }, [items, filter, showAll]);

  const pickableIds = useMemo(
    () => visible.filter((i) => i.status === 'Open' && !i.brix_native).map((i) => i.qbo_id),
    [visible],
  );

  const allSelected = pickableIds.length > 0 && pickableIds.every((id) => selected.has(id));
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(pickableIds));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function doImport() {
    if (selected.size === 0) return;
    setImporting(true);
    try {
      const result = await importQboPos(Array.from(selected));
      const lines = result.details.imported.reduce((s, r) => s + r.lines, 0);
      toast.success(`Imported ${result.imported} PO${result.imported === 1 ? '' : 's'} (${lines} line${lines === 1 ? '' : 's'})${result.skipped > 0 ? ` · ${result.skipped} skipped` : ''}`);
      onImported();
      await load(); // refresh "already imported" flags
    } catch (e) {
      toast.error('Import failed: ' + errMsg(e));
    } finally {
      setImporting(false);
    }
  }

  const totalSelected = useMemo(
    () => Array.from(selected).reduce((s, id) => {
      const it = items.find((i) => i.qbo_id === id);
      return s + (it?.total_amt || 0);
    }, 0),
    [selected, items],
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        background: 'var(--bg)', color: 'var(--tx)', border: '1px solid var(--bd)',
        borderRadius: 8, maxWidth: 1100, width: '100%', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--bd)',
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Pull purchase orders from QBO</div>
            <div style={{ fontSize: 12, color: 'var(--mt)', marginTop: 2 }}>
              Pick which open POs to mirror into BRIX. They count toward the inventory <em>On Order</em> column. Re-pull anytime to refresh totals + status.
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={20} />
          </button>
        </div>

        <div style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--bd)' }}>
          <input
            placeholder="Search by PO #, vendor, memo…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ flex: 1, padding: '6px 10px', background: 'var(--bg-2)', color: 'var(--tx)', border: '1px solid var(--bd)', borderRadius: 6, fontSize: 13 }}
          />
          <label style={{ fontSize: 12, color: 'var(--mt)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show already-imported
          </label>
          <button onClick={() => void load()} style={{ ...btnSecondary(), display: 'flex', alignItems: 'center', gap: 4 }}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '4px 18px 18px' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--mt)' }}>
              <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /> Loading QBO POs…
            </div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--mt)' }}>
              No POs match. {!showAll && items.some((i) => i.already_imported) ? 'Toggle "Show already-imported" to see ones already in BRIX.' : ''}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--bg-2)' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid var(--bd)', width: 36 }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={pickableIds.length === 0} />
                  </th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>PO #</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>Vendor</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>Date</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--bd)' }}>Total</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--bd)' }}>Lines</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((it) => {
                  const isPickable = it.status === 'Open' && !it.brix_native;
                  const isSelected = selected.has(it.qbo_id);
                  const isExpanded = expanded.has(it.qbo_id);
                  return (
                    <>
                      <tr key={it.qbo_id} style={{ borderBottom: '1px solid var(--bd)' }}>
                        <td style={{ padding: '8px 10px' }}>
                          <input type="checkbox" checked={isSelected} disabled={!isPickable} onChange={() => toggleOne(it.qbo_id)} />
                        </td>
                        <td style={{ padding: '8px 10px', fontFamily: 'var(--ff-mono)', fontWeight: 600 }}>
                          <button onClick={() => toggleExpand(it.qbo_id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ac)', padding: 0, fontFamily: 'inherit', fontWeight: 'inherit' }}>
                            {it.doc_number || it.qbo_id} {isExpanded ? '▾' : '▸'}
                          </button>
                        </td>
                        <td style={{ padding: '8px 10px' }}>{it.vendor_name || '—'}</td>
                        <td style={{ padding: '8px 10px' }}>{it.txn_date || '—'}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fm(it.total_amt || 0)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{it.line_count}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, padding: '1px 6px', borderRadius: 10, border: '1px solid', color: it.status === 'Open' ? 'var(--gn)' : 'var(--mt)' }}>
                            {it.status.toUpperCase()}
                          </span>
                          {it.already_imported && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--mt)' }}>imported</span>}
                          {it.brix_native && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--mt)' }}>brix-native</span>}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                          <td colSpan={7} style={{ padding: '8px 18px' }}>
                            {it.lines.length === 0 ? (
                              <div style={{ color: 'var(--mt)', fontStyle: 'italic' }}>No item lines on this PO.</div>
                            ) : (
                              <table style={{ width: '100%', fontSize: 11 }}>
                                <thead>
                                  <tr style={{ color: 'var(--mt)' }}>
                                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Item / Description</th>
                                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Qty</th>
                                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Unit cost</th>
                                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {it.lines.map((l) => (
                                    <tr key={l.line_num}>
                                      <td style={{ padding: '4px 8px' }}>
                                        <strong>{l.qbo_item_name || l.account_name || '—'}</strong>
                                        {l.description ? <span style={{ color: 'var(--mt)' }}> · {l.description}</span> : null}
                                        {!l.qbo_item_id && <span style={{ color: 'var(--am)', marginLeft: 6, fontSize: 10 }}>(no item — won't count toward On Order)</span>}
                                      </td>
                                      <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{l.qty ?? '—'}</td>
                                      <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{l.unit_cost != null ? fm(l.unit_cost) : '—'}</td>
                                      <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{l.amount != null ? fm(l.amount) : '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--bd)', gap: 12,
        }}>
          <div style={{ fontSize: 12, color: 'var(--mt)' }}>
            {selected.size > 0 ? (
              <>
                <strong style={{ color: 'var(--tx)' }}>{selected.size}</strong> selected · {fm(totalSelected)}
              </>
            ) : (
              <>Tip: only Open POs can be imported — closed ones don't contribute to On Order.</>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSecondary()}>Cancel</button>
            <button
              onClick={() => void doImport()}
              disabled={selected.size === 0 || importing}
              style={{ ...btnPrimary(), display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {importing ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={14} />}
              Import {selected.size || ''} selected
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
