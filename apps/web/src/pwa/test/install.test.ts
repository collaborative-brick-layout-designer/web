// Installing the web app: the browser's offer is kept for Settings, an
// iPhone gets the Share › Add to Home Screen steps, and an installed app
// says so.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installState, isAppleMobile, isMobileDevice, listenForInstall, reportDisplayMode, resetInstallForTests } from '../install';

import manifestText from '../../../public/manifest.webmanifest?raw';
import indexHtml from '../../../index.html?raw';

// Every file in public/, by its URL path.
const publicFiles = new Set(Object.keys(import.meta.glob('../../../public/*')).map((p) => p.replace('../../../public', '')));

function fakeWindow(opts: { ua?: string; standalone?: boolean; touch?: number; media?: string[] } = {}) {
  const target = new EventTarget();
  return Object.assign(target, {
    navigator: { userAgent: opts.ua ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', maxTouchPoints: opts.touch ?? 0 },
    matchMedia: (q: string) => ({
      matches: (q === '(display-mode: standalone)' && !!opts.standalone) || (opts.media ?? []).includes(q),
    }),
  }) as unknown as Window;
}

function offer(outcome: 'accepted' | 'dismissed') {
  const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  e.prompt = vi.fn(async () => {});
  e.userChoice = Promise.resolve({ outcome });
  return e;
}

afterEach(resetInstallForTests);

describe('install the app', () => {
  it("keeps the browser's offer for Settings and installs from it", async () => {
    const win = fakeWindow();
    listenForInstall(win);
    expect(installState(win).kind).toBe('browser-menu');
    const e = offer('accepted');
    win.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true); // no mini-bar; Settings shows it
    const state = installState(win);
    expect(state.kind).toBe('prompt');
    if (state.kind !== 'prompt') return;
    expect(await state.install()).toBe(true);
    expect(e.prompt).toHaveBeenCalled();
    expect(installState(win).kind).toBe('installed');
  });

  it('offers again later when turned down', async () => {
    const win = fakeWindow();
    listenForInstall(win);
    win.dispatchEvent(offer('dismissed'));
    const state = installState(win);
    if (state.kind !== 'prompt') throw new Error(state.kind);
    expect(await state.install()).toBe(false);
    expect(installState(win).kind).toBe('browser-menu');
  });

  it('says installed when running as the app, and gives iPhone and iPad the Share steps', () => {
    expect(installState(fakeWindow({ standalone: true })).kind).toBe('installed');
    expect(installState(fakeWindow({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).kind).toBe('ios');
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 } as Navigator)).toBe(true);
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 } as Navigator)).toBe(false);
  });

  it('tells Firefox users what their Firefox can do', () => {
    expect(installState(fakeWindow({ ua: 'Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0' })).kind).toBe('firefox-android');
    expect(installState(fakeWindow({ ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0' })).kind).toBe('firefox-desktop');
    // An offer still wins, should a Firefox ever make one.
    const win = fakeWindow({ ua: 'Mozilla/5.0 (Windows NT 10.0; rv:150.0) Gecko/20100101 Firefox/150.0' });
    listenForInstall(win);
    win.dispatchEvent(offer('accepted'));
    expect(installState(win).kind).toBe('prompt');
  });

  it('offers installing on phones and tablets only', () => {
    expect(isMobileDevice(fakeWindow({ ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 7) Chrome/140 Mobile Safari/537.36' }))).toBe(true);
    expect(isMobileDevice(fakeWindow({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }))).toBe(true);
    expect(isMobileDevice(fakeWindow({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', touch: 5 }))).toBe(true); // iPad
    expect(isMobileDevice(fakeWindow())).toBe(false); // a computer
    // A touch-only tablet that hides its make; a touch laptop still has a mouse.
    expect(isMobileDevice(fakeWindow({ media: ['(pointer: coarse)'] }))).toBe(true);
    expect(isMobileDevice(fakeWindow({ media: ['(pointer: coarse)', '(any-pointer: fine)'] }))).toBe(false);
  });

  it('has a manifest browsers accept, with every icon it lists', () => {
    const m = JSON.parse(manifestText) as {
      name: string;
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; purpose: string }[];
    };
    expect(m.name).toBeTruthy();
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
    // Chrome needs a 192 and a 512 icon; Android masks the maskable ones.
    expect(m.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const i of m.icons) expect(publicFiles.has(i.src), i.src).toBe(true);
    const html = indexHtml;
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon"');
  });
});

describe('the once-a-day display beacon', () => {
  function beaconWindow(status: number) {
    const store = new Map<string, string>();
    const fetch = vi.fn(async () => ({ status }) as Response);
    const win = Object.assign(fakeWindow(), {
      fetch,
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    }) as unknown as Window;
    return { win, fetch };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('sends once a day after it was counted, so page loads never hit the rate limit', async () => {
    const { win, fetch } = beaconWindow(204);
    for (let i = 0; i < 5; i++) {
      reportDisplayMode(win);
      await settle();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next load while signed out (not counted)', async () => {
    const { win, fetch } = beaconWindow(202);
    reportDisplayMode(win);
    await settle();
    reportDisplayMode(win);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
