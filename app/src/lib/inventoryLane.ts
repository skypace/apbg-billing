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
