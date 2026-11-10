// Admin › Settings › Sign-in: how long people stay signed in, on the
// website and in the desktop app. Two numbers each: how long a sign-in
// lasts unused, and the longest it can last however much it is used
// ("never" allowed). A server env var may force one, and then the page
// says so. A change applies at each sign-in's next check; saving signs
// nobody out. Demo sign-ins always end at each demo reset.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SignInSettingState, type SignInValue } from '../api';
import { HelpButton } from '../help/HelpButton';

type Unit = 'days' | 'hours' | 'never';

/** "30 days", "12 hours", "1 day", "never". */
export function durationText(v: SignInValue): string {
  if (v === 'never') return 'never';
  if (v % 24 === 0) return v === 24 ? '1 day' : `${v / 24} days`;
  return v === 1 ? '1 hour' : `${v} hours`;
}

function draftOf(v: SignInValue): { amount: string; unit: Unit } {
  if (v === 'never') return { amount: '', unit: 'never' };
  return v % 24 === 0 ? { amount: String(v / 24), unit: 'days' } : { amount: String(v), unit: 'hours' };
}

/** The draft in hours ('never'), or why it can't be saved. */
export function checkDraft(
  s: Pick<SignInSettingState, 'min' | 'max' | 'allowNever'>,
  amount: string,
  unit: Unit,
): { value: SignInValue } | { error: string } {
  if (unit === 'never') return s.allowNever ? { value: 'never' } : { error: 'Pick a length of time.' };
  const n = Number(amount);
  if (amount.trim() === '' || !Number.isInteger(n)) return { error: 'Use a whole number.' };
  const hours = unit === 'days' ? n * 24 : n;
  if (hours < s.min) return { error: `At least ${durationText(s.min)}.` };
  if (hours > s.max) return { error: `At most ${durationText(s.max)}.` };
  return { value: hours };
}

/** Whether `a` is longer than `b` ("never" is longer than any time). */
const longer = (a: SignInValue, b: SignInValue): boolean => b !== 'never' && (a === 'never' || a > b);

function SettingRow({
  s,
  partner,
  onSave,
  saving,
}: {
  s: SignInSettingState;
  /** The other half of the pair (idle ↔ longest), as it applies now. */
  partner: SignInSettingState;
  onSave: (v: SignInValue | null) => void;
  saving: boolean;
}) {
  const start = draftOf(s.value);
  const [amount, setAmount] = useState(start.amount);
  const [unit, setUnit] = useState<Unit>(start.unit);
  const checked = checkDraft(s, amount, unit);
  // The longest can't be shorter than the time unused, nor the other way round.
  const clash =
    'value' in checked &&
    (s.kind === 'max' ? longer(partner.value, checked.value) : longer(checked.value, partner.value))
      ? s.kind === 'max'
        ? `Can’t be shorter than “${partner.label.toLowerCase()}” (${durationText(partner.value)}).`
        : `Can’t be longer than “${partner.label.toLowerCase()}” (${durationText(partner.value)}).`
      : null;
  const error = 'error' in checked ? checked.error : clash;
  const changed = 'value' in checked && checked.value !== s.value;
  const forced = !!s.forcedBy;
  const id = `sign-in-${s.key}`;
  return (
    <div className="space-y-1" data-testid={`sign-in-setting-${s.key}`}>
      <label htmlFor={id} className="block text-sm">
        {s.label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {unit !== 'never' && (
          <input
            id={id}
            type="number"
            min={1}
            inputMode="numeric"
            value={amount}
            disabled={forced}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={`${id}-help`}
            className="w-24 rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink disabled:opacity-50"
          />
        )}
        <select
          {...(unit === 'never' ? { id } : {})}
          aria-label={`${s.label}: unit`}
          value={unit}
          disabled={forced}
          onChange={(e) => {
            const next = e.target.value as Unit;
            // Coming back from "never": start from the default.
            if (unit === 'never' && next !== 'never' && amount === '') setAmount(next === 'days' ? String(Math.round(s.builtIn / 24)) : String(s.builtIn));
            setUnit(next);
          }}
          className="rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink disabled:opacity-50"
        >
          <option value="days">days</option>
          <option value="hours">hours</option>
          {s.allowNever && <option value="never">never (no longest)</option>}
        </select>
        {changed && !error && !forced && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave((checked as { value: SignInValue }).value)}
            className="tap-target rounded-lg bg-accent px-3 py-1 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
          >
            Save
          </button>
        )}
        {s.setting !== null && !forced && (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              const d = draftOf(s.builtIn);
              setAmount(d.amount);
              setUnit(d.unit);
              onSave(null);
            }}
            className="text-xs text-accent-text hover:underline"
          >
            Back to the default ({durationText(s.builtIn)})
          </button>
        )}
      </div>
      {error && !forced && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      <p id={`${id}-help`} className="text-xs text-muted">
        {s.help} Default: {durationText(s.builtIn)}.
      </p>
      {forced && (
        <p className="text-xs text-muted" data-testid={`sign-in-forced-${s.key}`}>
          Forced by the server setting <code>{s.forcedBy}</code> ({durationText(s.value)}). Remove it from the server’s settings to change it
          here.
        </p>
      )}
    </div>
  );
}

