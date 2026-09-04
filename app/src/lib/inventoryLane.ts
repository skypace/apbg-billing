import { useEffect, useMemo, useState } from 'react';

export type InventoryLane = 'bib_product' | 'cans_24pk' | 'cans_8pk';
export type InventoryLaneDb = InventoryLane | 'excluded';
export type InventoryLaneSize = '3g' | '5g' | '24pk' | '8pk';

export const INVENTORY_LANES: { value: InventoryLane; label: string; shortLabel: string }[] = [
  { value: 'bib_product', label: 'BIB Product', shortLabel: 'BIB' },
  { value: 'cans_24pk', label: 'Cans 24pks', shortLabel: '24pk Cans' },
  { value: 'cans_8pk', label: 'Cans 8pks', shortLabel: '8pk Cans' },
];

export const ALL_INVENTORY_LANES: InventoryLane[] = INVENTORY_LANES.map((l) => l.value);

/**
 * Production runs work orders for BIB purchasing and 24-pack canning only —
 * an 8-pack is made from a 24-pack case on a repack sheet, never by a BOM, so
 * the Production page offers two lanes while planning offers three.
 */
export const PRODUCTION_LANES: InventoryLane[] = ['bib_product', 'cans_24pk'];

export const INVENTORY_LANE_LABEL: Record<InventoryLaneDb, string> = {
  bib_product: 'BIB Product',
  cans_24pk: 'Cans 24pks',
  cans_8pk: 'Cans 8pks',
  excluded: 'Excluded',
};

export const INVENTORY_LANE_SIZE_LABEL: Record<InventoryLaneSize, string> = {
  '3g': '3G',
  '5g': '5G',
  '24pk': '24pk',
  '8pk': '8pk',
};

const STORAGE_KEY = 'brix.inventory.lane';
const STORAGE_KEY_MULTI = 'brix.inventory.lanes';

/** Coerce an unknown value onto one of the allowed lanes (default: all three); anything else falls to the first allowed lane. */
export function coerceInventoryLane(value: unknown, allowed: InventoryLane[] = ALL_INVENTORY_LANES): InventoryLane {
  return (allowed as unknown[]).includes(value) ? (value as InventoryLane) : allowed[0];
}

export function getStoredInventoryLane(allowed: InventoryLane[] = ALL_INVENTORY_LANES): InventoryLane {
  if (typeof localStorage === 'undefined') return allowed[0];
  return coerceInventoryLane(localStorage.getItem(STORAGE_KEY), allowed);
}

/**
 * The lane is shared across pages through localStorage. A page that only
 * handles some lanes (Production: no 8-packs) passes `allowed` so a lane picked
 * on the planner is coerced rather than rendered as an empty page.
 */
export function useInventoryLane(allowed: InventoryLane[] = ALL_INVENTORY_LANES): [InventoryLane, (lane: InventoryLane) => void] {
  const [lane, setLaneState] = useState<InventoryLane>(() => getStoredInventoryLane(allowed));

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, lane);
  }, [lane]);

  return useMemo(() => [lane, setLaneState] as const, [lane]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-select lanes (Sky, 2026-09-04): "the lanes need to be multiple select.
// theres no way for me to put 24pks and 3 gallon on the same order because of
// the lane. those need to be selectable click on it turns a color. or i can just
// have when they arent selected it shows all."
//
// So the selection is a SET. Click a lane to toggle it; NONE selected means
// every lane (the default), so a fresh screen shows everything and a filter is
// something you opt into. Stored as a JSON array under its own key so the old
// single-lane key (still read by nothing after this change, kept for a session
// or two of stale tabs) cannot be mis-parsed.
// ─────────────────────────────────────────────────────────────────────────────

function readStoredLanes(allowed: InventoryLane[]): InventoryLane[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MULTI);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const set = arr.filter((v): v is InventoryLane => (allowed as unknown[]).includes(v));
    // every allowed lane ticked is the same as none ticked — normalise so the
    // chips read "all" rather than "each"
    return set.length >= allowed.length ? [] : set;
  } catch { return []; }
}

/** [selected lanes (empty = all), setter, toggle-one]. */
export function useInventoryLanes(allowed: InventoryLane[] = ALL_INVENTORY_LANES): [
  InventoryLane[], (lanes: InventoryLane[]) => void, (lane: InventoryLane) => void,
] {
  const [lanes, setLanesState] = useState<InventoryLane[]>(() => readStoredLanes(allowed));

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY_MULTI, JSON.stringify(lanes));
  }, [lanes]);

  const setLanes = (next: InventoryLane[]) => {
    const clean = next.filter((l) => allowed.includes(l));
    setLanesState(clean.length >= allowed.length ? [] : clean);
  };
  const toggle = (lane: InventoryLane) => {
    setLanesState((cur) => {
      const next = cur.includes(lane) ? cur.filter((l) => l !== lane) : [...cur, lane];
      return next.length >= allowed.length ? [] : next;
    });
  };

  return useMemo(() => [lanes, setLanes, toggle] as const, [lanes]);   // eslint-disable-line react-hooks/exhaustive-deps
}

/** Is this lane in the selection? An empty selection means every lane. */
export function laneSelected(lanes: InventoryLane[], lane: InventoryLaneDb | null | undefined): boolean {
  if (!lane || lane === 'excluded') return false;
  return lanes.length === 0 || lanes.includes(lane);
}

/** "All lanes" / "BIB Product + Cans 24pks" — for a hero line. */
export function describeLanes(lanes: InventoryLane[], allowed: InventoryLane[] = ALL_INVENTORY_LANES): string {
  if (lanes.length === 0 || lanes.length >= allowed.length) return allowed.length === ALL_INVENTORY_LANES.length ? 'All lanes' : allowed.map((l) => INVENTORY_LANE_LABEL[l]).join(' + ');
  return lanes.map((l) => INVENTORY_LANE_LABEL[l]).join(' + ');
}

export function itemIsInLane(
  item: { inventory_lane?: string | null; active?: boolean | null } | null | undefined,
  lane: InventoryLane,
): boolean {
  return item?.inventory_lane === lane && item.active !== false;
}

export function filterItemsByLane<T extends { inventory_lane?: string | null; active?: boolean | null }>(
  rows: T[] | null | undefined,
  lane: InventoryLane,
): T[] {
  return (rows ?? []).filter((row) => itemIsInLane(row, lane));
}

/** Rows in ANY selected lane (empty selection = every lane in `allowed`), active only, never `excluded`. */
export function filterItemsByLanes<T extends { inventory_lane?: string | null; active?: boolean | null }>(
  rows: T[] | null | undefined,
  lanes: InventoryLane[],
  allowed: InventoryLane[] = ALL_INVENTORY_LANES,
): T[] {
  const set = lanes.length === 0 ? allowed : lanes.filter((l) => allowed.includes(l));
  return (rows ?? []).filter((row) => row.active !== false && (set as unknown[]).includes(row.inventory_lane));
}
