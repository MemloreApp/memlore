import Constants from 'expo-constants';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export default function Home() {
  const version = Constants.expoConfig?.version ?? 'unknown';
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Memlore</Text>
      <Text style={styles.version}>Version {version}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space(2),
    paddingTop: rt.insets.top,
    paddingBottom: rt.insets.bottom,
    backgroundColor: theme.colors.background,
  },
  title: {
    fontSize: 34,
    fontWeight: '700',
    color: theme.colors.text,
  },
  version: {
    fontSize: 15,
    color: theme.colors.textMuted,
  },
}));
