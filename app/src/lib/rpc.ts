import { SB_URL, SB_KEY, _sbToken } from './supabase';

// Thin wrappers around PostgREST that target the `ops` schema.
// Each write helper sends BOTH Accept-Profile (response) and
// Content-Profile (request). Without Content-Profile, PostgREST
// falls back to `public` — which silently 404s DELETEs because
// these tables only exist in `ops`.

export async function sbq<T = unknown>(tbl: string, query = ''): Promise<T[]> {
  const url = SB_URL + '/rest/v1/' + tbl + (query ? '?' + query : '');
  const token = await _sbToken();
  const res = await fetch(url, {
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error('sbq ' + tbl + ' failed: ' + res.status);
  return res.json() as Promise<T[]>;
}

export async function sbrpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('sbrpc ' + fn + ' failed: ' + res.status + ' ' + text);
  }
  return res.json() as Promise<T>;
}

export async function sbInsert<T = unknown>(tbl: string, row: T): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/' + tbl, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error('sbInsert ' + tbl + ' failed: ' + res.status);
  return res.json() as Promise<T>;
}

export async function sbUpdate<T = unknown>(
  tbl: string,
  filter: string,
  patch: Partial<T>,
): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/' + tbl + '?' + filter, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('sbUpdate ' + tbl + ' failed: ' + res.status);
  return res.json() as Promise<T>;
}

export async function sbDelete(tbl: string, filter: string): Promise<void> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/' + tbl + '?' + filter, {
    method: 'DELETE',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('sbDelete ' + tbl + ' failed: ' + res.status + ' ' + text);
  }
}
