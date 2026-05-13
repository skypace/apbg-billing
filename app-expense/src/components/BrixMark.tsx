import type { CSSProperties } from 'react';

interface Props {
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

// Brand assets — all live in app-expense/public/ (Vite serves from BASE_URL).
const BRIX_ROUND      = 'Brix-Round-Logo.png';
const ALAMEDA_SEAL    = 'Alameda-Soda-Seal-Logo-Red-2024.png';
const ALAMEDA_SCRIPT  = 'ASC-Logo---Red.png';

function publicUrl(filename: string) {
  return import.meta.env.BASE_URL + filename;
}

/** Brix Beverage °bx round badge. The default brand mark for the dashboard. */
export function BrixMark({ size = 36, className, style, title }: Props) {
  return (
    <img
      src={publicUrl(BRIX_ROUND)}
      alt={title ?? 'Brix Beverage'}
      width={size}
      height={size}
      className={className}
      style={{ ...style, objectFit: 'contain' }}
      draggable={false}
    />
  );
}

/** Legacy: Brix wordmark (BRI[X]) — kept for places that don't want the full
 *  Brixpense identity. New work should prefer <BrixpenseWordmark />. */
export function BrixWordmark({ style }: { style?: CSSProperties }) {
  return (
    <span className="brand-mark" style={style}>
      BRI<span className="brand-bx">X</span>
    </span>
  );
}

/** BrixXpense wordmark — the product identity. Renders as a single line in
 *  the display font with an amber X bridging "Brix" and "pense". The amber
 *  X picks up a soft glow from the brand palette. */
export function BrixpenseWordmark({ style }: { style?: CSSProperties }) {
  return (
    <span className="brand-mark" style={style}>
      Brix<span className="brand-bx">X</span>pense
    </span>
  );
}

/** Alameda Soda Co. mark — seal (default) or script wordmark. */
export function AlamedaMark({
  size = 36,
  variant = 'seal',
  className,
  style,
  title,
}: Props & { variant?: 'seal' | 'script' }) {
  const file = variant === 'script' ? ALAMEDA_SCRIPT : ALAMEDA_SEAL;
  const width  = variant === 'script' ? Math.round(size * 2.6) : size;
  const height = size;
  return (
    <img
      src={publicUrl(file)}
      alt={title ?? 'Alameda Soda Co.'}
      width={width}
      height={height}
      className={className}
      style={{ ...style, objectFit: 'contain' }}
      draggable={false}
    />
  );
}
