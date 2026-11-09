import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { plural } from '../ui/plural';

/**
 * Profile › Password: change it with the current one. Every other
 * browser and desktop app is signed out; this one stays signed in.
 */
export function ChangePasswordForm() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.changePassword(current, password),
    onSuccess: (res) => {
      setCurrent('');
      setPassword('');
      setConfirm('');
      const others = [res.signedOutBrowsers ? plural(res.signedOutBrowsers, 'other browser') : '', res.signedOutDesktops ? plural(res.signedOutDesktops, 'desktop app') : ''].filter(Boolean);
      setDone(`Password changed. You’re still signed in here${others.length ? `; ${others.join(' and ')} signed out` : ''}.`);
      // The Devices list shows the desktop apps as signed out at once.
      void qc.invalidateQueries({ queryKey: ['api-tokens'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setDone(null);
        if (password.length < 8) return setError('Use at least 8 characters for the new password.');
        if (password !== confirm) return setError('The two new passwords don’t match.');
        save.mutate();
      }}
      className="space-y-2"
      data-testid="change-password"
    >
      <input
        type="password"
        aria-label="Current password"
        placeholder="Current password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        required
        autoComplete="current-password"
        className="w-full rounded-lg border border-border bg-soft px-3 py-2"
      />
      <input
        type="password"
        aria-label="New password"
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={8}
        maxLength={128}
        autoComplete="new-password"
        className="w-full rounded-lg border border-border bg-soft px-3 py-2"
      />
      <input
        type="password"
        aria-label="New password again"
        placeholder="New password again"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
        minLength={8}
        maxLength={128}
        autoComplete="new-password"
        className="w-full rounded-lg border border-border bg-soft px-3 py-2"
      />
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="text-sm text-ok" role="status">
          {done}
        </p>
      )}
      <button type="submit" disabled={save.isPending} className="rounded-lg bg-accent px-4 py-2 text-sm text-accent-ink hover:bg-accent-hover disabled:opacity-50">
        {save.isPending ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}
