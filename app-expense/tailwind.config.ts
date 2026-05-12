import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brix Beverage brand palette
        brand: {
          navy: '#1F4E79',
          'navy-dark': '#163A5C',
          'navy-light': '#2A6599',
          cyan: '#22d3ee',
        },
        // Semantic aliases
        primary: {
          DEFAULT: '#1F4E79',
          foreground: '#ffffff',
        },
        secondary: {
          DEFAULT: '#f4f6f8',
          foreground: '#1F4E79',
        },
        destructive: {
          DEFAULT: '#ef4444',
          foreground: '#ffffff',
        },
        muted: {
          DEFAULT: '#f1f5f9',
          foreground: '#64748b',
        },
        accent: {
          DEFAULT: '#f59e0b',
          foreground: '#ffffff',
        },
        card: {
          DEFAULT: '#ffffff',
          foreground: '#0f172a',
        },
        border: '#e2e8f0',
        input: '#e2e8f0',
        ring: '#1F4E79',
        background: '#f8fafc',
        foreground: '#0f172a',
      },
      borderRadius: {
        lg: '0.75rem',
        md: '0.5rem',
        sm: '0.375rem',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
