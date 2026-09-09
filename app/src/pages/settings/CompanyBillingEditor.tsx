import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useToast } from '../../lib/toast';
import {
  ORDERS_API, fetchCompanyBillingSettings, type CompanyBillingSettings,
} from '../../lib/customerBilling';
import { _sbToken } from '../../lib/supabase';

/**
 * Company billing identity — the letterhead on every invoice and statement,
 * the remit-to a customer pays into, and the dunning calendar.
 *
 * ⚠ WHY IT IS HERE. It lived only on the customer ORDERING portal's admin,
 * which is where the code happened to get written and not where the setting
 * belongs: of the 14 columns on `orders.company_settings`, NINE are company
 * billing identity and only two — `order_fees` and `order_desk` — are
 * genuinely order-portal. That row is two tables wearing one name. This
 * screen edits the nine; the portal keeps the two.
 *
 * ⚠ It is a SINGLETON: one row, shared by every document the business sends.
 * A wrong remit-to here is a customer paying into the wrong account, so the
 * screen states the blast radius before it saves rather than after.
 *
 * ⚠ The write goes through brix-order's `admin-company-settings` (PUT), which
 * is the one writer — see lib/customerBilling.ts. It is deliberately NOT a
 * PostgREST PATCH: `authenticated` has no UPDATE grant on this table, and the
 * UPDATE POLICY that exists there is dead code with no grant behind it
 * (Postgres checks grants before RLS), which reads as live and is not.
 */

const lbl: React.CSSProperties = {
  fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1,
};
const ctl: React.CSSProperties = {
  fontSize: 12, padding: '5px 7px', background: 'var(--ctl-bg)', color: 'var(--tx)',
  border: '1px solid var(--ctl-bd)', borderRadius: 4, width: '100%',
  boxSizing: 'border-box',
};

type Draft = {
  company_name: string; from_name: string; remittance_email: string;
  accounting_email: string; reply_to: string; statement_send_day: string;
  reminders_enabled_global: boolean; statements_enabled_global: boolean;
};

const EMPTY: Draft = {
  company_name: '', from_name: '', remittance_email: '', accounting_email: '',
  reply_to: '', statement_send_day: '', reminders_enabled_global: false,
  statements_enabled_global: false,
};

function toDraft(s: CompanyBillingSettings): Draft {
  return {
    company_name: s.company_name ?? '', from_name: s.from_name ?? '',
    remittance_email: s.remittance_email ?? '', accounting_email: s.accounting_email ?? '',
    reply_to: s.reply_to ?? '',
    statement_send_day: s.statement_send_day == null ? '' : String(s.statement_send_day),
    reminders_enabled_global: s.reminders_enabled_global === true,
    statements_enabled_global: s.statements_enabled_global === true,
  };
}

const FIELDS: { key: keyof Draft; label: string; hint: string; type?: string }[] = [
  { key: 'company_name',     label: 'Company name',   hint: 'Prints as the letterhead on every invoice and statement.' },
  { key: 'from_name',        label: 'From name',      hint: 'The sender name on billing email.' },
  { key: 'reply_to',         label: 'Reply-to',       hint: 'Where a customer replying to a billing email lands.', type: 'email' },
  { key: 'remittance_email', label: 'Remit-to',       hint: 'Printed on invoices as where to send remittance advice.', type: 'email' },
  { key: 'accounting_email', label: 'Accounting BCC', hint: 'Blind copy of every billing email we send.', type: 'email' },
];

