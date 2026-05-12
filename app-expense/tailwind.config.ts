import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* Backgrounds — navy-tinted dark, matching main app theme.css */
        background: '#06121F',
        foreground: '#E6EEF7',
        surface: { DEFAULT: '#0E2240', '2': '#163052', '3': '#1E4068' },

        /* Borders */
        border: '#1B3A5E',
        'border-2': '#2A5285',
        input: '#1B3A5E',
        ring: '#5BB5F0',

        /* Brand */
        primary: { DEFAULT: '#5BB5F0', foreground: '#06121F' },
        accent: { DEFAULT: '#5BB5F0', foreground: '#06121F' },
        secondary: { DEFAULT: '#0E2240', foreground: '#E6EEF7' },
        muted: { DEFAULT: '#0E2240', foreground: '#6B8499' },
        card: { DEFAULT: 'rgba(20, 57, 102, 0.32)', foreground: '#E6EEF7' },
        destructive: { DEFAULT: '#FF5A5F', foreground: '#ffffff' },

        /* Semantic */
        success: '#2EB872',
        warning: '#F4B400',
        danger: '#FF5A5F',
        info: '#5BB5F0',

        /* Text tiers */
        'tx': '#E6EEF7',
        'tx2': '#94A8BD',
        'mt': '#6B8499',
      },
      borderRadius: {
        lg: '12px',
        md: '8px',
        sm: '4px',
      },
      fontFamily: {
        display: ["'Bricolage Grotesque'", "'Söhne'", 'system-ui', '-apple-system', 'sans-serif'],
        sans: ["'Inter Tight'", 'system-ui', '-apple-system', 'BlinkMacSystemFont', "'Segoe UI'", 'sans-serif'],
        mono: ["'JetBrains Mono'", "'SF Mono'", 'Consolas', 'monospace'],
      },
      backdropBlur: {
        glass: '20px',
        'glass-sm': '12px',
        'glass-lg': '28px',
      },
      boxShadow: {
        glass: '0 4px 14px rgba(0, 0, 0, 0.40)',
        'glass-lg': '0 12px 40px rgba(0, 0, 0, 0.55)',
        glow: '0 0 0 1px rgba(91, 181, 240, 0.20), 0 8px 24px rgba(91, 181, 240, 0.10)',
        bar: '0 4px 12px rgba(91, 181, 240, 0.22)',
      },
    },
  },
  plugins: [],
};

export default config;
