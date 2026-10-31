import { useCallback, useEffect, useState } from 'react';

import MemloreCore, { type EntryTitle } from '@/modules/memlore-core';

export type EntryDocStatus = 'loading' | 'ready' | 'locked' | 'failed';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

function isLocked(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'ERR_LOCKED';
}

/** Newest entries for a picker. Components use this, never the native module. */
export function useEntryTitles(limit = 50) {
  const [titles, setTitles] = useState<EntryTitle[] | null>(null);
  const [status, setStatus] = useState<EntryDocStatus>('loading');

  const refresh = useCallback(() => {
    setStatus('loading');
    MemloreCore.listEntryTitles(limit)
      .then((rows) => {
        setTitles(rows);
        setStatus('ready');
      })
      .catch((e: unknown) => setStatus(isLocked(e) ? 'locked' : 'failed'));
  }, [limit]);

  useEffect(refresh, [refresh]);

  /** Dev-only (spike 15.4): a new entry with this body, saved like the editor saves. */
  // TODO(later): see docs/LATER.md (remove with the spike screen).
  const seed = useCallback(
    async (title: string, fullStateB64: string, contentText: string) => {
      const id = await MemloreCore.createEntry(title);
      await MemloreCore.saveEntryYjs(id, fullStateB64, contentText, contentText.slice(0, 150));
      refresh();
    },
    [refresh],
  );

  return { titles, status, refresh, seed };
}

/**
 * One entry's Yjs document for the DOM editor: the stored full state
 * (base64) and the save the editor calls with its full state. The save goes
 * through the engine's merged save, like the desktop editor.
 */
export function useEntryDoc(id: string) {
  const [stateB64, setStateB64] = useState<string | null>(null);
  const [status, setStatus] = useState<EntryDocStatus>('loading');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setStateB64(null);
    setSaveStatus('idle');
    MemloreCore.loadEntryYjs(id)
      .then((b64) => {
        if (cancelled) return;
        setStateB64(b64);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(isLocked(e) ? 'locked' : 'failed');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  /** Rejects when the save failed, so the editor retries on its next edit. */
  const save = useCallback(
    async (fullStateB64: string, contentText: string, previewText: string) => {
      setSaveStatus('saving');
      try {
        await MemloreCore.saveEntryYjs(id, fullStateB64, contentText, previewText);
        setSaveStatus('saved');
      } catch (e) {
        setSaveStatus('failed');
        if (isLocked(e)) setStatus('locked');
        throw e;
      }
    },
    [id],
  );

  return { stateB64, status, saveStatus, save };
}
