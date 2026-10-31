import { Redirect } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useICloudSpike } from '@/src/hooks/useICloudSpike';

// Dev-only spike screen (plan phase 17.1): pick the MemloreSpike folder in
// iCloud Drive, keep a bookmark, list it with NSFileCoordinator, download
// placeholders, and list it from the background. Read-only. Not translated;
// never reachable in a release build. The iCloud entitlements and the
// background task exist only in a build made with MEMLORE_SPIKE_ICLOUD=1.
// Open with `xcrun simctl openurl booted memlore:///spike-icloud`.
// TODO(later): see docs/LATER.md (remove with the dev spike routes).

/** Seconds before the fallback background listing runs (time to go Home). */
const LATER_DELAY_S = 10;

export default function SpikeICloud() {
  if (!__DEV__) return <Redirect href="/" />;
  return <Spike />;
}

function Spike() {
  const spike = useICloudSpike();
  const actions: [string, string, () => void][] = [
    ['spike-icloud-pick', 'Pick folder', spike.pickFolder],
    ['spike-icloud-bookmark', 'Resolve bookmark', spike.bookmarkStatus],
    ['spike-icloud-list', 'List (coordinated)', spike.list],
    ['spike-icloud-download', 'Download placeholders', spike.startDownloads],
    ['spike-icloud-schedule', 'Schedule BGProcessingTask', spike.scheduleBackgroundTask],
    [
      'spike-icloud-later',
      `List in background in ${LATER_DELAY_S} s`,
      () => spike.listLaterInBackground(LATER_DELAY_S),
    ],
    ['spike-icloud-bg-result', 'Last background listing', spike.backgroundResult],
    ['spike-icloud-container', 'Probe ubiquity container', spike.containerProbe],
    ['spike-icloud-forget', 'Forget bookmark', spike.forgetBookmark],
  ];
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.title}>iCloud spike</Text>
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
      <View style={styles.output}>
        <Text testID="spike-icloud-output" selectable style={styles.outputText}>
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
  link: {
    fontSize: 17,
    color: theme.colors.accentText,
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
