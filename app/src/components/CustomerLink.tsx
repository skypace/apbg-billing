interface Props {
  qboCustomerId: string | null | undefined;
  name: string | null | undefined;
}

export function CustomerLink({ qboCustomerId, name }: Props) {
  if (!qboCustomerId || !name) return <>{name ?? '—'}</>;
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
