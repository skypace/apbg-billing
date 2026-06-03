import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { ExpenseSettings, CogsAccount } from '@/types/expense';
import type { Session } from '@supabase/supabase-js';

/** Auth session hook */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  return { session, loading };
}

/** Load expense settings from ops.expense_settings */
export function useExpenseSettings() {
  const [settings, setSettings] = useState<ExpenseSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('expense_settings')
        .select('key, value')
        .in('key', [
          'approval_threshold',
          'manager_emails',
          'cogs_accounts',
          'tags',
          'departments',
          'department_cogs_map',
        ]);

      if (error) {
        console.error('Failed to load expense settings:', error);
        setLoading(false);
        return;
      }

      const map = Object.fromEntries(
        (data ?? []).map((r) => [r.key, r.value])
      );

      setSettings({
        approval_threshold: Number(map.approval_threshold ?? 500),
        manager_emails: (map.manager_emails ?? []) as string[],
        cogs_accounts: (map.cogs_accounts ?? []) as CogsAccount[],
        tags: (map.tags ?? []) as string[],
        departments: (map.departments ?? []) as string[],
        department_cogs_map: (map.department_cogs_map ?? {}) as Record<string, string>,
      });
      setLoading(false);
    }

    load();
  }, []);

  return { settings, loading };
}