function Group({ title, rows, saving, onSave }: { title: string; rows: SignInSettingState[]; saving: boolean; onSave: (key: string, v: SignInValue | null) => void }) {
  const idle = rows.find((r) => r.kind === 'idle');
  const max = rows.find((r) => r.kind === 'max');
  if (!idle || !max) return null;
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-xs font-semibold text-muted">{title}</legend>
      {[idle, max].map((s) => (
        // The key resets the draft when the saved value changes.
        <SettingRow key={`${s.key}:${String(s.value)}`} s={s} partner={s === idle ? max : idle} saving={saving} onSave={(v) => onSave(s.key, v)} />
      ))}
    </fieldset>
  );
}

/**
 * The addresses to register with a GitHub OAuth app, a Google client or a
 * single sign-on provider, with this server's own site address filled in.
 */
function CallbackAddresses({ publicUrl }: { publicUrl: string }) {
  const base = publicUrl.replace(/\/$/, '');
  return (
    <div className="space-y-1" data-testid="sign-in-callbacks">
      <p>Signing in with GitHub, Google or single sign-on is set up on the server. Give the provider this callback address:</p>
      <ul className="space-y-0.5">
        {(['github', 'google', 'oidc'] as const).map((id) => (
          <li key={id}>
            <code className="break-all text-[12px]">{`${base}/api/auth/${id}/callback`}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SignInSettingsSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: api.admin.settings });
  const save = useMutation({
    mutationFn: (signIn: Record<string, SignInValue | null>) => api.admin.patchSettings({ signIn }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-settings'] }),
  });
  const rows = settings.data?.signIn?.settings;
  const publicUrl = settings.data?.signIn?.publicUrl ?? '';
  if (!rows) return null;
  const onSave = (key: string, v: SignInValue | null) => save.mutate({ [key]: v });
  return (
    <section className="space-y-4" aria-labelledby="sign-in-settings-title" data-testid="sign-in-settings">
      <div>
        <h2 id="sign-in-settings-title" className="flex items-center gap-1.5 text-sm font-semibold text-neutral-300">
          Sign-in
          <HelpButton helpKey="admin.signIn" target='[data-testid="sign-in-settings"]' extra={<CallbackAddresses publicUrl={publicUrl} />} />
        </h2>
        <p className="text-xs text-muted">
          How long people stay signed in. A change applies to everyone the next time they use the site; nobody is signed out when you save.
        </p>
      </div>
      <Group title="On the website" rows={rows.filter((r) => r.app === 'web')} saving={save.isPending} onSave={onSave} />
      <Group title="In the desktop app" rows={rows.filter((r) => r.app === 'desktop')} saving={save.isPending} onSave={onSave} />
      <p className="text-xs text-muted" data-testid="sign-in-demo">
        Demo visitors are signed out at each demo reset, and after 24 hours at most.
      </p>
      {save.isError && <p className="text-sm text-danger">{(save.error as Error).message}</p>}
    </section>
  );
}
