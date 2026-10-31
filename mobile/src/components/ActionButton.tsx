import { Pressable, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/** The app's one button style, shared by the home screen and the Security panel. */
export function ActionButton(props: {
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

const styles = StyleSheet.create((theme) => ({
  button: {
    alignItems: 'center',
    paddingVertical: theme.space(3),
    borderRadius: theme.radii.button,
    backgroundColor: theme.colors.accent,
  },
  buttonLabel: {
    fontSize: 17,
    fontWeight: '600',
    color: theme.colors.fgInverse,
  },
}));
