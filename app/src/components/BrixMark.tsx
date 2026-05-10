import type { CSSProperties } from 'react';

interface Props {
  size?: number;
  /** Show the three bubble dots above the mark (logo-lockup style). */
  bubbles?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

// Inline SVG recreation of the Brix °bx badge.
// Approximates the custom letterform; perfect for sidebar / splash / favicon
// where the mark renders at 24–96px and small letterform differences vanish.
export function BrixMark({ size = 36, bubbles = false, className, style, title }: Props) {
  const W = bubbles ? 200 : 200;
  const H = bubbles ? 240 : 200;
  const cy = bubbles ? 140 : 100;

  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={(size * H) / W}
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : 'presentation'}
      aria-label={title ?? undefined}
    >
      <defs>
        {/* Navy radial: lighter at upper-left, deepest at lower-right */}
        <radialGradient id="brixCircle" cx="40%" cy="35%" r="75%">
          <stop offset="0%"   stopColor="#28548A" />
          <stop offset="55%"  stopColor="#163966" />
          <stop offset="100%" stopColor="#0B2148" />
        </radialGradient>
        {/* Glossy upper-right highlight */}
        <radialGradient id="brixHighlight" cx="68%" cy="22%" r="32%">
          <stop offset="0%"   stopColor="rgba(255,255,255,0.32)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        {/* Bubble gradient */}
        <radialGradient id="brixBubble" cx="35%" cy="35%" r="65%">
          <stop offset="0%"   stopColor="#9EDDFB" />
          <stop offset="100%" stopColor="#3A8FCC" />
        </radialGradient>
      </defs>

      {bubbles && (
        <g>
          <circle cx="124" cy="22"  r="11" fill="url(#brixBubble)" opacity="0.92" />
          <circle cx="156" cy="40"  r="9"  fill="url(#brixBubble)" opacity="0.85" />
          <circle cx="178" cy="68"  r="7"  fill="url(#brixBubble)" opacity="0.78" />
        </g>
      )}

      {/* Main circle — navy with glossy highlight */}
      <circle cx="100" cy={cy} r="98" fill="url(#brixCircle)" />
      <circle cx="100" cy={cy} r="98" fill="url(#brixHighlight)" />

      {/* "°" — small open ring at upper-left of the badge */}
      <circle
        cx="50"
        cy={cy - 32}
        r="6.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="3"
      />

      {/* "bx" letterform — heavyweight, condensed, white */}
      <text
        x="100"
        y={cy + 36}
        fontFamily="'Bricolage Grotesque', 'Inter Tight', system-ui, sans-serif"
        fontSize="108"
        fontWeight="800"
        fill="#FFFFFF"
        textAnchor="middle"
        letterSpacing="-6"
        style={{ fontVariationSettings: '"wght" 900' }}
      >
        bx
      </text>
    </svg>
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
