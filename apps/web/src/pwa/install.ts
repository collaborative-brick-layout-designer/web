// Installing the web app (manifest.webmanifest): Chrome, Edge and Samsung
// Internet offer their own prompt, which we keep to show from Settings;
// Safari on iPhone and iPad installs from Share › Add to Home Screen.

import { useSyncExternalStore } from 'react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  | { kind: 'installed' }
  | { kind: 'prompt'; install: () => Promise<boolean> }
  | { kind: 'ios' }
  | { kind: 'firefox-android' }
  | { kind: 'firefox-desktop' }
  | { kind: 'browser-menu' };

let deferred: InstallPromptEvent | null = null;
let justInstalled = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Start listening for the browser's install offer; call once at startup. */
export function listenForInstall(win: Window = window): void {
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // shown from Settings instead of a mini-bar
    deferred = e as InstallPromptEvent;
    notify();
  });
  win.addEventListener('appinstalled', () => {
    deferred = null;
    justInstalled = true;
    notify();
  });
}

/** Running as the installed app, not in a browser tab. */
export function runningInstalled(win: Window = window): boolean {
  return (
    justInstalled ||
    win.matchMedia?.('(display-mode: standalone)').matches === true ||
    (win.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone or iPad (iPadOS reports itself as a Mac with touch). */
export function isAppleMobile(nav: Navigator = navigator): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
}

/**
 * A phone or tablet: a mobile browser, an iPad, or a touch-only screen.
 * Installing the app is offered there only.
 */
export function isMobileDevice(win: Window = window): boolean {
  const ua = win.navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/.test(ua) || isAppleMobile(win.navigator)) return true;
  // A touch screen with no mouse at all (no fine pointer, no hover).
  return win.matchMedia?.('(pointer: coarse)').matches === true && win.matchMedia?.('(any-pointer: fine)').matches !== true;
}

export function installState(win: Window = window): InstallState {
  if (runningInstalled(win)) return { kind: 'installed' };
  if (deferred) {
    const event = deferred;
    return {
      kind: 'prompt',
      install: async () => {
        await event.prompt();
        const { outcome } = await event.userChoice;
        deferred = null;
        if (outcome === 'accepted') justInstalled = true;
        notify();
        return outcome === 'accepted';
      },
    };
  }
  if (isAppleMobile(win.navigator)) return { kind: 'ios' };
  // Firefox never offers its own prompt: on Android it installs from the
  // menu; on a computer it doesn't install web apps.
  if (/Firefox\//.test(win.navigator.userAgent)) {
    return /Android/.test(win.navigator.userAgent) ? { kind: 'firefox-android' } : { kind: 'firefox-desktop' };
  }
  return { kind: 'browser-menu' };
}

let snapshot: InstallState | null = null;
function subscribe(l: () => void) {
  const wrapped = () => {
    snapshot = null;
    l();
  };
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}
function getSnapshot(): InstallState {
  return (snapshot ??= installState());
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Test hook: forget any captured offer. */
export function resetInstallForTests(): void {
  deferred = null;
  justInstalled = false;
  snapshot = null;
}

const REPORTED_KEY = 'cld-display-reported';

/**
 * Tell the server, once a day per browser, whether this copy runs as the
 * installed app or in a browser tab. The server counts it per person
 * per day for the admin dashboard (aggregate only; signed-out loads are
 * ignored). Failures don't matter.
 */
export function reportDisplayMode(win: Window = window): void {
  const display = runningInstalled(win) ? 'standalone' : 'browser';
  // The server counts each person once a day, so a browser that has said it
  // today stays quiet: one beacon per page load ran into the rate limit.
  const stamp = `${new Date().toISOString().slice(0, 10)}:${display}`;
  try {
    if (win.localStorage.getItem(REPORTED_KEY) === stamp) return;
  } catch {
    /* storage blocked: send it anyway */
  }
  try {
    void win
      .fetch('/api/metrics/client', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display }),
        keepalive: true,
      })
      .then((res) => {
        // 204 means it was counted (signed in); a signed-out load (202)
        // tries again next time.
        if (res.status !== 204) return;
        try {
          win.localStorage.setItem(REPORTED_KEY, stamp);
        } catch {
          /* storage blocked */
        }
      })
      .catch(() => undefined);
  } catch {
    /* offline or blocked */
  }
}
