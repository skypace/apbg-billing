/** @type {import('tailwindcss').Config} */
export default {
  // Only scan files in the expense module + UI primitives. Tailwind classes
  // anywhere else in the app are ignored, keeping Margin/Fleet/Ops on their
  // existing CSS-var system untouched.
  content: [
    './src/pages/expense/**/*.{ts,tsx}',
    './src/components/ui/**/*.{ts,tsx}',
    './src/components/SignaturePad.tsx',
  ],
  corePlugins: {
    // Preflight is Tailwind's CSS reset. Disabling it prevents Tailwind from
    // resetting button/input/h1/etc globally and breaking the rest of the
    // app, which depends on its own normalize in theme.css.
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // Brix brand palette — derived from the existing 3rd Party Billing
        // Loader. Replace these hex values when the official Brix brand
        // spec lands; everything tokenizes off of `brix-*` so a single
        // swap propagates everywhere.
        brix: {
          50:  '#EFF4F9',
          100: '#D6E2EF',
          200: '#A8C0DA',
          300: '#789EC5',
          400: '#4A7FB0',
          500: '#1F4E79', // primary navy (= --navy in approve.html)
          600: '#1A4267',
          700: '#143456',
          800: '#0E2545',
          900: '#081A33',
          ink: '#0F172A',
        },
        amber: {
          DEFAULT: '#F59E0B',
          dark:    '#B45309',
          tint:    '#FEF3C7',
        },
      },
      fontFamily: {
        sans: ['"Fira Sans"', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"Fira Code"', '"SF Mono"', '"JetBrains Mono"', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card:    '0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.04)',
        cardLg:  '0 10px 25px rgba(15, 23, 42, 0.08), 0 4px 10px rgba(15, 23, 42, 0.04)',
      },
    },
  },
  plugins: [],
};
