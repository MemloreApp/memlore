import { Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

// Placeholder themes. Phase 16 replaces them with the exported design tokens.
const lightTheme = {
  colors: { background: '#ffffff', text: '#111111', textMuted: '#555555' },
  space: (n: number) => n * 4,
} as const;

const darkTheme = {
  colors: { background: '#111111', text: '#f5f5f5', textMuted: '#a3a3a3' },
  space: (n: number) => n * 4,
} as const;

const appThemes = { light: lightTheme, dark: darkTheme };

type AppThemes = typeof appThemes;

declare module 'react-native-unistyles' {
  export interface UnistylesThemes extends AppThemes {}
}

// Runs before any route module is evaluated: the root layout loads first.
StyleSheet.configure({
  themes: appThemes,
  settings: { adaptiveThemes: true },
});

export default function RootLayout() {
  const { theme } = useUnistyles();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
