import { getAccessToken } from '@/lib/supabase';

// The ONE client-side path to expense-request-link-bill.
//
// Five pages offer a "Post to QuickBooks" button, and before this they each
// had their own near-identical fetch. That was survivable while the call was
// one shape — it stopped being survivable when the backend gained a duplicate
// gate that answers 409, because a page that doesn't know about the 409 shows
// the user "possible_duplicate" as an error message and dead-ends.

export interface PostResult {
  success?: boolean;
  qbo_bill_id?: string;
  qbo_purchase_id?: string;
  qbo_doc_number?: string;
  margin_match?: unknown;
  message?: string;
  error?: string;
  [k: string]: unknown;
}

export class DuplicateBillError extends Error {
  duplicateOf?: string;
  constructor(message: string, duplicateOf?: string) {
    super(message);
    this.name = 'DuplicateBillError';
    this.duplicateOf = duplicateOf;
  }
}

async function call(requestId: string, confirmDuplicate: boolean): Promise<Response> {
  const token = await getAccessToken();
  return fetch('/expense/api/expense-request-link-bill', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ requestId, mode: 'create', ...(confirmDuplicate ? { confirmDuplicate: true } : {}) }),
  });
}

/**
 * Post an expense to QuickBooks.
 *
 * On a suspected duplicate the backend refuses with 409 + can_override. We ask
 * rather than either silently overriding (which defeats the gate) or failing
 * flat (which strands a legitimate re-issued invoice with no way forward).
 * Pass `onDuplicate: () => false` to decline automatically — useful anywhere
 * the post is not the user's direct, foregrounded action.
 *
 * Throws on any other failure so callers keep one error path.
 */
export async function postToQuickBooks(
  requestId: string,
  opts: { onDuplicate?: (message: string) => boolean | Promise<boolean> } = {},
): Promise<PostResult> {
  let res = await call(requestId, false);
  let data: PostResult = await res.json().catch(() => ({}));

  if (res.status === 409 && data.error === 'possible_duplicate') {
    const message = data.message || 'This looks like a bill we have already posted.';
    const ask = opts.onDuplicate
      ?? ((m: string) => window.confirm(`${m}\n\nPost it to QuickBooks anyway?`));
    const proceed = await ask(message);
    if (!proceed) {
      throw new DuplicateBillError(message, data.duplicate_of as string | undefined);
    }
    res = await call(requestId, true);
    data = await res.json().catch(() => ({}));
  }

  if (!res.ok || data.success === false) {
    throw new Error(data.message || data.error || 'Could not post to QuickBooks.');
  }
  return data;
}
