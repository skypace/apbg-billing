import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import {
  fetchCustomerCylinders, oddReason,
  type CustomerCylinders, type CylinderRow,
} from '../lib/customerCylinders';

/**
 * Cylinders under the customer — what they hold, and the working behind it.
 *
 * Ask (Sky, 2026-09-09): "We need to make sure cylinder count is on the
 * dispatch just echo'd and on refractor as well so that both sides can see
 * whats happening with customer cylinders."
 *
 * ⚠ THE COUNT IS DERIVED, NOT COUNTED — the last BTRF rental invoice's printed
 * "New Balance" plus every delivery and minus every pickup invoiced since. So
 * the working is printed under every number: nobody can check a figure computed
 * from hundreds of invoice lines if they are only told the answer. The
 * arithmetic lives once, in `ops.fn_customer_cylinders`, shared with BrixSD's
 * customer page and the customer portal.
 *
 * ⚠ A NEGATIVE IS NEVER RENDERED AS A COUNT. Fleet-wide, 74 rows at 66
 * customers are below zero — the common case, not an edge one — and "−6 tanks"
 * is not something anybody can act on. It reads as a records problem, and the
 * two causes are named apart because they want different work: a gas we have
 * never rent-billed (52 of the 74, no anchor, so the count has no floor) versus
 * a pickup keyed below a real printed balance.
 *
 * ⚠ IT LOADS ON MOUNT, like the equipment card beside it and unlike the billing
 * card: this is one RPC and the collapsed summary IS the answer most of the
 * time. A card you must open to find out whether there is anything in it is a
 * card nobody opens.
 */

const lbl: React.CSSProperties = {
  fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1,
};
const btn: React.CSSProperties = {
  fontSize: 11, padding: '5px 10px', borderRadius: 4, cursor: 'pointer',
  border: '1px solid var(--ctl-bd)', background: 'transparent', color: 'var(--tx2)',
};

const money = (v: number) =>
  '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ⚠ UTC-anchored. A `BTRF-*` date is date-only, and a Pacific browser renders
 *  2026-09-09 as the 8th — the bug brix-order paid for with a month of invoices
 *  dated a day early. */
const day = (d: string | null) => {
  if (!d) return null;
  const s = String(d);
  const t = new Date(s.length <= 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(+t) ? null
    : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/** The working: where the number came from. */
function Working({ r }: { r: CylinderRow }) {
  const from = r.btrf_doc_number
    ? <>{r.balance_at_btrf} at <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{r.btrf_doc_number}</span>
      {day(r.btrf_date) ? <> ({day(r.btrf_date)})</> : null}</>
    : <>no rental invoice for this gas yet</>;
  return (
    <div style={{ fontSize: 10.5, color: 'var(--mt)', marginTop: 1 }}>
      {from} · +{r.deliveries_since} out · −{r.pickups_since} back
    </div>
  );
}

function Row({ r }: { r: CylinderRow }) {
  const why = oddReason(r);
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px solid var(--bd)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx)' }}>{r.label}</div>
          {r.is_sub && r.customer_name
            ? <div style={{ fontSize: 10.5, color: 'var(--mt)' }}>{r.customer_name}</div>
            : null}
        </div>
        {why ? (
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 0.6, whiteSpace: 'nowrap',
            padding: '2px 6px', borderRadius: 3, color: 'var(--rd)',
            border: '1px solid var(--rd)', background: 'rgba(234,67,53,0.07)',
          }}>
            RECORDS DISAGREE
          </span>
        ) : (
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            {/* ⚠ A settled row is muted. A 0 in the same weight as a real count
                reads as a quantity; the eye should find the tanks that are out. */}
            <div style={{
              fontSize: 15, fontWeight: r.on_hand ? 700 : 500, lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
              color: r.on_hand ? 'var(--tx)' : 'var(--mt)',
            }}>
              {r.on_hand}
            </div>
            {Number(r.monthly_rent) > 0
              ? <div style={{ fontSize: 10, color: 'var(--mt)', fontVariantNumeric: 'tabular-nums' }}>
                {money(Number(r.monthly_rent))}/mo
              </div>
              : null}
          </div>
        )}
      </div>
      {why
        ? <div style={{ fontSize: 10.5, color: 'var(--rd)', marginTop: 1 }}>{why}</div>
        : <Working r={r} />}
    </div>
  );
}

