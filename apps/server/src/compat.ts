// Which desktop apps work with this server, and what this server can do.
// The values here follow compat/compat.json at the repo root — the same
// file the desktop app's tests read — and compat.test.ts checks they
// still agree. Change the JSON (in both repos) when you change these.

import type { FastifyInstance } from 'fastify';
import { getPlatformSettings } from './auth/platformSettings.js';
import { isOwnSignOut } from './auth/cookie.js';

/** The oldest desktop that works with this server (see compat.json "why"). */
export const DESKTOP_MINIMUM = '1.2.0';
/** The desktop this server suggests; older ones are asked to update. */
export const DESKTOP_RECOMMENDED = '1.4.0';
/** Where a desktop that must update is sent: the desktop's GitHub releases. */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/collaborative-brick-layout-designer/desktop/releases/latest';
/**
 * What the desktop app sends: `CollaborativeBrickLayoutDesigner/<version> (desktop)`
 * once it carries the new name, `BrickLayoutDesigner/<version> (desktop)` before.
 * Both are the desktop app; the older name stays accepted for good.
 */
export const DESKTOP_UA = /^(?:Collaborative)?BrickLayoutDesigner\/([0-9][0-9A-Za-z.+-]{0,31}) \(desktop\)/;

/** What this server can do, so a desktop can hide what it lacks. */
export const FEATURES = [
  'liveSync',
  'signIn',
  'publish',
  'clubs',
  'venues',
  'partsManifest',
  'partFilesWithToken',
  'uploadParts',
  'preferences',
  'ownerTags',
  // Usage limits (#148): a refusal says limit_reached with a sentence to show.
  'limits',
  // GET /api/layouts/:id/export.bld-layout, and each venue's size and date in GET /api/venues.
  'layoutDownload',
  // POST /api/catalog/submissions and GET /api/catalog/mine take the desktop's API token.
  'catalogShare',
  // POST /api/custom-parts takes a set (a <group> XML, no sprite), and the catalog and manifest list it.
  'uploadSets',
  // DELETE /api/custom-parts/:id takes the desktop's API token (parts:write), with the website's checks.
  'deletePartsFromDesktop',
] as const;

interface Parsed {
  nums: number[];
  pre: string;
}

function parse(v: string): Parsed | null {
  const m = /^[vV]?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: m[1]!.split('.').map(Number), pre: m[2] ?? '' };
}

/**
 * Compare two versions: -1, 0 or 1, or null when either can't be read.
 * Numbers compare as numbers ("1.10" > "1.9"), missing parts are 0, a
 * pre-release is older than its release, and "+build" is ignored.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (!pa.pre !== !pb.pre) return pa.pre ? -1 : 1;
  return 0;
}

/** The desktop version in a User-Agent, or null for anything else. */
export function desktopVersionOf(userAgent: string | undefined): string | null {
  return DESKTOP_UA.exec(userAgent ?? '')?.[1] ?? null;
}

export type Standing = 'ok' | 'updateSuggested' | 'updateRequired';

/**
 * Where a desktop version stands against a minimum and a recommended
 * version. A version that can't be read (a developer's build) is never
 * refused; an empty minimum or recommendation asks nothing.
 */
export function desktopStanding(app: string, minimum: string, recommended: string): Standing {
  if (minimum && compareVersions(app, minimum) === -1) return 'updateRequired';
  if (recommended && compareVersions(app, recommended) === -1) return 'updateSuggested';
  return 'ok';
}

export interface DesktopPolicy {
  minimum: string;
  recommended: string;
}

/**
 * The minimum an admin set (never below the code's own), and the
 * recommendation (never below that minimum).
 */
export function resolvePolicy(adminMinimum: string | null | undefined): DesktopPolicy {
  let minimum = DESKTOP_MINIMUM;
  if (adminMinimum && compareVersions(adminMinimum, minimum) === 1) minimum = adminMinimum;
  const recommended = compareVersions(minimum, DESKTOP_RECOMMENDED) === 1 ? minimum : DESKTOP_RECOMMENDED;
  return { minimum, recommended };
}

let cached: { policy: DesktopPolicy; at: number } | null = null;
const CACHE_MS = 60_000;

/** The policy in force, read from Admin › Settings at most once a minute. */
export async function desktopPolicy(now: number = Date.now()): Promise<DesktopPolicy> {
  if (cached && now - cached.at < CACHE_MS) return cached.policy;
  let adminMinimum: string | null = null;
  try {
    adminMinimum = (await getPlatformSettings()).minDesktopVersion;
  } catch {
    /* no database yet (tests, first start): the code's own minimum */
  }
  cached = { policy: resolvePolicy(adminMinimum), at: now };
  return cached.policy;
}

/** Forget the cached policy (Admin › Settings changed it). */
export function resetDesktopPolicy(): void {
  cached = null;
}

/** The friendly 426 body a too-old desktop gets. */
export function updateRequiredBody(minimum: string) {
  return {
    error: 'update_required',
    message: `This server needs Collaborative Brick Layout Designer ${minimum} or newer. Please download the new version.`,
    minimum,
    downloadUrl: DESKTOP_DOWNLOAD_URL,
  };
}

/**
 * Whether a request's desktop app is too old for this server: its
 * minimum, or null when it may go on (not the desktop app, or new enough).
 */
export async function blockedDesktopMinimum(userAgent: string | undefined): Promise<string | null> {
  const app = desktopVersionOf(userAgent);
  if (!app) return null;
  const { minimum } = await desktopPolicy();
  return desktopStanding(app, minimum, '') === 'updateRequired' ? minimum : null;
}

/** /api routes a too-old desktop may still reach: how it learns it must update. */
const OPEN_TO_OLD_DESKTOPS = new Set(['/api/version', '/api/health', '/api/health/ready']);

/**
 * Turn away API requests from desktop apps older than the minimum with a
 * clear 426 update_required (the live socket closes with 4426 instead;
 * see routes/ws.ts), rather than letting them fail in stranger ways.
 */
export function registerDesktopGate(app: FastifyInstance): void {
  // preHandler, after attachUser: the admin dashboard still counts the
  // person behind a refused request under their desktop version.
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?', 1)[0]!;
    if (!path.startsWith('/api/') || OPEN_TO_OLD_DESKTOPS.has(path)) return;
    // Sign Out works from any version: an old desktop can still end its own token.
    if (isOwnSignOut(req)) return;
    const minimum = await blockedDesktopMinimum(req.headers['user-agent']);
    if (minimum) return reply.code(426).header('Upgrade', 'BrickLayoutDesigner').send(updateRequiredBody(minimum));
  });
}
