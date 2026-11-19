// Upload a custom part: its BlueBrick XML, a sprite, a name and category,
// and where it's saved (you or one of your clubs). Opened from the home
// page's Custom parts section and from the editor's Parts panel. A part made
// from an LDraw, Studio or LDD model goes through the site's own import
// (`onImportModel`) when this site can import; else the desktop app's steps.

import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { defaultSaveTo, readOwnerFilter, type OwnerFilter } from '../owners/owners';
import { SaveToPicker } from '../owners/OwnerControls';
import { CategoryPicker } from './CategoryPicker';
import { DesktopOnlySteps } from '../open/DesktopOnly';
import { useEscape } from '../editor/useEscape';
import { importApi } from '../import/importApi';
import { HelpButton } from '../help/HelpButton';

/**
 * `filter`: the owner filter being shown (home page); otherwise the last one picked there.
 * `onImportModel`: open the site's model import instead (from a click: it opens the file picker).
 */
export function UploadPartDialog({ onClose, filter, onImportModel }: { onClose: () => void; filter?: OwnerFilter; onImportModel?: (() => void) | undefined }) {
  useEscape(onClose);
  const qc = useQueryClient();
  const importStatus = useQuery({ queryKey: ['imports-status'], queryFn: importApi.status, staleTime: 60_000 });
  const canImport = !!onImportModel && importStatus.data?.available === true;
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const catalog = useQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 5 * 60 * 1000 });
  const [partNumber, setPartNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [category, setCategory] = useState('Custom');
  const [xmlText, setXmlText] = useState('');
  const [spriteFile, setSpriteFile] = useState<File | null>(null);
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [ownerSlug, setOwnerSlug] = useState(() => defaultSaveTo(filter ?? readOwnerFilter(me.data?.user?.id)));
  // A remembered club you've since left: save to Me.
  useEffect(() => {
    if (ownerSlug && orgs.data && !orgs.data.orgs.some((o) => o.slug === ownerSlug)) setOwnerSlug('');
  }, [orgs.data, ownerSlug]);
  const [error, setError] = useState<string | null>(null);

  const existingCategories = Array.from(
    new Set((catalog.data?.parts ?? []).map((p) => p.category || 'Custom').filter(Boolean))
  ).sort();

  const create = useMutation({
    mutationFn: api.customParts.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-parts'] });
      // Past the browser's 60 s catalog cache, so the Parts panel shows it now.
      void qc.fetchQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 0 }).catch(() => undefined);
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  async function pickXml(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setXmlText(await file.text());
    if (!partNumber) setPartNumber(file.name.replace(/\.xml$/i, ''));
  }

  function pickSprite(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSpriteFile(file);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!xmlText) return setError('XML payload required');
    if (!spriteFile) return setError('Sprite required');
    const mime: 'image/gif' | 'image/png' =
      spriteFile.type === 'image/png' ? 'image/png' : 'image/gif';
    const xmlBase64 = btoa(xmlText);
    const buf = await spriteFile.arrayBuffer();
    const spriteBase64 = arrayBufferToBase64(buf);
    create.mutate({
      partNumber: partNumber.trim(),
      displayName: displayName.trim(),
      category: category.trim() || 'Custom',
      xmlBase64,
      spriteBase64,
      spriteMime: mime,
      ...(ownerSlug ? { orgSlug: ownerSlug } : {}),
    });
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Upload custom part"
        onSubmit={submit}
        className="w-full max-w-md space-y-3 rounded-lg border border-line bg-panel p-6 text-sm"
      >
        <h3 className="text-lg font-semibold">Upload custom part</h3>

        {canImport ? (
          <div className="flex items-start gap-1 rounded-lg border border-line bg-soft px-3 py-2 text-xs text-muted" data-testid="upload-part-import">
            <p>
              Making a part from an LDraw, Studio or LDD model?{' '}
              <button type="button" onClick={onImportModel} className="font-semibold text-accent-text hover:underline">
                Import from a model file (LDraw, Studio, LDD)
              </button>{' '}
              and this site makes the part for you.
            </p>
            <HelpButton helpKey="import.asPart" />
          </div>
        ) : (
          <details className="rounded-lg border border-line bg-soft px-3 py-2 text-xs text-muted">
            <summary className="cursor-pointer font-semibold text-ink">Making a part from an LDraw, Studio or LDD model?</summary>
            <div className="mt-2">
              <DesktopOnlySteps part />
            </div>
          </details>
        )}

        <label className="block">
          <span className="mb-1 block text-muted">Part number</span>
          <input
            value={partNumber}
            onChange={(e) => setPartNumber(e.target.value)}
            required
            className="w-full rounded-lg border border-border bg-soft px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-muted">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            className="w-full rounded-lg border border-border bg-soft px-3 py-2"
          />
        </label>

        <CategoryPicker
          categories={existingCategories}
          value={category}
          onChange={setCategory}
        />

        <SaveToPicker value={ownerSlug} onChange={setOwnerSlug} orgs={orgs.data?.orgs} kind="part" />

        <label className="block">
          <span className="mb-1 block text-muted">Part XML</span>
          <input
            type="file"
            accept=".xml,application/xml,text/xml"
            onChange={pickXml}
            required
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-muted">Sprite (gif or png)</span>
          <input
            type="file"
            accept="image/gif,image/png"
            onChange={pickSprite}
            required
          />
        </label>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 hover:bg-soft"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-lg bg-accent text-accent-ink px-4 py-2 hover:bg-accent-hover disabled:opacity-50"
          >
            Upload
          </button>
        </div>
      </form>
    </div>
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
