// Admin › Settings: the background jobs (switches, unless the server's env
// var forces one, which the page names) and the server's own setup, read
// only, each with why it can't be changed here.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AdminJobSetting, type ServerSetupWhy } from '../api';

function Forced({ by }: { by: string | null }) {
  if (!by) return null;
  return (
    <p className="text-xs text-muted">
      Forced by the server setting <code>{by}</code>. Remove it from the server’s settings to use this switch.
    </p>
  );
}

export function BackgroundJobsSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: api.admin.settings });
  const save = useMutation({
    mutationFn: api.admin.patchSettings,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-settings'] }),
  });
  const jobs = settings.data?.jobs;
  if (!jobs) return null;
  const toggle = (label: string, job: AdminJobSetting<boolean>, key: 'backupsEnabled' | 'dailyCompactionEnabled', help: string) => (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={job.value} disabled={!!job.forcedBy} onChange={(e) => save.mutate({ [key]: e.target.checked })} />
        {label}
      </label>
      <p className="text-xs text-muted">{help}</p>
      <Forced by={job.forcedBy} />
    </div>
  );
  return (
    <section className="space-y-3" aria-labelledby="jobs-settings">
      <h2 id="jobs-settings" className="text-sm font-semibold text-neutral-300">Background jobs</h2>
      <p className="text-xs text-muted">These run once a day. Changes apply from the next run, no restart needed.</p>
      {toggle('Nightly backups', jobs.backups, 'backupsEnabled', 'A copy of the database in the backups folder, with older copies thinned out.')}
      {toggle('Tidy layouts nightly', jobs.dailyCompaction, 'dailyCompactionEnabled', 'Rewrites each changed layout compactly so it opens quickly.')}
    </section>
  );
}

/** Admin › Settings › Notifications: browser pop-ups for the whole site. */
export function PushSettingsSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: api.admin.settings });
  const save = useMutation({
    mutationFn: api.admin.patchSettings,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-settings'] }),
  });
  const push = settings.data?.push;
  if (!push) return null;
  return (
    <section className="space-y-3" aria-labelledby="push-settings">
      <h2 id="push-settings" className="text-sm font-semibold text-neutral-300">Notifications</h2>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={push.value} disabled={!!push.forcedBy || save.isPending} onChange={(e) => save.mutate({ pushEnabled: e.target.checked })} />
          Pop-up notifications in browsers
        </label>
        <p className="text-xs text-muted">
          People can choose to get a pop-up from their browser when something waits for them. Turned off, nobody gets pop-ups and Settings doesn’t offer them; email and the bell carry on.
          {push.keys === 'env' ? ' The keys come from the server’s settings.' : ' The server made its own keys and keeps them.'}
        </p>
        <Forced by={push.forcedBy} />
      </div>
    </section>
  );
}

const WHY: Record<ServerSetupWhy, string> = {
  secret: 'A password or key: set it in the server’s settings, so it is never shown here.',
  restart: 'Read when the server starts: change it in the server’s settings and restart.',
  deploy: 'Part of how the server is installed (an address, folder or port).',
  bootstrap: 'Needed before the database exists, to make the first admin.',
};

export function ServerSetupSection() {
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: api.admin.settings });
  const rows = settings.data?.serverSetup;
  if (!rows) return null;
  return (
    <section className="space-y-3" aria-labelledby="server-setup">
      <h2 id="server-setup" className="text-sm font-semibold text-neutral-300">Server setup</h2>
      <p className="text-xs text-muted">Set in the server’s own settings, not here. Shown so you can see what is in use.</p>
      <dl className="divide-y divide-line rounded-lg border border-line text-sm">
        {rows.map((r) => (
          <div key={r.env} className="grid gap-1 px-3 py-2 sm:grid-cols-[10rem_1fr]">
            <dt className="font-medium text-ink">{r.name}</dt>
            <dd className="min-w-0 space-y-0.5">
              <span className="break-all">{r.value}</span>
              <p className="text-xs text-muted">
                {WHY[r.why]} <code className="break-all">{r.env}</code>
              </p>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
