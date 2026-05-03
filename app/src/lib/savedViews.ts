import { sbq } from './rpc';
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
  sales_reps?: string[] | null;
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
