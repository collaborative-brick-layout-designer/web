// "Import from a model file (LDraw, Studio, LDD)" where custom parts are
// managed (Home's Custom parts, Upload part): pick a model, and the import
// dialog makes one custom part of it, saved to you or a club. Nothing is
// placed and no layout is made. The editor's Parts panel does the same
// through EditorPage, which can also place the part.

import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { OwnerFilter } from '../owners/owners';
import { ImportDialog } from './ImportDialog';
import { IMPORT_ACCEPT, importApi } from './importApi';

/** `pick` opens the file picker (call it from a click); absent when this site can't import. */
export function useModelPartImport(opts: { enabled: boolean; filter?: OwnerFilter | undefined }): { pick: (() => void) | undefined; element: ReactNode } {
  const status = useQuery({ queryKey: ['imports-status'], queryFn: importApi.status, staleTime: 60_000, enabled: opts.enabled });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, enabled: opts.enabled });
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const pick = opts.enabled && status.data?.available ? () => input.current?.click() : undefined;
  const element = opts.enabled ? (
    <>
      <input
        ref={input}
        type="file"
        accept={IMPORT_ACCEPT}
        aria-label="Import a model as a custom part"
        data-testid="import-part-input"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) setFile(f);
        }}
      />
      {file && (
        <ImportDialog
          file={file}
          purpose="part"
          filter={opts.filter}
          isAdmin={!!me.data?.user?.isGlobalAdmin}
          onClose={() => setFile(null)}
          onDone={() => setFile(null)}
        />
      )}
    </>
  ) : null;
  return { pick, element };
}
