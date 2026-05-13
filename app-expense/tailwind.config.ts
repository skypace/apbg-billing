import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* Backgrounds — light, operator-friendly. Per brix-design-rules. */
        background: '#FFFFFF',
        foreground: '#1A2730',
        surface: {
          DEFAULT: '#FFFFFF',
          '2': '#F5F7F8',
          '3': '#EBEFF2',
        },

        /* Borders & focus */
        border: '#E1E6EA',
        'border-2': '#CFD6DC',
        input: '#E1E6EA',
        ring: '#003A49',

        /* Brand — deep teal primary, amber accent */
        primary: {
          DEFAULT: '#003A49',
          foreground: '#FFFFFF',
          hover: '#00536A',
          tint: '#E6EEF1',
        },
        accent: {
          DEFAULT: '#F4B400',
          foreground: '#1A2730',
          hover: '#FFC829',
        },
        secondary: {
          DEFAULT: '#F5F7F8',
          foreground: '#1A2730',
        },
        muted: {
          DEFAULT: '#F5F7F8',
          foreground: '#6A7780',
        },
        card: {
          DEFAULT: '#FFFFFF',
          foreground: '#1A2730',
        },

        /* Semantic */
        success: '#2E8B57',
        warning: '#D97706',
        danger: '#DC2626',
        destructive: { DEFAULT: '#DC2626', foreground: '#FFFFFF' },
        info: '#003A49',

        /* Text tiers — for direct CSS use */
        tx: '#1A2730',
        tx2: '#465662',
        mt: '#6A7780',
      },

      borderRadius: {
        lg: '14px',
        md: '10px',
        sm: '6px',
      },

      fontFamily: {
        display: [
          "'Bricolage Grotesque'",
          "'Söhne'",
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        sans: [
          "'Inter Tight'",
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          "'Segoe UI'",
          'sans-serif',
        ],
        mono: [
          "'JetBrains Mono'",
          "'SF Mono'",
          'Consolas',
          'monospace',
        ],
      },

      /* Light-mode shadows — subtle layering, no glass effects */
      boxShadow: {
        sm:  '0 1px 2px rgba(15, 23, 31, 0.04)',
        DEFAULT: '0 1px 3px rgba(15, 23, 31, 0.06), 0 1px 2px rgba(15, 23, 31, 0.04)',
        md:  '0 4px 12px rgba(15, 23, 31, 0.08), 0 2px 4px rgba(15, 23, 31, 0.04)',
        lg:  '0 12px 28px rgba(15, 23, 31, 0.10), 0 4px 8px rgba(15, 23, 31, 0.04)',
        focus: '0 0 0 3px rgba(0, 58, 73, 0.18)',
      },

      spacing: {
        'shell-pad': '24px',
        'sidebar': '232px',
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
