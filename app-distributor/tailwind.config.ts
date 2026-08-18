import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--bg)',
        foreground: 'var(--tx)',
        surface: {
          DEFAULT: 'var(--sf)',
          '2': 'var(--sf2)',
          '3': 'var(--sf3)',
        },
        border: 'var(--bd)',
        'border-2': 'var(--bd2)',
        input: 'var(--bd)',
        ring: 'var(--teal)',
        primary: {
          DEFAULT: 'var(--teal)',
          foreground: '#ffffff',
          deep: 'var(--teal-deep)',
          hover: 'var(--teal-hover)',
        },
        muted: {
          DEFAULT: 'var(--sf2)',
          foreground: 'var(--mt)',
        },
        card: {
          DEFAULT: 'var(--sf)',
          foreground: 'var(--tx)',
        },
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        tx: 'var(--tx)',
        tx2: 'var(--tx2)',
        mt: 'var(--mt)',
      },
      borderRadius: {
        lg: '16px',
        md: '12px',
        sm: '8px',
      },
      fontFamily: {
        display: ['-apple-system', 'BlinkMacSystemFont', "'SF Pro Display'", "'Inter'", 'system-ui', 'sans-serif'],
        sans: ['-apple-system', 'BlinkMacSystemFont', "'SF Pro Text'", "'Inter'", 'system-ui', 'sans-serif'],
        mono: ["'SF Mono'", "'JetBrains Mono'", 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        focus: 'var(--focus-ring)',
      },
      transitionTimingFunction: {
        brix: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
