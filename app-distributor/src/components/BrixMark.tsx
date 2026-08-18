import type { CSSProperties } from 'react';

interface Props {
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

const BRIX_ROUND = 'Brix-Round-Logo.png';

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

/** Product wordmark — one line: BRI[green X] DISTRIBUTOR. */
export function BrixWordmark({ style }: { style?: CSSProperties }) {
  return (
    <span className="brand-mark" style={style}>
      BRI<span className="brand-bx">X</span>
      <span style={{ marginLeft: '0.28em' }}>DISTRIBUTOR</span>
    </span>
  );
}
