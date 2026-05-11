// Typed wrappers for the Settings tables. These are plain CRUD via
// PostgREST — no RPCs needed since the rows are flat.
import { sbDelete, sbInsert, sbUpdate, sbq, sbrpc } from './rpc';
import { SB_KEY, SB_URL, _sbToken } from './supabase';

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

// ----- Expense Buckets -----

export type AllocationBasis = 'revenue' | 'unit_volume' | 'sku_equal_share' | 'margin_contribution';

export interface ExpenseBucketType {
  bucket_code: string;
  label: string;
  sort_order: number | null;
  is_allocable: boolean;
  allocation_basis: AllocationBasis;
}

export interface PlAccount {
  account_name: string;
  account_type: string | null;
  total: number | null;
  bucket_code: string;
  bucket_assigned: boolean;
}

export const fetchExpenseBucketTypes = () =>
  sbq<ExpenseBucketType>('expense_bucket_types', 'select=*&order=sort_order,label');

export const updateBucketType = (code: string, patch: Partial<ExpenseBucketType>) =>
  sbUpdate<ExpenseBucketType>('expense_bucket_types', 'bucket_code=eq.' + encodeURIComponent(code), patch);

export const fetchPlAccounts = (start: string, end: string) =>
  sbrpc<PlAccount[]>('fn_list_pl_accounts', { p_start: start, p_end: end });

export const setAccountBucket = (account_name: string, bucket_code: string) =>
  sbrpc('fn_set_account_bucket', { p_account_name: account_name, p_bucket_code: bucket_code || 'oh' });

// ----- Users (admin-users edge function) -----

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  last_sign_in_at: string | null;
  confirmed_at: string | null;
}

export interface UserRole {
  value: string;
  label: string;
}

async function adminUsersCall<T>(
  action: string,
  body?: Record<string, unknown>,
  method?: 'GET' | 'POST' | 'DELETE',
): Promise<T> {
  const token = await _sbToken();
  const url = SB_URL + '/functions/v1/admin-users' + (action ? '?action=' + action : '');
  const res = await fetch(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export const adminUsersList = () => adminUsersCall<{ ok: boolean; users?: AdminUser[]; error?: string }>('list');
export const adminUsersRoles = () => adminUsersCall<{ ok: boolean; roles?: UserRole[]; error?: string }>('roles');
export const adminUsersInvite = (payload: { email: string; name?: string; role: string }) =>
  adminUsersCall<{ ok: boolean; error?: string }>('invite', payload);
export const adminUsersUpdateRole = (id: string, role: string) =>
  adminUsersCall<{ ok: boolean; error?: string }>('update_role', { id, role });
export const adminUsersDelete = (id: string) =>
  adminUsersCall<{ ok: boolean; error?: string }>('delete', { id }, 'DELETE');

// ----- Customer Classification (customer ↔ channel M:N) -----

export interface CustomerClassificationRow {
  qbo_customer_id: string;
  display_name: string;
  is_sub_customer: boolean;
  active: boolean;
  state: string | null;
  customer_type_name: string | null;
  ytd_revenue: number;
  invoice_count: number;
  channels: string[] | null;
  primary_channel: string | null;
}

export const fetchCustomerClassificationList = (opts: {
  search?: string;
  channel?: string;
  start: string;
  end: string;
  limit?: number;
  offset?: number;
}) =>
  sbrpc<CustomerClassificationRow[]>('fn_customer_classification_list', {
    p_search: opts.search ?? null,
    p_channel: opts.channel ?? null,
    p_start: opts.start,
    p_end: opts.end,
    p_limit: opts.limit ?? 200,
    p_offset: opts.offset ?? 0,
  });

export const setCustomerChannels = (
  qbo_customer_id: string,
  channel_labels: string[],
  primary_label: string | null,
) =>
  sbrpc('fn_set_customer_channels', {
    p_qbo_customer_id: qbo_customer_id,
    p_channel_labels: channel_labels,
    p_primary_label: primary_label,
  });
