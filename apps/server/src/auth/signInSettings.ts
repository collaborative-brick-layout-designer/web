// Admin › Settings › Sign-in: how long a sign-in lasts, on the website
// (the session cookie) and in the desktop app (its API token). Two numbers
// each:
//   - the idle window: a sign-in nobody uses for this long ends. Each use
//     pushes it back (sliding), so an active person stays signed in;
//   - the longest a sign-in can last, counted from when it was made, used
//     or not ("never" allowed): then the person signs in again.
// Stored as one JSON object in platform_settings.sign_in, in hours. For
// each setting, first match wins:
//   1. its SIGN_IN_* env var (e.g. 30d, 12h, never): it forces the value,
//      and the settings page says "Forced by …"
//   2. what an admin saved in Admin › Settings
//   3. the built-in default below
// Read live (a short cache, cleared on save). A change applies to every
// existing sign-in at its next check; saving never signs anyone out by
// itself. Demo sign-ins aren't set here: they end with their demo space, and
// after 24 hours at most (demo/demoAccount.ts).

import { getPlatformSettings } from './platformSettings.js';

export type SignInKey = 'webIdleHours' | 'webMaxHours' | 'desktopIdleHours' | 'desktopMaxHours';
/** Hours, or 'never' (only for the longest a sign-in can last). */
export type SignInValue = number | 'never';

export interface SignInSettingInfo {
  key: SignInKey;
  app: 'web' | 'desktop';
  kind: 'idle' | 'max';
  label: string;
  /** One plain sentence for the settings page. */
  help: string;
  /** Hours. */
  builtIn: number;
  /** Hours. */
  min: number;
  /** Hours. */
  max: number;
  /** Whether "never" is a choice. */
  allowNever: boolean;
  envVar: string;
}

const DAY_HOURS = 24;
const IDLE_CEILING = 365 * DAY_HOURS;
const MAX_CEILING = 3650 * DAY_HOURS;

export const SIGN_IN_SETTINGS: readonly SignInSettingInfo[] = [
  {
    key: 'webIdleHours',
    app: 'web',
    kind: 'idle',
    label: 'Sign out when not used for',
    help: 'Every visit starts this over, so people who keep using the site stay signed in.',
    builtIn: 30 * DAY_HOURS,
    min: 1,
    max: IDLE_CEILING,
    allowNever: false,
    envVar: 'SIGN_IN_WEB_IDLE',
  },
  {
    key: 'webMaxHours',
    app: 'web',
    kind: 'max',
    label: 'Sign in again after at most',
    help: 'Even someone who visits every day signs in again after this long.',
    builtIn: 90 * DAY_HOURS,
    min: 1,
    max: MAX_CEILING,
    allowNever: true,
    envVar: 'SIGN_IN_WEB_MAX',
  },
  {
    key: 'desktopIdleHours',
    app: 'desktop',
    kind: 'idle',
    label: 'Sign out when not used for',
    help: 'Every time the desktop app talks to this site it starts this over.',
    builtIn: 90 * DAY_HOURS,
    min: 1,
    max: IDLE_CEILING,
    allowNever: false,
    envVar: 'SIGN_IN_DESKTOP_IDLE',
  },
  {
    key: 'desktopMaxHours',
    app: 'desktop',
    kind: 'max',
    label: 'Sign in again after at most',
    help: 'Even a desktop app in daily use asks its owner to sign in again after this long. Work on the computer is kept.',
    builtIn: 180 * DAY_HOURS,
    min: 1,
    max: MAX_CEILING,
    allowNever: true,
    envVar: 'SIGN_IN_DESKTOP_MAX',
  },
];

const BY_KEY = new Map(SIGN_IN_SETTINGS.map((s) => [s.key, s]));

export function isSignInKey(k: string): k is SignInKey {
  return BY_KEY.has(k as SignInKey);
}

function inRange(info: SignInSettingInfo, v: unknown): v is SignInValue {
  if (v === 'never') return info.allowNever;
  return typeof v === 'number' && Number.isInteger(v) && v >= info.min && v <= info.max;
}

/** Keep only known keys with values in range. */
export function cleanSignIn(raw: unknown): Partial<Record<SignInKey, SignInValue>> {
  const out: Partial<Record<SignInKey, SignInValue>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isSignInKey(k) && inRange(BY_KEY.get(k)!, v)) out[k] = v;
  }
  return out;
}

/**
 * An env var's duration: "never", or a whole number of days ("30", "30d")
 * or hours ("12h"). Null when it isn't one of those.
 */
export function parseDuration(raw: string): SignInValue | null {
  const v = raw.trim().toLowerCase();
  if (v === 'never') return 'never';
  const m = /^(\d+)\s*([hd]?)$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'h' ? n : n * DAY_HOURS;
}

/** The env var's value when it is a duration in range, else null. */
export function forcedSignIn(info: SignInSettingInfo, source: NodeJS.ProcessEnv = process.env): SignInValue | null {
  const raw = source[info.envVar];
  if (raw === undefined || raw.trim() === '') return null;
  const v = parseDuration(raw);
  return v !== null && inRange(info, v) ? v : null;
}

