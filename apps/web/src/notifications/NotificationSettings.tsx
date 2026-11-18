// Settings › Notifications: per category (each row opens to its types), in
// the app / email / push for each type; quiet hours in your time zone; when
// summaries go; per club; pause all. Every change is saved at once
// (PUT /api/me/notification-settings) and shows in every tab.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type NotificationCategory, type NotificationSettingsView, type NotificationEmailMode } from '../api';
import { CATEGORY_LABEL } from './model';
import { PushDevices } from './PushDevices';

const EMAIL_LABEL: Record<NotificationEmailMode, string> = { now: 'Right away', daily: 'Daily summary', weekly: 'Weekly summary', off: 'Off' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const field = 'rounded-control border border-border bg-soft px-2 py-1 text-sm text-ink disabled:opacity-60';

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex shrink-0 items-center justify-center rounded-full disabled:opacity-50"
    >
      <span aria-hidden className={`relative block h-7 w-12 rounded-full transition-colors group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent ${checked ? 'bg-accent' : 'bg-border'}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-[left] ${checked ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}

export function NotificationSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notification-settings'], queryFn: api.notifications.settings });
  const save = useMutation({
    mutationFn: (settings: Record<string, unknown>) => api.notifications.saveSettings(settings),
    onSuccess: (v) => qc.setQueryData(['notification-settings'], v),
  });
  // Anything but a settings view (an older server) reads as "couldn't load".
  const v = q.data && Array.isArray(q.data.types) && Array.isArray(q.data.categories) ? q.data : undefined;
  const browserZone = useMemo(browserTimeZone, []);
  // The time zone follows this browser until the person picks one.
  useEffect(() => {
    if (v && v.timeZone === null && !save.isPending) save.mutate({ timeZone: browserZone });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.timeZone]);

  if (q.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (q.isError || !v) return <p className="text-sm text-danger">{(q.error as Error | null)?.message ?? 'Couldn’t load your notification settings.'}</p>;
  const set = (settings: Record<string, unknown>) => save.mutate(settings);
  const pushShown = v.pushAvailable;

  return (
    <div className="flex flex-col gap-5" data-testid="notification-settings">
      {!v.emailAvailable && (
        <p className="rounded-control border border-line bg-soft p-3 text-sm text-muted" data-testid="email-unavailable">
          This site can’t send email right now. Your email choices are kept, and work once a site admin sets up email.
        </p>
      )}
      <div className="flex items-center justify-between gap-6">
        <div>
          <div className="text-[15px] font-semibold">Pause all email</div>
          <div className="text-sm text-muted">No notification emails at all, summaries included, until you turn this off. Invites and account emails still come.</div>
        </div>
        <Toggle label="Pause all email" checked={v.pauseEmail} onChange={(x) => set({ pauseEmail: x })} />
      </div>
      {pushShown && <PushDevices />}
      {pushShown && (
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-[15px] font-semibold">Pause all pop-ups</div>
            <div className="text-sm text-muted">No pop-up notifications on any of your devices until you turn this off.</div>
          </div>
          <Toggle label="Pause all pop-ups" checked={v.pausePush} onChange={(x) => set({ pausePush: x })} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-[15px] font-semibold">What you hear about</h3>
        {v.categories.map((c) => (
          <CategoryRow key={c} category={c} view={v} pushShown={pushShown} onSave={set} />
        ))}
      </div>

      <fieldset className="flex flex-col gap-3 rounded-card border border-line p-4">
        <legend className="px-1 text-[15px] font-semibold">Quiet hours</legend>
        <div className="flex items-center justify-between gap-6">
          <div className="text-sm text-muted">Emails{pushShown ? ' and pop-ups' : ''} that come in quiet hours wait until they end. Summaries aren’t held.</div>
          <Toggle label="Quiet hours" checked={v.quiet.on} onChange={(x) => set({ quiet: { on: x } })} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            From
            <input type="time" aria-label="Quiet hours start" value={v.quiet.start} disabled={!v.quiet.on} onChange={(e) => e.target.value && set({ quiet: { start: e.target.value } })} className={field} />
          </label>
          <label className="flex items-center gap-2">
            to
            <input type="time" aria-label="Quiet hours end" value={v.quiet.end} disabled={!v.quiet.on} onChange={(e) => e.target.value && set({ quiet: { end: e.target.value } })} className={field} />
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-card border border-line p-4">
        <legend className="px-1 text-[15px] font-semibold">Summaries and time zone</legend>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            Daily summary at
            <input type="time" aria-label="Daily summary time" value={v.dailyAt} onChange={(e) => e.target.value && set({ dailyAt: e.target.value })} className={field} />
          </label>
          <label className="flex items-center gap-2">
            Weekly summary on
            <select aria-label="Weekly summary day" value={v.weeklyDay} onChange={(e) => set({ weeklyDay: Number(e.target.value) })} className={field}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-muted">The weekly summary goes at the daily summary’s time. Each lists what you haven’t read since the last one.</p>
        <TimeZonePicker value={v.timeZone ?? browserZone} browserZone={browserZone} onChange={(tz) => set({ timeZone: tz })} />
      </fieldset>

      {v.clubs.length > 0 && (
        <fieldset className="flex flex-col gap-2 rounded-card border border-line p-4">
          <legend className="px-1 text-[15px] font-semibold">Your clubs</legend>
          <p className="text-sm text-muted">Mute a busy club, or keep it in the app but out of your email{pushShown ? ' or pop-ups' : ''}. Warnings always reach you.</p>
          <ul className="divide-y divide-line">
            {v.clubs.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-2 text-sm" data-testid="club-notification-row">
                <span className="min-w-0 flex-1 font-semibold">{c.name}</span>
                <label className="flex items-center gap-2">
                  Mute
                  <Toggle label={`Mute ${c.name}`} checked={c.mute} onChange={(x) => set({ clubs: { [c.id]: { mute: x } } })} />
                </label>
                <label className="flex items-center gap-2">
                  Email
                  <Toggle label={`Email from ${c.name}`} checked={c.email && !c.mute} disabled={c.mute} onChange={(x) => set({ clubs: { [c.id]: { email: x } } })} />
                </label>
                {pushShown && (
                  <label className="flex items-center gap-2">
                    Pop-ups
                    <Toggle label={`Pop-ups from ${c.name}`} checked={c.push && !c.mute} disabled={c.mute} onChange={(x) => set({ clubs: { [c.id]: { push: x } } })} />
                  </label>
                )}
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <p role="status" className="min-h-5 text-xs text-muted">
        {save.isPending ? 'Saving…' : save.isError ? <span className="text-danger">{(save.error as Error).message}</span> : save.isSuccess ? 'Saved.' : ''}
      </p>
    </div>
  );
}

function CategoryRow({ category, view, pushShown, onSave }: { category: NotificationCategory; view: NotificationSettingsView; pushShown: boolean; onSave: (s: Record<string, unknown>) => void }) {
  const types = view.types.filter((t) => t.category === category);
  const emailed = types.filter((t) => t.email !== 'off' && !t.emailApart).length;
  const off = types.filter((t) => !t.app).length;
  const summary = [`${types.length} ${types.length === 1 ? 'kind' : 'kinds'}`, emailed ? `${emailed} by email` : 'no email', off ? `${off} off in the app` : ''].filter(Boolean).join(' · ');
  return (
    <details className="group rounded-card border border-line" data-testid={`notification-category-${category}`}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2">
        <span className="flex-1">
          <span className="block text-[15px] font-semibold">{CATEGORY_LABEL[category]}</span>
          <span className="block text-xs text-muted">{summary}</span>
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="transition-transform group-open:rotate-180">
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <ul className="divide-y divide-line border-t border-line">
        {types.map((t) => (
          <li key={t.type} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 text-sm" data-testid="notification-type-row" data-type={t.type}>
            <span className="min-w-[12rem] flex-1">{t.label}</span>
            <label className="flex items-center gap-2">
              <span className="text-xs text-muted">In the app</span>
              <Toggle label={`${t.label}: in the app`} checked={t.app} disabled={t.appLocked} onChange={(x) => onSave({ types: { [t.type]: { app: x } } })} />
            </label>
            {t.appLocked && <span className="text-xs text-muted">Warnings always show, so you never miss one.</span>}
            {t.emailApart ? (
              <span className="text-xs text-muted sm:w-52">{t.emailApart === 'invite' ? 'Emailed with the invite’s link, always.' : 'Always emailed, for your account’s safety.'}</span>
            ) : (
              <label className="flex items-center gap-2 sm:w-52 sm:justify-end">
                <span className="text-xs text-muted">Email</span>
                <select aria-label={`${t.label}: email`} value={t.email} onChange={(e) => onSave({ types: { [t.type]: { email: e.target.value } } })} className={field}>
                  {(Object.keys(EMAIL_LABEL) as NotificationEmailMode[]).map((m) => (
                    <option key={m} value={m}>
                      {EMAIL_LABEL[m]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {pushShown && (
              <label className="flex items-center gap-2">
                <span className="text-xs text-muted">Pop-up</span>
                <Toggle label={`${t.label}: pop-up`} checked={t.push} onChange={(x) => onSave({ types: { [t.type]: { push: x } } })} />
              </label>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TimeZonePicker({ value, browserZone, onChange }: { value: string; browserZone: string; onChange: (tz: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const all = useMemo(zones, []);
  const known = all.length === 0 || all.includes(text);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2">
        Time zone
        <input
          aria-label="Time zone"
          list="notification-time-zones"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => known && text !== value && onChange(text)}
          className={`${field} w-56`}
        />
      </label>
      <datalist id="notification-time-zones">
        {all.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      {!known && <span className="text-xs text-danger">Pick a time zone from the list.</span>}
      {value !== browserZone && (
        <button type="button" onClick={() => onChange(browserZone)} className="tap-target rounded-control px-2 py-1 text-xs font-semibold text-accent-text hover:bg-soft">
          Use this browser’s ({browserZone})
        </button>
      )}
    </div>
  );
}