export function CustomerCylindersCard({ qboCustomerId, customerName }:
{ qboCustomerId: string; customerName?: string }) {
  const [open, setOpen] = useState(false);
  /** undefined = not loaded · a value = loaded, possibly empty. Three states,
   *  three renders — a failed read and an empty result must never look alike. */
  const [data, setData] = useState<CustomerCylinders | undefined>(undefined);
  const [err, setErr] = useState('');

  async function load() {
    setErr('');
    setData(undefined);
    try {
      setData(await fetchCustomerCylinders(qboCustomerId));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => { void load(); }, [qboCustomerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = err ? 'could not load'
    : data === undefined ? 'loading…'
      : data.rows.length === 0 ? 'no cylinder activity'
        : [`${data.out} out`,
          data.monthly > 0 ? `${money(data.monthly)}/mo` : null,
          data.atSubs ? `${data.atSubs} at stores` : null,
          data.odd ? `${data.odd} need${data.odd === 1 ? 's' : ''} a look` : null,
        ].filter(Boolean).join(' · ');

  const own = data?.rows.filter((r) => !r.is_sub) ?? [];
  const subs = data?.rows.filter((r) => r.is_sub) ?? [];

  return (
    <div className="cd" style={{ padding: '10px 14px', marginBottom: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center',
          gap: 8, width: '100%', boxSizing: 'border-box',
        }}
        aria-expanded={open}
      >
        {open
          ? <ChevronDown size={14} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />
          : <ChevronRight size={14} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />}
        <span style={{ ...lbl, color: 'var(--tx2)' }}>Cylinders</span>
        <span style={{
          fontSize: 10, marginLeft: 'auto',
          color: data?.odd ? 'var(--am)' : 'var(--mt)',
        }}>
          {summary}
        </span>
      </button>

      {!open ? null : err ? (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', marginTop: 8,
          borderRadius: 4, fontSize: 11, color: 'var(--tx2)',
          border: '1px solid var(--rd)', background: 'rgba(234,67,53,0.07)',
        }}>
          <AlertTriangle size={14} strokeWidth={2.3} color="var(--rd)" aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: 'var(--rd)' }}>Could not load the cylinders</div>
            <div style={{ marginTop: 2 }}>{err}</div>
            <button type="button" style={{ ...btn, marginTop: 6 }} onClick={() => void load()}>
              <RefreshCw size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Try again
            </button>
          </div>
        </div>
      ) : data === undefined ? (
        <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 10 }}>Loading…</div>
      ) : data.rows.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--tx2)', marginTop: 10, lineHeight: 1.5 }}>
          <strong>{customerName ?? 'This customer'}</strong> has never been invoiced for a
          cylinder — neither on this account nor at any store under it. A balance is derived
          from the rental and delivery invoices, so it appears here as soon as the first one
          posts.
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginBottom: 8, lineHeight: 1.5 }}>
            Derived from the rental and delivery invoices — the last{' '}
            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>BTRF</span>{' '}
            balance, plus what has gone out and come back since. BrixSD and the customer
            portal read the same numbers.
          </div>

          {own.map((r) => <Row key={`${r.qbo_customer_id}:${r.label}`} r={r} />)}

          {/* ⚠ Stores are GROUPED, never merged into the parent's rows. A chain
              holds its tanks at the stores — THE MELT MAIN has none on its own
              record and 20 stores holding them — and "who do I collect these
              from" is the question being asked. */}
          {subs.length ? (
            <>
              <div style={{ ...lbl, marginTop: 12, marginBottom: 2 }}>
                At stores under this account
              </div>
              {subs.map((r) => <Row key={`${r.qbo_customer_id}:${r.label}`} r={r} />)}
            </>
          ) : null}

          {data.odd ? (
            <div style={{ fontSize: 10.5, color: 'var(--mt)', marginTop: 10, lineHeight: 1.5 }}>
              {data.odd} {data.odd === 1 ? 'line shows' : 'lines show'} more tanks coming back
              than we ever invoiced out. That is a records problem rather than a quantity —
              either a pickup was keyed against a tank billed to somebody else, or the gas has
              never been put on the rental programme.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
