// Typed wrappers for the Settings tables. These are plain CRUD via
// PostgREST — no RPCs needed since the rows are flat.
import { sbDelete, sbInsert, sbUpdate, sbq } from './rpc';

export interface Channel {
  channel_code: string;
  label: string;
  sort_order: number | null;
  is_active: boolean;
}
export interface Segment {
  segment_code: string;
  label: string;
  sort_order: number | null;
  is_active: boolean;
}
export interface SalesRep {
  rep_code: string;
  name: string;
  email: string | null;
  notes: string | null;
  sort_order: number | null;
  is_active: boolean;
  created_at: string;
}
export interface ItemSet {
  set_code: string;
  label: string;
  description: string | null;
  sort_order: number | null;
  is_active: boolean;
  created_at: string;
}
export interface ItemSetMember {
  set_code: string;
  qbo_item_id: string;
  item_name: string;
  sort_order: number | null;
  added_at: string;
}

export const fetchChannels = () =>
  sbq<Channel>('channels', 'select=*&order=sort_order,label');
export const insertChannel = (row: Channel) => sbInsert<Channel>('channels', row);
export const updateChannel = (code: string, patch: Partial<Channel>) =>
  sbUpdate<Channel>('channels', 'channel_code=eq.' + encodeURIComponent(code), patch);
export const deleteChannel = (code: string) =>
  sbDelete('channels', 'channel_code=eq.' + encodeURIComponent(code));

export const fetchSegments = () =>
  sbq<Segment>('segments', 'select=*&order=sort_order,label');
export const insertSegment = (row: Segment) => sbInsert<Segment>('segments', row);
export const updateSegment = (code: string, patch: Partial<Segment>) =>
  sbUpdate<Segment>('segments', 'segment_code=eq.' + encodeURIComponent(code), patch);
export const deleteSegment = (code: string) =>
  sbDelete('segments', 'segment_code=eq.' + encodeURIComponent(code));

export const fetchSalesReps = () =>
  sbq<SalesRep>('sales_reps', 'select=*&order=sort_order,name');
export const insertSalesRep = (row: Partial<SalesRep>) => sbInsert<SalesRep>('sales_reps', row as SalesRep);
export const updateSalesRep = (code: string, patch: Partial<SalesRep>) =>
  sbUpdate<SalesRep>('sales_reps', 'rep_code=eq.' + encodeURIComponent(code), patch);
export const deleteSalesRep = (code: string) =>
  sbDelete('sales_reps', 'rep_code=eq.' + encodeURIComponent(code));

export const fetchItemSets = () =>
  sbq<ItemSet>('item_sets', 'select=*&order=sort_order,label');
export const insertItemSet = (row: Partial<ItemSet>) => sbInsert<ItemSet>('item_sets', row as ItemSet);
export const deleteItemSet = (code: string) =>
  sbDelete('item_sets', 'set_code=eq.' + encodeURIComponent(code));
export const fetchItemSetMembers = (set_code: string) =>
  sbq<ItemSetMember>(
    'item_set_items',
    'select=*&set_code=eq.' + encodeURIComponent(set_code) + '&order=sort_order,item_name',
  );
export const addItemSetMember = (row: Partial<ItemSetMember>) =>
  sbInsert<ItemSetMember>('item_set_items', row as ItemSetMember);
export const removeItemSetMember = (set_code: string, qbo_item_id: string) =>
  sbDelete(
    'item_set_items',
    'set_code=eq.' + encodeURIComponent(set_code) + '&qbo_item_id=eq.' + encodeURIComponent(qbo_item_id),
  );

export interface DigestSubscription {
  id: string;
  name: string;
  recipients: string[];
  frequency: string;
  day_of_week: number;
  hour_utc: number;
  sections: string[];
  is_active: boolean;
  last_sent_at: string | null;
  created_by: string | null;
  created_at: string;
}
export interface DigestLogRow {
  id: string;
  subscription_id: string | null;
  sent_at: string;
  recipients: string[];
  subject: string;
  status: string;
  error: string | null;
  preview: string | null;
}

export const fetchDigestSubscriptions = () =>
  sbq<DigestSubscription>('digest_subscriptions', 'select=*&order=created_at.desc');
export const insertDigestSubscription = (row: Partial<DigestSubscription>) =>
  sbInsert<DigestSubscription>('digest_subscriptions', row as DigestSubscription);
export const updateDigestSubscription = (id: string, patch: Partial<DigestSubscription>) =>
  sbUpdate<DigestSubscription>('digest_subscriptions', 'id=eq.' + id, patch);
export const deleteDigestSubscription = (id: string) =>
  sbDelete('digest_subscriptions', 'id=eq.' + id);
export const fetchDigestLog = (limit = 30) =>
  sbq<DigestLogRow>('digest_log', 'select=*&order=sent_at.desc&limit=' + limit);
