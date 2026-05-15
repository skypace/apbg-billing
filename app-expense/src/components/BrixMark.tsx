import type { CSSProperties } from 'react';

interface Props {
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

const BRIX_ROUND      = 'Brix-Round-Logo.png';
const ALAMEDA_SEAL    = 'Alameda-Soda-Seal-Logo-Red-2024.png';
const ALAMEDA_SCRIPT  = 'ASC-Logo---Red.png';

function publicUrl(filename: string) {
  return import.meta.env.BASE_URL + filename;
}

/** Brix Beverage °bx round badge. */
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

/** Product wordmark — one line: BRI[green X]PENSE. */
export function BrixWordmark({ style }: { style?: CSSProperties }) {
  return (
    <span className="brand-mark" style={style}>
      BRI<span className="brand-bx">X</span>PENSE
    </span>
  );
}

/** Alameda Soda Co. */
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
