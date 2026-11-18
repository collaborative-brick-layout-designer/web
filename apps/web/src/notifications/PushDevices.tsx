// Pop-ups on your devices (Settings › Notifications): turn them on or off in
// this browser, and see and remove every browser that gets them. Plus the
// one-time offer in the bell's panel, and the bridge that moves the app to
// a notification's page when its pop-up is clicked.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { currentSubscription, disablePush, enablePush, permission, pushSupported, thisBrowserId } from './push';
import { timeAgo } from './model';

/** Which of the server's devices is this browser (same push service, and this browser has a subscription). */
function useThisBrowser() {
  return useQuery({
    queryKey: ['push-devices', 'this-browser'],
    queryFn: async () => {
      const sub = await currentSubscription();
      return sub ? new URL(sub.endpoint).hostname : null;
    },
    enabled: pushSupported(),
  });
}

export function usePushDevices(enabled: boolean) {
  return useQuery({ queryKey: ['push-devices'], queryFn: api.push.list, enabled });
}

export function PushDevices() {
  const qc = useQueryClient();
  const devices = usePushDevices(true);
  const here = useThisBrowser();
  const on = useMutation({
    mutationFn: enablePush,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['push-devices'] }),
  });
  const off = useMutation({
    mutationFn: () => disablePush(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['push-devices'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.push.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['push-devices'] }),
  });
  const list = devices.data?.subscriptions ?? [];
  const thisOn = !!here.data;
  const perm = permission();
  const error = (on.error ?? off.error ?? remove.error) as Error | null;

  return (
    <div className="flex flex-col gap-3" data-testid="push-devices">
      <div className="flex items-center justify-between gap-6">
        <div>
          <div className="text-[15px] font-semibold">Pop-ups in this browser</div>
          <div className="text-sm text-muted">
            {perm === 'unsupported'
              ? 'This browser can’t show pop-up notifications. On an iPhone or iPad, add this site to your Home Screen first.'
              : perm === 'denied'
                ? 'Your browser is blocking notifications from this site. Allow them in the browser’s site settings, then turn this on.'
                : thisOn
                  ? 'On. You get a pop-up for the kinds of notifications with “Pop-up” on, even with the site closed.'
                  : 'Get a pop-up from your browser for the kinds of notifications with “Pop-up” on.'}
          </div>
        </div>
        {perm !== 'unsupported' && (
          <button
            type="button"
            disabled={on.isPending || off.isPending || perm === 'denied'}
            onClick={() => (thisOn ? off.mutate() : on.mutate())}
            className={`tap-target shrink-0 rounded-control px-3 py-1.5 text-sm font-semibold disabled:opacity-60 ${thisOn ? 'border border-border hover:bg-soft' : 'bg-accent text-accent-ink hover:bg-accent-hover'}`}
          >
            {thisOn ? 'Turn off here' : 'Turn on here'}
          </button>
        )}
      </div>
      {list.length > 0 && (
        <ul className="divide-y divide-line rounded-control border border-line text-sm">
          {list.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2" data-testid="push-device">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  {d.name}
                  {d.id === thisBrowserId() && <span className="font-normal text-muted"> (this browser)</span>}
                </span>
                <span className="block text-xs text-muted">
                  Added {new Date(d.createdAt).toLocaleDateString()}
                  {d.lastUsedAt ? ` · last pop-up ${timeAgo(d.lastUsedAt)}` : ''}
                </span>
              </span>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate(d.id)}
                aria-label={`Remove ${d.name}`}
                className="tap-target rounded-control border border-border px-2 py-1 text-xs font-semibold hover:bg-soft disabled:opacity-60"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-danger">{error.message}</p>}
    </div>
  );
}

const PROMPT_KEY = 'cbld-push-prompt-dismissed';

function promptDismissed(): boolean {
  try {
    return localStorage.getItem(PROMPT_KEY) === '1';
  } catch {
    return true;
  }
}

/** The bell panel's one-time offer: only when the site has push, the browser can, and nobody answered yet. Never on page load. */
export function PushPrompt() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['notification-settings'], queryFn: api.notifications.settings });
  const here = useThisBrowser();
  const [hidden, setHidden] = useState(promptDismissed);
  const on = useMutation({ mutationFn: enablePush, onSuccess: () => void qc.invalidateQueries({ queryKey: ['push-devices'] }) });
  const dismiss = () => {
    try {
      localStorage.setItem(PROMPT_KEY, '1');
    } catch {
      // Private window: it asks again next time the panel opens.
    }
    setHidden(true);
  };
  if (hidden || !settings.data?.pushAvailable || !pushSupported() || permission() !== 'default' || here.isLoading || here.data) return null;
  if (on.isSuccess) return null;
  return (
    <div className="border-b border-line bg-soft px-3 py-2 text-sm" data-testid="push-prompt">
      <p className="font-semibold">Get a pop-up when something waits for you?</p>
      <p className="text-xs text-muted">Your browser shows it even with the site closed. Change it any time in Settings › Notifications.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={on.isPending} onClick={() => on.mutate(undefined, { onSettled: dismiss })} className="tap-target rounded-control bg-accent px-3 py-1 text-xs font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-60">
          Turn on
        </button>
        <button type="button" onClick={dismiss} className="tap-target rounded-control border border-border px-3 py-1 text-xs font-semibold hover:bg-soft">
          Not now
        </button>
      </div>
      {on.isError && <p className="mt-1 text-xs text-danger">{(on.error as Error).message}</p>}
    </div>
  );
}

/** A clicked pop-up asks the open tab to show its page (sw.js): the app moves there without a reload. */
export function PushBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!pushSupported()) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; path?: unknown } | null;
      if (d?.type === 'cbld-open' && typeof d.path === 'string' && d.path.startsWith('/') && !d.path.startsWith('//')) navigate(d.path);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);
  return null;
}
