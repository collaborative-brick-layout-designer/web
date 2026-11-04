// Admin › Settings › Demo account: one shared account anyone can try from
// the sign-in page. Off by default. It resets itself on a timer (or now,
// with "Reset now"): everything it made is deleted and the samples come back.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { RESET_CHOICES, timeUntil } from '../demo/demoText';

export function DemoAccountSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: api.admin.settings });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-settings'] });
  const save = useMutation({ mutationFn: api.admin.patchSettings, onSuccess: refresh });
  const reset = useMutation({ mutationFn: api.admin.resetDemo, onSuccess: refresh });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const demo = settings.data?.demo;
  if (!demo) return null;
  const error = save.error ?? reset.error;
  return (
    <section className="space-y-3" aria-labelledby="demo-settings">
      <h2 id="demo-settings" className="text-sm font-semibold text-neutral-300">Demo account</h2>
      <p className="text-xs text-muted">
        One shared account anyone can try from the sign-in page, without signing up. It can build, edit and export layouts, venues
        and modules, but can’t invite, share, join clubs or upload parts. Everything it makes is deleted and the samples put back on a timer.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={demo.enabled}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ demoEnabled: e.target.checked })}
        />
        Enable the demo account
      </label>
      <p className="text-xs text-muted">Turning it off signs every demo visitor out and hides “Try the demo”.</p>
      <p className="text-xs text-muted" data-testid="demo-sign-in-note">
        Demo sign-ins end at each demo reset (at most 24 hours): every reset signs the visitors out, and their page offers to start again.
      </p>
      <fieldset className="space-y-1 text-sm">
        <legend className="mb-1 text-xs text-muted">Reset it every</legend>
        <div className="flex flex-wrap gap-4">
          {RESET_CHOICES.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="demo-reset-every"
                checked={demo.resetEvery === value}
                disabled={save.isPending}
                onChange={() => save.mutate({ demoResetEvery: value })}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!demo.enabled || reset.isPending}
          onClick={() => reset.mutate()}
          className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft disabled:opacity-50"
        >
          {reset.isPending ? 'Resetting…' : 'Reset now'}
        </button>
        <p className="text-xs text-muted" data-testid="demo-last-reset">
          {demo.lastResetAt ? `Last reset ${new Date(demo.lastResetAt).toLocaleString()}` : 'Not reset yet'}
          {demo.enabled && demo.nextResetAt !== null ? ` · next in ${timeUntil(demo.nextResetAt, now)}` : ''}
          {` · ${demo.items} ${demo.items === 1 ? 'thing' : 'things'} in it now`}
        </p>
      </div>
      {error && <p className="text-xs text-danger">{error.message}</p>}
    </section>
  );
}
