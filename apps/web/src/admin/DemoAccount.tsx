// Admin › Settings › Demo account: anyone can try the site from the sign-in
// page, in a private demo space of their own (a copy of the samples). Off by
// default. Each space lasts a set time from when it was made (1 hour unless
// changed here). The samples are put back on a timer (or now, with "Reset
// now"); that never ends a visitor's space. The most spaces at once is set
// here, next to how many there are now, with how much one space may hold
// and how many one network address may open (two usage limits, kept here).

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { RESET_CHOICES, SPACE_LIFETIME_CHOICES, timeUntil } from '../demo/demoText';
import { HelpButton } from '../help/HelpButton';
import type { WebOnlyHelpKey } from '../help/webOnlyHelpTexts';
import { formatLimit, limitsApi, toInput, toStored, type GlobalLimit } from './limits/limitsApi';

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
        upload parts. Each space lasts a set time from when it was made, then it is deleted. The samples are put back on a timer.
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
      <DemoLimits />
      <p className="text-xs text-muted" data-testid="demo-sign-in-note">
        Putting the samples back never cuts a visit short. When a space’s time is up, its visitor is signed out and their page offers to start again.
      </p>
      <fieldset className="space-y-1 text-sm" data-testid="demo-lifetime">
        <legend className="mb-1 flex items-center gap-1 text-xs text-muted">
          Each demo space lasts
          <HelpButton helpKey="admin.demoLifetime" target='[data-testid="demo-lifetime"]' />
        </legend>
        <div className="flex flex-wrap gap-4">
          {SPACE_LIFETIME_CHOICES.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="demo-space-minutes"
                checked={(demo.spaceMinutes ?? 60) === value}
                disabled={save.isPending}
                onChange={() => save.mutate({ demoSpaceMinutes: value })}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-1 text-sm">
        <legend className="mb-1 text-xs text-muted">Put the samples back every</legend>
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

/** The demo's two usage limits, with their ⓘ. */
const DEMO_LIMITS: Array<{ key: string; help: WebOnlyHelpKey }> = [
  { key: 'storagePerDemoSpace', help: 'admin.demoStorage' },
  { key: 'demoSpacesPerAddress', help: 'admin.demoPerAddress' },
];

/** How much one demo space may hold, and how many one address may open: saved like the other usage limits. */
function DemoLimits() {
  const qc = useQueryClient();
  const limits = useQuery({ queryKey: ['admin-limits'], queryFn: limitsApi.global });
  const save = useMutation({
    mutationFn: limitsApi.patchGlobal,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-limits'] }),
  });
  if (!limits.data) return null;
  return (
    <>
      {DEMO_LIMITS.map(({ key, help }) => {
        const l = limits.data.limits.find((x) => x.key === key);
        // `key` on the row: a value saved here (or by another admin) shows at once.
        return l ? <DemoLimit key={`${key}:${l.value}`} l={l} help={help} saving={save.isPending} onSave={(v) => save.mutate({ [key]: v })} /> : null;
      })}
      {save.error && <p className="text-xs text-danger">{save.error.message}</p>}
    </>
  );
}

function DemoLimit({ l, help, saving, onSave }: { l: GlobalLimit; help: WebOnlyHelpKey; saving: boolean; onSave: (v: number | null) => void }) {
  const id = `demo-limit-${l.key}`;
  const [draft, setDraft] = useState(toInput(l.value, l.unit));
  const stored = toStored(draft, l.unit);
  // Space: at least 1 MB, or a visitor couldn't save their first layout.
  const valid = stored !== null && !Number.isNaN(stored) && (l.unit !== 'bytes' || stored >= 1024 * 1024);
  const changed = valid && stored !== l.value;
  const origin = l.changedHere ? '' : l.fromEnv ? ` Set by ${l.envVar}.` : '';
  return (
    <div className="space-y-1" data-testid={id}>
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="text-sm">
          {l.label}
          {l.unit === 'bytes' ? ' (MB)' : ''}
        </label>
        <HelpButton helpKey={help} target={`[data-testid="${id}"]`} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={!valid}
          aria-describedby={`${id}-note`}
          className="w-24 rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink"
        />
        {changed && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave(stored === l.default ? null : stored)}
            className="tap-target rounded-lg bg-accent px-3 py-1 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
          >
            Save
          </button>
        )}
      </div>
      {!valid && <p className="text-xs text-danger">{l.unit === 'bytes' ? 'Choose 1 MB or more.' : 'Choose a whole number, 0 or more.'}</p>}
      <p id={`${id}-note`} className="text-xs text-muted">
        {l.help} Default: {formatLimit(l.default, l.unit)}.{origin}
      </p>
    </div>
  );
}
