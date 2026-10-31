import { Redirect } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import EntryEditorDom, { type EntryEditorHandle } from '@/editor/EntryEditorDom';
import SeedEntryDom from '@/editor/SeedEntryDom';
import { useEntryDoc, useEntryTitles } from '@/src/hooks/useEntryDoc';

// Dev-only spike screen (plan phase 15.2): pick an entry, edit it in the DOM
// editor, save through the engine. Not translated; never reachable in a
// release build. Open with `xcrun simctl openurl booted memlore:///editor-spike`
// after unlocking the vault on the home screen.

/** Leave anyway if the editor never answers (WebView gone or stuck). */
const FLUSH_TIMEOUT_MS = 3000;

export default function EditorSpike() {
  if (!__DEV__) return <Redirect href="/" />;
  return <Spike />;
}

function Spike() {
  const [entryId, setEntryId] = useState<string | null>(null);
  return entryId ? (
    <EntryScreen id={entryId} onBack={() => setEntryId(null)} />
  ) : (
    <EntryList onOpen={setEntryId} />
  );
}

function EntryList({ onOpen }: { onOpen: (id: string) => void }) {
  const { titles, status, refresh, seed } = useEntryTitles();
  // Each press remounts the seeder (key); it stays mounted afterwards so the
  // reply to its native action never targets an unmounted WebView.
  const [seedRun, setSeedRun] = useState(0);
  const [seedRemote, setSeedRemote] = useState(false);
  const [seeding, setSeeding] = useState(false);
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Editor spike</Text>
      <Pressable
        testID="spike-seed"
        accessibilityRole="button"
        disabled={seeding}
        onPress={() => {
          setSeeding(true);
          setSeedRemote(false);
          setSeedRun((run) => run + 1);
        }}
      >
        <Text style={styles.link}>{seeding ? 'Seeding…' : 'Seed 5k words'}</Text>
      </Pressable>
      <Pressable
        testID="spike-seed-remote"
        accessibilityRole="button"
        disabled={seeding}
        onPress={() => {
          setSeeding(true);
          setSeedRemote(true);
          setSeedRun((run) => run + 1);
        }}
      >
        <Text style={styles.link}>Seed link + remote media</Text>
      </Pressable>
      {seedRun > 0 ? (
        <SeedEntryDom
          key={seedRun}
          words={5000}
          remoteMedia={seedRemote}
          onSeeded={(stateB64, text) =>
            seed(seedRemote ? 'Remote media' : '5k words', stateB64, text).finally(() =>
              setSeeding(false),
            )
          }
          dom={{ style: { height: 0 } }}
        />
      ) : null}
      {status === 'locked' ? <Text style={styles.muted}>Unlock the vault first.</Text> : null}
      {status === 'failed' ? <Text style={styles.muted}>Could not list entries.</Text> : null}
      <FlatList
        data={titles ?? []}
        keyExtractor={(item) => item.id}
        onRefresh={refresh}
        refreshing={status === 'loading'}
        renderItem={({ item, index }) => (
          <Pressable
            testID={`spike-entry-${index}`}
            accessibilityRole="button"
            onPress={() => onOpen(item.id)}
            style={styles.row}
          >
            <Text style={styles.rowText}>{item.title ?? '(untitled)'}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function EntryScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const { stateB64, status, saveStatus, save } = useEntryDoc(id);
  const openedAt = useRef(Date.now());
  const [firstPaint, setFirstPaint] = useState('');
  const editorRef = useRef<EntryEditorHandle>(null);
  const flushed = useRef<(() => void) | null>(null);
  const leaving = useRef(false);

  // The editor WebView is torn down with no unmount hook on its side, so a
  // save still in its 1.5 s debounce must be flushed before leaving.
  const back = async () => {
    if (leaving.current) return;
    leaving.current = true;
    // Undefined until the editor registered its handle (nothing typed yet).
    const flush = editorRef.current?.flush;
    if (flush) {
      await Promise.race([
        new Promise<void>((resolve) => {
          flushed.current = resolve;
          flush();
        }),
        new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
      ]);
    }
    onBack();
  };

  useEffect(() => {
    if (status === 'ready') {
      console.log(`[editor-spike] loadEntryYjs ready after ${Date.now() - openedAt.current} ms`);
    }
  }, [status]);

  useEffect(() => {
    const subs = (['keyboardWillShow', 'keyboardDidShow', 'keyboardDidHide'] as const).map(
      (name) =>
        Keyboard.addListener(name, (e) =>
          console.log(`[editor-spike] ${name} height=${Math.round(e.endCoordinates.height)}`),
        ),
    );
    return () => subs.forEach((sub) => sub.remove());
  }, []);

  // Spike 15.4: first paint as the user sees it (screen opened -> frame with
  // the document), plus the WebView's own performance.now() numbers.
  const onDebug = async (event: string, detail: string) => {
    if (event === 'firstPaint') {
      const { wallClock, ...rest } = JSON.parse(detail) as { wallClock: number };
      const line = `openToPaintMs=${wallClock - openedAt.current} ${JSON.stringify(rest)}`;
      setFirstPaint(line);
      console.log(`[editor-spike] firstPaint ${line}`);
      return;
    }
    console.log(`[editor-spike] ${event} ${detail}`);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Pressable testID="spike-back" accessibilityRole="button" onPress={back}>
          <Text style={styles.link}>Back</Text>
        </Pressable>
        <Text testID="spike-save-status" style={styles.muted}>
          {status === 'ready' ? saveStatus : status}
        </Text>
      </View>
      {status === 'ready' && stateB64 !== null ? (
        <EntryEditorDom
          key={id}
          ref={editorRef}
          initialStateB64={stateB64}
          onUpdate={save}
          onFlushed={async () => flushed.current?.()}
          readOnly={false}
          onDebug={onDebug}
          dom={{ style: { flex: 1 } }}
        />
      ) : null}
      <Text testID="spike-first-paint" style={styles.muted}>
        {firstPaint}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  screen: {
    flex: 1,
    gap: theme.space(3),
    paddingTop: rt.insets.top + theme.space(3),
    paddingBottom: rt.insets.bottom,
    paddingHorizontal: theme.space(4),
    backgroundColor: theme.colors.panel1,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: theme.colors.fg,
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  link: {
    fontSize: 17,
    color: theme.colors.accentText,
  },
  muted: {
    fontSize: 15,
    color: theme.colors.fgSecondary,
  },
  row: {
    paddingVertical: theme.space(3),
    borderBottomWidth: 1,
    borderColor: theme.colors.borderDefault,
  },
  rowText: {
    fontSize: 17,
    color: theme.colors.fg,
  },
}));
