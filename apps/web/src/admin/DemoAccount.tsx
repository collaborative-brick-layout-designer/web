// Admin › Settings › Demo account: anyone can try the site from the sign-in
// page, in a private demo space of their own (a copy of the samples). Off by
// default. It resets itself on a timer (or now, with "Reset now"): every
// space is deleted and the samples come back. The most spaces at once is
// set here, next to how many there are now.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { RESET_CHOICES, timeUntil } from '../demo/demoText';
import { HelpButton } from '../help/HelpButton';

/** The most demo spaces at once an admin may set (the server checks the same). */
const MAX_SPACES_LIMIT = 10_000;

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
        Anyone can try the site from the sign-in page, without signing up. Each visitor gets a private demo space with their own
        copy of the samples. They can build, edit and export layouts, venues and modules, but can’t invite, share, join clubs or
        upload parts. Each space is deleted when its sign-in ends, and the samples are put back on a timer.
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
      <MaxSpaces
        key={demo.maxSpaces}
        value={demo.maxSpaces}
        live={demo.liveSpaces}
        saving={save.isPending}
        onSave={(n) => save.mutate({ demoMaxSpaces: n })}
      />
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

/** "Most demo spaces at once": a number with ⓘ, and how many there are now. */
function MaxSpaces({ value, live, saving, onSave }: { value: number; live: number; saving: boolean; onSave: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const n = Number(draft);
  const valid = /^\d+$/.test(draft.trim()) && n >= 1 && n <= MAX_SPACES_LIMIT;
  const changed = valid && n !== value;
  return (
    <div className="space-y-1" data-testid="demo-max-spaces">
      <div className="flex items-center gap-1">
        <label htmlFor="demo-max-spaces" className="text-sm">
          Most demo spaces at once
        </label>
        <HelpButton helpKey="admin.demoSpaces" target='[data-testid="demo-max-spaces"]' />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="demo-max-spaces"
          type="number"
          min={1}
          max={MAX_SPACES_LIMIT}
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={!valid}
          aria-describedby="demo-live-spaces"
          className="w-24 rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink"
        />
        {changed && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave(n)}
            className="tap-target rounded-lg bg-accent px-3 py-1 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
          >
            Save
          </button>
        )}
      </div>
      {!valid && <p className="text-xs text-danger">Choose a whole number from 1 to {MAX_SPACES_LIMIT.toLocaleString()}.</p>}
      <p id="demo-live-spaces" className="text-xs text-muted" data-testid="demo-live-spaces">
        {live === 1 ? '1 demo space in use now' : `${live} demo spaces in use now`}
      </p>
    </div>
  );
}
