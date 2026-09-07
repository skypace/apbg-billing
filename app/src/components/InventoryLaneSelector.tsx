import { Boxes, Package, PackageCheck } from 'lucide-react';
import {
  INVENTORY_LANES,
  type InventoryLane,
} from '../lib/inventoryLane';

interface Props {
  /** Selected lanes. EMPTY means every lane — the chips then all read as lit. */
  value: InventoryLane[];
  /** Toggle one lane in or out of the selection. */
  onToggle: (lane: InventoryLane) => void;
  /** Which lanes to offer (default: all). Production passes PRODUCTION_LANES — no 8-packs there. */
  lanes?: InventoryLane[];
}

const ICONS = { bib_product: Boxes, cans_24pk: PackageCheck, cans_8pk: Package } as const;

/**
 * Lane chips, multi-select (Sky, 2026-09-04): click a lane to turn it on or
 * off; with nothing picked every lane shows. A lit chip is a filter; an
 * unlit row of chips is "all". The "All" chip clears the selection.
 */
export function InventoryLaneSelector({ value, onToggle, lanes }: Props) {
  const offered = lanes ? INVENTORY_LANES.filter((l) => lanes.includes(l.value)) : INVENTORY_LANES;
  const all = value.length === 0;
  const chip = (active: boolean, dim: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: 28,
    padding: '0 10px',
    border: 'none',
    borderRight: '1px solid var(--ctl-bd)',
    background: active ? 'var(--ac)' : 'transparent',
    color: active ? 'var(--bg)' : dim ? 'var(--mt)' : 'var(--tx)',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: active ? 800 : 600,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  });
  return (
    <div className="toolbar-section" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="toolbar-label">Lanes</span>
      <div role="group" aria-label="Inventory lanes (pick any; none = all)" style={{
        display: 'inline-flex',
        alignItems: 'center',
        border: '1px solid var(--ctl-bd)',
        borderRadius: 4,
        overflow: 'hidden',
        background: 'var(--ctl-bg)',
      }}>
        <button type="button" aria-pressed={all} title="Every lane"
          onClick={() => { for (const l of value) onToggle(l); }}
          style={chip(all, false)}>
          All
        </button>
        {offered.map((lane, idx) => {
          const active = value.includes(lane.value);
          const Icon = ICONS[lane.value];
          return (
            <button
              key={lane.value}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(lane.value)}
              title={active ? `${lane.label} — click to drop it` : `${lane.label} — click to add it`}
              style={{ ...chip(active, !all && !active), borderRight: idx < offered.length - 1 ? '1px solid var(--ctl-bd)' : 'none' }}
            >
              <Icon size={12} strokeWidth={2.2} aria-hidden="true" />
              {lane.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
