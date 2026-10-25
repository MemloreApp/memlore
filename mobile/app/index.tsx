import { type ReactNode, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useVault, type VaultError } from '@/src/hooks/useVault';
import { t } from '@/src/i18n';

// Mirrors MIN_PASSWORD_LEN in memlore-engine (vault/mod.rs), which still
// validates it.
const MIN_PASSWORD_LEN = 8;

type Vault = ReturnType<typeof useVault>;

export default function Home() {
  const vault = useVault();

  let body: ReactNode;
  switch (vault.status) {
    case 'loading':
      body = <ActivityIndicator />;
      break;
    case 'first_launch':
      body = <CreateVault vault={vault} />;
      break;
    case 'show_phrase':
      body = <RecoveryPhrase vault={vault} />;
      break;
    case 'locked':
      body = <Unlock vault={vault} />;
      break;
    case 'unlocked':
      body = <Unlocked vault={vault} />;
      break;
    case 'boot_file_corrupt':
      body = (
        <>
          <Text style={styles.title}>{t('boot_file_corrupt.title')}</Text>
          <Text style={styles.body}>{t('boot_file_corrupt.body')}</Text>
          <Text style={styles.body}>{t('boot_file_corrupt.hint')}</Text>
        </>
      );
      break;
    case 'error':
      body = (
        <>
          <Text style={styles.error}>{t('mobile.error')}</Text>
          <ActionButton testID="retry-button" label={t('mobile.retry')} onPress={vault.retry} />
        </>
      );
      break;
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {body}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function errorMessage(error: VaultError | null): string | null {
  if (error === 'wrong_password') return t('lock.invalid_password');
  if (error === 'failed') return t('mobile.error');
  return null;
}

function CreateVault({ vault }: { vault: Vault }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  async function submit() {
    if (vault.busy) return;
    if (password.length < MIN_PASSWORD_LEN) {
      setInvalid(t('mobile.password_too_short', { count: MIN_PASSWORD_LEN }));
      return;
    }
    if (password !== confirm) {
      setInvalid(t('set_password.mismatch'));
      return;
    }
    setInvalid(null);
    if (await vault.createVault(password)) {
      setPassword('');
      setConfirm('');
    }
  }

  return (
    <>
      <Text style={styles.title}>{t('set_password.title')}</Text>
      <Text style={styles.body}>{t('set_password.description')}</Text>
      <PasswordInput
        testID="password-input"
        placeholder={t('set_password.password_label')}
        value={password}
        onChangeText={setPassword}
      />
      <PasswordInput
        testID="confirm-password-input"
        placeholder={t('set_password.confirm_label')}
        value={confirm}
        onChangeText={setConfirm}
      />
      <ErrorText message={invalid ?? errorMessage(vault.error)} />
      <ActionButton
        testID="create-vault-button"
        label={vault.busy ? t('set_password.creating') : t('mobile.create_vault')}
        disabled={vault.busy}
        onPress={submit}
      />
    </>
  );
}

function RecoveryPhrase({ vault }: { vault: Vault }) {
  return (
    <>
      <Text style={styles.title}>{t('recovery.intro_title')}</Text>
      <Text style={styles.body}>{t('recovery.intro_body')}</Text>
      <Text
        testID="recovery-phrase"
        accessibilityLabel={t('recovery.words_aria')}
        selectable
        style={styles.phrase}
      >
        {vault.recoveryPhrase}
      </Text>
      <ActionButton
        testID="phrase-saved-button"
        label={t('recovery.continue_to_confirm')}
        onPress={vault.confirmPhraseSaved}
      />
    </>
  );
}

function Unlock({ vault }: { vault: Vault }) {
  const [password, setPassword] = useState('');

  async function submit() {
    if (vault.busy || password.length === 0) return;
    await vault.unlock(password);
    // Cleared either way: a wrong password is retyped from scratch.
    setPassword('');
  }

  return (
    <>
      <Text style={styles.title}>{t('lock.welcome_back')}</Text>
      <Text style={styles.body}>{t('lock.encrypted_device')}</Text>
      <PasswordInput
        testID="password-input"
        placeholder={t('lock.password_placeholder')}
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={submit}
      />
      <ErrorText message={errorMessage(vault.error)} />
      <ActionButton
        testID="unlock-button"
        label={vault.busy ? t('lock.unlocking') : t('lock.unlock')}
        disabled={vault.busy || password.length === 0}
        onPress={submit}
      />
    </>
  );
}

function Unlocked({ vault }: { vault: Vault }) {
  const { theme } = useUnistyles();
  const [title, setTitle] = useState('');

  async function submit() {
    if (vault.busy) return;
    if (await vault.createEntry(title)) setTitle('');
  }

  return (
    <>
      <Text style={styles.title}>Memlore</Text>
      <Text testID="entry-count" style={styles.body}>
        {t('mobile.entry_count', { count: vault.entryCount ?? '…' })}
      </Text>
      <TextInput
        testID="entry-title-input"
        style={styles.input}
        placeholder={t('mobile.entry_title_placeholder')}
        placeholderTextColor={theme.colors.textMuted}
        value={title}
        onChangeText={setTitle}
      />
      <ErrorText message={errorMessage(vault.error)} />
      <ActionButton
        testID="new-entry-button"
        label={t('mobile.new_entry')}
        disabled={vault.busy}
        onPress={submit}
      />
      <ActionButton
        testID="lock-button"
        label={t('mobile.lock')}
        disabled={vault.busy}
        onPress={vault.lock}
      />
    </>
  );
}

function PasswordInput(props: {
  testID: string;
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  onSubmitEditing?: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <TextInput
      {...props}
      style={styles.input}
      placeholderTextColor={theme.colors.textMuted}
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      // No iCloud Keychain prompts: the vault password never goes to the OS.
      autoComplete="off"
      textContentType="none"
    />
  );
}

function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Text testID="vault-error" style={styles.error}>
      {message}
    </Text>
  );
}

function ActionButton(props: {
  testID: string;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={styles.button}
    >
      <Text style={styles.buttonLabel}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: theme.space(3),
    paddingTop: rt.insets.top + theme.space(6),
    paddingBottom: rt.insets.bottom + theme.space(6),
    paddingHorizontal: theme.space(6),
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: theme.colors.text,
  },
  body: {
    fontSize: 15,
    color: theme.colors.textMuted,
  },
  phrase: {
    fontSize: 17,
    lineHeight: 26,
    color: theme.colors.text,
    padding: theme.space(4),
    borderWidth: 1,
    borderRadius: theme.space(2),
    borderColor: theme.colors.border,
  },
  input: {
    fontSize: 17,
    color: theme.colors.text,
    paddingVertical: theme.space(3),
    paddingHorizontal: theme.space(4),
    borderWidth: 1,
    borderRadius: theme.space(2),
    borderColor: theme.colors.border,
  },
  error: {
    fontSize: 15,
    color: theme.colors.danger,
  },
  button: {
    alignItems: 'center',
    paddingVertical: theme.space(3),
    borderRadius: theme.space(2),
    backgroundColor: theme.colors.accent,
  },
  buttonLabel: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.colors.accentText,
  },
}));
