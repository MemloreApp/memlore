import { Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { VaultError } from '@/src/hooks/useVault';
import { t } from '@/src/i18n';

/** The translated message for a vault error, or null when there is none. */
export function errorMessage(error: VaultError | null): string | null {
  if (error === 'wrong_password') return t('lock.invalid_password');
  if (error === 'biometric_disabled') return t('mobile.biometric_disabled');
  if (error === 'failed') return t('mobile.error');
  return null;
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Text testID="vault-error" style={styles.error}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: {
    fontSize: 15,
    color: theme.colors.dangerText,
  },
}));
