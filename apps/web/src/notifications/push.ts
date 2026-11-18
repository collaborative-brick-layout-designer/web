// Pop-ups in this browser (Web Push): whether it can, whether it's on here,
// and turning it on or off. The service worker (/sw.js) is registered only
// when someone turns pop-ups on.

import { api } from '../api';

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** 'granted' | 'denied' | 'default', or 'unsupported'. */
export function permission(): NotificationPermission | 'unsupported' {
  return pushSupported() ? Notification.permission : 'unsupported';
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

/** This browser's subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg ? await reg.pushManager.getSubscription() : null;
}

function keyBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Ask the browser, sign it up and tell the server. Returns the server's id for it. */
export async function enablePush(): Promise<string> {
  if (!pushSupported()) throw new Error('This browser can’t show pop-up notifications.');
  const key = await api.push.key();
  if (!key.enabled || !key.publicKey) throw new Error('Pop-up notifications are turned off on this site.');
  const asked = await Notification.requestPermission();
  if (asked !== 'granted') throw new Error(asked === 'denied' ? 'Your browser is blocking notifications from this site. Allow them in the browser’s site settings, then try again.' : 'Notifications weren’t allowed.');
  const reg = (await registration()) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.publicKey) as BufferSource });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  const saved = await api.push.subscribe({ endpoint: json.endpoint ?? sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } });
  try {
    localStorage.setItem(ID_KEY, saved.id);
  } catch {
    // Private window: "Turn off here" still unsubscribes the browser.
  }
  return saved.id;
}

const ID_KEY = 'cbld-push-id';

/** The server's id for this browser's subscription, when this browser remembers it. */
export function thisBrowserId(): string | null {
  try {
    return localStorage.getItem(ID_KEY);
  } catch {
    return null;
  }
}

/** Stop pop-ups in this browser (the server forgets it too, when `id` is given). */
export async function disablePush(id: string | null = thisBrowserId()): Promise<void> {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe().catch(() => undefined);
  if (id) await api.push.remove(id).catch(() => undefined);
  try {
    localStorage.removeItem(ID_KEY);
  } catch {
    // Nothing kept.
  }
}
