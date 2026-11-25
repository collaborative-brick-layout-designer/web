// Clipboard for bricks — port of MapViewClipboard.cpp.
//
// Differences from desktop:
//   - Uses the BROWSER clipboard (navigator.clipboard) so paste survives
//     across tabs and reloads. The desktop's in-process clipboard works
//     fine because it's a single window; the web port's natural multi-
//     tab use case wants a real shared buffer.
//   - Also keeps this tab's own copy (in memory and sessionStorage, so
//     it survives opening another layout or a reload in the same tab)
//     for when the browser clipboard API is unavailable or denied (e.g.
//     a phone browser that won't let a page read the clipboard). Same
//     data shape, so paste-from-self always works; a paste takes the
//     newer of the two.
//
// Wire format: a JSON object tagged with a fixed `kind` discriminator
// so we can refuse foreign clipboard payloads.

import type { Brick, Group, RectangleF } from '@cld/model';
import type { PlacedSet, SidecarModule } from '@cld/bbm';

const CLIPBOARD_KIND = 'cbld-bricks/v1';

interface ClipboardEntry {
  /** Source layer NAME (not id) so paste finds-or-creates the same name. */
  sourceLayerName: string;
  /** Verbatim copy of the brick's serialisable fields. */
  brick: Pick<Brick, 'partNumber' | 'displayArea' | 'orientation' | 'altitude' | 'activeConnectionPointIndex'> & { myGroup?: string };
  /** Its id in the layout it was copied from (a copied module's places name it by that). */
  sourceId?: string;
  /** The groups (sets) the brick is in, innermost first, so a pasted set stays a set. */
  groups?: Group[];
  /** The brick is the anchor part of a placed custom set: its link, so the pasted set keeps track of its version. */
  placedSet?: PlacedSet;
}

interface ClipboardPayload {
  kind: typeof CLIPBOARD_KIND;
  version: 1;
  entries: ClipboardEntry[];
  /** The copied parts were exactly this module: a paste makes a copy of it. */
  module?: SidecarModule;
  /** When it was copied (ms since 1970), so the newer of the system's and this tab's copies is pasted. */
  copiedAt?: number;
}

/** What a paste found: the parts, and, when they were exactly one module, that module. */
export interface ClipboardContent {
  entries: ClipboardEntry[];
  module: SidecarModule | null;
}

/**
 * Whether the browser let the app use the system clipboard: `ok` (the
 * copy is there for other tabs, apps and devices), or `blocked` (denied,
 * or no clipboard here), so only this tab has it.
 */
export type SystemClipboard = 'ok' | 'blocked';

/** This tab's own copy, kept for the tab's life (a reload or another layout too), whatever the browser allows. */
const TAB_KEY = 'cbld-clipboard';
let memoryFallback: ClipboardPayload | null = null;

function tabCopy(): ClipboardPayload | null {
  if (memoryFallback) return memoryFallback;
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(TAB_KEY) : null;
    const parsed = raw ? parsePayload(raw) : null;
    if (parsed) memoryFallback = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function parsePayload(raw: string): ClipboardPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ClipboardPayload>;
    if (parsed && parsed.kind === CLIPBOARD_KIND && Array.isArray(parsed.entries)) return parsed as ClipboardPayload;
  } catch {
    /* not ours */
  }
  return null;
}

/**
 * Copies `entries` to the system clipboard and to this tab's own
 * clipboard. Says whether the system clipboard took it.
 */
export async function writeBricksToClipboard(entries: ClipboardEntry[], module?: SidecarModule | null): Promise<SystemClipboard> {
  const payload: ClipboardPayload = {
    kind: CLIPBOARD_KIND,
    version: 1,
    entries,
    ...(module ? { module } : {}),
    copiedAt: Date.now(),
  };
  memoryFallback = payload;
  const text = JSON.stringify(payload);
  try {
    sessionStorage.setItem(TAB_KEY, text);
  } catch {
    /* too big, or storage off: the copy in memory still pastes in this tab */
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return 'ok';
    } catch {
      /* permission denied / unsupported → this tab's copy */
    }
  }
  return 'blocked';
}

/** Read previously-written bricks. Returns null if clipboard is empty/foreign. */
export async function readBricksFromClipboard(): Promise<ClipboardEntry[] | null> {
  return (await readClipboard())?.entries ?? null;
}

/** The copied bricks and, when they were exactly one module, that module. */
export async function readClipboard(): Promise<ClipboardContent | null> {
  return (await readClipboardStatus()).content;
}

/**
 * What there is to paste: the newer of the system clipboard's copy (from
 * another tab, app or device) and this tab's own, and whether the browser
 * let the app read the system clipboard.
 */
export async function readClipboardStatus(): Promise<{ content: ClipboardContent | null; system: SystemClipboard }> {
  let fromSystem: ClipboardPayload | null = null;
  let system: SystemClipboard = 'blocked';
  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    try {
      fromSystem = parsePayload(await navigator.clipboard.readText());
      system = 'ok';
    } catch {
      /* denied → this tab's copy */
    }
  }
  const tab = tabCopy();
  const newer = fromSystem && tab && (tab.copiedAt ?? 0) > (fromSystem.copiedAt ?? 0) ? tab : (fromSystem ?? tab);
  return { content: newer ? { entries: newer.entries, module: newer.module ?? null } : null, system };
}

/**
 * Whether this session has bricks to paste, for the context menu's Paste
 * entry (desktop lists it only when the clipboard has content). The system
 * clipboard can't be checked without a permission prompt, so this knows
 * only this tab's copies; Ctrl+V still reads the system clipboard.
 */
export function hasClipboardBricks(): boolean {
  return (tabCopy()?.entries.length ?? 0) > 0;
}

/** For tests: forget this tab's copy. */
export function clearTabClipboard(): void {
  memoryFallback = null;
  try {
    sessionStorage.removeItem(TAB_KEY);
  } catch {
    /* nothing kept */
  }
}

export type { ClipboardEntry };

type Point = { x: number; y: number };

/**
 * Where a paste lands, in studs: under the cursor, or the centre of the
 * visible view when the cursor isn't over it (MapViewClipboard.cpp:64-69).
 * `view` is the stage size in px with its pan and zoom.
 */
export function pasteTarget(
  pointer: Point | null,
  view: { width: number; height: number; panX: number; panY: number; zoom: number },
  pxPerStud = 8,
): Point {
  if (pointer) return pointer;
  return {
    x: (view.width / 2 - view.panX) / view.zoom / pxPerStud,
    y: (view.height / 2 - view.panY) / view.zoom / pxPerStud,
  };
}

/**
 * The move that puts the average of the boxes' centres on `target` —
 * computed over the whole clipboard, before the budget leaves any out
 * (MapViewClipboard.cpp:70-73).
 */
export function pasteOffset(areas: readonly RectangleF[], target: Point): { dx: number; dy: number } {
  if (areas.length === 0) return { dx: 0, dy: 0 };
  let cx = 0;
  let cy = 0;
  for (const a of areas) {
    cx += a.x + a.width / 2;
    cy += a.y + a.height / 2;
  }
  return { dx: target.x - cx / areas.length, dy: target.y - cy / areas.length };
}
