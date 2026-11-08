// Admin › Part libraries: the base library, downloads and manual installs.

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type PartLibrary, type RemotePackage } from '../../api';
import { confirmDelete, toastDeleted } from '../../ui/ConfirmDialog';
import { Loading, Td, Th } from './shared';

const KNOWN_SOURCES = [
  {
    id: 'official',
    label: 'BlueBrick packs (Town, Train, Castle, BrickTracks, TrixBrix, …)',
    hint: 'Town, Train, Castle, Space, Duplo, Vehicle, BrickTracks and TrixBrix packs',
  },
  {
    id: 'nonlego',
    label: 'Other toy brands (Plarail)',
    hint: 'Packs for toys that are not LEGO, such as Plarail',
  },
] as const;

function invalidatePartQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['admin-part-libraries'] });
  qc.invalidateQueries({ queryKey: ['parts-catalog'] });
  qc.invalidateQueries({ queryKey: ['custom-parts'] });
  qc.invalidateQueries({ queryKey: ['org-part-libraries'] });
}

/** "Get the parts library": downloads BlueBrickParts from GitHub onto the server. */
export function useGetPartsLibrary() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'idle' | 'downloading' | 'done' | 'err'>('idle');
  const [err, setErr] = useState('');
  async function run() {
    setStatus('downloading');
    setErr('');
    try {
      await api.admin.downloadPartLibrary({
        name: 'BlueBrickParts (default)',
        slug: 'bluebrickparts-default',
        sourceUrl: 'https://github.com/Lswbanban/BlueBrickParts/archive/refs/heads/master.zip',
        defaultEnabled: true,
      });
      invalidatePartQueries(qc);
      setStatus('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'download failed');
      setStatus('err');
    }
  }
  return { status, err, run };
}

/** The Admin dashboard's warning when the server has no parts at all. */
export function PartsSetupCard() {
  const libs = useQuery({ queryKey: ['admin-part-libraries'], queryFn: api.admin.partLibraries, retry: false });
  const get = useGetPartsLibrary();
  if (!libs.data) return null;
  const registered = libs.data.libraries;
  const baseRow = registered.find((l) => l.slug === 'bluebrickparts');
  const total = registered.filter((l) => l.slug !== 'bluebrickparts').reduce((n, l) => n + l.partCount, 0)
    + Math.max(baseRow?.partCount ?? 0, libs.data.onDiskBaseParts ?? 0);
  if (total > 0 && get.status !== 'done') return null;
  return (
    <section data-testid="parts-setup-card" className="space-y-2 rounded-lg border border-amber-500/50 bg-panel p-4 text-sm">
      <h2 className="font-semibold">Parts</h2>
      {get.status === 'done' ? (
        <p className="text-emerald-400">The parts library is installed. Layouts can show their parts now.</p>
      ) : (
        <>
          <p>
            <strong>{registered.length} {registered.length === 1 ? 'library' : 'libraries'} · 0 parts.</strong>{' '}
            Layouts will show every part as missing until this server has a parts library.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void get.run()}
              disabled={get.status === 'downloading'}
              className="min-h-11 rounded-lg bg-accent-hover px-3 text-sm font-medium text-accent-ink hover:bg-accent disabled:opacity-50"
            >
              {get.status === 'downloading' ? 'Getting the parts library…' : 'Get the parts library'}
            </button>
            <a href="/admin?tab=libraries" className="text-accent-text hover:underline">Open Part libraries</a>
          </div>
          {get.status === 'err' && <p className="text-danger">{get.err}</p>}
        </>
      )}
    </section>
  );
}

