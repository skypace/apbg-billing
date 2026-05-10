import { Layers, X } from 'lucide-react';
import { CHAIN_MODIFIERS, type ChainModifier } from '../lib/chainModifiers';

interface Props {
  active: string[];
  onChange: (next: string[]) => void;
}

// Large prominent button group — one row of equipment & service rollups,
// one row of soda rollups. Each button shows the code (large) + label.
// Click to toggle. Multiple can be active; their filters union together.
export function ModifierPicker({ active, onChange }: Props) {
  function toggle(code: string) {
    onChange(
      active.includes(code)
        ? active.filter((c) => c !== code)
        : [...active, code],
    );
  }

  const equipment = CHAIN_MODIFIERS.filter((m) => m.group === 'equipment');
  const soda      = CHAIN_MODIFIERS.filter((m) => m.group === 'soda');

  return (
    <div className="modifier-bar" role="toolbar" aria-label="Customer chain rollup">
      <div className="modifier-bar-label">
        <Layers size={13} strokeWidth={2.2} aria-hidden="true" />
        <span>Customer rollup</span>
      </div>

      <ModifierGroup title="Equipment & Service" modifiers={equipment} active={active} onToggle={toggle} />
      <div className="modifier-divider" aria-hidden="true" />
      <ModifierGroup title="Soda Sales" modifiers={soda} active={active} onToggle={toggle} />

      {active.length > 0 && (
        <button type="button" className="modifier-btn modifier-btn--clear" onClick={() => onChange([])} title="Clear all rollups">
          <X size={11} strokeWidth={2.4} aria-hidden="true" />
          <span style={{ marginLeft: 4 }}>Clear ({active.length})</span>
        </button>
      )}
    </div>
  );
}

function ModifierGroup({
  title,
  modifiers,
  active,
  onToggle,
}: {
  title: string;
  modifiers: ChainModifier[];
  active: string[];
  onToggle: (code: string) => void;
}) {
  return (
    <div className="modifier-group">
      <span className="modifier-group-label">{title}</span>
      {modifiers.map((m) => {
        const on = active.includes(m.code);
        const isRollup = !m.parent;
        return (
          <button
            key={m.code}
            type="button"
            onClick={() => onToggle(m.code)}
            className={'modifier-btn' + (on ? ' modifier-btn--active' : '') + (isRollup ? ' modifier-btn--rollup' : '')}
            title={m.full}
            aria-pressed={on}
          >
            <span className="modifier-code">{m.code}</span>
            <span className="modifier-name">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
