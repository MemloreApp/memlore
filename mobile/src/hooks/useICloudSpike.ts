import { useCallback, useState } from 'react';

import MemloreCore from '@/modules/memlore-core';

// Dev-only (spike 17.1): the native calls of `app/(dev)/spike-icloud.tsx`.
// Every action shows its result or error as text; nothing is retried.
// TODO(later): see docs/LATER.md (remove with the dev spike routes).

function describe(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') {
    return e.message;
  }
  return String(e);
}

export function useICloudSpike() {
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const result = await action();
      const text = `${label}: ${JSON.stringify(result ?? null, null, 2)}`;
      setOutput(text);
      console.log(`[spike-icloud] ${text}`);
    } catch (e) {
      const text = `${label} failed: ${describe(e)}`;
      setOutput(text);
      console.log(`[spike-icloud] ${text}`);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    output,
    busy,
    pickFolder: () => run('pick', () => MemloreCore.spikeICloudPickFolder()),
    bookmarkStatus: () => run('bookmark', () => MemloreCore.spikeICloudBookmarkStatus()),
    forgetBookmark: () => run('forget', () => MemloreCore.spikeICloudForgetBookmark()),
    list: () => run('list', () => MemloreCore.spikeICloudList()),
    startDownloads: () => run('download', () => MemloreCore.spikeICloudStartDownloads()),
    containerProbe: () => run('container', () => MemloreCore.spikeICloudContainerProbe()),
    scheduleBackgroundTask: () =>
      run('schedule', () => MemloreCore.spikeICloudScheduleBackgroundTask()),
    listLaterInBackground: (delaySeconds: number) =>
      run('later', () => MemloreCore.spikeICloudListLaterInBackground(delaySeconds)),
    backgroundResult: () =>
      run('background', async () => {
        const json = await MemloreCore.spikeICloudBackgroundResult();
        return json === null ? null : (JSON.parse(json) as unknown);
      }),
  };
}
