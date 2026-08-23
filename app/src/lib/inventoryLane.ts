import { useEffect, useMemo, useState } from 'react';

export type InventoryLane = 'bib_product' | 'cans_24pk';
export type InventoryLaneDb = InventoryLane | 'excluded';
export type InventoryLaneSize = '3g' | '5g' | '24pk';

export const INVENTORY_LANES: { value: InventoryLane; label: string; shortLabel: string }[] = [
  { value: 'bib_product', label: 'BIB Product', shortLabel: 'BIB' },
  { value: 'cans_24pk', label: 'Cans 24pks', shortLabel: '24pk Cans' },
];

export const INVENTORY_LANE_LABEL: Record<InventoryLaneDb, string> = {
  bib_product: 'BIB Product',
  cans_24pk: 'Cans 24pks',
  excluded: 'Excluded',
};

export const INVENTORY_LANE_SIZE_LABEL: Record<InventoryLaneSize, string> = {
  '3g': '3G',
  '5g': '5G',
  '24pk': '24pk',
};

const STORAGE_KEY = 'brix.inventory.lane';

export function coerceInventoryLane(value: unknown): InventoryLane {
  return value === 'cans_24pk' ? 'cans_24pk' : 'bib_product';
}

export function getStoredInventoryLane(): InventoryLane {
  if (typeof localStorage === 'undefined') return 'bib_product';
  return coerceInventoryLane(localStorage.getItem(STORAGE_KEY));
}

export function useInventoryLane(): [InventoryLane, (lane: InventoryLane) => void] {
  const [lane, setLaneState] = useState<InventoryLane>(() => getStoredInventoryLane());

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
