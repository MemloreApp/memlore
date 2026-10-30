import { useState } from 'react';
import { ActivityIndicator, Pressable, Switch, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AutoLockSeconds, BiometricKind } from '@/modules/memlore-core';
import { ActionButton } from '@/src/components/ActionButton';
import { ErrorText, errorMessage } from '@/src/components/ErrorText';
import type { useVault } from '@/src/hooks/useVault';
import { type AuthKey, t } from '@/src/i18n';

type Vault = ReturnType<typeof useVault>;

const AUTO_LOCK_OPTIONS: readonly { seconds: AutoLockSeconds; label: AuthKey }[] = [
  { seconds: 0, label: 'mobile.auto_lock_0' },
  { seconds: 60, label: 'mobile.auto_lock_60' },
  { seconds: 300, label: 'mobile.auto_lock_300' },
  { seconds: 900, label: 'mobile.auto_lock_900' },
];

/** The product name, never translated. */
export function biometricName(kind: BiometricKind): string {
  return kind === 'touchID' ? 'Touch ID' : 'Face ID';
}

/**
 * Face ID/Touch ID and the auto-lock interval. Rendered in place of the
 * unlocked view, so a lock unmounts it.
 */
export function SecurityPanel({ vault, onBack }: { vault: Vault; onBack: () => void }) {
  return (
    <>
      <Text style={styles.title}>{t('mobile.security')}</Text>
      <BiometricRow vault={vault} />
      <Text style={styles.sectionTitle}>{t('mobile.auto_lock_title')}</Text>
      <Text style={styles.body}>{t('mobile.auto_lock_description')}</Text>
      <View style={styles.pills}>
        {AUTO_LOCK_OPTIONS.map(({ seconds, label }) => {
          const selected = vault.autoLockSeconds === seconds;
          return (
            <Pressable
              key={seconds}
              testID={`auto-lock-${seconds}`}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: vault.busy }}
              disabled={vault.busy}
              onPress={() => void vault.setAutoLockSeconds(seconds)}
              style={styles.pill(selected)}
            >
              <Text style={styles.pillLabel(selected)}>{t(label)}</Text>
            </Pressable>
          );
        })}
      </View>
      <ErrorText message={errorMessage(vault.error)} />
      <ActionButton testID="security-back-button" label={t('mobile.back')} onPress={onBack} />
    </>
  );
}

function BiometricRow({ vault }: { vault: Vault }) {
  const { theme } = useUnistyles();
  // The switch moves at once; it settles on the stored state once the call
  // ends, so a cancel or a failure flips it back.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const { available, kind, enabled } = vault.biometric;
  const name = biometricName(kind);

  async function toggle(next: boolean) {
    if (vault.busy) return;
    setOptimistic(next);
    try {
      await (next ? vault.enableBiometric() : vault.disableBiometric());
    } finally {
      setOptimistic(null);
    }
  }

  if (!available) {
    return (
      <View testID="biometric-row" style={styles.row}>
        <Text style={styles.reason}>
          {kind === 'none'
            ? t('mobile.biometric_unavailable')
            : t('mobile.biometric_not_enrolled', { kind: name })}
        </Text>
      </View>
    );
  }

  return (
    <View testID="biometric-row" style={styles.row}>
      <Text style={styles.rowLabel}>{t('mobile.unlock_with_biometric', { kind: name })}</Text>
      {vault.busy && optimistic !== null ? <ActivityIndicator /> : null}
      <Switch
        testID="biometric-switch"
        accessibilityLabel={t('mobile.unlock_with_biometric', { kind: name })}
        value={optimistic ?? enabled}
        disabled={vault.busy}
        onValueChange={(next) => void toggle(next)}
        trackColor={{ false: theme.colors.borderStrong, true: theme.colors.accent }}
        ios_backgroundColor={theme.colors.borderStrong}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: theme.colors.fg,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.colors.fg,
    marginTop: theme.space(3),
  },
  body: {
    fontSize: 15,
    color: theme.colors.fgSecondary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(3),
    paddingVertical: theme.space(3),
    paddingHorizontal: theme.space(4),
    borderWidth: 1,
    borderRadius: theme.radii.xl,
    borderColor: theme.colors.borderDefault,
    backgroundColor: theme.colors.elevated,
  },
  rowLabel: {
    flex: 1,
    fontSize: 17,
    color: theme.colors.fg,
  },
  reason: {
    flex: 1,
    fontSize: 15,
    color: theme.colors.fgSecondary,
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space(2),
  },
  pill: (selected: boolean) => ({
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(4),
    borderWidth: 1,
    borderRadius: theme.radii.button,
    borderColor: selected ? theme.colors.accent : theme.colors.borderDefault,
    backgroundColor: selected ? theme.colors.accent : theme.colors.elevated,
  }),
  pillLabel: (selected: boolean) => ({
    fontSize: 15,
    fontWeight: selected ? '600' : '400',
    color: selected ? theme.colors.fgInverse : theme.colors.fg,
  }),
}));
