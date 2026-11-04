// Admin › Settings: email, the desktop app, catalogs, privacy, sign-in, jobs, demo, server.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { GlobalLimitsForm } from '../limits/LimitsUi';
import { CatalogSettingsSection } from '../Moderation';
import { BackgroundJobsSection, ServerSetupSection } from '../ServerSetup';
import { DemoAccountSection } from '../DemoAccount';
import { PrivacySettingsSection } from '../../privacy/PrivacySettings';
import { SignInSettingsSection } from '../SignInSettings';
import { Loading } from './shared';

export function SettingsTab() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: api.admin.settings });

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'err'>('idle');
  const [saveErr, setSaveErr] = useState('');

  // Local draft state, seeded from the loaded settings and re-seeded
  // whenever a fresh fetch comes in (but not while the user is mid-edit
  // — `seeded` tracks whether we've initialised from this query result
  // yet, same "don't clobber an in-progress edit" concern as elsewhere
  // in this codebase, e.g. LayersPanel's layer-rename draft).
  const [seeded, setSeeded] = useState(false);
  const [requireVerification, setRequireVerification] = useState(true);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpPass, setSmtpPass] = useState(''); // always starts blank — never echoed by the server
  const [smtpPassTouched, setSmtpPassTouched] = useState(false);
  const [minDesktop, setMinDesktop] = useState('');

  if (settings.data && !seeded) {
    setSeeded(true);
    setRequireVerification(settings.data.requireEmailVerification);
    setSmtpHost(settings.data.smtp.host ?? '');
    setSmtpPort(settings.data.smtp.port?.toString() ?? '');
    setSmtpUser(settings.data.smtp.user ?? '');
    setSmtpFrom(settings.data.smtp.from ?? '');
    setMinDesktop(settings.data.desktop.minimumSet ?? '');
  }

  const save = useMutation({
    mutationFn: () => {
      const port = smtpPort.trim() === '' ? null : Number.parseInt(smtpPort, 10);
      return api.admin.patchSettings({
        requireEmailVerification: requireVerification,
        smtpHost: smtpHost.trim() === '' ? null : smtpHost.trim(),
        smtpPort: Number.isNaN(port) ? null : port,
        smtpUser: smtpUser.trim() === '' ? null : smtpUser.trim(),
        smtpFrom: smtpFrom.trim() === '' ? null : smtpFrom.trim(),
        minDesktopVersion: minDesktop.trim() === '' ? null : minDesktop.trim(),
        // Omit entirely if untouched — leaves the saved password as-is.
        // "" means the user cleared the field on purpose.
        ...(smtpPassTouched ? { smtpPass } : {}),
      });
    },
    onSuccess: () => {
      setSaveStatus('saved');
      setSmtpPass('');
      setSmtpPassTouched(false);
      qc.invalidateQueries({ queryKey: ['admin-settings'] });
      setTimeout(() => setSaveStatus('idle'), 2000);
    },
    onError: (e: Error) => {
      setSaveStatus('err');
      setSaveErr(e.message);
    },
  });

  if (settings.isLoading) return <Loading />;
  if (!settings.data) return <p className="text-sm text-muted">Couldn&apos;t load settings.</p>;

  const usingDbSmtp = smtpHost.trim() !== '';

  return (
    <>
    <div className="max-w-xl space-y-8">
      <DemoAccountSection />
      <CatalogSettingsSection />
      <BackgroundJobsSection />
      <PrivacySettingsSection />
      <SignInSettingsSection />
      <ServerSetupSection />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-300">Desktop app</h2>
        <label className="block space-y-1 text-xs text-muted">
          Oldest desktop allowed
          <input
            type="text"
            value={minDesktop}
            onChange={(e) => setMinDesktop(e.target.value)}
            placeholder={settings.data.desktop.codeMinimum}
            aria-describedby="min-desktop-help"
            className="block w-40 rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <p id="min-desktop-help" className="text-xs text-muted">
          People with an older desktop app are asked to download the new one before they can connect. Leave it
          empty to allow everything from {settings.data.desktop.codeMinimum}, the oldest version that works with
          this server. Right now: {settings.data.desktop.minimum} or newer is allowed, and{' '}
          {settings.data.desktop.recommended} or newer is recommended.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-neutral-300">Email verification</h2>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={requireVerification}
            onChange={(e) => setRequireVerification(e.target.checked)}
          />
          <span>
            Require new email/password accounts to verify their email before signing in
            <span className="block text-xs text-muted">
              Off: registration logs the user in immediately, matching pre-verification
              behaviour. Existing unverified accounts aren't retroactively marked verified —
              turning this off just stops enforcing the check.
            </span>
          </span>
        </label>
        {requireVerification && !settings.data.smtp.active && (
          <p className="rounded-lg border border-amber-900 bg-amber-950/30 p-2 text-xs text-amber-300">
            No SMTP server is configured below (or in the environment) — verification links
            will only be written to the server log, not emailed.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-300">SMTP server</h2>
          <p className="text-xs text-muted">
            Used for signup verification links and club and layout invite emails.{' '}
            {settings.data.smtp.source === 'database' && (
              <span className="text-emerald-400">Using the configuration below.</span>
            )}
            {settings.data.smtp.source === 'env' && (
              <span className="text-muted">
                Using the deployment's environment variables — fill in a host below to override.
              </span>
            )}
            {settings.data.smtp.source === null && (
              <span className="text-amber-400">Not configured — links are logged, not emailed.</span>
            )}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 space-y-1 text-xs text-muted">
            Host
            <input
              type="text"
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="smtp.example.com"
              className="block w-full rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="space-y-1 text-xs text-muted">
            Port
            <input
              type="number"
              value={smtpPort}
              onChange={(e) => setSmtpPort(e.target.value)}
              placeholder="587"
              disabled={!usingDbSmtp}
              className="block w-full rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink disabled:opacity-40"
            />
          </label>
          <label className="space-y-1 text-xs text-muted">
            From address
            <input
              type="email"
              value={smtpFrom}
              onChange={(e) => setSmtpFrom(e.target.value)}
              placeholder="noreply@example.com"
              disabled={!usingDbSmtp}
              className="block w-full rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink disabled:opacity-40"
            />
          </label>
          <label className="space-y-1 text-xs text-muted">
            Username
            <input
              type="text"
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              disabled={!usingDbSmtp}
              className="block w-full rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink disabled:opacity-40"
            />
          </label>
          <label className="space-y-1 text-xs text-muted">
            Password
            <input
              type="password"
              value={smtpPass}
              onChange={(e) => { setSmtpPass(e.target.value); setSmtpPassTouched(true); }}
              disabled={!usingDbSmtp}
              placeholder={settings.data.smtp.passSet ? '•••••••• (set — leave blank to keep)' : '(not set)'}
              className="block w-full rounded-lg border border-border bg-panel px-2 py-1.5 text-sm text-ink disabled:opacity-40"
            />
          </label>
        </div>
        {!usingDbSmtp && (
          <p className="text-xs text-muted">Enter a host above to set a database-backed SMTP config.</p>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={() => { setSaveStatus('saving'); setSaveErr(''); save.mutate(); }}
          disabled={save.isPending}
          className="rounded-lg bg-accent text-accent-ink px-4 py-2 text-sm hover:bg-accent-hover disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save settings'}
        </button>
        {saveStatus === 'saved' && <span className="text-sm text-emerald-400">Saved.</span>}
        {saveStatus === 'err' && <span className="text-sm text-danger">{saveErr}</span>}
      </div>
    </div>
    <div className="mt-10 border-t border-line pt-8">
      <GlobalLimitsForm />
    </div>
    </>
  );
}