export function CompanyBillingEditor() {
  const toast = useToast();
  const [row, setRow] = useState<CompanyBillingSettings | null | undefined>(undefined);
  const [d, setD] = useState<Draft>(EMPTY);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(''); setRow(undefined);
    try {
      const s = await fetchCompanyBillingSettings();
      setRow(s ?? null);
      if (s) setD(toDraft(s));
    } catch (e) {
      setErr((e as Error).message); setRow(null);
    }
  }
  useEffect(() => { void load(); }, []);

  const dirty = !!row && JSON.stringify(toDraft(row)) !== JSON.stringify(d);

  const dayNum = d.statement_send_day.trim() === '' ? null : Number(d.statement_send_day);
  const dayBad = dayNum !== null && (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 28);

  async function save() {
    if (dayBad) { toast.error('Statement day must be a whole number from 1 to 28.'); return; }
    setBusy(true);
    try {
      const token = await _sbToken();
      const res = await fetch(`${ORDERS_API}/.netlify/functions/admin-company-settings`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_name: d.company_name || null,
          from_name: d.from_name || null,
          reply_to: d.reply_to || null,
          remittance_email: d.remittance_email || null,
          accounting_email: d.accounting_email || null,
          statement_send_day: dayNum,
          reminders_enabled_global: d.reminders_enabled_global,
          statements_enabled_global: d.statements_enabled_global,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(
          res.status === 401 ? 'Your session expired — sign in again.'
          : res.status === 403 ? 'Editing company billing needs a superadmin account.'
          : `Save failed (${res.status}): ${t.slice(0, 200)}`,
        );
      }
      toast.success('Saved.');
      await load();
    } catch (e) {
      // ⚠ A blocked cross-origin request arrives as an opaque "Failed to
      // fetch" with no status, which reads as a network outage.
      const m = (e as Error).message;
      toast.error(/Failed to fetch/i.test(m)
        ? 'Could not reach the billing API — usually a blocked origin rather than a network '
          + "fault. This page must be served from an origin on brix-order's allow-list."
        : m);
    } finally {
      setBusy(false);
    }
  }

  if (row === undefined) {
    return <div className="cd" style={{ padding: 14, fontSize: 12, color: 'var(--mt)' }}>Loading…</div>;
  }
  if (err || row === null) {
    return (
      <div className="cd" style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <AlertTriangle size={15} color="var(--rd)" aria-hidden="true" />
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--rd)' }}>
              {err ? 'Could not load company billing settings' : 'No company settings row found'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--tx2)', marginTop: 3 }}>
              {err || 'The orders.company_settings singleton is missing.'}
            </div>
            <button type="button" onClick={() => void load()}
              style={{ fontSize: 11, padding: '5px 10px', marginTop: 8, borderRadius: 4,
                       border: '1px solid var(--ctl-bd)', background: 'transparent',
                       color: 'var(--tx2)', cursor: 'pointer' }}>
              <RefreshCw size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cd" style={{ padding: 14 }}>
      <div style={lbl}>Company billing identity</div>
      <div style={{ fontSize: 11, color: 'var(--tx2)', margin: '4px 0 12px' }}>
        One row, shared by <strong>every</strong> invoice, statement and reminder the business
        sends. A wrong remit-to here means customers paying into the wrong account, so change it
        deliberately.
      </div>

      <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 12 }}>
        {FIELDS.map((f) => (
          <div key={f.key}>
            <div style={lbl}>{f.label}</div>
            <input style={{ ...ctl, marginTop: 3 }} type={f.type ?? 'text'}
              value={d[f.key] as string}
              onChange={(e) => setD((p) => ({ ...p, [f.key]: e.target.value }))} />
            <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>{f.hint}</div>
          </div>
        ))}
        <div>
          <div style={lbl}>Statement send day</div>
          <input style={{ ...ctl, marginTop: 3, borderColor: dayBad ? 'var(--rd)' : undefined }}
            inputMode="numeric" placeholder="e.g. 5"
            value={d.statement_send_day}
            onChange={(e) => setD((p) => ({ ...p, statement_send_day: e.target.value }))} />
          <div style={{ fontSize: 10, color: dayBad ? 'var(--rd)' : 'var(--mt)', marginTop: 2 }}>
            {dayBad
              ? 'Must be 1–28.'
              : 'Day of the month statements go out. Capped at 28 so it exists in February.'}
          </div>
        </div>
      </div>

      {/* ⚠ These two are GLOBAL kill switches, not defaults for new customers.
          Off here means nobody gets one however their own record is set — which
          is why the copy says so instead of leaving a bare checkbox. */}
      <div style={{ ...lbl, marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--bd)' }}>
        Dunning — global switches
      </div>
      <div style={{ fontSize: 10, color: 'var(--mt)', margin: '3px 0 8px' }}>
        These override every customer&apos;s own setting. Turning one off stops that document for
        the whole book, not just for new accounts.
      </div>
      {([
        ['statements_enabled_global', 'Send statements'],
        ['reminders_enabled_global', 'Send payment reminders'],
      ] as const).map(([k, label]) => (
        <label key={k} style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12, marginTop: 6 }}>
          <input type="checkbox" checked={d[k]}
            onChange={(e) => setD((p) => ({ ...p, [k]: e.target.checked }))} />
          {label}
          {!d[k] && <span style={{ fontSize: 10, color: 'var(--am)' }}>— off for everyone</span>}
        </label>
      ))}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
        <button type="button" disabled={!dirty || busy || dayBad} onClick={() => void save()}
          style={{ fontSize: 11, padding: '6px 12px', borderRadius: 4, cursor: 'pointer',
                   border: '1px solid var(--ac)',
                   background: !dirty || busy || dayBad ? 'transparent' : 'var(--ac)',
                   color: !dirty || busy || dayBad ? 'var(--mt)' : '#fff' }}>
          {busy ? 'Saving…' : 'Save company billing settings'}
        </button>
        {dirty && <span style={{ fontSize: 10, color: 'var(--am)' }}>unsaved changes</span>}
      </div>

      <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 14, borderTop: '1px solid var(--bd)', paddingTop: 8 }}>
        Order fees and the email order desk live on this same database row and stay in the Brix
        Order admin — they are order-portal settings, not billing. See
        docs/OWNERSHIP-AND-MIGRATION.md.
      </div>
    </div>
  );
}
