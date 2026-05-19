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
  // bridge.finishedVolPerYieldGal is "gal of finished product per 1
  // yield_uom unit" — explicitly per-unit semantics, matching the column
  // comment on ops.product_bom.finished_vol_per_yield_gal and the BomsTab
  // input label ("1 {yield_uom} produces ___ gal"). The yieldQty factor
  // does NOT appear here — applying it would double-count for yield_qty>1
  // BOMs (e.g. 2 cases/batch at 2.25 gal/case = 4.5 gal/batch; without the
  // fix, "1000 gal" stored as 888.88 case instead of the correct 444.44).
  if (bridge && bridge.yieldQty > 0 && bridge.finishedVolPerYieldGal) {
    const yieldGroup = uomGroup(bridge.yieldUom);
    if (yieldGroup === 'count' && gFrom === 'volume' && to === bridge.yieldUom) {
      // gal-family → yield_uom (e.g. fl_oz → case): convert input to gal
      // first, then divide by per-unit bridge.
      const gal = qty * VOLUME[from] / VOLUME.gal;
      return gal / bridge.finishedVolPerYieldGal;
    }
    if (yieldGroup === 'count' && gTo === 'volume' && from === bridge.yieldUom) {
      // yield_uom → gal-family (e.g. case → fl_oz): multiply by per-unit
      // bridge first, then convert from gal to the target volume unit.
      const gal = qty * bridge.finishedVolPerYieldGal;
      return gal * VOLUME.gal / VOLUME[to];
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
  /** 0..1. Matches the (1 + scrap_pct) factor in fn_consume_work_order so
   *  the scaler agrees with what the WO will actually consume. */
  scrap_pct?: number;
  ref: T;
}

export interface ScaledLine<T> {
  qty: number;
  uom: string;
  ref: T;
}

/**
 * Best-effort: parse a QBO item's name/SKU for the per-unit volume in fl_oz.
 *
 * Recognized patterns (anchored at the start of the name):
 *   "1GNS1091 …"             → 1 gal      (one-gallon syrup pack)
 *   "1GN1091 …"              → 1 gal
 *   "3G2051 …"               → 3 gal      (BIB)
 *   "5G… "                   → 5 gal
 *   "2L2051 …"               → 2 L
 *   "12OZ CAN GOLDEN GATE …" → 12 fl_oz   (single can)
 *   "8PK6481 … (8 × 12 fl oz)" → 96 fl_oz (from parenthesized N × M oz)
 *   "24P126481 …"            → 288 fl_oz (24-pack of 12 oz)
 *
 * Returns null when:
 *   - the item is a Service / Category (Service items like "12OZ CAN FILL
 *     LABOR" share the prefix but aren't a volume themselves)
 *   - the pattern is ambiguous (e.g. "5P…" — could be 5-pack or 5-pint)
 *
 * The parser is intentionally conservative — false negatives are fine
 * (the operator can override on the line), but false positives would
 * silently break the scaler math.
 */
export function inferItemVolumeFlOz(name?: string | null, type?: string | null): number | null {
  if (!name) return null;
  // Service / Category items don't represent a volume of beverage even when
  // their name happens to include a unit (e.g. "12OZ CAN FILL LABOR" is a
  // labor service whose 12oz is just descriptive).
  if (type === 'Service' || type === 'Category') return null;

  const s = name.trim();

  // Parenthesized "(N × M oz)" or "(N × M fl oz)" — most reliable signal,
  // try it first so 8PK6481 with "(8 × 12 fl oz)" wins over a leading
  // "8" misread.
  const paren = s.match(/\((\d+(?:\.\d+)?)\s*[×x*]\s*(\d+(?:\.\d+)?)\s*(fl\s*oz|oz|gal|L|mL)\s*\)/i);
  if (paren) {
    const n = Number(paren[1]);
    const m = Number(paren[2]);
    const u = paren[3].toLowerCase().replace(/\s+/g, '');
    if (Number.isFinite(n) && Number.isFinite(m) && n > 0 && m > 0) {
      if (u === 'floz' || u === 'oz') return n * m;
      if (u === 'gal')                 return n * m * VOLUME.gal;
      if (u === 'l')                   return n * m * VOLUME.L;
      if (u === 'ml')                  return n * m * VOLUME.mL;
    }
  }

  // Leading "NGN" or "NGNS" / "NG" + digit (gallon SKU prefix).
  // "1GNS1091" → 1 gal.  "3G2051" → 3 gal.  Require a digit AFTER the unit
  // letter to keep this from matching service codes like "3GAL FEE".
  const galPrefix = s.match(/^(\d+(?:\.\d+)?)\s*G(?:NS?)?\d/i);
  if (galPrefix) {
    const n = Number(galPrefix[1]);
    if (Number.isFinite(n) && n > 0) return n * VOLUME.gal;
  }

  // Leading "NL" + digit (liter SKU prefix). "2L2051" → 2 L.
  const literPrefix = s.match(/^(\d+(?:\.\d+)?)\s*L\d/i);
  if (literPrefix) {
    const n = Number(literPrefix[1]);
    if (Number.isFinite(n) && n > 0) return n * VOLUME.L;
  }

  // Leading "NPK" + ... + "MOZ" (case-pack with N units of M ounces).
  // "24P126481" / "8PK6481 (alt)" patterns vary; only commit when both
  // counts are explicit.
  const pkOz = s.match(/^(\d+)\s*PK(\d+)/i);
  if (pkOz) {
    const n = Number(pkOz[1]);
    const m = Number(pkOz[2]);
    // Only count if M looks like fl_oz (8-32 range). Otherwise the second
    // number is more likely a SKU suffix.
    if (n > 0 && m >= 6 && m <= 32) return n * m;
  }

  // Leading "12OZ" / "16OZ" + space + word (single can — describes the
  // beverage, not labor/packaging service). The conservative gate: the next
  // token must look like a beverage word, not a labor/service word.
  const ozCan = s.match(/^(\d+(?:\.\d+)?)\s*OZ\s+(CAN|BTL|BOTTLE|CUP|MUG|GLASS)/i);
  if (ozCan) {
    const n = Number(ozCan[1]);
    if (n > 0) return n;
  }

  return null;
}

/**
 * Scale BOM lines to a target production quantity.
 *
 * @param target  How much finished product the operator wants to make (qty + uom).
 * @param yield_  The BOM's yield (qty + uom). 1 "run" of the BOM produces this much.
 * @param lines   The BOM lines (qty_per per yield + uom + caller-defined ref).
 *                Each line may carry optional `itemName` and `itemType` so the
 *                scaler can derive per-unit volume from the SKU prefix and
 *                run ingredient-driven math when `dilutionRatio` is set.
 * @returns       { runs, scaledLines, ingredientVolGal?, finishedVolPerYieldGal? }
 *                — runs and scaled qty/uom preserved as before, plus the
 *                computed concentrate + finished volumes when ingredient
 *                math kicked in. Returns null if target ↔ yield UoMs are
 *                incompatible and no ingredient-derived path exists.
 */
export function scaleBom<T>(
  target: { qty: number; uom: string },
  yield_: {
    qty: number;
    uom: string;
    finishedVolPerYieldGal?: number;
    /** Water parts per 1 part concentrate. 5:1 post-mix → 5. */
    dilutionRatio?: number;
  },
  lines: ScalableLineWithItem<T>[],
): {
  runs: number;
  scaledLines: ScaledLine<T>[];
  ingredientVolGal?: number;
  finishedVolPerYieldGal?: number;
  mode: 'yield' | 'ingredient';
} | null {
  if (!(target.qty > 0) || !(yield_.qty > 0)) return null;

  // Ingredient-driven scaling: when target is in volume units AND any
  // ingredient line parses to a per-unit volume AND a dilution_ratio is
  // configured on the BOM, compute the finished-volume-per-yield from the
  // ingredients themselves rather than from the legacy
  // finishedVolPerYieldGal bridge. This is how Sky's "5:1 post-mix"
  // workflow works: 1 gal syrup × (1 + 5) = 6 gal finished, target /
  // 6 = runs.
  if (uomGroup(target.uom) === 'volume' && (yield_.dilutionRatio ?? 0) > 0) {
    const targetFlOz = target.qty * VOLUME[target.uom];
    let concentrateFlOzPerYield = 0;
    for (const l of lines) {
      const perUnit = inferItemVolumeFlOz(l.itemName, l.itemType);
      if (perUnit != null && perUnit > 0) {
        // Line's qty_per is in fl_oz (its UoM is 'each') or in its own
        // volume unit. We rely on the SKU-derived per-unit volume so this
        // path doesn't double-count when qty_uom is already a volume.
        if (uomGroup(l.qty_uom) === 'volume') {
          concentrateFlOzPerYield += l.qty_per * VOLUME[l.qty_uom];
        } else {
          concentrateFlOzPerYield += l.qty_per * perUnit;
        }
      }
    }
    if (concentrateFlOzPerYield > 0) {
      const multiplier = 1 + (yield_.dilutionRatio ?? 0);
      const finishedFlOzPerYield = concentrateFlOzPerYield * multiplier;
      const runs = targetFlOz / finishedFlOzPerYield;
      const scaledLines = lines.map((l) => ({
        qty: l.qty_per * runs * (1 + (l.scrap_pct ?? 0)),
        uom: l.qty_uom,
        ref: l.ref,
      }));
      return {
        runs,
        scaledLines,
        ingredientVolGal: concentrateFlOzPerYield / VOLUME.gal,
        finishedVolPerYieldGal: finishedFlOzPerYield / VOLUME.gal,
        mode: 'ingredient',
      };
    }
    // No parseable ingredient volumes — fall through to legacy yield mode.
  }

  // Legacy: how many "runs" of this BOM are needed to satisfy the target?
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
    qty: l.qty_per * runs * (1 + (l.scrap_pct ?? 0)),
    uom: l.qty_uom,
    ref: l.ref,
  }));

  return { runs, scaledLines, mode: 'yield' as const };
}

/** A ScalableLine that carries optional item context so scaleBom can run
 *  ingredient-driven math (SKU → per-unit volume → dilution). When the
 *  caller doesn't have item info, leave `itemName`/`itemType` undefined and
 *  scaleBom falls back to the legacy yield-bridge path. */
export interface ScalableLineWithItem<T = unknown> extends ScalableLine<T> {
  itemName?: string | null;
  itemType?: string | null;
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
