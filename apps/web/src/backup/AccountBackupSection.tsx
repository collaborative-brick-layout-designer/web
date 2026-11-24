// Profile › Back up your things: download one zip of your own layouts,
// modules, venues and rolling stock, and put them back from it. Restoring
// adds copies to your account and never changes or replaces what you have;
// something you still have is left out unless you tick it. See
// accountBackup.ts for the file and why it goes through the usual pages.

import { useRef, useState } from 'react';
import { HelpButton } from '../help/HelpButton';
import {
  KIND_WORDS,
  backupFileName,
  buildAccountBackup,
  existingThings,
  openAccountBackup,
  planRestore,
  restoreItem,
  type OpenedBackup,
  type PlannedItem,
  type Progress,
} from './accountBackup';

function saveBytes(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function AccountBackupSection({ me }: { me: { id: string; displayName: string } }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedBackup | null>(null);
  const [plan, setPlan] = useState<PlannedItem[] | null>(null);
  const [restoring, setRestoring] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ restored: number; failed: { title: string; why: string }[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function download() {
    setError(null);
    setMade(null);
    setProgress({ done: 0, total: 0, title: '' });
    try {
      const { bytes, manifest } = await buildAccountBackup(me, setProgress);
      const name = backupFileName();
      saveBytes(bytes, name);
      setMade(`Saved ${name} with ${plural(manifest.items.length, 'thing', 'things')} in it. Keep it somewhere safe, away from this computer too.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  async function open(file: File) {
    setError(null);
    setResult(null);
    try {
      const backup = await openAccountBackup(new Uint8Array(await file.arrayBuffer()));
      const existing = await existingThings(me);
      setOpened(backup);
      setPlan(planRestore(backup.manifest, existing));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function restore() {
    if (!opened || !plan) return;
    const chosen = plan.filter((p) => p.choice === 'add');
    const failed: { title: string; why: string }[] = [];
    let restored = 0;
    setRestoring({ done: 0, total: chosen.length });
    for (const [i, p] of chosen.entries()) {
      try {
        await restoreItem(p, opened.files);
        restored += 1;
      } catch (e) {
        failed.push({ title: p.newTitle, why: (e as Error).message });
      }
      setRestoring({ done: i + 1, total: chosen.length });
    }
    setRestoring(null);
    setOpened(null);
    setPlan(null);
    setResult({ restored, failed });
  }

  const toggle = (i: number) => setPlan((p) => p && p.map((x, j) => (j === i ? { ...x, choice: x.choice === 'add' ? 'skip' : 'add' } : x)));
  const busy = progress !== null || restoring !== null;
  const chosen = plan?.filter((p) => p.choice === 'add').length ?? 0;

  return (
    <section id="backup" className="scroll-mt-6 space-y-3" aria-labelledby="backup-heading">
      <h2 id="backup-heading" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        Back up your things <HelpButton helpKey="account.backup" />
      </h2>
      <p className="text-sm text-muted">
        One file with your own layouts, modules, venues and engines and cars, to keep safe and to put back later, here or on another site. Your clubs’ things aren’t in it.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy}
          className="tap-target rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
        >
          Download a backup
        </button>
        <label className={`tap-target inline-flex cursor-pointer items-center rounded-lg border border-border px-3 py-1.5 text-sm font-semibold hover:bg-soft ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          Restore from a backup…
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            aria-label="Restore from a backup"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void open(f);
            }}
          />
        </label>
        <HelpButton helpKey="account.backupRestore" />
      </div>
      {progress && (
        <p role="status" className="text-sm text-muted">
          {progress.total === 0 ? 'Gathering your things…' : `Packing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}${progress.title ? `: ${progress.title}` : ''}…`}
        </p>
      )}
      {made && (
        <p role="status" className="text-sm text-emerald-500">
          {made}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {plan && opened && (
        <div className="space-y-3 rounded-lg border border-line p-4" role="region" aria-label="What to restore">
          <p className="text-sm">
            This backup was made {new Date(opened.manifest.exportedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} for {opened.manifest.account.name}. Tick what to bring back: each comes back as a new
            copy in your account, and nothing you have now is changed.
          </p>
          {plan.length === 0 ? (
            <p className="text-sm text-muted">There’s nothing in this backup.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {plan.map((p, i) => (
                <li key={`${p.item.kind}-${p.item.id}-${i}`} className="px-3 py-2">
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={p.choice === 'add'} disabled={busy} onChange={() => toggle(i)} aria-label={`Restore ${p.item.title}`} />
                    <span className="min-w-0">
                      <span className="block break-words">
                        {p.item.title} <span className="text-xs text-muted">· {KIND_WORDS[p.item.kind].one}</span>
                      </span>
                      {p.clash?.why === 'same' && (
                        <span className="block text-xs text-muted">You still have this one, so it’s left out. Tick it to bring back a copy as it was, named “{p.newTitle}”.</span>
                      )}
                      {p.clash?.why === 'name' && <span className="block text-xs text-muted">You have one with this name, so it comes back as “{p.newTitle}”.</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {restoring && (
            <div role="status" className="flex items-center gap-2 text-sm">
              <progress value={restoring.done} max={Math.max(1, restoring.total)} aria-label="Restore progress" />
              Restoring {restoring.done} of {restoring.total}…
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void restore()}
              disabled={busy || chosen === 0}
              className="tap-target rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
            >
              Restore {plural(chosen, 'thing', 'things')}
            </button>
            <button
              type="button"
              onClick={() => {
                setPlan(null);
                setOpened(null);
              }}
              disabled={busy}
              className="tap-target rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-soft disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <div role="status" className="space-y-1 text-sm">
          <p className={result.failed.length ? '' : 'text-emerald-500'}>
            Restored {plural(result.restored, 'thing', 'things')}. {result.restored > 0 && 'They are in your lists now.'}
          </p>
          {result.failed.length > 0 && (
            <>
              <p className="text-danger">Couldn’t restore {plural(result.failed.length, 'thing', 'things')}:</p>
              <ul className="list-disc pl-5 text-danger">
                {result.failed.map((f, i) => (
                  <li key={i}>
                    {f.title}: {f.why}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
