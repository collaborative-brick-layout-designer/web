// Fetch a saved library module's Y.Doc snapshot and turn it into
// per-layer insert batches. Shared by the module-library panel (click /
// drag to canvas) and the Insert Module dialog.

import * as Y from 'yjs';
import { docToBbm } from '@cld/ydoc';
import type { ModuleBatch } from './mutations';
import { moduleBatchesFromMap } from './moduleDrop';
import { api, reach } from '../api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What placing a module with no parts says (it was made but never built). */
export const EMPTY_MODULE = 'This module has no parts yet. Open it from Home and add some first.';

export async function fetchModuleBatches(moduleId: string): Promise<ModuleBatch[]> {
  if (!UUID_RE.test(moduleId)) throw new Error('invalid module id');
  // Same-origin relative fetch; the id is a validated UUID.
  const res = await reach(fetch(`/api/modules/${moduleId}/snapshot`, { credentials: 'include' }));
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const moduleDoc = new Y.Doc();
  try {
    Y.applyUpdate(moduleDoc, new Uint8Array(buf));
    const batches = moduleBatchesFromMap(docToBbm(moduleDoc));
    if (batches.length === 0) throw new Error(EMPTY_MODULE);
    return batches;
  } catch (e) {
    if (e instanceof Error && e.message === EMPTY_MODULE) throw e;
    throw new Error('This module couldn’t be read. Open it from Home to check it.', { cause: e });
  } finally {
    moduleDoc.destroy();
  }
}

/**
 * The library module's newest version number, for linking a placed copy
 * to it (Update from library); undefined when it can't be told.
 */
export async function libraryVersionOf(moduleId: string): Promise<number | undefined> {
  try {
    return (await api.modules.get(moduleId)).module.latestVersion || undefined;
  } catch {
    return undefined;
  }
}
