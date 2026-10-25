import { StyleSheet } from 'react-native-unistyles';

import tokens from './tokens.generated.json';

// Mobile themes from the desktop design tokens (plan phase 16.2).
// tokens.generated.json is written by `pnpm tokens:export` from
// src/styles/globals.css; never edit it by hand. Colour keys are the desktop
// `--color-*` names in camelCase (`--color-fg-secondary` → `fgSecondary`),
// with the mobile-only WCAG overrides listed in its `mobileOverrides`.
//
// Import this module first in `app/_layout.tsx`: configure must run before any
// route module creates a stylesheet.

type ThemeName = keyof typeof tokens.themes;
type ThemeTokens = (typeof tokens.themes)[ThemeName];

/** Mirrors src/lib/designSystem.ts DEFAULT_CORNER_RADIUS. */
const DEFAULT_CORNER_RADIUS = 'high';

function makeTheme(t: ThemeTokens) {
  return {
    colors: t.colors,
    radii: t.radii[DEFAULT_CORNER_RADIUS],
    // RN `boxShadow` arrays (elev-1 … elev-4).
    elevation: t.elevation,
    // Family stacks only: Geist, Baloo 2 and Fraunces are not bundled in the
    // app yet, so text renders in the system font.
    // TODO(later): bundle fonts for mobile, see docs/LATER.md.
    fonts: t.fonts,
    // Spacing scale step, the same 0.25rem (4px) as the desktop's Tailwind.
    space: (n: number) => n * 4,
  };
}

const appThemes = {
  // Adaptive light/dark follow the OS appearance with the default design
  // system, Clay (src/lib/designSystem.ts DEFAULT_DESIGN_SYSTEM).
  light: makeTheme(tokens.themes.clayLight),
  dark: makeTheme(tokens.themes.clayDark),
  signatureLight: makeTheme(tokens.themes.signatureLight),
  signatureDark: makeTheme(tokens.themes.signatureDark),
  signatureDarkSoft: makeTheme(tokens.themes.signatureDarkSoft),
  signatureDarkLumen: makeTheme(tokens.themes.signatureDarkLumen),
  cleanLight: makeTheme(tokens.themes.cleanLight),
  cleanDark: makeTheme(tokens.themes.cleanDark),
  clayLight: makeTheme(tokens.themes.clayLight),
  clayDark: makeTheme(tokens.themes.clayDark),
};

type AppThemes = typeof appThemes;

declare module 'react-native-unistyles' {
  export interface UnistylesThemes extends AppThemes {}
}

StyleSheet.configure({
  themes: appThemes,
  settings: { adaptiveThemes: true },
});
