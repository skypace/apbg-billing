import { AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react';
import type { FormulaReadiness, FormulaReadinessStatus } from './formulaReadiness';

function readinessTone(status: FormulaReadinessStatus) {
  switch (status) {
    case 'ready':
      return { color: 'var(--gn)', border: 'rgba(125,238,164,0.38)', bg: 'rgba(125,238,164,0.07)' };
    case 'watch':
      return { color: 'var(--am)', border: 'rgba(239,191,65,0.40)', bg: 'rgba(239,191,65,0.08)' };
    case 'blocked':
      return { color: '#f87171', border: 'rgba(248,113,113,0.45)', bg: 'rgba(248,113,113,0.08)' };
    case 'pending':
    default:
      return { color: 'var(--mt)', border: 'rgba(148,163,184,0.30)', bg: 'rgba(148,163,184,0.06)' };
  }
}

function ReadinessIcon({ status, size = 14 }: { status: FormulaReadinessStatus; size?: number }) {
  if (status === 'ready') return <CheckCircle2 size={size} />;
  if (status === 'pending') return <CircleDashed size={size} />;
  return <AlertTriangle size={size} />;
}

export function FormulaReadinessBadge({ readiness }: { readiness: FormulaReadiness }) {
  const tone = readinessTone(readiness.status);
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      color: tone.color,
      border: `1px solid ${tone.border}`,
      background: tone.bg,
      padding: '2px 7px',
      borderRadius: 10,
      fontSize: 10,
      fontWeight: 700,
      whiteSpace: 'nowrap',
    }}>
      <ReadinessIcon status={readiness.status} size={12} />
      {readiness.label}
    </span>
  );
}

export function FormulaReadinessPanel({
  readiness,
  title = 'Formula readiness',
  compact = false,
}: {
  readiness: FormulaReadiness;
  title?: string;
  compact?: boolean;
}) {
  const tone = readinessTone(readiness.status);
  const visibleChecks = readiness.checks.filter((c) => c.level !== 'ok');
  return (
    <section style={{
      marginBottom: compact ? 10 : 14,
      padding: compact ? 10 : 12,
      border: `1px solid ${tone.border}`,
      borderRadius: 4,
      background: tone.bg,
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: tone.color, display: 'inline-flex', alignItems: 'center' }}>
          <ReadinessIcon status={readiness.status} />
        </span>
        <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
          {title}
        </div>
        <FormulaReadinessBadge readiness={readiness} />
        <span style={{ color: 'var(--mt)' }}>{readiness.summary}</span>
      </div>
      {!compact && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginTop: 10 }}>
          <Mini label="Components" value={String(readiness.componentCount)} />
          <Mini label="Services" value={String(readiness.serviceCount)} />
          <Mini label="Volume lines" value={String(readiness.parseableVolumeCount)} />
          <Mini label="Missing costs" value={String(readiness.missingCostCount)} />
        </div>
      )}
      {visibleChecks.length > 0 && (
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          {visibleChecks.slice(0, compact ? 2 : 6).map((check, idx) => {
            const itemTone = check.level === 'block'
              ? readinessTone('blocked')
              : readinessTone('watch');
            return (
              <div key={`${check.label}-${idx}`} style={{
                borderLeft: `2px solid ${itemTone.color}`,
                paddingLeft: 8,
                color: 'var(--tx)',
                lineHeight: 1.4,
              }}>
                <strong style={{ color: itemTone.color }}>{check.label}</strong>
                <span style={{ color: 'var(--mt)' }}> · {check.detail}</span>
              </div>
            );
          })}
          {compact && visibleChecks.length > 2 && (
            <div style={{ color: 'var(--mt)' }}>+{visibleChecks.length - 2} more</div>
          )}
        </div>
      )}
    </section>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ marginTop: 2, color: 'var(--tx)', fontFamily: 'var(--ff-mono)', fontWeight: 700 }}>{value}</div>
    </div>
  );
}
