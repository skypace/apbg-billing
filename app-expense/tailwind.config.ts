import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* Dark surfaces — derived from brand teal, deeper for contrast */
        background: '#0B1A24',
        foreground: '#E6EEF1',
        surface: {
          DEFAULT: '#0F2330',
          '2': '#16303F',
          '3': '#1F3A4A',
        },

        /* Borders & focus */
        border: '#1F3A4A',
        'border-2': '#2F526A',
        input: '#1F3A4A',
        ring: '#4FAEC8',

        /* Brand — teal anchored, lighter on dark; amber accent */
        primary: {
          DEFAULT: '#4FAEC8',       /* teal that reads on dark */
          foreground: '#0B1A24',
          deep:  '#003A49',         /* brand-truth teal — used as section base */
          hover: '#6BC5DE',
        },
        accent: {
          DEFAULT: '#F4B400',
          foreground: '#0B1A24',
          hover:   '#FFC829',
        },
        secondary: {
          DEFAULT: '#16303F',
          foreground: '#E6EEF1',
        },
        muted: {
          DEFAULT: '#16303F',
          foreground: '#7E94A4',
        },
        card: {
          DEFAULT: '#0F2330',
          foreground: '#E6EEF1',
        },

        /* Semantic */
        success: '#3CC684',
        warning: '#F4B400',
        danger:  '#EF4F5B',
        destructive: { DEFAULT: '#EF4F5B', foreground: '#FFFFFF' },
        info:    '#4FAEC8',

        /* Text tiers */
        tx: '#E6EEF1',
        tx2: '#A8BAC4',
        mt: '#7E94A4',
      },

      borderRadius: {
        lg: '14px',
        md: '10px',
        sm: '6px',
      },

      fontFamily: {
        display: ["'Bricolage Grotesque'", "'Söhne'", 'system-ui', '-apple-system', 'sans-serif'],
        sans:    ["'Inter Tight'", 'system-ui', '-apple-system', 'BlinkMacSystemFont', "'Segoe UI'", 'sans-serif'],
        mono:    ["'JetBrains Mono'", "'SF Mono'", 'Consolas', 'monospace'],
      },

      boxShadow: {
        sm:  '0 1px 2px rgba(0, 0, 0, 0.35)',
        DEFAULT: '0 1px 3px rgba(0, 0, 0, 0.40), 0 1px 2px rgba(0, 0, 0, 0.30)',
        md:  '0 6px 18px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.30)',
        lg:  '0 18px 40px rgba(0, 0, 0, 0.55), 0 6px 14px rgba(0, 0, 0, 0.35)',
        focus: '0 0 0 3px rgba(79, 174, 200, 0.30)',
        glow:  '0 0 0 1px rgba(79, 174, 200, 0.22), 0 6px 18px rgba(79, 174, 200, 0.10)',
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
