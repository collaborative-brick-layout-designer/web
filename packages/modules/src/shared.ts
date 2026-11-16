// A shared (read-only) placed module, as the layout's sidecar keeps it
// (docs/shared-modules.md): the module's value `m:<id>` has `shared` next
// to its link (`libraryModuleId`, `libraryVersion`).
//
//   shared: {
//     by:        the owner's public name when it was placed (for files with no server)
//     server:    where the module lives (the desktop can have several servers)
//     placement: how the version's coordinates map onto the layout (placement.ts)
//     review:    set by an update: which version it came from, so the apps
//                can say what changed, mark what it now overlaps, and offer
//                "Go back to version N". Cleared when someone presses OK.
//   }
//
// BlueBrick never sees any of it (the sidecar only), and an app that
// doesn't know the field keeps it as it is.

import type { SidecarModule } from '@cld/bbm';
import { readPlacement, type Placement } from './placement.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What an update left for the apps to show. */
export interface SharedReview {
  /** The version it had before; null when that wasn't known. */
  from: number | null;
  /** The version it has now. */
  to: number;
  /** When, in ms. */
  at: number;
}

/** The `shared` field of a placed module. */
export interface SharedLink {
  by?: string;
  server?: string;
  placement?: Placement;
  review?: SharedReview;
  /** Fields a newer build added; kept as they are. */
  [extra: string]: unknown;
}

/** A shared placed module's link, read from its sidecar value. */
export interface SharedPlaced {
  /** The module's id in the layout. */
  placedId: string;
  name: string;
  /** The library module it follows. */
  moduleId: string;
  /** The version it has; null when not known. */
  version: number | null;
  by: string | null;
  server: string | null;
  placement: Placement | null;
  review: SharedReview | null;
  members: string[];
}

type ModuleLike = Pick<SidecarModule, 'id' | 'name' | 'members' | 'libraryModuleId' | 'libraryVersion'> & { shared?: unknown };

function readReview(v: unknown): SharedReview | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.to !== 'number' || !Number.isInteger(o.to) || o.to < 1) return null;
  const from = typeof o.from === 'number' && Number.isInteger(o.from) && o.from > 0 ? o.from : null;
  return { from, to: o.to, at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0 };
}

/**
 * The module's shared link, or null when it isn't a shared (read-only)
 * placed module: it needs `shared` and a library module to follow.
 */
export function sharedPlaced(m: ModuleLike | null | undefined): SharedPlaced | null {
  if (!m || typeof m.id !== 'string') return null;
  const s = m.shared;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (typeof m.libraryModuleId !== 'string' || !UUID_RE.test(m.libraryModuleId)) return null;
  const o = s as Record<string, unknown>;
  return {
    placedId: m.id,
    name: typeof m.name === 'string' ? m.name : '',
    moduleId: m.libraryModuleId,
    version: typeof m.libraryVersion === 'number' && Number.isInteger(m.libraryVersion) && m.libraryVersion > 0 ? m.libraryVersion : null,
    by: typeof o.by === 'string' && o.by ? o.by : null,
    server: typeof o.server === 'string' && o.server ? o.server : null,
    placement: readPlacement(o.placement),
    review: readReview(o.review),
    members: Array.isArray(m.members) ? m.members.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** Whether a placed module is shared (read-only): its parts can't be changed in the layout. */
export function isSharedModule(m: ModuleLike | null | undefined): boolean {
  return sharedPlaced(m) !== null;
}

/** Every shared placed module of a sidecar (`readSidecarCache`'s answer). */
export function sharedModulesIn(sidecar: Record<string, unknown> | null | undefined): SharedPlaced[] {
  const list = Array.isArray(sidecar?.modules) ? (sidecar.modules as ModuleLike[]) : [];
  const out: SharedPlaced[] = [];
  for (const m of list) {
    const s = sharedPlaced(m);
    if (s) out.push(s);
  }
  return out;
}

/** The module's value with its `shared` field changed (the rest of `shared` kept; a field given as undefined is taken out). */
export function withShared<T extends object>(m: T, patch: { [K in keyof SharedLink]?: SharedLink[K] | undefined }): T {
  const had = (m as { shared?: unknown }).shared;
  const was = had && typeof had === 'object' && !Array.isArray(had) ? (had as SharedLink) : {};
  const next = { ...was, ...patch } as SharedLink;
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  return { ...m, shared: next };
}

/** The module's value as an ordinary module of the layout ("Make it mine"): unlocked, and no longer linked. */
export function detached<T extends object>(m: T): T {
  const { shared: _shared, libraryModuleId: _id, libraryVersion: _version, ...rest } = m as T & { shared?: unknown; libraryModuleId?: unknown; libraryVersion?: unknown };
  return rest as unknown as T;
}
