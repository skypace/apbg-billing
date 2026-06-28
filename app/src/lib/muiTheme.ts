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
        primary:   dark ? '#E6EEF7' : '#0E2447',
        secondary: dark ? '#94A8BD' : '#436081',
        disabled:  dark ? '#5A6F84' : '#8AA0B5',
      },
      divider: dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.10)',
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily:
        '"Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
      fontSize: 12,
      htmlFontSize: 14,
      button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
      h1: { fontFamily: '"Bricolage Grotesque", "Inter Tight", sans-serif', fontWeight: 600 },
      h2: { fontFamily: '"Bricolage Grotesque", "Inter Tight", sans-serif', fontWeight: 600 },
      h3: { fontFamily: '"Bricolage Grotesque", "Inter Tight", sans-serif', fontWeight: 600 },
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
