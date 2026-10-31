import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import MemloreCore from '@/modules/memlore-core';

/**
 * Whether a secret (the recovery phrase) may be on screen: only while the app
 * is active and the screen is not recorded, mirrored or AirPlayed (decision
 * 6). Hidden until the first capture check answers. Components use this
 * hook, never the native module.
 */
export function useScreenPrivacy(): { visible: boolean } {
  const [active, setActive] = useState(AppState.currentState === 'active');
  // null until the native check answers: hidden meanwhile.
  const [captured, setCaptured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Bumped by every query and every event: only the newest one lands.
    let latest = 0;
    function query() {
      const mine = ++latest;
      MemloreCore.isScreenCaptured()
        // Never seen in practice. Hiding the phrase for good would lose it, and
        // a capture that starts later still sends the event.
        .catch(() => false)
        .then((value) => {
          // An event or a query that came after this one is newer.
          if (!cancelled && mine === latest) setCaptured(value);
        });
    }
    const appState = AppState.addEventListener('change', (state) => {
      setActive(state === 'active');
      // A capture that started while the app was suspended may send no event.
      if (state === 'active') query();
    });
    const capture = MemloreCore.addListener('onScreenCaptureChange', (event) => {
      latest += 1;
      setCaptured(event.captured);
    });
    query();
    return () => {
      cancelled = true;
      appState.remove();
      capture.remove();
    };
  }, []);

  return { visible: active && captured === false };
}
