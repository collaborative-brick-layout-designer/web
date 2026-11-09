// "What should we call you?" — asked after signing in when someone has no
// name yet, or their name is an email address (older accounts got their
// email as their name, and names are shown to other people). They can
// skip it; it asks again the next time they sign in. Until they pick a
// name, other people see "Builder #abc123" (the server never shows an
// email-looking name to anyone else).

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { HelpButton } from '../help/HelpButton';
import { useEscape } from '../editor/useEscape';

const SKIP_KEY = 'cld.namePrompt.skipped';

function skipped(userId: string): boolean {
  try {
    return sessionStorage.getItem(SKIP_KEY) === userId;
  } catch {
    return false;
  }
}

function rememberSkip(userId: string): void {
  try {
    sessionStorage.setItem(SKIP_KEY, userId);
  } catch {
    /* private window: it just asks again on the next page load */
  }
}

/** Signing out forgets "Not now", so the next sign-in asks again. */
export function forgetNamePromptSkip(): void {
  try {
    sessionStorage.removeItem(SKIP_KEY);
  } catch {
    /* nothing to forget */
  }
}

/** Pages where the prompt would get in the way of signing in or out. */
const QUIET = /^\/(login|verify-email|reset-password|link|device)\b/;

export function NamePrompt() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const location = useLocation();
  const user = me.data?.user;
  const [closedFor, setClosedFor] = useState<string | null>(null);
  if (!user?.needsName || user.isDemoAccount || QUIET.test(location.pathname)) return null;
  if (closedFor === user.id || skipped(user.id)) return null;
  return <NameDialog key={user.id} suggestion={user.suggestedName ?? ''} onSkip={() => { rememberSkip(user.id); setClosedFor(user.id); }} />;
}

function NameDialog({ suggestion, onSkip }: { suggestion: string; onSkip: () => void }) {
  useEscape(onSkip);
  const [name, setName] = useState(suggestion);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  // Refetching 'me' closes this; the server tells other tabs and people
  // (club lists, the catalog, share lists) to refetch the new name too.
  const save = useMutation({
    mutationFn: (n: string) => api.updateDisplayName(n),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
    onError: (e: Error) => setError(e.message),
  });
  const trimmed = name.trim();
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-prompt-title"
        data-testid="name-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (trimmed.includes('@')) {
            setError('Other people see your name, so it can’t be an email address. Try your first name or a nickname.');
            return;
          }
          if (trimmed) save.mutate(trimmed);
        }}
        className="w-full max-w-md space-y-3 rounded-card border border-line bg-panel p-5 text-ink shadow-pop"
      >
        <h2 id="name-prompt-title" className="font-display text-lg font-semibold">What should we call you?</h2>
        <p className="text-sm text-muted">
          Pick the name other people see when you share or build together. Your email address stays private.
        </p>
        <div>
          <div className="mb-1 flex items-center gap-1 text-sm text-muted">
            <label htmlFor="name-prompt-input">Your name (shown to others)</label>
            <HelpButton helpKey="account.publicName" target="#name-prompt-input" />
          </div>
          <input
            id="name-prompt-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoComplete="nickname"
            placeholder="e.g. Sam, or Sam from ArkLUG"
            className="w-full rounded-lg border border-border bg-soft px-3 py-2"
          />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button type="button" onClick={onSkip} className="tap-target text-sm text-muted hover:underline">
            Not now
          </button>
          <button
            type="submit"
            disabled={save.isPending || !trimmed}
            className="tap-target rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
          >
            Save name
          </button>
        </div>
      </form>
    </div>
  );
}
