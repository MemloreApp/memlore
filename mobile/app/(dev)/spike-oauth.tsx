import { Redirect } from 'expo-router';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useOAuthSpike } from '@/src/hooks/useOAuthSpike';

// Dev-only spike screen (plan phase 17.2): sign in to Google with the iOS
// OAuth client (PKCE, ASWebAuthenticationSession), keep the tokens in the
// Keychain, list the Drive appDataFolder (metadata only), refresh, and
// disconnect by deleting the Keychain item. Read-only against Drive. Not
// translated; never reachable in a release build. The client ID comes from
// MEMLORE_GOOGLE_IOS_CLIENT_ID in mobile/.env.local (see app.config.ts).
// Open with `xcrun simctl openurl booted memlore:///spike-oauth`.
// TODO(later): see docs/LATER.md (remove with the dev spike routes).

export default function SpikeOAuth() {
  if (!__DEV__) return <Redirect href="/" />;
  return <Spike />;
}

function Spike() {
  const spike = useOAuthSpike();
  const actions: [string, string, () => void][] = [
    [
      'spike-oauth-preview',
      'Preview authorization URL (opens nothing)',
      spike.previewAuthorizationUrl,
    ],
    ['spike-oauth-signin', 'Sign in with Google', spike.signIn],
    ['spike-oauth-status', 'Keychain status', spike.keychainStatus],
    ['spike-oauth-list', 'List appDataFolder (metadata)', spike.listAppData],
    ['spike-oauth-refresh', 'Refresh access token', spike.refresh],
    [
      'spike-oauth-refresh-empty-secret',
      'Refresh with empty client_secret (engine form)',
      spike.refreshEmptySecret,
    ],
    ['spike-oauth-disconnect', 'Disconnect (delete Keychain tokens)', spike.disconnect],
  ];
  const confirmRevoke = () =>
    Alert.alert(
      'Revoke the Google grant?',
      'The grant belongs to the whole GCP project: the desktop and web clients signed in with this account lose Drive access too. Not part of the spike run.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revoke', style: 'destructive', onPress: spike.revokeGrant },
      ],
    );
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.title}>Google OAuth spike</Text>
      {!spike.configured && (
        <Text testID="spike-oauth-not-configured" style={styles.warning}>
          Client ID not configured (MEMLORE_GOOGLE_IOS_CLIENT_ID in mobile/.env.local).
        </Text>
      )}
      {actions.map(([testID, label, onPress]) => (
        <Pressable
          key={testID}
          testID={testID}
          accessibilityRole="button"
          disabled={spike.busy}
          onPress={onPress}
        >
          <Text style={styles.link}>{label}</Text>
        </Pressable>
      ))}
      <Pressable
        testID="spike-oauth-revoke"
        accessibilityRole="button"
        disabled={spike.busy}
        onPress={confirmRevoke}
      >
        <Text style={styles.danger}>Revoke grant at Google (dev only, do not press)</Text>
      </Pressable>
      <View style={styles.output}>
        <Text testID="spike-oauth-output" selectable style={styles.outputText}>
          {spike.busy ? '…' : spike.output}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  screen: {
    gap: theme.space(3),
    paddingTop: rt.insets.top + theme.space(3),
    paddingBottom: rt.insets.bottom + theme.space(3),
    paddingHorizontal: theme.space(4),
    backgroundColor: theme.colors.panel1,
    flexGrow: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: theme.colors.fg,
  },
  warning: {
    fontSize: 15,
    color: theme.colors.warningText,
  },
  link: {
    fontSize: 17,
    color: theme.colors.accentText,
  },
  danger: {
    fontSize: 17,
    color: theme.colors.dangerText,
  },
  output: {
    paddingTop: theme.space(3),
    borderTopWidth: 1,
    borderColor: theme.colors.borderDefault,
  },
  outputText: {
    fontSize: 13,
    color: theme.colors.fgSecondary,
  },
}));
