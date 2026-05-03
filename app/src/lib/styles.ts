import type { CSSProperties } from 'react';

// Shared inline-style helpers. Mirrors the legacy CSS-var palette
// declared in src/styles/theme.css.

export const inp = (): CSSProperties => ({
  background: 'var(--sf2)',
  color: 'var(--tx)',
  border: '1px solid var(--bd)',
  padding: '4px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontFamily: 'inherit',
});

export const btnPrimary = (): CSSProperties => ({
  background: 'var(--ac)',
  color: 'var(--bg)',
  border: '1px solid var(--ac)',
  padding: '5px 11px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  cursor: 'pointer',
});

export const btnSecondary = (): CSSProperties => ({
  background: 'var(--sf2)',
  color: 'var(--tx)',
  border: '1px solid var(--bd)',
  padding: '5px 11px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.5,
  cursor: 'pointer',
});

export const btnDanger = (): CSSProperties => ({
  background: 'transparent',
  color: 'var(--rd)',
  border: '1px solid var(--rd)',
  padding: '3px 8px',
  borderRadius: 4,
  fontSize: 10,
  cursor: 'pointer',
});
