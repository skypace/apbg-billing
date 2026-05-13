import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* Surfaces — classic dark navy */
        background: '#06121F',
        foreground: '#E6EEF7',
        surface: {
          DEFAULT: '#0E2240',
          '2': '#163052',
          '3': '#1E4068',
        },

        /* Borders & focus */
        border: '#1B3A5E',
        'border-2': '#2A5285',
        input: '#1B3A5E',
        ring: '#5BB5F0',

        /* Brand — teal anchor + amber accent on navy */
        primary: {
          DEFAULT: '#5BB5F0',
          foreground: '#06121F',
          deep:  '#003A49',
          hover: '#7CC5F5',
        },
        accent: {
          DEFAULT: '#F4B400',
          foreground: '#06121F',
          hover:   '#FFC829',
        },
        secondary: {
          DEFAULT: '#0E2240',
          foreground: '#E6EEF7',
        },
        muted: {
          DEFAULT: '#0E2240',
          foreground: '#6B8499',
        },
        card: {
          DEFAULT: 'rgba(20, 57, 102, 0.32)',
          foreground: '#E6EEF7',
        },

        /* Semantic */
        success: '#2EB872',
        warning: '#F4B400',
        danger:  '#FF5A5F',
        destructive: { DEFAULT: '#FF5A5F', foreground: '#FFFFFF' },
        info:    '#5BB5F0',

        /* Text tiers */
        tx:  '#E6EEF7',
        tx2: '#94A8BD',
        mt:  '#6B8499',
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
        focus: '0 0 0 3px rgba(91, 181, 240, 0.28)',
        glow:  '0 0 0 1px rgba(91, 181, 240, 0.22), 0 8px 24px rgba(91, 181, 240, 0.18)',
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
