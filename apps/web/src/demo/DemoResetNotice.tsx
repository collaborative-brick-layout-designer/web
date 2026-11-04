// "The demo was reset. Start again?" Each demo reset signs every visitor
// out (and an admin turning the demo off does too). Instead of finding
// themselves on a sign-in screen, or an editor saying the layout isn't
// there, the visitor gets this, with one click back in. Shown when a page
// that was signed in to the demo finds itself signed out: at once when a
// reset hint refetches /api/auth/me or a live layout closes, and on the
// next visit when the tab was closed meanwhile. Signing out on purpose
// never shows it.

import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { forgetDemoVisitor, markDemoVisitor, SIGN_IN_ENDED_EVENT, wasDemoVisitor } from './demoVisitor';

export function DemoResetNotice() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  const known = me.data !== undefined;
  const userId = me.data?.user?.id ?? null;
  const isDemo = me.data?.user?.isDemoAccount === true;

  useEffect(() => {
    if (!known) return;
    if (isDemo) {
      markDemoVisitor();
      setOpen(false);
    } else if (userId) {
      // Signed in to a real account: not a demo visitor any more.
      forgetDemoVisitor();
      setOpen(false);
    } else if (wasDemoVisitor()) {
      setOpen(true);
    }
  }, [known, userId, isDemo]);

  // A live layout closed because its sign-in ended: find out whether it was the demo's.
  useEffect(() => {
    const onEnded = () => {
      if (wasDemoVisitor()) void qc.invalidateQueries({ queryKey: ['me'] });
    };
    window.addEventListener(SIGN_IN_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SIGN_IN_ENDED_EVENT, onEnded);
  }, [qc]);

  // Whether the demo is still on (an admin may have turned it off).
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers, enabled: open });
  const demoOff = providers.data !== undefined && !providers.data.demoEnabled;

  const again = useMutation({
    mutationFn: api.tryDemo,
    // A fresh page: the old one's layouts and lists were the demo's before the reset.
    onSuccess: () => window.location.assign('/'),
  });

  const notNow = () => {
    forgetDemoVisitor();
    setOpen(false);
    qc.clear();
    navigate('/login', { replace: true });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      notNow();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // notNow only closes and navigates; it needs no fresh copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 sm:items-center sm:p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="demo-reset-notice"
        className="w-full rounded-t-section border border-line bg-panel p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-sm text-ink shadow-pop sm:max-w-md sm:rounded-section sm:pb-5"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {demoOff ? 'The demo has ended' : 'The demo was reset. Start again?'}
        </h2>
        <p id={bodyId} className="mt-2 text-muted">
          {demoOff
            ? 'The demo isn’t available right now. Sign up or sign in to keep building.'
            : 'Everything in the demo went back to the start, so you were signed out. Start again to keep exploring, or sign up to keep what you make.'}
        </p>
        {again.error && <p className="mt-2 text-danger">{(again.error as Error).message}</p>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={notNow}
            className="tap-target min-h-11 rounded-lg border border-border px-4 py-2 hover:bg-soft pointer-fine:min-h-9"
          >
            {demoOff ? 'Sign in' : 'Not now'}
          </button>
          {!demoOff && (
            <button
              type="button"
              autoFocus
              disabled={again.isPending}
              onClick={() => again.mutate()}
              className="tap-target min-h-11 rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50 pointer-fine:min-h-9"
            >
              {again.isPending ? 'Opening the demo…' : 'Start again'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