export function PartLibrariesTab() {
  const qc = useQueryClient();
  const libs = useQuery({
    queryKey: ['admin-part-libraries'],
    queryFn: api.admin.partLibraries,
  });

  const installedSlugs = new Set(libs.data?.libraries.map((l) => l.slug) ?? []);

  // ── Base library ──────────────────────────────────────────────────────────
  const [baseStatus, setBaseStatus] = useState<'idle' | 'installing' | 'done' | 'err'>('idle');
  const [baseErr, setBaseErr] = useState('');
  // A base library registered with no parts (an old server let that happen)
  // doesn't count, so the download stays on offer.
  const baseInstalled = (libs.data?.libraries ?? []).some((l) => l.slug === 'bluebrickparts' && l.partCount > 0);
  const baseDownloaded = installedSlugs.has('bluebrickparts-default');
  const onDiskBaseParts = libs.data?.onDiskBaseParts ?? 0;

  const { status: dlBaseStatus, err: dlBaseErr, run: downloadDefaultLibrary } = useGetPartsLibrary();

  async function installBase() {
    setBaseStatus('installing');
    setBaseErr('');
    try {
      await api.admin.installBaseLibrary();
      invalidateLibraries();
      setBaseStatus('done');
    } catch (e) {
      setBaseErr(e instanceof Error ? e.message : 'failed');
      setBaseStatus('err');
    }
  }

  // ── Download Center ───────────────────────────────────────────────────────
  type SourceId = typeof KNOWN_SOURCES[number]['id'] | 'custom';
  const [selectedSources, setSelectedSources] = useState<Set<SourceId>>(new Set(['official']));
  const [customUrl, setCustomUrl] = useState('');
  const [searchStatus, setSearchStatus] = useState<'idle' | 'searching' | 'done' | 'err'>('idle');
  const [searchErr, setSearchErr] = useState('');
  const [candidates, setCandidates] = useState<(RemotePackage & { checked: boolean; installing: boolean; installed: boolean; err: string })[]>([]);
  const [defaultEnabled, setDefaultEnabled] = useState(false);

  function toggleSource(id: SourceId) {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSearch() {
    setSearchStatus('searching');
    setSearchErr('');
    setCandidates([]);

    const sources: string[] = [];
    if (selectedSources.has('official')) sources.push('official');
    if (selectedSources.has('nonlego')) sources.push('nonlego');
    if (selectedSources.has('custom') && customUrl.trim()) sources.push(customUrl.trim());

    if (sources.length === 0) {
      setSearchErr('Select at least one source.');
      setSearchStatus('err');
      return;
    }

    const all: (RemotePackage & { checked: boolean; installing: boolean; installed: boolean; err: string })[] = [];
    for (const src of sources) {
      try {
        const res = await api.admin.searchPartLibraries(src);
        for (const pkg of res.packages) {
          const slug = pkg.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          all.push({ ...pkg, checked: false, installing: false, installed: installedSlugs.has(slug), err: '' });
        }
      } catch (e) {
        setSearchErr((prev) => (prev ? prev + '; ' : '') + (e instanceof Error ? e.message : `${src} failed`));
      }
    }

    setCandidates(all);
    setSearchStatus('done');
  }

  function toggleCandidate(idx: number) {
    setCandidates((prev) => prev.map((c, i) => i === idx ? { ...c, checked: !c.checked } : c));
  }

  async function handleDownloadSelected() {
    const toInstall = candidates.filter((c) => c.checked && !c.installed);
    if (toInstall.length === 0) return;

    for (const pkg of toInstall) {
      const slug = pkg.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      setCandidates((prev) =>
        prev.map((c) => c.sourceUrl === pkg.sourceUrl ? { ...c, installing: true, err: '' } : c),
      );
      try {
        await api.admin.downloadPartLibrary({
          name: pkg.version ? `${pkg.name} (v${pkg.version})` : pkg.name,
          slug,
          sourceUrl: pkg.sourceUrl,
          defaultEnabled,
        });
        setCandidates((prev) =>
          prev.map((c) =>
            c.sourceUrl === pkg.sourceUrl
              ? { ...c, installing: false, installed: true, checked: false }
              : c,
          ),
        );
        invalidateLibraries();
      } catch (e) {
        setCandidates((prev) =>
          prev.map((c) =>
            c.sourceUrl === pkg.sourceUrl
              ? { ...c, installing: false, err: e instanceof Error ? e.message : 'failed' }
              : c,
          ),
        );
      }
    }
  }

  const anyDownloading = candidates.some((c) => c.installing);
  const anyChecked = candidates.some((c) => c.checked && !c.installed);

  // ── Manual install ────────────────────────────────────────────────────────
  const [manualForm, setManualForm] = useState({ name: '', slug: '', sourceUrl: '', defaultEnabled: false });
  const zipRef = useRef<HTMLInputElement>(null);
  const [manualMode, setManualMode] = useState<'url' | 'upload'>('url');
  const [manualInstalling, setManualInstalling] = useState(false);
  const [manualErr, setManualErr] = useState('');

  async function handleManualInstall(e: React.FormEvent) {
    e.preventDefault();
    setManualErr('');
    const name = manualForm.name.trim();
    const slug = manualForm.slug.trim();
    if (!name || !slug) { setManualErr('Name and slug are required'); return; }
    setManualInstalling(true);
    try {
      if (manualMode === 'url') {
        if (!manualForm.sourceUrl.trim()) { setManualErr('Source URL required'); return; }
        await api.admin.installPartLibrary({ name, slug, sourceUrl: manualForm.sourceUrl.trim(), defaultEnabled: manualForm.defaultEnabled });
      } else {
        const zipFile = zipRef.current?.files?.[0];
        if (!zipFile) { setManualErr('Zip file required'); return; }
        const zipBase64 = btoa(String.fromCharCode(...new Uint8Array(await zipFile.arrayBuffer())));
        await api.admin.installPartLibrary({ name, slug, zipBase64, defaultEnabled: manualForm.defaultEnabled });
      }
      setManualForm({ name: '', slug: '', sourceUrl: '', defaultEnabled: false });
      if (zipRef.current) zipRef.current.value = '';
      invalidateLibraries();
    } catch (err: unknown) {
      setManualErr(err instanceof Error ? err.message : 'Install failed');
    } finally {
      setManualInstalling(false);
    }
  }

  // ── Reload parts cache ───────────────────────────────────────────────────
  function invalidateLibraries() {
    invalidatePartQueries(qc);
  }

  const reloadParts = useMutation({
    mutationFn: api.admin.reloadParts,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['parts-catalog'] });
      qc.invalidateQueries({ queryKey: ['custom-parts'] });
    },
  });

  // ── Installed list actions ────────────────────────────────────────────────
  const patchLib = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; defaultEnabled?: boolean; locked?: boolean } }) =>
      api.admin.patchPartLibrary(id, body),
    onSuccess: invalidateLibraries,
  });
  const updateLib = useMutation({
    mutationFn: (id: string) => api.admin.updatePartLibrary(id),
    onSuccess: invalidateLibraries,
  });
  const deleteLib = useMutation({
    mutationFn: (id: string) => api.admin.deletePartLibrary(id),
    onSuccess: invalidateLibraries,
  });

  return (
    <div className="space-y-8">

      {/* ── Base library ── */}
      <section className="rounded-lg border border-line p-4 space-y-4">

        {/* Register on-disk library: only when PARTS_DIR really holds parts */}
        {(baseInstalled || onDiskBaseParts > 0) && (
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
          <div>
            <h2 className="text-sm font-semibold text-neutral-300">BlueBrickParts base library</h2>
            <p className="mt-1 text-xs text-muted">
              If the parts submodule is already on disk at <code className="text-muted">PARTS_DIR</code>,
              this registers it so clubs can enable/disable it. No download needed.
            </p>
          </div>
          {baseInstalled ? (
            <span className="shrink-0 rounded-lg bg-emerald-900/30 px-2 py-1 text-xs text-emerald-400">
              Installed
            </span>
          ) : (
            <button
              onClick={installBase}
              disabled={baseStatus === 'installing'}
              className="shrink-0 rounded-lg bg-neutral-700 px-3 py-1.5 text-xs font-medium text-ink hover:bg-neutral-600 disabled:opacity-50"
            >
              {baseStatus === 'installing' ? 'Registering…' : 'Register on-disk library'}
            </button>
          )}
        </div>
        )}
        {baseStatus === 'err' && <p className="text-xs text-danger">{baseErr}</p>}

        {/* Download from GitHub — only shown when the on-disk submodule isn't already registered */}
        {!baseInstalled && (
          <>
            <div className={`flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4${onDiskBaseParts > 0 ? ' border-t border-line pt-4' : ''}`}>
              <div>
                <h2 className="text-sm font-semibold text-neutral-300">Download BlueBrickParts from GitHub</h2>
                <p className="mt-1 text-xs text-muted">
                  Downloads the latest{' '}
                  <span className="text-muted">Lswbanban/BlueBrickParts</span> archive (~27 MB),
                  extracts it to <code className="break-all text-muted">PARTS_DIR/libraries/bluebrickparts-default/</code>,
                  and enables it for all clubs by default.
                </p>
              </div>
              {baseDownloaded ? (
                <span className="shrink-0 rounded-lg bg-emerald-900/30 px-2 py-1 text-xs text-emerald-400">
                  Downloaded
                </span>
              ) : (
                <button
                  onClick={downloadDefaultLibrary}
                  disabled={dlBaseStatus === 'downloading'}
                  className="shrink-0 rounded-lg bg-accent-hover px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent disabled:opacity-50"
                >
                  {dlBaseStatus === 'downloading' ? 'Getting the parts library…' : 'Get the parts library'}
                </button>
              )}
            </div>
            {dlBaseStatus === 'err' && <p className="text-xs text-danger">{dlBaseErr}</p>}
            {dlBaseStatus === 'done' && <p className="text-xs text-emerald-400">Downloaded and installed successfully.</p>}
          </>
        )}

      </section>

      {/* ── Download Center ── */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-neutral-300">Download Center</h2>
        <p className="mb-3 text-xs text-muted">
          Search the BlueBrick community package servers for additional part libraries (same sources as
          the desktop app). The server downloads and extracts the zip — no browser upload needed.
        </p>

        <div className="space-y-2 rounded-lg border border-line p-4">
          {/* Source selection */}
          <div className="space-y-1">
            {KNOWN_SOURCES.map((src) => (
              <label key={src.id} className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  type="checkbox"
                  checked={selectedSources.has(src.id)}
                  onChange={() => toggleSource(src.id)}
                  className="accent-accent"
                />
                <span>{src.label}</span>
                <span className="text-neutral-600">— {src.hint}</span>
              </label>
            ))}
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                checked={selectedSources.has('custom')}
                onChange={() => toggleSource('custom')}
                className="accent-accent"
              />
              <span>Custom URL</span>
              <input
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                disabled={!selectedSources.has('custom')}
                placeholder="https://example.com/parts/"
                className="ml-1 flex-1 rounded-lg border border-border bg-panel px-2 py-0.5 text-xs disabled:opacity-40"
              />
            </label>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSearch}
              disabled={searchStatus === 'searching'}
              className="rounded-lg bg-neutral-700 px-3 py-1.5 text-xs font-medium text-ink hover:bg-neutral-600 disabled:opacity-50"
            >
              {searchStatus === 'searching' ? 'Searching…' : 'Search'}
            </button>
            {searchStatus === 'done' && (
              <span className="text-xs text-muted">
                {candidates.length} package(s) found
                {candidates.filter((c) => c.installed).length > 0 &&
                  ` · ${candidates.filter((c) => c.installed).length} already installed`}
              </span>
            )}
            {searchErr && <span className="text-xs text-danger">{searchErr}</span>}
          </div>

          {candidates.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
                {candidates.map((pkg, idx) => (
                  <label
                    key={pkg.sourceUrl}
                    className={`flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs last:border-0 ${pkg.installed ? 'opacity-50' : 'cursor-pointer hover:bg-panel/40'}`}
                  >
                    <input
                      type="checkbox"
                      checked={pkg.checked}
                      disabled={pkg.installed || pkg.installing}
                      onChange={() => toggleCandidate(idx)}
                      className="accent-accent"
                    />
                    <span className="flex-1 font-medium text-ink">
                      {pkg.name}
                      {pkg.version && <span className="ml-1 text-muted">v{pkg.version}</span>}
                    </span>
                    {pkg.installing && <span className="text-accent-text">Installing…</span>}
                    {pkg.installed && <span className="text-emerald-400">✓ installed</span>}
                    {pkg.err && <span className="text-danger">{pkg.err}</span>}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={defaultEnabled}
                    onChange={(e) => setDefaultEnabled(e.target.checked)}
                    className="accent-accent"
                  />
                  Enable for all clubs by default
                </label>
                <button
                  onClick={handleDownloadSelected}
                  disabled={!anyChecked || anyDownloading}
                  className="rounded-lg bg-accent-hover px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent disabled:opacity-50"
                >
                  {anyDownloading ? 'Installing…' : 'Download & Install selected'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Manual install ── */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-neutral-300">Manual install</h2>
        <p className="mb-3 text-xs text-muted">
          Install from a direct zip URL or upload a local file. Use this for private or unlisted library zips.
        </p>
        <div className="mb-3 flex gap-2">
          {(['url', 'upload'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setManualMode(mode)}
              className={`rounded-lg px-3 py-1 text-xs ${manualMode === mode ? 'bg-accent-hover text-accent-ink' : 'border border-border text-muted hover:bg-soft'}`}
            >
              {mode === 'url' ? 'From URL' : 'Upload zip'}
            </button>
          ))}
        </div>
        <form onSubmit={handleManualInstall} className="space-y-3 rounded-lg border border-line p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Library name
              <input
                value={manualForm.name}
                onChange={(e) => setManualForm((f) => ({ ...f, name: e.target.value }))}
                className="rounded-lg border border-border bg-panel px-2 py-1 text-ink"
                placeholder="My Parts Pack"
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Slug (unique, URL-safe)
              <input
                value={manualForm.slug}
                onChange={(e) => setManualForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
                className="rounded-lg border border-border bg-panel px-2 py-1 text-ink"
                placeholder="my-parts-pack"
                required
              />
            </label>
            {manualMode === 'url' ? (
              <label className="col-span-2 flex flex-col gap-1 text-xs text-muted">
                Direct zip URL
                <input
                  value={manualForm.sourceUrl}
                  onChange={(e) => setManualForm((f) => ({ ...f, sourceUrl: e.target.value }))}
                  className="rounded-lg border border-border bg-panel px-2 py-1 text-ink"
                  placeholder="https://example.com/MyParts.zip"
                />
              </label>
            ) : (
              <label className="col-span-2 flex flex-col gap-1 text-xs text-muted">
                Zip file
                <input ref={zipRef} type="file" accept=".zip,application/zip" required className="text-neutral-300" />
              </label>
            )}
            <label className="col-span-2 flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={manualForm.defaultEnabled}
                onChange={(e) => setManualForm((f) => ({ ...f, defaultEnabled: e.target.checked }))}
                className="accent-accent"
              />
              Enable for all clubs by default
            </label>
          </div>
          {manualErr && <p className="text-xs text-danger">{manualErr}</p>}
          <button
            type="submit"
            disabled={manualInstalling}
            className="rounded-lg bg-accent-hover px-3 py-1.5 text-xs font-medium text-accent-ink hover:bg-accent disabled:opacity-50"
          >
            {manualInstalling ? 'Installing…' : 'Install'}
          </button>
        </form>
      </section>

      {/* ── Installed list ── */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-neutral-300">
            Installed libraries ({libs.data?.libraries.length ?? '…'})
          </h2>
          <button
            onClick={() => reloadParts.mutate()}
            disabled={reloadParts.isPending}
            title="Rescan all part library directories without restarting the server"
            className="rounded-lg border border-border px-2 py-1 text-xs text-neutral-300 hover:bg-soft disabled:opacity-50"
          >
            {reloadParts.isPending ? 'Reloading…' : 'Reload parts'}
          </button>
        </div>
        {libs.isLoading && <Loading />}
        {libs.data && libs.data.libraries.length === 0 && (
          <p className="text-xs text-muted">No part libraries installed yet.</p>
        )}
        {libs.data && libs.data.libraries.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-xs">
              <thead className="bg-panel text-left text-muted">
                <tr>
                  <Th>Name</Th><Th>Slug</Th><Th>Parts</Th><Th>Default on</Th><Th>Source</Th><Th>Path on disk</Th><Th>Installed</Th><Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {libs.data.libraries.map((lib: PartLibrary) => (
                  <tr key={lib.id} className="border-t border-line hover:bg-panel/40">
                    <Td>
                      {lib.name}
                      {lib.locked && (
                        <span className="ml-2 rounded-lg bg-soft px-1.5 py-0.5 text-[10px] text-muted" title="Always enabled for everyone — cannot be turned off by club admins">
                          locked
                        </span>
                      )}
                    </Td>
                    <Td className="font-mono text-muted">{lib.slug}</Td>
                    <Td>{lib.partCount.toLocaleString()}</Td>
                    <Td>
                      <input
                        type="checkbox"
                        checked={lib.defaultEnabled}
                        disabled={lib.locked}
                        onChange={(e) => !lib.locked && patchLib.mutate({ id: lib.id, body: { defaultEnabled: e.target.checked } })}
                        className="accent-accent disabled:opacity-40"
                        title={lib.locked ? 'Always enabled — cannot be changed' : 'Enable for all clubs by default'}
                      />
                    </Td>
                    <Td className="max-w-[16rem] truncate text-muted">
                      {lib.sourceUrl ? (
                        <span title={lib.sourceUrl}>{lib.sourceUrl}</span>
                      ) : (
                        <span className="italic text-neutral-600">upload</span>
                      )}
                    </Td>
                    <Td className="max-w-[20rem] truncate font-mono text-[11px] text-muted">
                      <span title={lib.diskPath}>{lib.diskPath}</span>
                    </Td>
                    <Td>{new Date(lib.installedAt).toLocaleDateString()}</Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-3">
                        {lib.sourceUrl && (
                          <button
                            onClick={() => updateLib.mutate(lib.id)}
                            disabled={updateLib.isPending}
                            className="text-accent-text hover:underline disabled:opacity-50"
                            title={`Re-download from ${lib.sourceUrl}`}
                          >
                            {updateLib.isPending ? 'Updating…' : 'Update'}
                          </button>
                        )}
                        <button
                          onClick={() => patchLib.mutate({ id: lib.id, body: { locked: !lib.locked } })}
                          className="text-muted hover:underline"
                          title={lib.locked ? 'Unlock — allow club admins to turn this library off' : 'Lock — force this library on for all clubs'}
                        >
                          {lib.locked ? 'Unlock' : 'Lock'}
                        </button>
                        {!lib.locked && (
                          <button
                            onClick={async () => {
                              const ok = await confirmDelete(lib.name, {
                                removes: 'The library and its parts folder are removed from the server’s disk.',
                                keeps: 'Layouts that use its parts show placeholders in their place.',
                                typeName: true,
                              });
                              if (ok) deleteLib.mutate(lib.id, { onSuccess: () => toastDeleted(lib.name) });
                            }}
                            className="text-danger hover:underline"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Global Audit Log tab
// ---------------------------------------------------------------------------
