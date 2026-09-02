import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Droplets, RefreshCw } from 'lucide-react';
import {
  RawIngredient, RawMaterialItemsResult,
  createRawMaterialItems, fetchProductionSettings, fetchRawIngredients, updateRawIngredient,
  type ProductionSettings,
} from '../../lib/rawMaterials';
import { QboVendor } from '../../lib/purchasing';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function num(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

type Draft = {
  purchase_uom: string;
  pack_size: string;
  order_multiple: string;
  purchase_cost: string;
  qbo_vendor_id: string;
  vendor_part_no: string;
};

function draftOf(r: RawIngredient): Draft {
  return {
    purchase_uom:   r.purchase_uom ?? '',
    pack_size:      r.pack_size == null ? '' : String(r.pack_size),
    order_multiple: String(r.order_multiple ?? 1),
    purchase_cost:  r.purchase_cost == null ? '' : String(r.purchase_cost),
    qbo_vendor_id:  r.qbo_vendor_id ?? '',
    vendor_part_no: r.vendor_part_no ?? '',
  };
}
function dirty(a: Draft, b: Draft): boolean {
  return (Object.keys(a) as (keyof Draft)[]).some((k) => a[k] !== b[k]);
}

/**
 * The ingredient master.
 *
 * A formula says a case holds 2.2056 lbs of cane sugar. That sentence cannot
 * become a purchase order until four separate facts exist: a QuickBooks item
 * to put on the line, a vendor to send it to, the pack the vendor sells (a
 * 50-lb bag), and what that pack costs. This page is where those four live,
 * and it names WHICH of them is missing rather than showing a bare red dot —
 * each one is a different job for a different person.
 */
export function RawMaterialsTab({ vendors, onChanged }: {
  vendors: QboVendor[] | null;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<RawIngredient[] | null>(null);
  const [settings, setSettings] = useState<ProductionSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [preview, setPreview] = useState<RawMaterialItemsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  function load() {
    setRows(null);
    fetchRawIngredients()
      .then((r) => { setRows(r); setDrafts(Object.fromEntries(r.map((x) => [x.id, draftOf(x)]))); })
      .catch((e) => { toast.error(errMsg(e)); setRows([]); });
    fetchProductionSettings().then(setSettings).catch(() => setSettings(null));
  }
  useEffect(load, []);

  const vendorOptions = useMemo(
    () => (vendors ?? []).slice().sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [vendors],
  );

  const stats = useMemo(() => {
    const list = rows ?? [];
    const purchased = list.filter((r) => r.is_purchased);
    return {
      total: list.length,
      purchased: purchased.length,
      noItem: purchased.filter((r) => !r.qbo_item_id).length,
      noCost: purchased.filter((r) => r.purchase_cost == null).length,
      noPack: purchased.filter((r) => r.pack_size == null).length,
      ready: purchased.filter((r) => r.gaps.length === 0).length,
    };
  }, [rows]);

  async function save(r: RawIngredient) {
    const d = drafts[r.id];
    if (!d) return;
    setSaving(r.id);
    try {
      await updateRawIngredient(r.id, {
        purchase_uom:   d.purchase_uom.trim() || null,
        pack_size:      num(d.pack_size),
        order_multiple: num(d.order_multiple) ?? 1,
        purchase_cost:  num(d.purchase_cost),
        qbo_vendor_id:  d.qbo_vendor_id || null,
        vendor_part_no: d.vendor_part_no.trim() || null,
      });
      toast.success(r.name + ' saved');
      load();
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(null); }
  }

  async function runPreview() {
    setBusy(true);
    try { setPreview(await createRawMaterialItems({ commit: false })); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function runCommit() {
    setBusy(true);
    try {
      const res = await createRawMaterialItems({ commit: true });
      const made = res.created.length, linked = res.linked.length, failed = res.failed.length;
      toast.success(
        made + ' item' + (made === 1 ? '' : 's') + ' created'
        + (linked ? ', ' + linked + ' already existed and were linked' : '')
        + (failed ? ' — ' + failed + ' failed' : ''),
      );
      if (failed) for (const f of res.failed) toast.error(f.name + ': ' + f.error);
      setPreview(null);
      load();
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <div className="toolbar-row">
          <strong style={{ fontSize: 12.5 }}>Raw materials</strong>
          <span style={{ fontSize: 11, color: 'var(--mt)' }}>
            {stats.purchased} purchased · {stats.ready} ready to order · {stats.total - stats.purchased} sourced on site
          </span>
          <div className="toolbar-spacer" />
          <button style={btnSecondary()} onClick={load}>
            <RefreshCw size={12} style={{ verticalAlign: -2, marginRight: 5 }} />Reload
          </button>
          <button style={btnPrimary()} disabled={busy || stats.noItem === 0} onClick={runPreview}>
            {stats.noItem === 0
              ? 'Every material has an item'
              : 'Create the ' + stats.noItem + ' missing QuickBooks item' + (stats.noItem === 1 ? '' : 's') + '…'}
          </button>
        </div>
      </div>

      {(stats.noItem > 0 || stats.noCost > 0) && (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--am)' }}>
          <div style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 5, color: 'var(--am)' }} />
            <strong>What is still missing.</strong>{' '}
            {stats.noItem > 0 && <>
              <b>{stats.noItem}</b> material{stats.noItem === 1 ? ' has' : 's have'} no QuickBooks item, so
              {stats.noItem === 1 ? ' it' : ' they'} cannot appear on a bill of materials or a purchase order at all.{' '}
            </>}
            {stats.noCost > 0 && <>
              <b>{stats.noCost}</b> {stats.noCost === 1 ? 'has' : 'have'} no cost on file. A work order will still
              order the right quantity — the per-case cost simply comes out short until a price is entered, and
              nothing here invents one.
            </>}
          </div>
        </div>
      )}

      {preview && (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--ac)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
            About to create {preview.planned?.length ?? 0} QuickBooks item
            {(preview.planned?.length ?? 0) === 1 ? '' : 's'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 8, lineHeight: 1.6 }}>
            Each is created as a non-inventory purchase item expensed to{' '}
            <b>{preview.expense_account.name}</b>. A QuickBooks item cannot be deleted once
            created, only made inactive — so the names below are worth reading. If an item of the
            same name already exists it is linked, never duplicated.
          </div>
          <div style={{ maxHeight: 240, overflow: 'auto', marginBottom: 10 }}>
            <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
              <tbody>
                {(preview.planned ?? []).map((p) => (
                  <tr key={p.slug} style={{ borderTop: '1px solid var(--bd)' }}>
                    <td style={{ padding: '4px 6px' }}>{p.name}</td>
                    <td style={{ padding: '4px 6px', color: 'var(--mt)' }} className="mn">{p.sku}</td>
                    <td style={{ padding: '4px 6px', color: p.has_cost ? 'var(--gn)' : 'var(--am)' }}>
                      {p.has_cost ? 'has a cost' : 'no cost yet'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button style={btnPrimary()} disabled={busy} onClick={runCommit}>
            {busy ? 'Creating…' : 'Create them in QuickBooks'}
          </button>{' '}
          <button style={btnSecondary()} disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse', minWidth: 1080 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--mt)', fontSize: 10, textTransform: 'uppercase' }}>
              <th style={{ padding: '6px 6px' }}>Material</th>
              <th style={{ padding: '6px 6px' }}>Formulas</th>
              <th style={{ padding: '6px 6px' }}>QuickBooks item</th>
              <th style={{ padding: '6px 6px' }}>Vendor</th>
              <th style={{ padding: '6px 6px' }}>Bought as</th>
              <th style={{ padding: '6px 6px' }}>Recipe units per pack</th>
              <th style={{ padding: '6px 6px' }}>Order multiple</th>
              <th style={{ padding: '6px 6px' }}>Cost per pack</th>
              <th style={{ padding: '6px 6px' }}></th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={9} style={{ padding: 14, color: 'var(--mt)' }}>Loading…</td></tr>
            )}
            {rows?.map((r) => {
              const d = drafts[r.id] ?? draftOf(r);
              const isDirty = dirty(d, draftOf(r));
              return (
                <tr key={r.id} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={{ padding: '5px 6px' }}>
                    <div style={{ fontWeight: 700 }}>{r.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--mt)' }}>
                      recipe unit: {r.recipe_uom}
                      {!r.is_purchased && <>
                        {' · '}
                        <Droplets size={10} style={{ verticalAlign: -1 }} /> sourced on site, never ordered
                      </>}
                    </div>
                  </td>
                  <td style={{ padding: '5px 6px' }} className="mn">{r.formula_count}</td>
                  <td style={{ padding: '5px 6px' }}>
                    {r.qbo_item_id
                      ? <span style={{ color: 'var(--gn)' }}>
                          <Check size={11} style={{ verticalAlign: -1 }} /> {r.qbo_item_name ?? r.qbo_item_id}
                        </span>
                      : r.is_purchased
                        ? <span style={{ color: 'var(--am)' }}>none yet</span>
                        : <span style={{ color: 'var(--mt)' }}>not needed</span>}
                  </td>
                  <td style={{ padding: '5px 6px' }}>
                    <select
                      style={{ ...inp(), width: 168 }}
                      disabled={!r.is_purchased}
                      value={d.qbo_vendor_id}
                      onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...d, qbo_vendor_id: e.target.value } })}
                    >
                      <option value="">—</option>
                      {vendorOptions.map((v) => (
                        <option key={v.qbo_vendor_id} value={v.qbo_vendor_id}>{v.display_name}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '5px 6px' }}>
                    <input
                      style={{ ...inp(), width: 110 }} placeholder="50 lb bag" disabled={!r.is_purchased}
                      value={d.purchase_uom}
                      onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...d, purchase_uom: e.target.value } })}
                    />
                  </td>
                  <td style={{ padding: '5px 6px' }}>
                    <input
                      style={{ ...inp(), width: 84 }} placeholder="50" disabled={!r.is_purchased}
                      value={d.pack_size}
                      onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...d, pack_size: e.target.value } })}
                    />
                  </td>
                  <td style={{ padding: '5px 6px' }}>
                    <input
                      style={{ ...inp(), width: 70 }} disabled={!r.is_purchased}
                      value={d.order_multiple}
                      onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...d, order_multiple: e.target.value } })}
                    />
                  </td>
                  <td style={{ padding: '5px 6px' }}>
                    <input
                      style={{ ...inp(), width: 92 }} placeholder="—" disabled={!r.is_purchased}
                      value={d.purchase_cost}
                      onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...d, purchase_cost: e.target.value } })}
                    />
                  </td>
                  <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>
                    <button
                      style={btnSecondary()}
                      disabled={!isDirty || saving === r.id}
                      onClick={() => save(r)}
                    >{saving === r.id ? 'Saving…' : 'Save'}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--mt)', lineHeight: 1.7 }}>
        <b>Recipe units per pack</b> is how many of the recipe's unit are inside one thing the vendor
        sells — 50 for a 50-lb bag of sugar. A work order needs 1 103 lbs of sugar, so it orders 23 bags.
        Leave it blank when the vendor sells in the recipe unit itself.
        {settings?.clearing_account_name && <>
          {' '}New items are expensed to <b>{settings.clearing_account_name}</b>, the account every
          production cost is offset through.
        </>}
      </div>
    </div>
  );
}
