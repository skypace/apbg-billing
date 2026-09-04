import { useEffect, useMemo, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import { sbq, sbInsert, sbUpdate, sbDelete } from '../../lib/rpc';
import { fm } from '../../lib/formatters';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { useToast } from '../../lib/toast';

type AllocationBasis = 'revenue' | 'unit_volume' | 'sku_equal_share' | 'margin_contribution';

interface OverheadPool {
  id: number;
  name: string;
  entity: string | null;
  monthly_amount: number;
  basis: AllocationBasis;
  active: boolean;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
}

const BASIS_OPTIONS: { id: AllocationBasis; label: string; help: string }[] = [
  { id: 'revenue',             label: 'By revenue',       help: 'pool × (row revenue / total revenue)' },
  { id: 'unit_volume',         label: 'By unit volume',   help: 'pool × (row qty / total qty)' },
  { id: 'sku_equal_share',     label: 'Equal share',      help: 'pool / count(items) — equal across SKUs' },
  { id: 'margin_contribution', label: 'By margin',        help: 'pool × (row margin / total margin)' },
];
const BASIS_LABEL: Record<AllocationBasis, string> = Object.fromEntries(
  BASIS_OPTIONS.map((b) => [b.id, b.label])
) as Record<AllocationBasis, string>;

const ENTITY_OPTIONS = ['', 'brix', 'AS', 'freeflow', 'FF', 'shared'];

const EMPTY_NEW: Omit<OverheadPool, 'id'> = {
  name: '',
  entity: null,
  monthly_amount: 0,
  basis: 'revenue',
  active: true,
  effective_from: new Date().toISOString().slice(0, 10),
  effective_to: null,
  notes: null,
};

export function OverheadPoolsEditor() {
  const toast = useToast();
  const [pools, setPools] = useState<OverheadPool[] | null>(null);
  const [draft, setDraft] = useState<Omit<OverheadPool, 'id'>>({ ...EMPTY_NEW });
  const [saving, setSaving] = useState(false);

  function load() {
    sbq<OverheadPool>(
      'overhead_pools',
      'select=id,name,entity,monthly_amount,basis,active,effective_from,effective_to,notes,created_at,updated_at&order=active.desc,name.asc',
    )
      .then(setPools)
      .catch(() => setPools([]));
  }
  useEffect(load, []);

  const stats = useMemo(() => {
    if (!pools) return { total: 0, activeCount: 0, totalActive: 0 };
    const activePools = pools.filter((p) => p.active);
    return {
      total: pools.length,
      activeCount: activePools.length,
      totalActive: activePools.reduce((s, p) => s + Number(p.monthly_amount || 0), 0),
    };
  }, [pools]);

  async function addPool() {
    if (!draft.name.trim()) {
      toast.error('Pool name is required');
      return;
    }
    setSaving(true);
    try {
      await sbInsert('overhead_pools', {
        name: draft.name.trim(),
        entity: draft.entity || null,
        monthly_amount: Number(draft.monthly_amount) || 0,
        basis: draft.basis,
        active: draft.active,
        effective_from: draft.effective_from,
        effective_to: draft.effective_to || null,
        notes: draft.notes?.trim() || null,
      });
      toast.success(`Added overhead pool "${draft.name.trim()}"`);
      setDraft({ ...EMPTY_NEW });
      load();
    } catch (e) {
      toast.error('Failed to add pool: ' + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function patchPool(id: number, patch: Partial<OverheadPool>) {
    try {
      await sbUpdate('overhead_pools', `id=eq.${id}`, { ...patch, updated_at: new Date().toISOString() });
      setPools((cur) => cur?.map((p) => (p.id === id ? { ...p, ...patch } : p)) ?? cur);
    } catch (e) {
      toast.error('Update failed: ' + (e as Error).message);
      load();
    }
  }

  async function removePool(id: number, name: string) {
    if (!confirm(`Delete overhead pool "${name}"? This cannot be undone.`)) return;
    try {
      await sbDelete('overhead_pools', `id=eq.${id}`);
      toast.success(`Deleted "${name}"`);
      load();
    } catch (e) {
      toast.error('Delete failed: ' + (e as Error).message);
    }
  }

  if (pools === null) return <div className="ld">Loading overhead pools…</div>;

  return (
    <div>
      {/* KPI strip */}
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <div className="cd" style={{ padding: '10px 12px' }}>
          <div className="ct" style={{ margin: 0 }}>TOTAL MONTHLY OH</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{fm(stats.totalActive)}</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>{stats.activeCount} active pool{stats.activeCount === 1 ? '' : 's'}</div>
        </div>
        <div className="cd" style={{ padding: '10px 12px' }}>
          <div className="ct" style={{ margin: 0 }}>POOLS TOTAL</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{stats.total}</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>incl. inactive</div>
        </div>
        <div className="cd" style={{ padding: '10px 12px' }}>
          <div className="ct" style={{ margin: 0 }}>ANNUALIZED</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{fm(stats.totalActive * 12)}</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>active × 12</div>
        </div>
        <div className="cd" style={{ padding: '10px 12px' }}>
          <div className="ct" style={{ margin: 0 }}>HOW IT'S USED</div>
          <div style={{ fontSize: 11, color: 'var(--tx2)', marginTop: 4, lineHeight: 1.35 }}>
            Margin Control picks up these pools and allocates each one by its basis across the rows in your current view.
          </div>
        </div>
      </div>

      {/* Add new pool */}
      <div className="cd" style={{ padding: '10px 14px', marginBottom: 12 }}>
        <div className="ct" style={{ marginTop: 0, marginBottom: 8 }}>ADD POOL</div>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '2fr 1fr 1fr 1.4fr 1fr 1fr 0.6fr' }}>
          <input
            type="text" placeholder="Pool name (e.g. Facility, S&A, Production)"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={inp()}
          />
          <input
            type="number" placeholder="Monthly $" step="100"
            value={draft.monthly_amount}
            onChange={(e) => setDraft({ ...draft, monthly_amount: Number(e.target.value) })}
            style={inp()}
          />
          <select
            value={draft.basis}
            onChange={(e) => setDraft({ ...draft, basis: e.target.value as AllocationBasis })}
            style={inp()}
            title={BASIS_OPTIONS.find((b) => b.id === draft.basis)?.help}
          >
            {BASIS_OPTIONS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
          <select
            value={draft.entity ?? ''}
            onChange={(e) => setDraft({ ...draft, entity: e.target.value || null })}
            style={inp()}
            title="Leave blank to apply across all entities"
          >
            {ENTITY_OPTIONS.map((e) => <option key={e} value={e}>{e || '(all entities)'}</option>)}
          </select>
          <input
            type="date" value={draft.effective_from}
            onChange={(e) => setDraft({ ...draft, effective_from: e.target.value })}
            style={inp()} title="Effective from"
          />
          <input
            type="date" value={draft.effective_to ?? ''}
            onChange={(e) => setDraft({ ...draft, effective_to: e.target.value || null })}
            style={inp()} title="Effective to (blank = open-ended)"
          />
          <button onClick={addPool} disabled={saving} style={btnPrimary()}>
            {saving ? '…' : 'Add'}
          </button>
        </div>
        <input
          type="text" placeholder="Notes (optional)"
          value={draft.notes ?? ''}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          style={{ ...inp(), width: '100%', marginTop: 8 }}
        />
      </div>

      {/* Existing pools table */}
      <div className="cd" style={{ padding: 0 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
          <div className="ct" style={{ margin: 0 }}>OVERHEAD POOLS — {pools.length}</div>
        </div>
        {pools.length === 0 ? (
          <div className="ld">No pools yet — add one above.</div>
        ) : (
          <div style={{ maxHeight: '52vh', overflow: 'auto' }}>
            <PrintableTable>
              <table>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                  <tr>
                    <th>Name</th>
                    <th style={{ textAlign: 'right' }}>Monthly $</th>
                    <th>Basis</th>
                    <th>Entity</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Active</th>
                    <th>Notes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((p) => (
                    <tr key={p.id} style={!p.active ? { opacity: 0.55 } : undefined}>
                      <td>
                        <input
                          type="text" value={p.name}
                          onChange={(e) => setPools((cur) => cur?.map((x) => x.id === p.id ? { ...x, name: e.target.value } : x) ?? null)}
                          onBlur={(e) => patchPool(p.id, { name: e.target.value })}
                          style={{ ...inp(), width: '100%', fontWeight: 600 }}
                        />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input
                          type="number" step="100" value={p.monthly_amount}
                          onChange={(e) => setPools((cur) => cur?.map((x) => x.id === p.id ? { ...x, monthly_amount: Number(e.target.value) } : x) ?? null)}
                          onBlur={(e) => patchPool(p.id, { monthly_amount: Number(e.target.value) })}
                          style={{ ...inp(), width: 110, textAlign: 'right' }}
                        />
                      </td>
                      <td>
                        <select
                          value={p.basis}
                          onChange={(e) => patchPool(p.id, { basis: e.target.value as AllocationBasis })}
                          style={{ ...inp(), width: 150 }}
                          title={BASIS_OPTIONS.find((b) => b.id === p.basis)?.help}
                        >
                          {BASIS_OPTIONS.map((b) => <option key={b.id} value={b.id}>{BASIS_LABEL[b.id]}</option>)}
                        </select>
                      </td>
                      <td>
                        <select
                          value={p.entity ?? ''}
                          onChange={(e) => patchPool(p.id, { entity: e.target.value || null })}
                          style={{ ...inp(), width: 110 }}
                        >
                          {ENTITY_OPTIONS.map((e) => <option key={e} value={e}>{e || '(all)'}</option>)}
                        </select>
                      </td>
                      <td>
                        <input
                          type="date" value={p.effective_from}
                          onChange={(e) => patchPool(p.id, { effective_from: e.target.value })}
                          style={{ ...inp(), width: 130 }}
                        />
                      </td>
                      <td>
                        <input
                          type="date" value={p.effective_to ?? ''}
                          onChange={(e) => patchPool(p.id, { effective_to: e.target.value || null })}
                          style={{ ...inp(), width: 130 }}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox" checked={p.active}
                          onChange={(e) => patchPool(p.id, { active: e.target.checked })}
                          style={{ accentColor: 'var(--ac)' }}
                        />
                      </td>
                      <td>
                        <input
                          type="text" value={p.notes ?? ''}
                          onChange={(e) => setPools((cur) => cur?.map((x) => x.id === p.id ? { ...x, notes: e.target.value } : x) ?? null)}
                          onBlur={(e) => patchPool(p.id, { notes: e.target.value || null })}
                          style={{ ...inp(), width: '100%', fontSize: 10 }}
                        />
                      </td>
                      <td>
                        <button
                          onClick={() => removePool(p.id, p.name)}
                          style={{ ...btnSecondary(), color: 'var(--rd)', borderColor: 'var(--rd)' }}
                          title="Delete pool"
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PrintableTable>
          </div>
        )}
      </div>

      {/* Basis legend */}
      <div className="cd" style={{ padding: '10px 14px', marginTop: 12, fontSize: 11, color: 'var(--tx2)' }}>
        <div className="ct" style={{ marginTop: 0, marginBottom: 6 }}>ALLOCATION BASIS REFERENCE</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
          {BASIS_OPTIONS.map((b) => (
            <div key={b.id}>
              <strong style={{ color: 'var(--tx)' }}>{b.label}</strong>
              <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2, fontFamily: 'var(--ff-mono)' }}>{b.help}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
