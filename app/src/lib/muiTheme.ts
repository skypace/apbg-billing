import { createTheme, type Theme } from '@mui/material/styles';

// Brix Margin Control (Refractor) — MUI theme. Mirrors the CSS variable tokens
// in theme.css against the actual Brix Beverage brand:
//   --brix      #143966   navy (logo circle, primary chrome)
//   --ac        #5BB5F0   bubble blue (accents, the "bubble" dots above brix wordmark)
//   --amber     #F4B400   warm secondary
//   --alameda   #C8102E   Alameda Soda Co cross-brand red
//   --bg        #06121F   page background (navy-tinted dark)
//   --sf        #0E2240   surface
//   --tx        #E6EEF7   primary text
//   --mt        #6B8499   muted text
//
// The app follows the universal APBG light/dark switch (gateway waffle writes
// localStorage.apbg_theme). `makeBrixTheme(mode)` builds the matching MUI theme;
// the CSS-variable half of the theme flips via theme.css on
// html[data-apbg-theme="light"]. Refractor keeps its navy/bubble-blue brand in
// both modes — the switch just lightens the canvas.

export type ThemeMode = 'light' | 'dark';

// Unified type stack — kept in lockstep with theme.css --ff-body / --ff-display.
// Neutral grotesque (Helvetica Neue / Arial), no webfont, crisp everywhere.
const SANS =
  '"Helvetica Neue", Helvetica, Arial, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const DISPLAY = SANS;

export function makeBrixTheme(mode: ThemeMode): Theme {
  const dark = mode !== 'light';

  // Accent reads as the bubble blue on dark; on the white canvas we deepen it so
  // links/accents keep contrast. The brand navy + amber are shared.
  const accent = dark ? '#5BB5F0' : '#1F76C2';
  const accentDark = dark ? '#3A8FCC' : '#15568F';
  const accentLight = dark ? '#7ACBF5' : '#2A7FBF';

  const paper = dark ? '#0E2240' : '#FFFFFF';
  const canvas = dark ? '#06121F' : '#EEF3F8';
  const fieldBorder = dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.16)';
  const paperBorder = dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.08)';

  return createTheme({
    palette: {
      mode,
      primary:   { main: accent, dark: accentDark, light: accentLight, contrastText: '#06121F' },
      secondary: { main: '#F4B400', contrastText: '#06121F' },
      success:   { main: '#2EB872' },
      error:     { main: '#FF5A5F' },
      warning:   { main: '#F4B400' },
      info:      { main: accent },
      background: {
        default: canvas,
        paper,
      },
      text: {
        primary:   dark ? '#E6EEF7' : '#14181F',
        secondary: dark ? '#94A8BD' : '#36414E',
        disabled:  dark ? '#5A6F84' : '#7C8B9B',
      },
      divider: dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.10)',
    },
    shape: { borderRadius: 12 },
    typography: {
      // One unified stack shared with theme.css (--ff-body/--ff-display):
      // SF Pro on Apple, Inter Tight as the cross-platform fallback. Headings
      // use the same family (SF Pro Display optical size) — Bricolage dropped so
      // MUI surfaces and CSS surfaces read as a single typeface.
      fontFamily: SANS,
      fontSize: 12,
      htmlFontSize: 14,
      button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
      h1: { fontFamily: DISPLAY, fontWeight: 600, letterSpacing: '-0.02em' },
      h2: { fontFamily: DISPLAY, fontWeight: 600, letterSpacing: '-0.015em' },
      h3: { fontFamily: DISPLAY, fontWeight: 600, letterSpacing: '-0.01em' },
    },
    components: {
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            backgroundColor: paper,
            border: `1px solid ${paperBorder}`,
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: { borderRadius: 10, fontWeight: 600 },
          containedPrimary: {
            background: `linear-gradient(135deg, ${accent} 0%, ${accentDark} 100%)`,
            color: dark ? '#06121F' : '#FFFFFF',
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: paper,
            '& fieldset': { borderColor: fieldBorder },
            '&:hover fieldset': { borderColor: dark ? 'rgba(91,181,240,0.40)' : 'rgba(31,118,194,0.45)' },
          },
        },
      },
      MuiCheckbox: {
        styleOverrides: { root: { color: dark ? '#94A8BD' : '#647D96', '&.Mui-checked': { color: accent } } },
      },
      MuiSwitch: {
        styleOverrides: {
          root: {
            '& .MuiSwitch-track': { backgroundColor: dark ? '#1B3A5E' : '#C3D2E2' },
            '& .Mui-checked + .MuiSwitch-track': { backgroundColor: `${accent} !important` },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: dark ? '#163052' : '#143052',
            color: '#E6EEF7',
            border: '1px solid rgba(255,255,255,0.08)',
            fontSize: 11,
          },
        },
      },
    },
  });
}

// Back-compat default export — the dark theme (the app's original look).
export const brixTheme = makeBrixTheme('dark');
export const brixThemeLight = makeBrixTheme('light');
