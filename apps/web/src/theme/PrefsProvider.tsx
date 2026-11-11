// Holds the appearance and help settings for the whole app. Signed in,
// they come from the account (and changes go back to it, debounced);
// signed out, they live in localStorage only. Either way the last-known
// copy is cached in localStorage so index.html can paint the right
// theme before React starts.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { createPrefsWriter, fetchPreferences, savePreferences, type PrefsWriter } from './prefsClient';
import {
  applyTheme,
  DEFAULT_PREFERENCES,
  readCachedPreferences,
  resolveMode,
  systemPrefersDark,
  writeCachedPreferences,
  writeCachedThemeVars,
  type Preferences,
} from './theme';
import type { Mode } from './tokens';

export interface PrefsContextValue {
  prefs: Preferences;
  /** The mode on screen now ("system" resolved). */
  mode: Mode;
  setPrefs: (changes: Partial<Preferences>) => void;
  /** True when the settings are stored on a signed-in account. */
  syncedToAccount: boolean;
  updatedAt: string | null;
  /** The account's settings have loaded (or there's no account): safe to act on toursSeen. */
  ready: boolean;
}

export const PrefsContext = createContext<PrefsContextValue | null>(null);

const FALLBACK: PrefsContextValue = {
  prefs: DEFAULT_PREFERENCES,
  mode: 'light',
  setPrefs: () => {},
  syncedToAccount: false,
  updatedAt: null,
  ready: true,
};

function sameAsDefaults(p: Preferences): boolean {
  return JSON.stringify(p) === JSON.stringify(DEFAULT_PREFERENCES);
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefsState] = useState<Preferences>(() => readCachedPreferences());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const userId = me.data?.user?.id ?? null;

  const writerRef = useRef<PrefsWriter | null>(null);
  if (!writerRef.current) {
    writerRef.current = createPrefsWriter({
      save: async (changes) => {
        const res = await savePreferences(changes);
        setUpdatedAt(res.updatedAt);
      },
    });
  }

  const remote = useQuery({
    queryKey: ['preferences', userId],
    queryFn: () => fetchPreferences(),
    enabled: userId !== null,
    staleTime: Infinity,
  });

  // Adopt the account's settings once they load. An account that has
  // never saved any takes this browser's choices instead.
  useEffect(() => {
    if (!remote.data) return;
    if (remote.data.updatedAt === null) {
      const local = readCachedPreferences();
      if (!sameAsDefaults(local)) writerRef.current?.queue(local);
      return;
    }
    // A change made here and not yet saved is newer than what loaded
    // (another tab's change refetches this, see live/LiveUpdates.tsx).
    if (writerRef.current?.hasPending()) return;
    setPrefsState(remote.data.prefs);
    setUpdatedAt(remote.data.updatedAt);
    writeCachedPreferences(remote.data.prefs);
  }, [remote.data]);

  // Follow the computer's light/dark setting while "system" is chosen.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const mode = resolveMode(prefs.theme, systemDark);
  useLayoutEffect(() => {
    applyTheme(document.documentElement, prefs, systemDark);
    writeCachedThemeVars(prefs);
  }, [prefs, systemDark]);

  // Don't lose a queued change when the tab closes.
  useEffect(() => {
    const onHide = () => void writerRef.current?.flush();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  const setPrefs = useCallback(
    (changes: Partial<Preferences>) => {
      setPrefsState((cur) => {
        const next = { ...cur, ...changes };
        writeCachedPreferences(next);
        return next;
      });
      if (userId !== null) writerRef.current?.queue(changes);
    },
    [userId],
  );

  const value = useMemo<PrefsContextValue>(
    () => ({
      prefs,
      mode,
      setPrefs,
      syncedToAccount: userId !== null,
      updatedAt,
      ready: !me.isLoading && (userId === null || remote.isSuccess || remote.isError),
    }),
    [prefs, mode, setPrefs, userId, updatedAt, me.isLoading, remote.isSuccess, remote.isError],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePreferences(): PrefsContextValue {
  // Outside the provider (isolated component tests) the defaults apply.
  return useContext(PrefsContext) ?? FALLBACK;
}
