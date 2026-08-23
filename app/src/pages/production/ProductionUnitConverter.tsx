import { useEffect, useMemo, useState } from 'react';
import { inp } from '../../lib/styles';

type ConverterUnit = 'gal' | 'fl_oz' | 'can' | 'pack8' | 'pack24' | 'finished';

const UNIT_OPTIONS: { value: ConverterUnit; label: string }[] = [
  { value: 'gal',      label: 'gallons' },
  { value: 'fl_oz',    label: 'ounces' },
  { value: 'can',      label: 'cans' },
  { value: 'pack8',    label: '8-packs' },
  { value: 'pack24',   label: '24-packs' },
  { value: 'finished', label: 'finished units' },
];

function fmt(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (abs >= 100) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 10) return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function unitToFlOz(qty: number, unit: ConverterUnit, ozPerCan: number, cansPerFinishedUnit: number): number | null {
  if (!Number.isFinite(qty) || !(ozPerCan > 0) || !(cansPerFinishedUnit > 0)) return null;
  if (unit === 'gal') return qty * 128;
  if (unit === 'fl_oz') return qty;
  if (unit === 'can') return qty * ozPerCan;
  if (unit === 'pack8') return qty * 8 * ozPerCan;
  if (unit === 'pack24') return qty * 24 * ozPerCan;
  return qty * cansPerFinishedUnit * ozPerCan;
}

export function ProductionUnitConverter({
  title = 'Unit converter',
  cansPerFinishedUnit,
  ozPerCan,
  initialQty = 500,
  initialUnit = 'gal',
}: {
  title?: string;
  cansPerFinishedUnit: number;
  ozPerCan: number;
  initialQty?: number;
  initialUnit?: ConverterUnit;
}) {
  const [qty, setQty] = useState(String(initialQty));
  const [unit, setUnit] = useState<ConverterUnit>(initialUnit);

  useEffect(() => {
    setQty(String(initialQty));
    setUnit(initialUnit);
  }, [initialQty, initialUnit]);

  const rows = useMemo(() => {
    const n = Number(qty);
    const flOz = unitToFlOz(n, unit, ozPerCan, cansPerFinishedUnit);
    if (flOz == null) return null;
    const cans = flOz / ozPerCan;
    return {
      gal: flOz / 128,
      fl_oz: flOz,
      can: cans,
      pack8: cans / 8,
      pack24: cans / 24,
      finished: cans / cansPerFinishedUnit,
    };
  }, [qty, unit, ozPerCan, cansPerFinishedUnit]);

  return (
    <div style={{
      padding: '10px 12px',
      border: '1px solid var(--bd)',
      borderRadius: 4,
      background: 'rgba(91,181,240,0.04)',
      fontSize: 11,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        marginBottom: 10,
      }}>
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>
          {title}
        </span>
        <input type="number" min={0} step="any" value={qty}
          onChange={(e) => setQty(e.target.value)}
          style={{ ...inp(), width: 110, textAlign: 'right' }} />
        <select value={unit} onChange={(e) => setUnit(e.target.value as ConverterUnit)}
          style={{ ...inp(), width: 130 }}>
          {UNIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span style={{ color: 'var(--mt)' }}>
          using {fmt(cansPerFinishedUnit)} cans/finished unit x {fmt(ozPerCan)} oz/can
        </span>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))',
        gap: 10,
      }}>
        <ConvTile label="Gallons" value={fmt(rows?.gal ?? null)} />
        <ConvTile label="Ounces" value={fmt(rows?.fl_oz ?? null)} />
        <ConvTile label="Cans" value={fmt(rows?.can ?? null)} />
        <ConvTile label="8-packs" value={fmt(rows?.pack8 ?? null)} />
        <ConvTile label="24-packs" value={fmt(rows?.pack24 ?? null)} />
        <ConvTile label="Finished units" value={fmt(rows?.finished ?? null)} />
      </div>
    </div>
  );
}

function ConvTile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ marginTop: 2, fontFamily: 'var(--ff-mono)', color: 'var(--tx)', fontWeight: 700 }}>
        {value}
      </div>
    </div>
  );
}
