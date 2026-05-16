// Unit of measure conversion + BOM scaling. Used by the BomsTab "Scale this
// BOM" calculator and the WorkOrders Create form's target-driven autoscale.
//
// Storage convention: BOM lines + WO targets are saved as a (qty, uom) pair
// in the user's input units. Conversions happen on read for display/math,
// so no destructive migration is needed.
//
// Supported UoM vocabulary (free text allowed in DB; UI dropdown shows
// these):
//   Counts: each, case
//   Volume: gal, fl_oz, L, mL
//   Weight: lb, oz   (oz here means weight-oz; volume uses fl_oz)

export type UomGroup = 'count' | 'volume' | 'weight' | 'unknown';

export const UOM_OPTIONS: ReadonlyArray<{ value: string; label: string; group: UomGroup }> = [
  { value: 'each',  label: 'each',     group: 'count'  },
  { value: 'case',  label: 'case',     group: 'count'  },
  { value: 'gal',   label: 'gal',      group: 'volume' },
  { value: 'fl_oz', label: 'fl oz',    group: 'volume' },
  { value: 'L',     label: 'L',        group: 'volume' },
  { value: 'mL',    label: 'mL',       group: 'volume' },
  { value: 'lb',    label: 'lb',       group: 'weight' },
  { value: 'oz',    label: 'oz (wt)',  group: 'weight' },
];

// Volume base = fl_oz. Conversion factors below give "1 unit of X = N fl_oz".
const VOLUME: Record<string, number> = {
  fl_oz: 1,
  gal:   128,
  L:     33.8140227,
  mL:    0.0338140227,
};

// Weight base = oz (16 oz / lb).
const WEIGHT: Record<string, number> = {
  oz: 1,
  lb: 16,
};

export function uomGroup(uom: string): UomGroup {
  if (uom === 'each' || uom === 'case') return 'count';
  if (uom in VOLUME) return 'volume';
  if (uom in WEIGHT) return 'weight';
  return 'unknown';
}

/**
 * Convert qty between two UoMs. Returns null when the conversion is not
 * possible (e.g. gal → each without a BOM yield to bridge).
 *
 * For case ↔ volume conversions, pass `bridge` describing how the BOM's
 * yield is defined (e.g. 1 case = 2.25 gal of finished product). The
 * BomsTab scaler synthesizes this from the BOM header's yield_qty +
 * yield_uom when the line happens to be in a different unit family.
 */
export function convertQty(
  qty: number,
  from: string,
  to: string,
  bridge?: { yieldQty: number; yieldUom: string; finishedVolPerYieldGal?: number },
): number | null {
  if (!Number.isFinite(qty)) return null;
  if (from === to) return qty;

  // Same-family conversions are pure factors.
  const gFrom = uomGroup(from);
  const gTo = uomGroup(to);
  if (gFrom === 'volume' && gTo === 'volume') {
    return qty * VOLUME[from] / VOLUME[to];
  }
  if (gFrom === 'weight' && gTo === 'weight') {
    return qty * WEIGHT[from] / WEIGHT[to];
  }
  if (gFrom === 'count' && gTo === 'count') {
    // each ↔ case requires a bridge (eaches per case). The BOM doesn't
    // currently store it; we don't auto-convert this direction. Operators
    // who need it can stage the BOM yield in cases and add 'each' lines
    // explicitly.
    return null;
  }

  // Cross-family bridge: count ↔ volume via the BOM yield definition.
  if (bridge && bridge.yieldQty > 0) {
    const yieldGroup = uomGroup(bridge.yieldUom);
    // Bridge: 1 yield = bridge.yieldQty (yieldUom). For "case → gal" or
    // "gal → case" we need a yield expressed in the target group OR the
    // optional finishedVolPerYieldGal hint.
    if (yieldGroup === 'count' && gFrom === 'volume') {
      // gal → case (when 1 case = X gal finished)
      const gal = qty * VOLUME[from] / VOLUME.gal;
      if (bridge.finishedVolPerYieldGal) {
        const yields = gal / bridge.finishedVolPerYieldGal;
        if (to === bridge.yieldUom) return yields * bridge.yieldQty;
      }
    }
    if (yieldGroup === 'count' && gTo === 'volume') {
      // case → gal (when 1 case = X gal finished)
      if (from === bridge.yieldUom && bridge.finishedVolPerYieldGal) {
        const yields = qty / bridge.yieldQty;
        const gal = yields * bridge.finishedVolPerYieldGal;
        return gal * VOLUME.gal / VOLUME[to];
      }
    }
  }

  return null;
}

/**
 * BOM line representation for the scaler. Keep it minimal so it composes with
 * whatever shape the caller is holding (DB row, draft form, etc.).
 */
export interface ScalableLine<T = unknown> {
  qty_per: number;
  qty_uom: string;
  ref: T;
}

export interface ScaledLine<T> {
  qty: number;
  uom: string;
  ref: T;
}

/**
 * Scale BOM lines to a target production quantity.
 *
 * @param target  How much finished product the operator wants to make (qty + uom).
 * @param yield_  The BOM's yield (qty + uom). 1 "run" of the BOM produces this much.
 * @param lines   The BOM lines (qty_per per yield + uom + caller-defined ref).
 * @returns       { runs, scaledLines }. `runs` is the multiplier applied to
 *                qty_per (1 BOM yields `yield_.qty` of `yield_.uom`; to make
 *                `target.qty` of `target.uom` we need `runs` repetitions of
 *                the BOM). Scaled line qty/uom preserves the line's own UoM.
 *                Returns null if target ↔ yield UoMs are incompatible.
 */
export function scaleBom<T>(
  target: { qty: number; uom: string },
  yield_: { qty: number; uom: string; finishedVolPerYieldGal?: number },
  lines: ScalableLine<T>[],
): { runs: number; scaledLines: ScaledLine<T>[] } | null {
  if (!(target.qty > 0) || !(yield_.qty > 0)) return null;

  // How many "runs" of this BOM are needed to satisfy the target?
  // 1 run produces yield_.qty of yield_.uom; convert target to yield_.uom to
  // get the runs.
  const targetInYieldUom = convertQty(target.qty, target.uom, yield_.uom, {
    yieldQty: yield_.qty,
    yieldUom: yield_.uom,
    finishedVolPerYieldGal: yield_.finishedVolPerYieldGal,
  });
  if (targetInYieldUom == null) return null;
  const runs = targetInYieldUom / yield_.qty;

  const scaledLines = lines.map((l) => ({
    qty: l.qty_per * runs,
    uom: l.qty_uom,
    ref: l.ref,
  }));

  return { runs, scaledLines };
}

/** Friendly display: "2.25 gal" not "2.2500000". */
export function fmtQty(qty: number | null | undefined, uom: string): string {
  if (qty == null || !Number.isFinite(qty)) return '—';
  const abs = Math.abs(qty);
  let s: string;
  if (abs >= 1000) s = qty.toLocaleString(undefined, { maximumFractionDigits: 0 });
  else if (abs >= 10) s = qty.toLocaleString(undefined, { maximumFractionDigits: 2 });
  else s = qty.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return `${s} ${uom}`;
}
