import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/** Is the signed-in user a gateway superadmin?
 *
 *  The role lives in app_metadata for gateway-minted logins and in
 *  user_metadata for some older ones, so both are checked — that pair was
 *  already copy-pasted into seven pages before this hook existed.
 *
 *  This is a UI convenience ONLY: it hides triggers that the server would
 *  refuse anyway, so nobody clicks into a 403. Every endpoint behind these
 *  buttons does its own gating and is the actual boundary. */
export function useIsSuperadmin(): boolean {
  const [is, setIs] = useState(false);
  useEffect(() => {
    let live = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (!live) return;
      const role =
        (data.user?.app_metadata as { role?: string } | undefined)?.role ||
        (data.user?.user_metadata as { role?: string } | undefined)?.role || '';
      setIs(role === 'superadmin');
    });
    return () => { live = false; };
  }, []);
  return is;
}
