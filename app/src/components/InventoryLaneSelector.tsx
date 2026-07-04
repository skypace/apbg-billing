import { Boxes, PackageCheck } from 'lucide-react';
import {
  INVENTORY_LANES,
  type InventoryLane,
} from '../lib/inventoryLane';

interface Props {
  value: InventoryLane;
  onChange: (lane: InventoryLane) => void;
}

export function InventoryLaneSelector({ value, onChange }: Props) {
  return (
    <div className="toolbar-section" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="toolbar-label">Lane</span>
      <div role="tablist" aria-label="Inventory lane" style={{
        display: 'inline-flex',
        alignItems: 'center',
        border: '1px solid var(--ctl-bd)',
        borderRadius: 4,
        overflow: 'hidden',
        background: 'var(--ctl-bg)',
      }}>
        {INVENTORY_LANES.map((lane) => {
          const active = lane.value === value;
          const Icon = lane.value === 'bib_product' ? Boxes : PackageCheck;
          return (
            <button
              key={lane.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(lane.value)}
              title={lane.label}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 28,
                padding: '0 10px',
                border: 'none',
                borderRight: lane.value === 'bib_product' ? '1px solid var(--ctl-bd)' : 'none',
                background: active ? 'var(--ac)' : 'transparent',
                color: active ? 'var(--bg)' : 'var(--tx)',
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: active ? 800 : 600,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}
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

