import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export type ExpenseJob = 'driver' | 'office' | 'tech' | 'manager' | 'owner';

export interface ExpenseRole {
  loading: boolean;
  /** On the Brixpense roster at all. Not being on it means you approve nothing. */
  known: boolean;
  email: string | null;
  job: ExpenseJob | null;
  /** null = unlimited (owner only); 0 = approves nothing. */
  limit: number | null;
  approverEmail: string | null;
  /** Sees the company-wide AP surfaces: Vendor Inbox, Service Fusion, reports. */
  apAdmin: boolean;
}

const EMPTY: ExpenseRole = {
  loading: true, known: false, email: null, job: null,
  limit: 0, approverEmail: null, apAdmin: false,
};

/**
 * Who you are inside Brixpense — which is NOT your gateway role.
 *
 * Every staff login on this project is a gateway superadmin, so keying the AP
 * surfaces off that flag showed everyone the whole company's payables. This
 * reads ops.expense_people, the same row the RLS and requireApAdmin() read.
 *
 * UI convenience only: it hides what the server would refuse anyway, so nobody
 * clicks into a 403. The endpoints and the policies are the real boundary.
 */
export function useExpenseRole(): ExpenseRole {
  const [role, setRole] = useState<ExpenseRole>(EMPTY);

  useEffect(() => {
    let live = true;
    void (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const email = auth.user?.email?.toLowerCase() ?? null;
      if (!email) { if (live) setRole({ ...EMPTY, loading: false }); return; }

      // RLS lets you read your own row; a manager or driver reading this gets
      // exactly one row back, and an AP admin gets everyone's.
      const { data, error } = await supabase
        .from('expense_people')
        .select('email,job,approval_limit,approver_email,ap_admin')
        .eq('email', email)
        .eq('active', true)
        .maybeSingle();
      if (!live) return;

      if (error || !data) {
        // Not on the roster: no AP surfaces, approves nothing. Failing closed
        // is the right default on a project with 187 logins on it.
        setRole({ ...EMPTY, loading: false, email });
        return;
      }
      setRole({
        loading: false,
        known: true,
        email,
        job: (data.job as ExpenseJob) ?? null,
        limit: data.approval_limit === null ? null : Number(data.approval_limit),
        approverEmail: data.approver_email ?? null,
        apAdmin: !!data.ap_admin,
      });
    })();
    return () => { live = false; };
  }, []);

  return role;
}

/** "$500" / "no limit" / "none" — for telling someone what they may approve. */
export function describeLimit(role: ExpenseRole): string {
  if (!role.known) return 'none';
  if (role.limit === null) return 'no limit';
  return `$${role.limit.toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
}
