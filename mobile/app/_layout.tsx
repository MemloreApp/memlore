// Registers the Unistyles themes. First import: configure must run before any
// route module is evaluated, and the root layout loads first.
import '@/src/theme/unistyles';

import { Stack } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

export default function RootLayout() {
  const { theme } = useUnistyles();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.panel1 },
      }}
    />
  );
}
