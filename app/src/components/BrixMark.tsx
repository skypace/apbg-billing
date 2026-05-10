import type { CSSProperties } from 'react';

interface Props {
  size?: number;
  /** Reserved — bubble dots are part of the vector lockup, not the round badge. */
  bubbles?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** 'round' = circular °bx badge PNG (default).
   *  'vector' = the BrixVectorLogo gif lockup. */
  variant?: 'round' | 'vector';
}

// Real brand asset committed to app/public/.
// Vite serves /public files at import.meta.env.BASE_URL (e.g. /sales-next/).
function assetUrl(filename: string): string {
  return import.meta.env.BASE_URL + filename;
}

export function BrixMark({
  size = 36,
  className,
  style,
  title,
  variant = 'round',
}: Props) {
  const src =
    variant === 'vector'
      ? assetUrl('BrixVectorLogo.gif')
      : assetUrl('Brix-Round-Logo.png');

  return (
    <img
      src={src}
      alt={title ?? 'Brix Beverage'}
      width={size}
      height={size}
      className={className}
      style={{
        objectFit: 'contain',
        flex: 'none',
        ...style,
      }}
      draggable={false}
    />
  );
}

// "BRIX" wordmark — display-font, with the "X" tinted in bubble blue
export function BrixWordmark({ style }: { style?: CSSProperties }) {
  return (
    <span className="brand-mark" style={style}>
      BRI<span className="brand-bx">X</span>
    </span>
  );
}

// Helpers exposed for any caller that wants a direct asset URL
export const BRAND_ASSETS = {
  brixRound:    () => assetUrl('Brix-Round-Logo.png'),
  brixVector:   () => assetUrl('BrixVectorLogo.gif'),
  alamedaScript:() => assetUrl('ASC-Logo---Red.png'),
  alamedaSeal:  () => assetUrl('Alameda-Soda-Seal-Logo-Red-2024.png'),
  alamedaCans:  () => assetUrl('Alameda-Soda-Cans-Die-Cut.png'),
  jetIcon:      () => assetUrl('Jet-Red-New-Icon-4x.png'),
} as const;
