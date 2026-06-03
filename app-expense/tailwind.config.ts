import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* Semantic tokens → CSS vars so they flip with the active theme.
           (See src/styles/globals.css :root / .dark.) */
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
          deep:  'var(--teal-deep)',
          hover: 'var(--teal-hover)',
        },
        accent: {
          DEFAULT: 'var(--amber)',
          foreground: '#ffffff',
          hover:   'var(--amber-hover)',
        },
        secondary: {
          DEFAULT: 'var(--sf)',
          foreground: 'var(--tx)',
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
        danger:  'var(--danger)',
        destructive: { DEFAULT: 'var(--danger)', foreground: '#ffffff' },
        info:    'var(--teal)',

        tx:  'var(--tx)',
        tx2: 'var(--tx2)',
        mt:  'var(--mt)',

        /* Theme-inverting palette ramps so raw Tailwind utilities on the pages
           (bg-slate-950, text-slate-500, bg-emerald-500/15, …) adapt too.
           Each shade is an "R G B" triplet swapped per theme in globals.css.
           Deep-merges with Tailwind defaults — only the used shades override. */
        slate: {
          50:  'rgb(var(--c-slate-50) / <alpha-value>)',
          100: 'rgb(var(--c-slate-100) / <alpha-value>)',
          200: 'rgb(var(--c-slate-200) / <alpha-value>)',
          300: 'rgb(var(--c-slate-300) / <alpha-value>)',
          400: 'rgb(var(--c-slate-400) / <alpha-value>)',
          500: 'rgb(var(--c-slate-500) / <alpha-value>)',
          600: 'rgb(var(--c-slate-600) / <alpha-value>)',
          700: 'rgb(var(--c-slate-700) / <alpha-value>)',
          800: 'rgb(var(--c-slate-800) / <alpha-value>)',
          900: 'rgb(var(--c-slate-900) / <alpha-value>)',
          950: 'rgb(var(--c-slate-950) / <alpha-value>)',
        },
        emerald: {
          100: 'rgb(var(--c-emerald-100) / <alpha-value>)',
          200: 'rgb(var(--c-emerald-200) / <alpha-value>)',
          300: 'rgb(var(--c-emerald-300) / <alpha-value>)',
          400: 'rgb(var(--c-emerald-400) / <alpha-value>)',
          500: 'rgb(var(--c-emerald-500) / <alpha-value>)',
          600: 'rgb(var(--c-emerald-600) / <alpha-value>)',
          700: 'rgb(var(--c-emerald-700) / <alpha-value>)',
          800: 'rgb(var(--c-emerald-800) / <alpha-value>)',
          900: 'rgb(var(--c-emerald-900) / <alpha-value>)',
          950: 'rgb(var(--c-emerald-950) / <alpha-value>)',
        },
        amber: {
          200: 'rgb(var(--c-amber-200) / <alpha-value>)',
          500: 'rgb(var(--c-amber-500) / <alpha-value>)',
          700: 'rgb(var(--c-amber-700) / <alpha-value>)',
          800: 'rgb(var(--c-amber-800) / <alpha-value>)',
          950: 'rgb(var(--c-amber-950) / <alpha-value>)',
        },
        red: {
          300: 'rgb(var(--c-red-300) / <alpha-value>)',
          400: 'rgb(var(--c-red-400) / <alpha-value>)',
          700: 'rgb(var(--c-red-700) / <alpha-value>)',
          950: 'rgb(var(--c-red-950) / <alpha-value>)',
        },
        sky: {
          300: 'rgb(var(--c-sky-300) / <alpha-value>)',
          500: 'rgb(var(--c-sky-500) / <alpha-value>)',
        },
        violet: {
          300: 'rgb(var(--c-violet-300) / <alpha-value>)',
          500: 'rgb(var(--c-violet-500) / <alpha-value>)',
        },
        cyan: {
          300: 'rgb(var(--c-cyan-300) / <alpha-value>)',
          500: 'rgb(var(--c-cyan-500) / <alpha-value>)',
        },
      },

      borderRadius: {
        lg: '16px',
        md: '12px',
        sm: '8px',
      },

      fontFamily: {
        display: ['-apple-system', 'BlinkMacSystemFont', "'SF Pro Display'", "'Inter'", 'system-ui', 'sans-serif'],
        sans:    ['-apple-system', 'BlinkMacSystemFont', "'SF Pro Text'", "'Inter'", 'system-ui', 'sans-serif'],
        mono:    ["'SF Mono'", "'JetBrains Mono'", 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },

      boxShadow: {
        sm:  'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        md:  'var(--shadow-md)',
        lg:  'var(--shadow-lg)',
        focus: 'var(--focus-ring)',
        glow:  'var(--glow-teal)',
      },

      spacing: {
        'shell-pad': '28px',
        'sidebar':           '236px',
        'sidebar-collapsed': '68px',
      },

      transitionTimingFunction: {
        'brix': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
