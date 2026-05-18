interface Props {
  qboCustomerId: string | null | undefined;
  name: string | null | undefined;
}

export function CustomerLink({ qboCustomerId, name }: Props) {
  const hasName = name != null && String(name).trim() !== '';
  if (!qboCustomerId) return <span style={{ color: 'var(--mt)' }}>{hasName ? name : '—'}</span>;
  if (!hasName) {
    // Render a clickable fallback so the row remains drillable even when the
    // name didn't survive whatever pipeline produced it. Surfaces the QBO ID
    // so we can chase the root cause.
    return (
      <a
        href={'#customer-' + qboCustomerId}
        onClick={(e) => e.stopPropagation()}
        style={{ color: 'var(--am)', textDecoration: 'none', fontStyle: 'italic' }}
        title={`Customer with no name. QBO ID: ${qboCustomerId}`}
      >
        (no name · QBO #{qboCustomerId})
      </a>
    );
  }
  return (
    <a
      href={'#customer-' + qboCustomerId}
      onClick={(e) => e.stopPropagation()}
      style={{ color: 'var(--ac)', textDecoration: 'none' }}
    >
      {name}
    </a>
  );
}
