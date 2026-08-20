import { useEffect, useRef, useState } from 'react';
import { X as XIcon } from 'lucide-react';
import { inp } from '../../lib/styles';
import {
  QboCustomerLite,
  QboVendorLite,
  searchQboCustomers,
  searchQboVendors,
  SubDistributorModel,
  SubDistributorStatus,
} from '../../lib/subDistributors';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * PostgREST wraps a plpgsql RAISE EXCEPTION in a JSON error blob; pull the
 * actionable `message` out so RPC errors surface verbatim in the toast.
 */
export function rpcErrMsg(e: unknown): string {
  const raw = errMsg(e);
  const brace = raw.indexOf('{');
  if (brace >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(brace)) as { message?: string; details?: string };
      if (parsed.message) return parsed.message;
    } catch { /* fall through to the raw string */ }
  }
  return raw;
}

// ── Table cells (same skin as the Stock tabs) ─────────────────────────────

export function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th style={{
      textAlign: 'left', padding: '8px 10px',
      fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)',
      ...style,
    }}>{children}</th>
  );
}

export function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: '7px 10px', verticalAlign: 'middle', ...style }}>{children}</td>;
}

export function LField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

// ── Status / model chips ──────────────────────────────────────────────────

export const DIST_STATUS_COLOR: Record<SubDistributorStatus, string> = {
  pending:  'var(--am)',
  active:   'var(--gn)',
  inactive: 'var(--mt)',
};

export function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      background: 'rgba(255,255,255,0.04)', color, border: '1px solid ' + color,
      padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
      whiteSpace: 'nowrap',
    }}>{label.replace(/_/g, ' ').toUpperCase()}</span>
  );
}

export function StatusChip({ status }: { status: SubDistributorStatus }) {
  return <Chip label={status} color={DIST_STATUS_COLOR[status] ?? 'var(--mt)'} />;
}

export function ModelChip({ model }: { model: SubDistributorModel }) {
  return <Chip label={model === 'sell_in' ? 'sell-in' : 'consignment'} color="var(--ac)" />;
}

// ── Modal (same hand-rolled overlay as the Stock detail modal) ────────────

export function Modal({ title, onClose, children, maxWidth = 640 }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
}) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth, width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {title}
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)',
          }}><XIcon size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── QBO customer search-attach ────────────────────────────────────────────

export function QboCustomerSearch({ value, valueLabel, onPick, placeholder }: {
  value: string | null;
  valueLabel?: string | null;
  onPick: (c: QboCustomerLite | null) => void;
  placeholder?: string;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<QboCustomerLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!term.trim()) { setResults([]); return; }
    timer.current = window.setTimeout(() => {
      setSearching(true);
      searchQboCustomers(term)
        .then((rows) => { setResults(rows); setOpen(true); })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [term]);

  if (value) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11 }}>
          {valueLabel || value}{' '}
          <code style={{ color: 'var(--mt)', fontFamily: 'var(--ff-mono)', fontSize: 10 }}>#{value}</code>
        </span>
        <button onClick={() => onPick(null)} style={{
          background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--rd)', fontSize: 10,
        }}>clear</button>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        style={{ ...inp(), width: '100%' }}
        value={term}
        placeholder={placeholder ?? 'Search QBO customers…'}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => { if (results.length) setOpen(true); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 180)}
      />
      {searching && <div style={{ fontSize: 9.5, color: 'var(--mt)', marginTop: 3 }}>Searching…</div>}
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 4,
          maxHeight: 220, overflowY: 'auto', marginTop: 2,
        }}>
          {results.map((r) => (
            <button
              key={r.qbo_customer_id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(r); setTerm(''); setResults([]); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '6px 8px', fontSize: 11, color: 'var(--tx)',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              {r.display_name}{' '}
              <code style={{ color: 'var(--mt)', fontFamily: 'var(--ff-mono)', fontSize: 9.5 }}>
                #{r.qbo_customer_id}
              </code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── QBO vendor search (same shape as the customer search) ────────────────

export function QboVendorSearch({ onPick, placeholder }: {
  onPick: (v: QboVendorLite) => void;
  placeholder?: string;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<QboVendorLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!term.trim()) { setResults([]); return; }
    timer.current = window.setTimeout(() => {
      setSearching(true);
      searchQboVendors(term)
        .then((rows) => { setResults(rows); setOpen(true); })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [term]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        style={{ ...inp(), width: '100%' }}
        value={term}
        placeholder={placeholder ?? 'Search QBO vendors…'}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => { if (results.length) setOpen(true); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 180)}
      />
      {searching && <div style={{ fontSize: 9.5, color: 'var(--mt)', marginTop: 3 }}>Searching…</div>}
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 4,
          maxHeight: 220, overflowY: 'auto', marginTop: 2,
        }}>
          {results.map((r) => (
            <button
              key={r.qbo_vendor_id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(r); setTerm(''); setResults([]); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '6px 8px', fontSize: 11, color: 'var(--tx)',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              {r.display_name}
              {r.active === false && <span style={{ marginLeft: 6, color: 'var(--rd)', fontSize: 9 }}>INACTIVE</span>}
              <span style={{ marginLeft: 6, color: 'var(--mt)', fontSize: 9.5 }}>
                {[r.city, r.state].filter(Boolean).join(', ')}
              </span>{' '}
              <code style={{ color: 'var(--mt)', fontFamily: 'var(--ff-mono)', fontSize: 9.5 }}>
                #{r.qbo_vendor_id}
              </code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
