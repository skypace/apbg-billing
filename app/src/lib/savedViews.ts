import { sbDelete, sbInsert, sbq, sbUpdate } from './rpc';
import type { Dim } from './sales';

export interface SavedViewConfig {
  dim?: Dim;
  start?: string;
  end?: string;
  entities?: string[] | null;
  categories?: string[] | null;
  customers?: string[] | null;
  items?: string[] | null;
  channels?: string[] | null;
  segments?: string[] | null;
  // Optional UI extras — extra columns + sparkline + chart kind, so a
  // restored view brings the user back to the same visual state.
  columnsByDim?: Record<string, string[]>;
  showSparklines?: boolean;
  chartKind?: 'none' | 'bar' | 'pie' | 'line';
  compareMode?: 'off' | 'prior_period' | 'prior_year';
}

export interface SavedView {
  id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  is_shared: boolean;
  config: SavedViewConfig;
  created_at: string;
  updated_at: string;
}

export function fetchSavedViews() {
  return sbq<SavedView>('saved_views', 'select=*&order=name');
}

export function insertSavedView(row: {
  name: string;
  description?: string | null;
  is_shared?: boolean;
  config: SavedViewConfig;
}) {
  return sbInsert<Partial<SavedView>>('saved_views', {
    name: row.name.trim(),
    description: row.description ?? null,
    is_shared: row.is_shared ?? false,
    config: row.config,
  });
}

export function updateSavedView(id: string, patch: Partial<{
  name: string;
  description: string | null;
  is_shared: boolean;
  config: SavedViewConfig;
}>) {
  return sbUpdate<SavedView>('saved_views', 'id=eq.' + id, patch);
}

export function deleteSavedView(id: string) {
  return sbDelete('saved_views', 'id=eq.' + id);
}