export interface SignInSettingState extends SignInSettingInfo {
  /** What applies now. */
  value: SignInValue;
  /** What an admin saved (null: the default). Kept even while forced. */
  setting: SignInValue | null;
  /** The env var forcing it, or null. */
  forcedBy: string | null;
}

/** The rules in force, in milliseconds; max null = no longest. */
export interface SignInLimits {
  web: { idleMs: number; maxMs: number | null };
  desktop: { idleMs: number; maxMs: number | null };
}

const HOUR_MS = 60 * 60 * 1000;

/** The longest a demo sign-in lasts, whatever the reset timer says. */
export const DEMO_SIGN_IN_MAX_MS = 24 * HOUR_MS;

const CACHE_MS = 30_000;
let cache: { at: number; states: SignInSettingState[] } | null = null;

export function invalidateSignInCache(): void {
  cache = null;
}

function parse(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const atLeast = (max: SignInValue, idle: SignInValue): boolean => max === 'never' || idle === 'never' || max >= idle;

function resolve(stored: Partial<Record<SignInKey, SignInValue>>, source: NodeJS.ProcessEnv): SignInSettingState[] {
  const states = SIGN_IN_SETTINGS.map((info) => {
    const forced = forcedSignIn(info, source);
    const setting = stored[info.key] ?? null;
    return { ...info, value: forced ?? setting ?? info.builtIn, setting, forcedBy: forced === null ? null : info.envVar };
  });
  // A longest below the idle window (only env vars can do that, or an
  // env var forcing one side of a pair saved earlier): the window wins,
  // so a sign-in never ends before its idle time is up.
  for (const app of ['web', 'desktop'] as const) {
    const idle = states.find((s) => s.app === app && s.kind === 'idle')!;
    const max = states.find((s) => s.app === app && s.kind === 'max')!;
    if (!atLeast(max.value, idle.value)) max.value = idle.value;
  }
  return states;
}

/** Every sign-in setting with where its value comes from (Admin › Settings). */
export async function signInSettingStates(now: number = Date.now()): Promise<SignInSettingState[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.states;
  const states = resolve(cleanSignIn(parse((await getPlatformSettings()).signIn)), process.env);
  cache = { at: now, states };
  return states;
}

const ms = (v: SignInValue): number | null => (v === 'never' ? null : v * HOUR_MS);

/** The rules in force now. */
export async function signInLimits(now: number = Date.now()): Promise<SignInLimits> {
  const states = await signInSettingStates(now);
  const get = (key: SignInKey) => states.find((s) => s.key === key)!.value;
  return {
    web: { idleMs: ms(get('webIdleHours')) ?? Infinity, maxMs: ms(get('webMaxHours')) },
    desktop: { idleMs: ms(get('desktopIdleHours')) ?? Infinity, maxMs: ms(get('desktopMaxHours')) },
  };
}

/**
 * For a sign-in made at `createdAt` and used `now`: when it ends if this
 * use pushes it back (`slid`, never past the longest), and the longest
 * (`cap`, Infinity when there is none).
 */
export function signInEnd(
  rule: { idleMs: number; maxMs: number | null },
  createdAt: number,
  now: number,
): { slid: number; cap: number } {
  const cap = rule.maxMs === null ? Infinity : createdAt + rule.maxMs;
  return { slid: Math.min(now + rule.idleMs, cap), cap };
}

/**
 * Merge an admin's patch into what is stored: a value sets a key, null
 * puts it back to the default. The longest must be at least the idle
 * window, for what applies afterwards (env vars included). Returns the
 * new JSON, or an error naming the first bad key.
 */
export function mergeSignInPatch(
  storedJson: string | null,
  patch: unknown,
  source: NodeJS.ProcessEnv = process.env,
): { json: string } | { error: string } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'invalid_sign_in' };
  const next: Partial<Record<SignInKey, SignInValue>> = { ...cleanSignIn(parse(storedJson)) };
  for (const [k, v] of Object.entries(patch)) {
    if (!isSignInKey(k)) return { error: `invalid_sign_in_key:${k}` };
    if (v === null) delete next[k];
    else if (inRange(BY_KEY.get(k)!, v)) next[k] = v;
    else return { error: `invalid_sign_in_value:${k}` };
  }
  // Check what would apply, before the window-wins fix-up in resolve().
  const raw = SIGN_IN_SETTINGS.map((info) => ({ info, value: forcedSignIn(info, source) ?? next[info.key] ?? info.builtIn }));
  for (const app of ['web', 'desktop'] as const) {
    const idle = raw.find((r) => r.info.app === app && r.info.kind === 'idle')!;
    const max = raw.find((r) => r.info.app === app && r.info.kind === 'max')!;
    if (!atLeast(max.value, idle.value)) return { error: `sign_in_max_below_idle:${app}` };
  }
  return { json: JSON.stringify(next) };
}
