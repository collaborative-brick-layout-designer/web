// "Confirm your email": for a signed-in account that hasn't proven it owns
// its address (made while the site's email checks were off, say). Invites
// and hand-overs sent to the address wait for it. One button emails a link;
// opening it (verify-email) confirms the address, and every open tab
// updates through the live `me` hint, so the invite shows up by itself.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { api } from '../api';
import { HelpButton } from '../help/HelpButton';

interface Props {
  /** What waits for it, as the end of "Confirm your email to …", e.g. "accept this invite". */
  toDo: string;
  /** Smaller, for Home and Profile. */
  compact?: boolean;
  /** Where the emailed link goes on to; this page by default. */
  next?: string;
  /**
   * Offer "Not now", remembered in this browser under this key (Home, where
   * it would otherwise show on every visit). Profile always has it.
   */
  dismissKey?: string;
}

function readDismissed(key: string | undefined): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function ConfirmEmailPrompt({ toDo, compact = false, next, dismissKey }: Props) {
  const location = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: () => api.confirmEmail(next ?? `${location.pathname}${location.search}`),
    // Confirmed meanwhile (another tab): show it.
    onSuccess: (r) => {
      if (r.alreadyConfirmed) void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const [dismissed, setDismissed] = useState(() => readDismissed(dismissKey));
  const user = me.data?.user;
  if (!user || user.isDemoAccount || user.needsEmailConfirm !== true || dismissed) return null;
  const dismiss = () => {
    try {
      if (dismissKey) localStorage.setItem(dismissKey, '1');
    } catch {
      // Not remembered: it shows again next visit.
    }
    setDismissed(true);
  };

  const passwordOn = providers.data?.passwordEnabled !== false;
  const linked = (providers.data?.providers ?? []).filter((p) => p.enabled && user.linkedProviders.includes(p.id));
  const viaProvider = linked.length > 0 ? linked.map((p) => p.label).join(' or ') : null;

  return (
    <div
      data-testid="confirm-email"
      className={`relative rounded-lg border border-accent bg-accent-soft/40 text-sm text-ink ${compact ? 'p-3' : 'mt-3 p-4'}`}
    >
      <p className="pr-8 font-semibold">Confirm your email to {toDo}</p>
      <HelpButton helpKey="account.confirmEmail" className="absolute right-2 top-2" />
      <p className="mt-1 text-muted">
        Invites sent to <strong className="text-ink">{user.email}</strong> show up here once you’ve shown the address is yours.
      </p>
      {passwordOn && !send.data && (
        <button
          type="button"
          disabled={send.isPending}
          onClick={() => send.mutate()}
          className="tap-target mt-2 rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
        >
          {send.isPending ? 'Sending…' : 'Send me a confirmation email'}
        </button>
      )}
      {send.data?.sent && (
        <p role="status" className="mt-2">
          We sent a link to <strong>{user.email}</strong>. Open it while signed in to this account and this page updates by itself.
        </p>
      )}
      {send.data && !send.data.sent && !send.data.alreadyConfirmed && (
        <p role="status" className="mt-2 text-danger">
          This site couldn’t send the email. Ask the site admin to check its email settings, then try again.
        </p>
      )}
      {send.isError && <p className="mt-2 text-danger">{(send.error as Error).message}</p>}
      {viaProvider && (
        <p className="mt-2 text-xs text-muted">
          {passwordOn ? 'Or sign' : 'Sign'} out and back in with {viaProvider}: that confirms it too.
        </p>
      )}
      {!passwordOn && !viaProvider && (
        <p className="mt-2 text-xs text-muted">Ask the site admin how to confirm your email here.</p>
      )}
      {dismissKey && (
        <button type="button" onClick={dismiss} className="tap-target mt-1 text-xs text-muted underline underline-offset-2 hover:text-ink">
          Not now (you can confirm it any time from your Profile)
        </button>
      )}
    </div>
  );
}
