import { forgetDemoVisitor } from './demo/demoVisitor';
import type { FourDBrixRemap, LDrawRemap, TrackDesignerRemap } from '@cld/parts-catalog/browser';
import type { ClubRole } from './orgs/clubRoles';
import { askForPermission, isClubPermission, type ClubPermission } from './orgs/clubPermissions';
import type { Venue } from '@cld/bbm';

export type ProviderId = 'google' | 'github' | 'oidc';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  /** The name other people see (never an email address). */
  publicName?: string;
  /** No name yet, or it looks like an email: ask "What should we call you?". */
  needsName?: boolean;
  /** A starting point for that prompt: the part of the email before '@'. */
  suggestedName?: string;
  avatarUrl: string | null;
  /** The shared demo account (Admin › Settings › Demo account). */
  isDemoAccount: boolean;
  isGlobalAdmin: boolean;
  /** Reviews the public catalogs (global admins can too). */
  isModerator?: boolean;
  /** On hold (read only) while a privacy request is looked at (older servers leave it out). */
  restricted?: boolean;
  linkedProviders: ProviderId[];
  /** False when the account has no password yet (older servers leave it out). */
  hasPassword?: boolean;
  /** Only on the demo account: how often it resets, and when next. */
  demo?: DemoStatus;
}

export type DemoResetEvery = '1h' | '6h' | 'daily';

export interface DemoStatus {
  enabled: boolean;
  resetEvery: DemoResetEvery;
  lastResetAt: number | null;
  nextResetAt: number | null;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  enabled: boolean;
}

/**
 * Curated overrides for error codes whose humanized form (see
 * `humanizeErrorCode`) would read awkwardly or ambiguously in a form's
 * inline error text. Everything else falls through to the generic
 * snake_case → sentence conversion.
 */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Incorrect email or password.',
  invalid_input: 'Please fill in all required fields.',
  invalid_password: 'Use a password of 8 to 128 characters.',
  password_already_set: 'This account already has a password.',
  name_taken: 'Another saved venue already has that name.',
  not_an_org_member: 'You are not in that club.',
  not_a_member_of_recipient_org: 'You are not in that club.',
  org_not_found: 'That club was not found.',
  recipient_org_not_found: 'That club was not found.',
  only_club_admins_can_add: 'Your roles in this club can’t add this here. Ask a club admin.',
  only_admins_set_roles: 'Only club admins give that role.',
  last_admin: 'A club needs at least one admin. Make someone else an admin first, or hand the club over.',
  confirm_name_mismatch: 'Type the club’s name exactly to delete it.',
  slug_taken: 'Another club already uses that address.',
  invalid_slug: 'Use lowercase letters, numbers and dashes for the address.',
  already_member: 'That person is already in the club.',
  invite_only: 'This club takes new members by invite only. Ask one of its admins.',
  too_many_requests: 'You’re waiting to hear from a lot of clubs already. Take some requests back, or wait for an answer.',
  message_too_long: 'Please keep the note to 300 characters.',
  invalid_join_policy: 'Pick who can join: Invite only, Ask to join or Open.',
  invalid_expiry: 'Pick between 1 and 30 days.',
  org_owned_rooms_can_only_move_to_orgs: "A club's venue stays with the club. Its author can take it back, or make a copy for yourself.",
  org_owned_layouts_can_only_transfer_to_orgs: "A club's layout stays with the club. Its author can take it back, or make a copy for yourself.",
  parts_can_only_move_to_clubs: 'Parts move to a club. To have your own, make a copy.',
  only_the_author_can_take_back: 'Only the person who made it can take it back.',
  only_club_admins_can_give_back: 'Ask a club admin for the Delete club items permission.',
  author_gone: 'The person who made it no longer has an account here.',
  already_returned: 'This is the club’s copy; its author already has the original.',
  author_handed_it_over: 'Its author handed it to someone else, so it stays with the club.',
  part_invite_no_longer_valid: 'This invite no longer works: the part changed hands, or the person who sent it no longer manages it. Ask its owner for a new one.',
  module_invite_no_longer_valid: 'This invite no longer works: the module changed hands, or the person who sent it no longer manages it. Ask its owner for a new one.',
  already_has_access: 'That person already has access.',
  invite_no_longer_valid: 'This invite no longer works: the layout changed hands, or the person who sent it no longer manages it. Ask its owner for a new one.',
  already_yours: 'It’s already yours.',
  part_number_taken: 'There’s already a part with that number there.',
  set_named_like_its_part: 'A set can’t have the same name as a part inside it. Pick another name.',
  invalid_email: 'Enter a valid email address.',
  forbidden: "You don't have permission to do that.",
  not_found: 'That item could not be found.',
  payload_too_large: 'That file is too large.',
  email_not_verified: 'Please verify your email before signing in — check your inbox for the confirmation link.',
  verification_not_found: 'That verification link is invalid.',
  verification_expired: 'That verification link has expired. Request a new one below.',
  invalid_display_name: 'Display name must be between 1 and 60 characters.',
  name_looks_like_email: 'Other people see your name, so it can’t be an email address. Try your first name or a nickname.',
  invalid_code: 'That code is invalid or has expired. Check the code shown in the app.',
  limit_reached: 'You’ve reached a limit on this site. Ask the site admin for more room.',
  suspended: 'This account is read-only for now. Ask the site admin why.',
  rate_limited: 'Too many requests at once. Please wait a minute and try again.',
  verify_email_first: 'Please confirm your email address first.',
  demo_off: 'The demo isn’t available right now.',
  transfer_to_club_only: 'A module can only be moved to a club you’re in. Make a copy for one person instead.',
  demo_account_cannot_invite: 'The demo can’t invite people. Sign up to share with others.',
  demo_account_cannot_share: 'The demo can’t share or hand things over. Sign up to share with others.',
  demo_account_cannot_create_org: 'The demo can’t make clubs. Sign up to start one.',
  demo_account_cannot_join_clubs: 'The demo can’t join clubs. Sign up to join one.',
  demo_account_cannot_upload_parts: 'The demo can’t upload parts. Sign up to add your own.',
  demo_account_cannot_submit: 'The demo can’t add to the public catalog.',
  collection_empty: 'Pick at least one item for the collection.',
  invalid_cover: 'That picture can’t be used. Choose a PNG, JPEG or WebP photo.',
  logo_too_large: 'That picture is too big for a logo. Choose a smaller one.',
  cover_too_large: 'That picture is too big. Choose a smaller one.',
  collection_too_big: 'A collection can hold up to 60 items.',
  item_not_public: 'One of the items isn’t in the public catalog any more. Take it out and try again.',
  not_featurable: 'Only collections made by moderators can be featured.',
  already_in_collection: 'It’s in that collection already.',
  module_not_in_club: 'Only the club’s own modules can go in a club collection.',
  module_not_yours: 'Only your own modules can go in your collection.',
  part_not_in_club: 'Only the club’s own parts can go in a club collection.',
  part_not_yours: 'Only your own parts can go in your collection.',
  only_club_admins_can_curate: 'Ask a club admin for the Send to the catalog permission.',
  not_public: 'This collection isn’t in the public catalog.',
  demo_account_cannot_change_profile: 'The demo’s name can’t be changed.',
  demo_account_cannot_use_desktop: 'The desktop app can’t sign in to the demo. Sign up to use it.',
  demo_account_cannot_link: 'The demo can’t be linked to another sign-in.',
};

/** Errors whose server message is the sentence to show (privacy: "You can ask again after …"). */
const MESSAGE_ERRORS = new Set(['invalid_logo', 'only_club_admins', 'only_admins_edit_roles', 'admin_role_fixed', 'builtin_role', 'role_in_use', 'role_name_taken', 'too_many_roles', 'only_admins_set_roles', 'last_admin', 'only_club_admins_can_give_back', 'export_too_soon', 'export_gone', 'demo_account', 'confirm_mismatch', 'deletion_blocked', 'account_pending_deletion', 'account_restricted', 'invalid_contact', 'no_account', 'subject_required', 'heir_not_member', 'sign_in_max_below_idle']);

/** A 403 the site's firewall answered (empty or non-JSON body), not the app. */
/** What a request says when it never reached the server (no Wi-Fi, server down). */
export function unreachableMessage(online: boolean = typeof navigator === 'undefined' || navigator.onLine !== false): string {
  return online
    ? "Couldn't reach the server. Check the connection and try again."
    : "You're offline. Check the Wi-Fi and try again.";
}

/**
 * A request that never reached the server fails with a plain sentence
 * instead of the browser's "Failed to fetch": `await reach(fetch(…))`.
 * (An abort stays an abort.)
 */
export function reach<T>(request: Promise<T>): Promise<T> {
  return Promise.resolve(request).catch((e: unknown) => {
    if (e instanceof TypeError) throw new Error(unreachableMessage(), { cause: e });
    throw e;
  });
}

export const FIREWALL_BLOCKED =
  "The site's firewall blocked this request. Please tell the site admin (what you were doing, and the time).";

/** "Too many tries. Please wait 30 seconds and try again." (`seconds` from Retry-After; null: unknown). */
export function tooManyTriesMessage(seconds: number | null): string {
  if (seconds === null) return 'Too many tries. Please wait a little and try again.';
  const s = Math.ceil(seconds);
  const wait = s < 60 ? `${s} second${s === 1 ? '' : 's'}` : `${Math.ceil(s / 60)} minute${Math.ceil(s / 60) === 1 ? '' : 's'}`;
  return `Too many tries. Please wait ${wait} and try again.`;
}

/** `some_error_code` -> "Some error code." */
function humanizeErrorCode(code: string): string {
  const words = code.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1) + '.';
}

/**
 * Reads `{ error: string }` from a failed JSON response and turns it
 * into a message fit for direct display in the UI — never the raw
 * `path → status`, which used to leak straight into forms (e.g. a
 * failed login showing "/api/auth/password/login → 401").
 */
async function friendlyErrorMessage(res: Response, method = 'GET', path = res.url): Promise<string> {
  type ErrorBody = { error?: unknown; message?: unknown };
  let body: ErrorBody | null = null;
  try {
    const parsed: unknown = await res.clone().json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as ErrorBody;
  } catch {
    // Not JSON.
  }
  // A 403 the app never saw: the site's firewall (WAF) answered it with an
  // empty or non-JSON body. That isn't a permissions problem.
  if (res.status === 403 && !body) {
    console.warn(`The site's firewall blocked ${method} ${path} (${new Date().toISOString()})`);
    return FIREWALL_BLOCKED;
  }
  // Too many tries (sign-in pacing, or the plain per-address limit, which
  // has no app error code): say how long to wait. Other 429s carry their
  // own code and sentence.
  const appCode = typeof body?.error === 'string' && /^[a-z_]+$/.test(body.error);
  if (res.status === 429 && (body?.error === 'login_paced' || !appCode)) {
    const fromBody = body && typeof (body as { retryAfter?: unknown }).retryAfter === 'number' ? (body as { retryAfter: number }).retryAfter : NaN;
    const seconds = Number.isFinite(fromBody) ? fromBody : Number(res.headers.get('retry-after'));
    return tooManyTriesMessage(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
  }
  if (body) {
    // Limits, suspension and rate limits come with a ready-made sentence
    // that names the limit ("Your club has used its 10 GB. …").
    if (
      (body.error === 'limit_reached' ||
        body.error === 'suspended' ||
        body.error === 'rate_limited' ||
        body.error === 'verify_email_first' ||
        MESSAGE_ERRORS.has(body.error as string)) &&
      typeof body.message === 'string' &&
      body.message
    ) {
      return body.message;
    }
    // A club permission the caller's roles don't give: name it, and who to ask.
    const perm = (body as { permission?: unknown }).permission;
    if (res.status === 403 && isClubPermission(perm)) return askForPermission(perm);
    if (typeof body.error === 'string' && body.error) {
      return ERROR_MESSAGES[body.error] ?? humanizeErrorCode(body.error);
    }
  }
  if (res.status === 401) return 'You need to sign in to do that.';
  if (res.status === 403) return "You don't have permission to do that.";
  if (res.status >= 500) return 'Something went wrong on our end. Please try again.';
  return 'Something went wrong. Please try again.';
}

/**
 * Every successful change this tab makes (POST / PUT / PATCH / DELETE)
 * is reported here, so the lists that show what changed refetch (see
 * live/invalidate.ts). Writes made outside these helpers call
 * `noteWrite` themselves.
 */
type WriteListener = (method: string, path: string) => void;
const writeListeners = new Set<WriteListener>();

export function onApiWrite(fn: WriteListener): () => void {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

export function noteWrite(method: string, path: string): void {
  for (const fn of writeListeners) {
    try {
      fn(method, path);
    } catch {
      // A listener's trouble never fails the write.
    }
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  return get<T>(path);
}

/** JSON request with the same friendly errors (for lazily loaded admin code). */
export async function apiSend<T>(method: 'PATCH' | 'PUT' | 'POST' | 'DELETE', path: string, body: unknown): Promise<T> {
  const res = await reach(fetch(path, {
    method,
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, method, path));
  noteWrite(method, path);
  return res.json() as Promise<T>;
}

function get<T>(path: string): Promise<T> {
  return reach(getJson<T>(path));
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'GET', path));
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: 'POST', credentials: 'include' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await reach(fetch(path, init));
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'POST', path));
  noteWrite('POST', path);
  return res.json() as Promise<T>;
}

/** Who owns a layout, venue or module: a person, or a club. */
export interface OwnerInfo {
  kind: 'user' | 'org';
  id: string;
  name: string;
  /** The club's slug; null for a person. */
  slug: string | null;
}

/**
 * Author credit (newer servers): "by Sam · in ArkLUG", "based on Yard by
 * Sam", and whether you may take it back or give it back to its author.
 */
export interface Credit {
  /** "you", a name, "a former member" or "Builder #…"; null when nobody is recorded. */
  by: string | null;
  /** The author's name while their account exists ("Give back to ‹name›"). */
  authorName: string | null;
  /** The club that holds it. */
  club: string | null;
  basedOn: { id: string; title: string; by: string | null } | null;
  canTakeBack: boolean;
  canGiveBack: boolean;
}

/** The four kinds of thing a person makes, as their API paths. */
export type OwnableKind = 'layouts' | 'modules' | 'venues' | 'custom-parts';

export interface VenueSummary {
  id: string;
  name: string;
  ownerUserId?: string | null;
  ownerOrgId: string | null;
  ownerOrgName?: string | null;
  ownerOrgSlug?: string | null;
  /** May rename, redesign, move or delete it (yours, or a club you admin). */
  canManage?: boolean;
  owner?: OwnerInfo | null;
  credit?: Credit | null;
  /** When it was saved (ms), and its size in studs (0: no outline); older servers leave them out. */
  createdAt?: number;
  widthStuds?: number;
  heightStuds?: number;
}

export interface LayoutSummary {
  id: string;
  title: string;
  /** The caller's role on it (list responses). */
  role?: 'owner' | 'editor' | 'viewer' | null;
  owner?: OwnerInfo | null;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  ownerOrgName: string | null;
  ownerOrgSlug: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  docVersion: number;
  hasSidecar: boolean;
  /**
   * Non-null when the layout is publicly shared. The token is the
   * suffix of the share URL (`/p/<token>`). Null = private.
   */
  publicShareToken: string | null;
  credit?: Credit | null;
}

/** Anonymous-readable summary for `/p/:token` viewer pages. */
export interface PublicLayoutSummary {
  id: string;
  title: string;
  updatedAt: number;
  docVersion: number;
  hasSidecar: boolean;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await reach(fetch(path, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'PATCH', path));
  noteWrite('PATCH', path);
  return res.json() as Promise<T>;
}

async function del(path: string): Promise<void> {
  const res = await reach(fetch(path, { method: 'DELETE', credentials: 'include' }));
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'DELETE', path));
  noteWrite('DELETE', path);
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await reach(fetch(path, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'PUT', path));
  noteWrite('PUT', path);
  return res.json() as Promise<T>;
}

export interface ConnectionPointWire {
  type: string;
  x: number;
  y: number;
  angle: number;
  electricPlug: number;
  nextConnexionPreference?: number;
}

export interface SubPartWire {
  /** Catalog key of the referenced part. */
  subKey: string;
  /** Local position in studs, relative to the group's origin. */
  x: number;
  y: number;
  /** Local rotation in degrees. */
  angle: number;
}

/** A part's `<SnapMargin>`, in studs (a 9V straight's half stud each side of the rails). */
export interface SnapMarginWire {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PartWire {
  key: string;
  partNumber: string;
  colorCode: string;
  kind: 'leaf' | 'group';
  description: string;
  sortingKey: string;
  /** Empty for source: 'custom' (use spriteUrlFor to compose). */
  spritePath: string;
  pxPerStud: number;
  /** Parent folder of the part XML — drives the category dropdown. */
  category: string;
  connections: ConnectionPointWire[];
  /** Group-only: subparts that compose this set; empty for leaves. */
  subparts: SubPartWire[];
  /** Group-only: false when the set may never be split (<CanUngroup>, flex.group); absent otherwise. */
  canUngroup?: false;
  /** Group-only: the set's <GroupConnectionPreferenceList> (connection index -> next); absent when none. */
  groupNextPreferred?: Record<number, number>;
  /** Hull polygon in pixel space (relative to sprite top-left). Empty = use bounding rect. */
  hullPts: { x: number; y: number }[];
  /** `<SnapMargin>` in studs: what grid snapping leaves out of the sprite; absent when none. */
  snapMargin?: SnapMarginWire;
  /** `<PickShape>`: an imported part's outline rings (holes too), studs around the sprite centre; absent when none. */
  pickShape?: { x: number; y: number }[][];
  /** Who built the model an imported part was made from (`<Designer>`). */
  designer?: { name: string; url?: string };
  source: 'bundled' | 'custom';
  /** Set on source: 'custom' so the editor can build the sprite URL. */
  customPartId: string | null;
  /** A custom set: no sprite of its own (its parts draw it). */
  noSprite?: true;
  /** A custom set: its version, so placed copies can say "Update available" when it changes (editor/setUpdates.ts). */
  setVersion?: string;
  /** BlueBrick's <NotListedInLibrary>: only placed inside its sets, not listed or placed by itself (editor/hiddenParts.ts). */
  notListed?: true;
  /** Earlier part numbers that resolve to this part (<OldNameList>); absent when none. */
  oldNames?: string[];
  /** Sprite size in pixels, for the BlueBrick footprint; absent when unreadable. */
  spriteSize?: { w: number; h: number };
  /** Map-format remaps, for opening and saving LDraw / TrackDesigner / 4DBrix maps; absent when none. */
  ldraw?: LDrawRemap;
  trackDesigner?: TrackDesignerRemap;
  fourDBrix?: FourDBrixRemap;
}

/** Resolve the sprite URL for any part, regardless of source. */
export function spriteUrlFor(part: PartWire): string {
  if (part.noSprite) return '';
  if (part.source === 'custom' && part.customPartId) {
    return `/api/custom-parts/${part.customPartId}/sprite`;
  }
  return part.spritePath ? `/parts/${part.spritePath}` : '';
}

async function getBytes(path: string): Promise<{ bytes: Uint8Array; docVersion: number }> {
  const res = await reach(fetch(path, { credentials: 'include' }));
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'GET', path));
  const buf = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(buf),
    docVersion: Number.parseInt(res.headers.get('x-doc-version') ?? '0', 10),
  };
}

async function putBytes(path: string, bytes: Uint8Array): Promise<{ updatedAt: number }> {
  const res = await reach(fetch(path, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/octet-stream' },
    // TypeScript 7's DOM lib types narrowed BodyInit to require
    // Uint8Array<ArrayBuffer> specifically, rejecting the more general
    // Uint8Array (which could theoretically back a SharedArrayBuffer,
    // though nothing in this codebase ever produces one here).
    body: bytes as Uint8Array<ArrayBuffer>,
  }));
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'PUT', path));
  noteWrite('PUT', path);
  return res.json() as Promise<{ updatedAt: number }>;
}

/** Scopes an API token (desktop sign-in) can carry. */
export type ApiScope =
  | 'layouts:read'
  | 'layouts:write'
  | 'layouts:create'
  | 'parts:read'
  | 'parts:write'
  | 'venues:read'
  | 'venues:write'
  | 'account:prefs';

/** A pending desktop sign-in, as shown on the /device approval page. */
export interface DeviceRequest {
  clientName: string;
  scopes: ApiScope[];
  expiresAt: number;
}

/** An API token in the Devices list. The secret itself is never returned. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: ApiScope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}

export const api = {
  me: () => get<{ user: Me | null }>('/api/auth/me'),
  updateDisplayName: (displayName: string) =>
    patch<{ ok: true; displayName: string }>('/api/auth/me', { displayName }),
  providers: () =>
    get<{ providers: ProviderInfo[]; passwordEnabled: boolean; demoEnabled?: boolean }>('/api/auth/providers'),
  logout: () => {
    // Signing out on purpose: no "The demo was reset" afterwards.
    forgetDemoVisitor();
    return post<{ ok: true }>('/api/auth/logout');
  },
  /** "Try the demo": sign in as the shared demo account (JSON, empty object body). */
  tryDemo: () => post<{ ok: true }>('/api/auth/demo', {}),
  passwordLogin: (email: string, password: string) =>
    post<{ ok: true }>('/api/auth/password/login', { email, password }),
  /**
   * `next`: where to go once the emailed link is opened (a path on this
   * site). `verificationRequired: false` means the site doesn't ask for
   * the email check and the new account is already signed in.
   */
  passwordRegister: (email: string, password: string, displayName?: string, next?: string) =>
    post<{ ok: true; verificationRequired: boolean }>('/api/auth/password/register', {
      email,
      password,
      displayName,
      ...(next && next !== '/' ? { next } : {}),
    }),
  resendVerification: (email: string, next?: string) =>
    post<{ ok: true }>('/api/auth/password/resend-verification', { email, ...(next && next !== '/' ? { next } : {}) }),
  /** `needsPassword`: signed in, but the account has no password yet; ask for one (setPassword). */
  verifyEmail: (token: string) =>
    post<{ ok: true; needsPassword?: boolean }>(`/api/auth/password/verify-email/${encodeURIComponent(token)}`),
  /** Choose a password for the signed-in account when it has none. */
  setPassword: (password: string) => post<{ ok: true }>('/api/auth/password/set', { password }),

  /** Desktop sign-in (device-code flow), the signed-in user's side. */
  device: {
    lookup: (userCode: string) => post<DeviceRequest>('/api/auth/device/lookup', { user_code: userCode }),
    approve: (userCode: string) => post<{ ok: true }>('/api/auth/device/approve', { user_code: userCode }),
    deny: (userCode: string) => post<{ ok: true }>('/api/auth/device/deny', { user_code: userCode }),
  },
  tokens: {
    list: () => get<{ tokens: ApiTokenSummary[] }>('/api/tokens'),
    revoke: (id: string) => del(`/api/tokens/${encodeURIComponent(id)}`),
  },

  layouts: {
    list: () => get<{ layouts: LayoutSummary[] }>('/api/layouts'),
    /** Copy into your own layouts (no `orgSlug`) or a club's. */
    copy: (id: string, orgSlug?: string) =>
      post<{ id: string; title: string }>(`/api/layouts/${encodeURIComponent(id)}/copy`, orgSlug ? { orgSlug } : {}),
    get: (id: string) => get<{ layout: LayoutSummary; role: 'owner' | 'editor' | 'viewer' }>(
      `/api/layouts/${id}`,
    ),
    /** `backgroundImage` is a .bld-layout's image: the server keeps it and points the sidecar at it. */
    create: (body: {
      title?: string;
      bbm?: string;
      sidecar?: string;
      orgSlug?: string;
      backgroundImage?: { type: string; data: Uint8Array };
    }) => {
      const { backgroundImage, ...rest } = body;
      return post<{ id: string; title: string }>(
        '/api/layouts',
        backgroundImage ? { ...rest, backgroundImage: { type: backgroundImage.type, data: toBase64(backgroundImage.data) } } : rest,
      );
    },
    rename: (id: string, title: string) =>
      patch<{ ok: true }>(`/api/layouts/${id}`, { title }),
    remove: (id: string) => del(`/api/layouts/${id}`),
    exportBbmUrl: (id: string) => `/api/layouts/${id}/export.bbm`,
    exportSidecarUrl: (id: string) => `/api/layouts/${id}/export.bbm.bld`,
    exportZipUrl: (id: string) => `/api/layouts/${id}/export.zip`,
    snapshot: (id: string) => getBytes(`/api/layouts/${id}/snapshot`),
    saveSnapshot: (id: string, bytes: Uint8Array) =>
      putBytes(`/api/layouts/${id}/snapshot`, bytes),
    enablePublicShare: (id: string) =>
      post<{ token: string }>(`/api/layouts/${id}/public-share`),
    disablePublicShare: (id: string) =>
      del(`/api/layouts/${id}/public-share`),
  },

  publicLayouts: {
    get: (token: string) =>
      // `layout: null`: the link was switched off, or its layout deleted.
      get<{ layout: PublicLayoutSummary | null }>(`/api/public-layouts/${token}`),
    snapshot: (token: string) => getBytes(`/api/public-layouts/${token}/snapshot`),
  },

  parts: {
    /**
     * The catalog. The browser always asks the server again (a cheap 304
     * when nothing changed, by its ETag), so a part or set added or renamed
     * here, in another tab or on the desktop shows on the next read and
     * after a reload, never the list from before the change.
     */
    catalog: async () => {
      const res = await reach(fetch('/api/parts/catalog', { credentials: 'include', cache: 'no-cache' }));
      if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'GET', '/api/parts/catalog'));
      return (await res.json()) as { parts: PartWire[] };
    },
  },

  collaborators: {
    list: (layoutId: string) =>
      get<{ collaborators: CollaboratorSummary[]; invites: InviteSummary[] }>(
        `/api/layouts/${layoutId}/collaborators`,
      ),
    invite: (layoutId: string, email: string, role: 'viewer' | 'editor') =>
      post<{
        id: string;
        token: string;
        inviteUrl: string;
        emailDelivered: boolean;
        /** Why it wasn’t emailed, when the sender reached today’s email cap. */
        emailNote?: string;
        expiresAt: number;
      }>(`/api/layouts/${layoutId}/invites`, { email, role }),
    revokeInvite: (layoutId: string, inviteId: string) =>
      del(`/api/layouts/${layoutId}/invites/${inviteId}`),
    changeRole: (layoutId: string, userId: string, role: 'viewer' | 'editor') =>
      patch<{ ok: true }>(`/api/layouts/${layoutId}/collaborators/${userId}`, { role }),
    remove: (layoutId: string, userId: string) =>
      del(`/api/layouts/${layoutId}/collaborators/${userId}`),
  },

  invites: {
    preview: (token: string) =>
      get<{
        /** Masked ("s…@example.com") unless the invite is for the signed-in account. */
        invitedEmail: string;
        /** Whether it's for the signed-in account; null when signed out. */
        forYou: boolean | null;
        role: 'viewer' | 'editor';
        layoutId: string;
        layoutTitle: string;
        expiresAt: number;
      }>(`/api/invites/${token}`),
    accept: (token: string) =>
      post<{ layoutId: string; role: 'viewer' | 'editor' }>(`/api/invites/${token}`),
  },

  /** A trusted club's own review (its admins and managers). */
  clubReview: {
    get: (slug: string) => get<ClubReview>(`/api/orgs/${encodeURIComponent(slug)}/review`),
    decideVersion: (slug: string, versionId: string, approve: boolean, reason = '') =>
      post<{ ok: true }>(`/api/orgs/${encodeURIComponent(slug)}/review/versions/${encodeURIComponent(versionId)}/${approve ? 'approve' : 'decline'}`, approve ? {} : { reason }),
    decideCover: (slug: string, itemId: string, approve: boolean, reason = '') =>
      post<{ ok: true }>(`/api/orgs/${encodeURIComponent(slug)}/review/items/${encodeURIComponent(itemId)}/cover/${approve ? 'approve' : 'decline'}`, approve ? {} : { reason }),
    unpublishItem: (slug: string, id: string, reason: string) =>
      post<{ ok: true }>(`/api/orgs/${encodeURIComponent(slug)}/review/items/${encodeURIComponent(id)}/unpublish`, { reason }),
    decideCollection: (slug: string, id: string, approve: boolean, reason = '') =>
      post<{ ok: true }>(`/api/orgs/${encodeURIComponent(slug)}/review/collections/${encodeURIComponent(id)}/${approve ? 'approve' : 'decline'}`, approve ? {} : { reason }),
    unpublishCollection: (slug: string, id: string, reason: string) =>
      post<{ ok: true }>(`/api/orgs/${encodeURIComponent(slug)}/review/collections/${encodeURIComponent(id)}/unpublish`, { reason }),
  },

  orgs: {
    list: () => get<{ orgs: OrgSummary[] }>('/api/orgs'),
    /** A club admin sets the club's logo: PNG, JPEG, WebP or SVG, as base64. */
    setLogo: (slug: string, body: { mime: string; data: string }) => put<{ ok: true; logoUrl: string | null }>(`/api/orgs/${encodeURIComponent(slug)}/logo`, body),
    removeLogo: (slug: string) => del(`/api/orgs/${encodeURIComponent(slug)}/logo`),
    /**
     * Create an org. `slug` is optional — when omitted, the server
     * auto-derives one from `name` and disambiguates with a numeric
     * suffix on collision. Older callers can still pass a manual slug.
     */
    create: (name: string, slug?: string) =>
      post<{ id: string; name: string; slug: string }>(
        '/api/orgs',
        slug ? { name, slug } : { name },
      ),
    get: (slug: string) => get<OrgDetail>(`/api/orgs/${slug}`),
    members: (slug: string) =>
      get<{ members: OrgMemberSummary[]; invites: OrgInviteSummary[]; roles?: ClubRoleSummary[] }>(
        `/api/orgs/${slug}/members`,
      ),
    /** The club's roles (everyone in it sees them), and mine. */
    roles: (slug: string) =>
      get<{ roles: ClubRoleSummary[]; mine: string[]; permissions: ClubPermission[]; isAdmin: boolean }>(`/api/orgs/${slug}/roles`),
    /** Admins: a new role. */
    createRole: (slug: string, name: string, permissions: ClubPermission[]) =>
      post<{ id: string; name: string; permissions: ClubPermission[] }>(`/api/orgs/${slug}/roles`, { name, permissions }),
    /** Admins: rename a role or change what it allows (not the Admin role). */
    updateRole: (slug: string, roleId: string, body: { name?: string; permissions?: ClubPermission[] }) =>
      patch<{ ok: true }>(`/api/orgs/${slug}/roles/${encodeURIComponent(roleId)}`, body),
    /** Admins: delete a role nobody holds (not the four starting ones). */
    deleteRole: (slug: string, roleId: string) => del(`/api/orgs/${slug}/roles/${encodeURIComponent(roleId)}`),
    /** Every role a member holds (at least one). */
    setMemberRoles: (slug: string, userId: string, roleIds: string[]) =>
      patch<{ ok: true; roleIds: string[]; role: ClubRole }>(`/api/orgs/${slug}/members/${userId}`, { roleIds }),
    /** Invite by email, OR by userId (the autocomplete path — see searchUsers). Pass exactly one. */
    invite: (
      slug: string,
      target: { email: string } | { userId: string },
      role: ClubRole | { roleId: string },
      /** 1 to 30; the server's default is 14. */
      expiresInDays?: number,
    ) =>
      post<{
        id: string;
        token: string;
        inviteUrl: string;
        emailDelivered: boolean;
        /** Why it wasn’t emailed, when the sender reached today’s email cap. */
        emailNote?: string;
        expiresAt: number;
      }>(`/api/orgs/${slug}/invites`, { ...target, ...(typeof role === 'string' ? { role } : role), ...(expiresInDays ? { expiresInDays } : {}) }),
    /** Send an invite again, with a fresh expiry. */
    resendInvite: (slug: string, inviteId: string, expiresInDays?: number) =>
      post<{ ok: true; inviteUrl: string; emailDelivered: boolean; emailNote?: string; expiresAt: number }>(
        `/api/orgs/${slug}/invites/${encodeURIComponent(inviteId)}/resend`,
        expiresInDays ? { expiresInDays } : {},
      ),
    /** Club settings (admins): name, address, description, who may add things. */
    update: (
      slug: string,
      body: {
        name?: string;
        slug?: string;
        description?: string;
        membersCanCreate?: boolean;
        joinPolicy?: JoinPolicy;
        listed?: boolean;
      },
    ) => patch<{ ok: true; slug: string; name: string }>(`/api/orgs/${slug}`, body),
    /**
     * Delete the club: it's hidden now and deleted for good after the
     * waiting time (restorable until then). `confirm` is its name, typed
     * out; `catalog` says what happens to its public items ('hand' them to
     * `heirUserId`, or 'takedown'). Newer servers answer `dueAt`.
     */
    remove: async (slug: string, confirm: string, choice: { catalog?: 'hand' | 'takedown'; heirUserId?: string | null } = {}) => {
      const res = await reach(fetch(`/api/orgs/${slug}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm, ...choice }),
      }));
      if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'DELETE', `/api/orgs/${slug}`));
      noteWrite('DELETE', `/api/orgs/${slug}`);
      try {
        return (await res.json()) as { ok: true; dueAt?: number };
      } catch {
        return { ok: true as const };
      }
    },
    /** Make `userId` an admin and step down to member, in one go. */
    handOver: (slug: string, userId: string) => post<{ ok: true }>(`/api/orgs/${slug}/hand-over`, { userId }),
    revokeInvite: (slug: string, inviteId: string) =>
      del(`/api/orgs/${slug}/invites/${inviteId}`),
    /** Autocomplete for the invite form — org-admin-only, min 2 chars, capped results. */
    searchUsers: (slug: string, q: string) =>
      get<{ users: { id: string; displayName: string; avatarUrl: string | null; alreadyMember: boolean }[] }>(
        `/api/orgs/${slug}/user-search?q=${encodeURIComponent(q)}`,
      ),
    /** Listed clubs, for Find a club; `q` searches names and descriptions. */
    directory: (q = '') =>
      get<{ clubs: ClubSummary[] }>(`/api/club-directory${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`),
    /** What anyone may see of a listed club (or of a club you're in). */
    summary: (slug: string) => get<ClubSummary>(`/api/orgs/${slug}/summary`),
    /** Join an open club, or ask to join one whose admins approve newcomers. */
    join: (slug: string, message?: string) =>
      post<{ status: 'member' | 'requested'; slug: string }>(`/api/orgs/${slug}/join`, message ? { message } : {}),
    /** Take back your request to join. */
    cancelJoin: (slug: string) => del(`/api/orgs/${slug}/join`),
    /** Requests waiting for an answer (admins). */
    joinRequests: (slug: string) => get<{ requests: JoinRequestSummary[] }>(`/api/orgs/${slug}/join-requests`),
    approveJoin: (slug: string, id: string) =>
      post<{ ok: true }>(`/api/orgs/${slug}/join-requests/${encodeURIComponent(id)}/approve`, {}),
    declineJoin: (slug: string, id: string) =>
      post<{ ok: true }>(`/api/orgs/${slug}/join-requests/${encodeURIComponent(id)}/decline`, {}),
    /** Requests waiting in the clubs you run, for the badge on Clubs. */
    joinRequestCount: () => get<{ count: number; clubs: { slug: string; count: number }[] }>('/api/join-requests/count'),
    changeMemberRole: (slug: string, userId: string, role: ClubRole) =>
      patch<{ ok: true }>(`/api/orgs/${slug}/members/${userId}`, { role }),
    removeMember: (slug: string, userId: string) =>
      del(`/api/orgs/${slug}/members/${userId}`),
    layouts: (slug: string) =>
      get<{ layouts: LayoutSummary[] }>(`/api/orgs/${slug}/layouts`),
  },

  orgInvites: {
    preview: (token: string) =>
      get<{
        /** Masked ("s…@example.com") unless the invite is for the signed-in account. */
        invitedEmail: string;
        /** Whether it's for the signed-in account; null when signed out. */
        forYou: boolean | null;
        role: ClubRole;
        /** The role it gives, by name (older servers leave it out). */
        roleName?: string | null;
        orgId: string;
        orgName: string;
        orgSlug: string;
        expiresAt: number;
      }>(`/api/org-invites/${token}`),
    accept: (token: string) =>
      post<{ orgId: string; role: ClubRole }>(`/api/org-invites/${token}`),
  },

  transfers: {
    initiate: (
      layoutId: string,
      recipient: { email: string } | { orgSlug: string },
    ) =>
      post<
        | { transferred: true; ownerKind: 'org'; ownerSlug: string }
        | { id: string; token: string; transferUrl: string; emailDelivered: boolean; emailNote?: string; expiresAt: number }
      >(`/api/layouts/${layoutId}/transfer`, {
        recipientEmail: 'email' in recipient ? recipient.email : undefined,
        recipientOrgSlug: 'orgSlug' in recipient ? recipient.orgSlug : undefined,
      }),
    preview: (token: string) =>
      get<{
        /** Masked ("s…@example.com") unless the hand-over is for the signed-in account. */
        recipientEmail: string;
        /** Whether it's for the signed-in account; null when signed out. */
        forYou: boolean | null;
        layoutId: string;
        layoutTitle: string;
        expiresAt: number;
      }>(`/api/transfers/${token}`),
    accept: (token: string) => post<{ layoutId: string }>(`/api/transfers/${token}`),
    /** Call off a transfer that hasn't been accepted: its link stops working. */
    cancel: (layoutId: string, transferId: string) =>
      del(`/api/layouts/${encodeURIComponent(layoutId)}/transfer/${encodeURIComponent(transferId)}`),
  },

  customParts: {
    list: () => get<{ parts: CustomPartSummary[] }>('/api/custom-parts'),
    get: (id: string) =>
      get<{ part: CustomPartSummary; role: 'owner' | 'editor' | 'viewer' }>(
        `/api/custom-parts/${id}`,
      ),
    /** A set (a `<group>` XML) is sent without a sprite. */
    create: (body: {
      partNumber: string;
      displayName: string;
      xmlBase64: string;
      spriteBase64?: string;
      spriteMime?: 'image/gif' | 'image/png';
      orgSlug?: string;
      category?: string;
    }) =>
      post<{ id: string; partNumber: string; displayName: string }>(
        '/api/custom-parts',
        body,
      ),
    /** A new XML and sprite (and name) for a part; the owner stays. */
    replace: (
      id: string,
      body: {
        partNumber: string;
        displayName: string;
        xmlBase64: string;
        spriteBase64?: string;
        spriteMime?: 'image/gif' | 'image/png';
      },
    ) => put<{ id: string; partNumber: string; displayName: string }>(`/api/custom-parts/${id}`, body),
    remove: (id: string) => del(`/api/custom-parts/${id}`),
    /** Hand a part to a club (a club's part goes back only to its author). */
    move: (id: string, orgSlug: string) =>
      post<{ ok: true; id: string }>(`/api/custom-parts/${encodeURIComponent(id)}/move`, { orgSlug }),
    /** What moving a set to the club `orgSlug` does with your custom parts in it. */
    movePlan: (id: string, orgSlug: string) =>
      get<{ parts: SetMovePlan }>(`/api/custom-parts/${encodeURIComponent(id)}/move-plan?orgSlug=${encodeURIComponent(orgSlug)}`),
    /** List it in the Parts panel, or (notListed) keep it for the sets that use it. */
    setListing: (id: string, notListed: boolean) =>
      patch<{ id: string; notListed: boolean }>(`/api/custom-parts/${encodeURIComponent(id)}/listing`, { notListed }),
    /** What copying a set to the club `orgSlug` does with your custom parts in it (they're copied too). */
    copyPlan: (id: string, orgSlug: string) =>
      get<{ parts: SetMovePlan }>(`/api/custom-parts/${encodeURIComponent(id)}/copy-plan?orgSlug=${encodeURIComponent(orgSlug)}`),
    /** Copy into your own parts (no `orgSlug`) or a club's; a set into a club brings copies of your custom parts in it (`parts`). */
    copy: (id: string, orgSlug?: string) =>
      post<{ id: string; parts?: { copied: string[]; inClub: string[]; notYours: string[] } }>(
        `/api/custom-parts/${encodeURIComponent(id)}/copy`,
        orgSlug ? { orgSlug } : {},
      ),
    spriteUrl: (id: string) => `/api/custom-parts/${id}/sprite`,
    xmlUrl: (id: string) => `/api/custom-parts/${id}/xml`,
    /** Who has it, and (for its owners) the invites still waiting. A set also lists its own custom parts, which come along when it's shared. */
    collaborators: (id: string) =>
      get<{ collaborators: CollaboratorSummary[]; invites?: InviteSummary[]; setParts?: SetPartSummary[] }>(
        `/api/custom-parts/${encodeURIComponent(id)}/collaborators`,
      ),
    /** Invite by email: they get a link to accept (nobody is added before that). */
    invite: (id: string, email: string, role: 'viewer' | 'editor') =>
      post<{ id: string; token: string; inviteUrl: string; emailDelivered: boolean; emailNote?: string; expiresAt: number }>(
        `/api/custom-parts/${encodeURIComponent(id)}/invites`,
        { email, role },
      ),
    revokeInvite: (id: string, inviteId: string) => del(`/api/custom-parts/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`),
    /** Take someone off it (or leave it yourself). */
    removeCollaborator: (id: string, userId: string) => del(`/api/custom-parts/${encodeURIComponent(id)}/collaborators/${encodeURIComponent(userId)}`),
  },

  partInvites: {
    preview: (token: string) =>
      /** `invitedEmail` is masked unless it's for the account signed in; `forYou` is null signed out. */
      get<{
        invitedEmail: string;
        forYou?: boolean | null;
        role: 'viewer' | 'editor';
        partId: string;
        partNumber: string;
        partName: string;
        /** It's a set (older servers leave it out). */
        isSet?: boolean;
        expiresAt: number;
        /** A set: the sender's own parts in it, which come along. */
        setParts?: { partNumber: string; displayName: string }[];
      }>(`/api/part-invites/${encodeURIComponent(token)}`),
    accept: (token: string) =>
      post<{ partId: string; role: 'viewer' | 'editor'; setParts?: { id: string; partNumber: string }[] }>(`/api/part-invites/${encodeURIComponent(token)}`),
  },

  modules: {
    list: () => get<{ modules: ModuleSummary[] }>('/api/modules'),
    /** Copy into your own modules (no `orgSlug`) or a club's. */
    copy: (id: string, orgSlug?: string) =>
      post<{ id: string; title: string }>(`/api/modules/${encodeURIComponent(id)}/copy`, orgSlug ? { orgSlug } : {}),
    get: (id: string) =>
      get<{ module: ModuleSummary; role: 'owner' | 'editor' | 'viewer' }>(
        `/api/modules/${id}`,
      ),
    create: (body: { title?: string; orgSlug?: string }) =>
      post<{ id: string; title: string }>('/api/modules', body),
    /** Save the module's contents; each save is a new version, with an optional "What changed" note. */
    saveSnapshot: (id: string, bytes: Uint8Array, note?: string) =>
      putBytes(`/api/modules/${id}/snapshot${note?.trim() ? `?note=${encodeURIComponent(note.trim())}` : ''}`, bytes) as Promise<{
        updatedAt: number;
        version?: number;
      }>,
    versions: (id: string) =>
      get<{ role: 'owner' | 'editor' | 'viewer'; versions: ModuleVersion[] }>(`/api/modules/${encodeURIComponent(id)}/versions`),
    /** One version's Y.Doc bytes. */
    versionSnapshot: async (id: string, version: number): Promise<Uint8Array> => {
      const path = `/api/modules/${encodeURIComponent(id)}/versions/${version}/snapshot`;
      const res = await reach(fetch(path, { credentials: 'include' }));
      if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'GET', path));
      return new Uint8Array(await res.arrayBuffer());
    },
    /** Make an old version current again (as a new version). */
    restoreVersion: (id: string, version: number) =>
      post<{ ok: true; version: number }>(`/api/modules/${encodeURIComponent(id)}/versions/${version}/restore`, {}),
    /** The module's Y.Doc bytes (for the module editor). */
    snapshot: async (id: string): Promise<Uint8Array> => {
      const res = await reach(fetch(`/api/modules/${encodeURIComponent(id)}/snapshot`, { credentials: 'include' }));
      if (!res.ok) throw new Error(await friendlyErrorMessage(res));
      return new Uint8Array(await res.arrayBuffer());
    },
    /** The module's picture, as base64 in JSON (never octet-stream: the site's firewall). */
    setThumbnail: (id: string, thumb: { mime: 'image/png' | 'image/webp'; data: string }) =>
      put<{ ok: true; thumbnailAt: number }>(`/api/modules/${encodeURIComponent(id)}/thumbnail`, thumb),
    rename: (id: string, title: string) =>
      patch<{ ok: true }>(`/api/modules/${id}`, { title }),
    remove: (id: string) => del(`/api/modules/${id}`),
    /** Who has it, and (for its owners) the invites still waiting. */
    collaborators: (id: string) =>
      get<{ collaborators: CollaboratorSummary[]; invites?: InviteSummary[] }>(`/api/modules/${encodeURIComponent(id)}/collaborators`),
    /** Invite by email: they get a link to accept (nobody is added before that). */
    invite: (id: string, email: string, role: 'viewer' | 'editor') =>
      post<{ id: string; token: string; inviteUrl: string; emailDelivered: boolean; emailNote?: string; expiresAt: number }>(
        `/api/modules/${encodeURIComponent(id)}/invites`,
        { email, role },
      ),
    revokeInvite: (id: string, inviteId: string) => del(`/api/modules/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`),
    /** Take someone off it (or leave it yourself). */
    removeCollaborator: (id: string, userId: string) => del(`/api/modules/${encodeURIComponent(id)}/collaborators/${encodeURIComponent(userId)}`),
  },

  moduleInvites: {
    preview: (token: string) =>
      /** `invitedEmail` is masked unless it's for the account signed in; `forYou` is null signed out. */
      get<{ invitedEmail: string; forYou?: boolean | null; role: 'viewer' | 'editor'; moduleId: string; moduleTitle: string; expiresAt: number }>(
        `/api/module-invites/${encodeURIComponent(token)}`,
      ),
    accept: (token: string) => post<{ moduleId: string; role: 'viewer' | 'editor' }>(`/api/module-invites/${encodeURIComponent(token)}`),
  },

  venues: {
    list: () => get<{ venues: VenueSummary[] }>('/api/venues'),
    /** Copy into your own venues (no `orgSlug`) or a club's. */
    copy: (id: string, orgSlug?: string) =>
      post<{ id: string; name: string }>(`/api/venues/${encodeURIComponent(id)}/copy`, orgSlug ? { orgSlug } : {}),
    /** Hand a venue to a club (a club's venue never moves back to one person). */
    move: (id: string, orgSlug: string) =>
      post<{ ok: true; id: string; name: string }>(`/api/venues/${encodeURIComponent(id)}/move`, { orgSlug }),
    get: (id: string) => get<{ id: string; name: string; data: unknown; credit?: Credit | null }>(`/api/venues/${id}`),
    create: (body: { name: string; data: unknown; orgSlug?: string }) =>
      post<{ id: string; name: string }>('/api/venues', body),
    rename: (id: string, name: string) =>
      patch<{ ok: true; id: string; name: string }>(`/api/venues/${id}`, { name }),
    /** Replace a saved venue's contents (Save Current Venue over an existing name). */
    update: (id: string, data: unknown) =>
      patch<{ ok: true; id: string; name: string }>(`/api/venues/${id}`, { data }),
    remove: (id: string) => del(`/api/venues/${id}`),
  },

  /** Handing a club's thing back to the person who made it (the club keeps a copy). */
  ownership: {
    /** The author takes it back (while a member of the club). */
    takeBack: (kind: OwnableKind, id: string) =>
      post<{ ok: true; id: string; keptCopyId: string; ownerUserId: string }>(`/api/${kind}/${encodeURIComponent(id)}/take-back`, {}),
    /** The club's admins and managers give it back to its author. */
    giveBack: (kind: OwnableKind, id: string) =>
      post<{ ok: true; id: string; keptCopyId: string; ownerUserId: string }>(`/api/${kind}/${encodeURIComponent(id)}/give-back`, {}),
  },

  audit: {
    forLayout: (layoutId: string, limit = 100) =>
      get<{ events: AuditEventSummary[] }>(
        `/api/layouts/${layoutId}/audit?limit=${limit}`,
      ),
    generic: (kind: 'layout' | 'custom_part' | 'module' | 'org', id: string, limit = 100) =>
      get<{ events: AuditEventSummary[] }>(
        `/api/audit?kind=${kind}&id=${encodeURIComponent(id)}&limit=${limit}`,
      ),
    forOrg: (slug: string, limit = 100, offset = 0) =>
      get<{ events: AuditEventSummary[]; limit: number; offset: number }>(
        `/api/orgs/${slug}/audit?limit=${limit}&offset=${offset}`,
      ),
  },

  /** Move a module to a club you're in (at once). */
  moduleTransfers: {
    initiate: (moduleId: string, recipient: { orgSlug: string }) =>
      post<{ transferred: true; ownerKind: 'org'; ownerSlug: string }>(`/api/modules/${moduleId}/transfer`, {
        recipientOrgSlug: recipient.orgSlug,
      }),
  },

  // ---------------------------------------------------------------------
  // Site admin — gated server-side by `requireGlobalAdmin`. Every
  // mutation writes an audit_event keyed by the admin's userId.
  // ---------------------------------------------------------------------
  admin: {
    stats: () => get<AdminStats>('/api/admin/stats'),
    users: (q: AdminListParams) =>
      get<{ users: AdminUser[]; total: number; limit: number; offset: number }>(
        `/api/admin/users?${listParams(q)}`,
      ),
    user: (id: string) => get<AdminUserDetail>(`/api/admin/users/${id}`),
    patchUser: (id: string, body: { isGlobalAdmin?: boolean; isModerator?: boolean }) =>
      patch<{ ok: true }>(`/api/admin/users/${id}`, body),
    deleteUser: (id: string) => del(`/api/admin/users/${id}`),
    revokeUserSessions: (id: string) =>
      post<{ ok: true }>(`/api/admin/users/${id}/sessions/revoke-all`),
    orgs: (q: AdminListParams) =>
      get<{ orgs: AdminOrg[]; total: number; limit: number; offset: number }>(
        `/api/admin/orgs?${listParams(q)}`,
      ),
    org: (id: string) => get<AdminOrgDetail>(`/api/admin/orgs/${id}`),
    deleteOrg: (id: string) => del(`/api/admin/orgs/${id}`),
    layouts: (q: AdminListParams & { ownerUserId?: string; ownerOrgId?: string }) =>
      get<{ layouts: AdminLayout[]; total: number; limit: number; offset: number }>(
        `/api/admin/layouts?${listParams(q)}`,
      ),
    deleteLayout: (id: string) => del(`/api/admin/layouts/${id}`),
    globalParts: (q: AdminListParams = {}) =>
      get<{ parts: AdminGlobalPart[]; total: number; limit: number; offset: number }>(`/api/admin/global-parts?${listParams(q)}`),
    createGlobalPart: (body: {
      partNumber: string;
      displayName: string;
      category?: string;
      xmlBase64: string;
      spriteBase64: string;
      spriteMime: 'image/gif' | 'image/png';
    }) => post<{ id: string }>('/api/admin/global-parts', body),
    deleteGlobalPart: (id: string) => del(`/api/admin/global-parts/${id}`),
    auditLog: (q: AdminListParams) =>
      get<{ events: AdminAuditEvent[]; total: number; limit: number; offset: number }>(
        `/api/admin/audit?${listParams(q)}`,
      ),
    partLibraries: () => get<{ libraries: PartLibrary[]; onDiskBaseParts?: number }>('/api/admin/part-libraries'),
    searchPartLibraries: (source: string) =>
      get<{ packages: RemotePackage[]; indexUrl: string }>(
        `/api/admin/part-libraries/search?source=${encodeURIComponent(source)}`,
      ),
    installBaseLibrary: () =>
      post<{ id: string; slug: string; partCount: number }>(
        '/api/admin/part-libraries/install-base',
      ),
    downloadPartLibrary: (body: {
      name: string;
      slug: string;
      sourceUrl: string;
      defaultEnabled?: boolean;
    }) => post<{ id: string; slug: string; partCount: number }>('/api/admin/part-libraries/download', body),
    installPartLibrary: (body: {
      name: string;
      slug: string;
      sourceUrl?: string;
      zipBase64?: string;
      defaultEnabled?: boolean;
    }) => post<{ id: string; slug: string; partCount: number }>('/api/admin/part-libraries', body),
    patchPartLibrary: (id: string, body: { name?: string; defaultEnabled?: boolean; locked?: boolean }) =>
      patch<{ ok: true }>(`/api/admin/part-libraries/${id}`, body),
    updatePartLibrary: (id: string) =>
      post<{ ok: true; partCount: number }>(`/api/admin/part-libraries/${id}/update`, {}),
    deletePartLibrary: (id: string) => del(`/api/admin/part-libraries/${id}`),
    reloadParts: () => post<{ ok: true }>('/api/admin/reload-parts'),
    settings: () => get<AdminSettings>('/api/admin/settings'),
    patchSettings: (body: {
      requireEmailVerification?: boolean;
      smtpHost?: string | null;
      smtpPort?: number | null;
      smtpUser?: string | null;
      smtpPass?: string | null;
      smtpFrom?: string | null;
      minDesktopVersion?: string | null;
      moduleCatalogEnabled?: boolean;
      partsCatalogEnabled?: boolean;
      layoutCatalogEnabled?: boolean;
      venueCatalogEnabled?: boolean;
      catalogReview?: CatalogReview;
      catalogAnonymousBrowse?: boolean;
      limitsEnforced?: boolean;
      backupsEnabled?: boolean;
      dailyCompactionEnabled?: boolean;
      demoEnabled?: boolean;
      demoResetEvery?: DemoResetEvery;
      collectionCoverMaxBytes?: number;
      /** Admin › Settings › Privacy: key -> number, or null for the default. */
      privacy?: Record<string, number | null>;
      /** Admin › Settings › Sign-in: key -> hours (or 'never'), or null for the default. */
      signIn?: Record<string, SignInValue | null>;
      privacyNotice?: string | null;
      privacyContact?: string | null;
    }) => patch<{ ok: true }>('/api/admin/settings', body),
    /** Demo account › Reset now (JSON, empty object body). */
    resetDemo: () => post<{ ok: true; lastResetAt: number; items: number }>('/api/admin/demo/reset', {}),
  },

  // Public module and parts catalogs.
  catalog: {
    settings: () => get<CatalogSettings>('/api/catalog/settings'),
    /** One kind, or every kind that's on ('all'); a page at a time with `limit` and `offset`. */
    items: (kind: CatalogKind | 'all', opts: { q?: string; tag?: string; sort?: 'newest' | 'popular'; limit?: number; offset?: number } = {}) => {
      const p = new URLSearchParams({ kind });
      if (opts.q) p.set('q', opts.q);
      if (opts.tag) p.set('tag', opts.tag);
      if (opts.sort) p.set('sort', opts.sort);
      if (opts.limit) p.set('limit', String(opts.limit));
      if (opts.offset) p.set('offset', String(opts.offset));
      return get<{ items: CatalogItem[]; nextOffset?: number | null }>(`/api/catalog/items?${p.toString()}`);
    },
    item: (id: string) =>
      get<{
        item: CatalogItem & { status: CatalogStatus; reason: string | null; club?: { slug: string; name: string } | null; coverLargeUrl?: string };
        versions: CatalogVersion[];
      }>(`/api/catalog/items/${encodeURIComponent(id)}`),
    /** A published layout's document, for the viewer. */
    itemSnapshot: (id: string, v?: number) => getBytes(`/api/catalog/items/${encodeURIComponent(id)}/snapshot${v ? `?v=${v}` : ''}`),
    /** A published venue's plan. */
    itemVenue: (id: string, v?: number) => get<{ name: string; venue: Venue }>(`/api/catalog/items/${encodeURIComponent(id)}/venue${v ? `?v=${v}` : ''}`),
    /** Where "Download .bld-layout" / ".bbm" points. */
    downloadUrl: (id: string, format: 'bld-layout' | 'bbm') => `/api/catalog/items/${encodeURIComponent(id)}/download${format === 'bbm' ? '?format=bbm' : ''}`,
    share: (body: {
      kind: CatalogKind;
      sourceId: string;
      title: string;
      description?: string;
      tags?: string[];
      note?: string;
      /** A layout's picture, drawn by the editor. */
      thumbnail?: { mime: string; data: string };
    }) =>
      post<{ id: string; version: number; status: 'in_review' | 'public' }>('/api/catalog/submissions', body),
    mine: () => get<{ items: MyCatalogItem[] }>('/api/catalog/mine'),
    withdraw: (id: string) => post<{ ok: true }>(`/api/catalog/items/${encodeURIComponent(id)}/withdraw`, {}),
    add: (id: string, orgSlug?: string) =>
      post<{ kind: CatalogKind; id: string; version: number }>(`/api/catalog/items/${encodeURIComponent(id)}/add`, orgSlug ? { orgSlug } : {}),
    copies: () => get<{ copies: CatalogCopy[] }>('/api/catalog/copies'),
    updateCopy: (copyId: string) => post<{ ok: true; version: number }>(`/api/catalog/copies/${encodeURIComponent(copyId)}/update`, {}),
    // Collections: named, ordered sets of modules and parts.
    collections: () => get<{ collections: CollectionSummary[] }>('/api/catalog/collections'),
    collection: (id: string) => get<{ collection: CollectionDetail; items: CollectionItem[] }>(`/api/catalog/collections/${encodeURIComponent(id)}`),
    myCollections: () => get<{ collections: MyCollection[] }>('/api/catalog/collections/mine'),
    /** The collections of my clubs (or of one club). */
    clubCollections: (club?: string) =>
      get<{ clubs: ClubCollections[] }>(`/api/catalog/collections/clubs${club ? `?club=${encodeURIComponent(club)}` : ''}`),
    createCollection: (body: CollectionInput) => post<CollectionSaved>('/api/catalog/collections', body),
    updateCollection: (id: string, body: Partial<CollectionInput> & { pinned?: boolean }) =>
      patch<CollectionSaved>(`/api/catalog/collections/${encodeURIComponent(id)}`, body),
    /** "Add to a collection…": one more item at the end. */
    addToCollection: (id: string, entry: CollectionEntry) =>
      post<CollectionSaved>(`/api/catalog/collections/${encodeURIComponent(id)}/items`, entry.source === 'catalog' ? { itemId: entry.id } : entry),
    deleteCollection: (id: string) => del(`/api/catalog/collections/${encodeURIComponent(id)}`),
    withdrawCollection: (id: string) => post<{ ok: true }>(`/api/catalog/collections/${encodeURIComponent(id)}/withdraw`, {}),
    /** Upload your own cover: JSON {mime, data} (base64), never an octet-stream body. */
    uploadCollectionCover: (id: string, body: { mime: string; data: string }) =>
      put<CollectionSaved & { coverImageId: string }>(`/api/catalog/collections/${encodeURIComponent(id)}/cover`, body),
    removeCollectionCover: async (id: string): Promise<CollectionSaved> => {
      const path = `/api/catalog/collections/${encodeURIComponent(id)}/cover`;
      const res = await reach(fetch(path, { method: 'DELETE', credentials: 'include' }));
      if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'DELETE', path));
      noteWrite('DELETE', path);
      return res.json() as Promise<CollectionSaved>;
    },
    /** A catalog item's own picture: JSON {mime, data} (base64), never an octet-stream body. */
    uploadItemCover: (id: string, body: { mime: string; data: string }) => put<ItemCoverState>(`/api/catalog/items/${encodeURIComponent(id)}/cover`, body),
    /** Back to the drawn picture (a waiting one goes too). */
    removeItemCover: async (id: string): Promise<ItemCoverState> => {
      const path = `/api/catalog/items/${encodeURIComponent(id)}/cover`;
      const res = await reach(fetch(path, { method: 'DELETE', credentials: 'include' }));
      if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'DELETE', path));
      noteWrite('DELETE', path);
      return res.json() as Promise<ItemCoverState>;
    },
    dismissCollectionNote: (id: string) => post<{ ok: true }>(`/api/catalog/collections/${encodeURIComponent(id)}/dismiss-note`, {}),
    addCollection: (id: string, orgSlug?: string) =>
      post<CollectionAddResult>(`/api/catalog/collections/${encodeURIComponent(id)}/add`, orgSlug ? { orgSlug } : {}),
  },

  moderation: {
    items: () =>
      get<{
        queue: ModerationEntry[];
        /** Waiting in trusted clubs' own queues (older servers leave it out). */
        trustedQueue?: ModerationEntry[];
        /** New pictures for public items (older servers leave these out). */
        covers?: CoverReviewEntry[];
        trustedCovers?: CoverReviewEntry[];
        items: (CatalogItem & { status: CatalogStatus; reason: string | null; owner: WarningSubject | null })[];
      }>('/api/moderation/items'),
    /** One moderation list, a page at a time (see ModerationView). */
    list: <V extends ModerationView>(view: V, f: ModerationFilter & { limit?: number; offset?: number } = {}) => {
      const p = new URLSearchParams({ view });
      for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== 0) p.set(k, String(v));
      return get<{ total: number; nextOffset: number | null; rows: V extends 'waiting' | 'trusted' ? ModerationEntry[] : ModeratedItem[] }>(`/api/moderation/catalog?${p.toString()}`);
    },
    /** New pictures for public items, waiting for review. */
    covers: () => get<{ covers: CoverReviewEntry[]; trustedCovers: CoverReviewEntry[] }>('/api/moderation/covers'),
    /** How many are in each list (the badges). */
    counts: () => get<ModerationCounts>('/api/moderation/counts'),
    /** Approve or decline waiting versions, or unpublish items, several at once. */
    bulk: (action: 'approve' | 'decline' | 'unpublish', ids: string[], reason = '') =>
      post<{ done: number; failed: { id: string; error: string }[] }>('/api/moderation/bulk', { action, ids, reason }),
    /** Trusted clubs, or (with `q`) clubs to trust. */
    clubs: (q?: string, offset = 0) => {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      if (offset) p.set('offset', String(offset));
      return get<{ clubs: ModerationClub[]; total?: number; nextOffset?: number | null }>(`/api/moderation/clubs${p.size ? `?${p.toString()}` : ''}`);
    },
    trustClub: (slug: string, trusted: boolean) => post<{ ok: true; trusted: boolean }>(`/api/moderation/clubs/${encodeURIComponent(slug)}/trust`, { trusted }),
    approve: (versionId: string) => post<{ ok: true }>(`/api/moderation/versions/${encodeURIComponent(versionId)}/approve`, {}),
    decline: (versionId: string, reason: string) =>
      post<{ ok: true }>(`/api/moderation/versions/${encodeURIComponent(versionId)}/decline`, { reason }),
    unpublish: (id: string, reason: string) => post<{ ok: true }>(`/api/moderation/items/${encodeURIComponent(id)}/unpublish`, { reason }),
    /** Put an unpublished item back in the catalog, on the version it had. */
    restore: (id: string) => post<{ ok: true }>(`/api/moderation/items/${encodeURIComponent(id)}/restore`, {}),
    decideCover: (itemId: string, approve: boolean, reason = '') =>
      post<{ ok: true }>(`/api/moderation/items/${encodeURIComponent(itemId)}/cover/${approve ? 'approve' : 'decline'}`, approve ? {} : { reason }),
    collections: () =>
      get<{ queue: CollectionReviewEntry[]; trustedQueue?: CollectionReviewEntry[]; collections: ModeratedCollection[]; clubCollections?: ModeratedCollection[] }>(
        '/api/moderation/collections',
      ),
    /** One collection list a page at a time: text waiting (the site's or trusted clubs'), the listed ones, or clubs' private ones. */
    collectionList: <V extends 'queue' | 'trusted' | 'listed' | 'club'>(view: V, f: Omit<ModerationFilter, 'kind'> & { limit?: number; offset?: number } = {}) => {
      const p = new URLSearchParams({ view });
      for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== 0) p.set(k, String(v));
      return get<{ total: number; nextOffset: number | null; rows: V extends 'queue' | 'trusted' ? CollectionReviewEntry[] : ModeratedCollection[] }>(
        `/api/moderation/collections/list?${p.toString()}`,
      );
    },
    /** Approve or decline collections' text, unpublish public ones, or remove clubs' private ones, several at once. */
    collectionBulk: (action: 'approve' | 'decline' | 'unpublish' | 'remove', ids: string[], reason = '') =>
      post<{ done: number; failed: { id: string; error: string }[] }>('/api/moderation/collections/bulk', { action, ids, reason }),
    removeCollection: (id: string, reason: string) => post<{ ok: true }>(`/api/moderation/collections/${encodeURIComponent(id)}/remove`, { reason }),
    approveCollection: (id: string) => post<{ ok: true }>(`/api/moderation/collections/${encodeURIComponent(id)}/approve`, {}),
    declineCollection: (id: string, reason: string) => post<{ ok: true }>(`/api/moderation/collections/${encodeURIComponent(id)}/decline`, { reason }),
    unpublishCollection: (id: string, reason: string) => post<{ ok: true }>(`/api/moderation/collections/${encodeURIComponent(id)}/unpublish`, { reason }),
    /** Put an unpublished collection back in the catalog, as it was. */
    restoreCollection: (id: string) => post<{ ok: true }>(`/api/moderation/collections/${encodeURIComponent(id)}/restore`, {}),
    featureCollection: (id: string, featured: boolean) =>
      post<{ ok: true; featured: boolean }>(`/api/moderation/collections/${encodeURIComponent(id)}/feature`, { featured }),
  },

  // Warnings: the ones I received (notices), and sending them.
  warnings: {
    notices: () => get<{ notices: WarningSummary[] }>('/api/notices'),
    acknowledge: (id: string) => post<{ ok: true; acknowledgedAt: number }>(`/api/notices/${encodeURIComponent(id)}/acknowledge`, {}),
    /** "Dismiss all": every unread note (never a warning). */
    acknowledgeAllNotes: () => post<{ ok: true; acknowledged: string[] }>('/api/notices/acknowledge-all', {}),
    /** Site admins and moderators: a person's or club's history. */
    history: (subject: WarningSubject) =>
      get<{ warnings: WarningSummary[] }>(`/api/admin/warnings?subjectKind=${subject.kind}&subjectId=${encodeURIComponent(subject.id)}`),
    send: (subject: WarningSubject, input: WarningInput) =>
      post<{ id: string }>('/api/admin/warnings', { subjectKind: subject.kind, subjectId: subject.id, ...input }),
    /** A club's admins and managers: what the club sent. */
    clubHistory: (slug: string) => get<{ warnings: WarningSummary[] }>(`/api/orgs/${encodeURIComponent(slug)}/warnings`),
    clubSend: (slug: string, userId: string, input: WarningInput) =>
      post<{ id: string }>(`/api/orgs/${encodeURIComponent(slug)}/warnings`, { userId, ...input }),
  },

  // Per-org part library management (org admin only).
  orgLibraries: {
    list: (slug: string) =>
      get<{ libraries: OrgPartLibrary[]; isAdmin: boolean }>(
        `/api/orgs/${encodeURIComponent(slug)}/part-libraries`,
      ),
    set: (slug: string, libraryId: string, enabled: boolean) =>
      put<{ ok: true }>(
        `/api/orgs/${encodeURIComponent(slug)}/part-libraries/${libraryId}`,
        { enabled },
      ),
    reset: (slug: string, libraryId: string) =>
      del(`/api/orgs/${encodeURIComponent(slug)}/part-libraries/${libraryId}`),
  },
};

interface AdminListParams {
  q?: string;
  limit?: number;
  offset?: number;
  ownerUserId?: string;
  ownerOrgId?: string;
}

function listParams(p: AdminListParams): string {
  const sp = new URLSearchParams();
  if (p.q) sp.set('q', p.q);
  if (p.limit !== undefined) sp.set('limit', String(p.limit));
  if (p.offset !== undefined) sp.set('offset', String(p.offset));
  if (p.ownerUserId) sp.set('ownerUserId', p.ownerUserId);
  if (p.ownerOrgId) sp.set('ownerOrgId', p.ownerOrgId);
  return sp.toString();
}

export interface AdminStats {
  users: number;
  globalAdmins: number;
  orgs: number;
  layouts: number;
  customParts: number;
  modules: number;
  activeSessions: number;
}

export type CatalogKind = 'module' | 'part' | 'layout' | 'venue';

/** What a layout's or venue's public page shows without opening it. */
export interface CatalogSummary {
  widthStuds: number;
  heightStuds: number;
  partCount?: number;
  parts?: { partNumber: string; count: number }[];
  venue?: string | null;
}
export type CatalogReview = 'moderators' | 'none';
export type CatalogStatus = 'in_review' | 'public' | 'declined' | 'unpublished' | 'withdrawn';

export interface CatalogSettings {
  modules: boolean;
  parts: boolean;
  /** Layouts and venues in the catalog (older servers leave them out: off). */
  layouts?: boolean;
  venues?: boolean;
  review: CatalogReview;
  anonymousBrowse: boolean;
  canModerate: boolean;
  /** The biggest picture a curator can upload as a collection's cover. */
  coverMaxBytes?: number;
}

export interface CatalogItem {
  id: string;
  kind: CatalogKind;
  title: string;
  description: string;
  tags: string[];
  /** Who shared it: a person's or a club's name. */
  by: string;
  uses: number;
  /** The public version. */
  version: number;
  updatedAt: number;
  /** Its drawn picture; '' when it has none (nothing to ask the server for). */
  previewUrl: string;
  /** A layout or venue: its size, and a layout's parts list. */
  summary?: CatalogSummary | null;
  /** The card's picture: its owner's own (cropped to the card), else the drawn one. Older servers leave it out. */
  coverUrl?: string;
  /** `coverUrl` is a picture its owner uploaded. */
  customCover?: boolean;
  /** Shared by a trusted club (it reviews its own). */
  trustedClub?: boolean;
}

/** A catalog item's own picture, as its owner sees it. */
export interface ItemCoverState {
  /** Set when the change shows at once ('public'), or waits for review. */
  status?: 'public' | 'in_review';
  customCoverUrl: string | null;
  pendingCoverUrl: string | null;
  /** Why the last uploaded picture was declined. */
  coverReason: string | null;
}

/** A new picture for a public catalog item, waiting for review. */
export interface CoverReviewEntry {
  itemId: string;
  kind: CatalogKind;
  title: string;
  by: string;
  /** What shows now (an uploaded picture, or the drawn one); null: no picture. */
  oldUrl: string | null;
  newUrl: string;
  submitter: string | null;
  createdAt: number;
  owner: WarningSubject | null;
  trustedClub: boolean;
}

export interface CatalogVersion {
  version: number;
  status: 'in_review' | 'public' | 'declined';
  note: string | null;
  reason: string | null;
  createdAt: number;
}

/** One of your (or your clubs') shared items, for the status badges. */
export interface MyCatalogItem {
  id: string;
  kind: CatalogKind;
  sourceId: string;
  title: string;
  status: CatalogStatus;
  reason: string | null;
  version: number;
  pendingVersion: number | null;
  /** The text sent with the version waiting, public once it's approved. Older servers leave it out. */
  pendingText?: CatalogText | null;
  /** Its drawn picture; '' when it has none. Older servers leave it out. */
  drawnUrl?: string;
  /** How many public collections it's in. */
  collections?: number;
  customCoverUrl?: string | null;
  pendingCoverUrl?: string | null;
  coverReason?: string | null;
}

/** Who sees a collection: everyone (its text reviewed first), or only its curator or club. */
export type CollectionAudience = 'everyone' | 'private';

/** A collection, as the lists show it. */
export interface CollectionSummary {
  id: string;
  title: string;
  description: string;
  featured: boolean;
  /** Made by a moderator or site admin. */
  official: boolean;
  /** The curator's name, or the club's. */
  by: string;
  /** Older servers leave it out: everyone. */
  audience?: CollectionAudience;
  /** A club's collection. */
  club?: boolean;
  itemCount: number;
  modules: number;
  parts: number;
  /** Layouts and venues in it (older servers leave them out). */
  layouts?: number;
  venues?: number;
  coverUrl: string | null;
  updatedAt: number;
  /** A trusted club's. */
  trustedClub?: boolean;
}

/** A change to a public collection's text waiting for review (curators and moderators only). */
export interface CollectionDraft {
  title: string;
  description: string;
  coverItemId: string | null;
  coverModuleId?: string | null;
  /** An uploaded cover waiting for review. */
  coverImageId?: string | null;
  coverUrl: string | null;
}

export interface CollectionDetail extends CollectionSummary {
  coverItemId: string | null;
  coverModuleId?: string | null;
  /** The uploaded cover showing, if any. */
  coverImageId?: string | null;
  status: CatalogStatus;
  reason: string | null;
  pending: CollectionDraft | null;
  curatorNote: string | null;
  canEdit: boolean;
  pinned?: boolean;
  /** The club it belongs to. */
  clubInfo?: { id: string; slug: string; name: string } | null;
  /** My role in that club. */
  myRole?: ClubRole | null;
  /** A site moderator may remove it (a club's collection). */
  canRemove?: boolean;
}

/** How a collection's own module or part stands in the catalog (its curators, public collections). */
export interface EntryReview {
  state: 'public' | 'in_review' | 'declined' | 'unpublished' | 'not_shared' | 'catalog_off';
  reason: string | null;
}

/** An item in a collection: a catalog item, or the curator's (or club's) own module or part. */
export interface CollectionItem extends CatalogItem {
  source?: 'catalog' | 'library';
  review?: EntryReview | null;
}

export interface MyCollection extends CollectionSummary {
  status: CatalogStatus;
  reason: string | null;
  /** A change is waiting for review. */
  pending: boolean;
  /** Items that left the catalog and were taken out. */
  curatorNote: string | null;
}

export interface ClubCollection extends MyCollection {
  pinned: boolean;
  /** Who made it. */
  curator: string;
}

export interface ClubCollections {
  id: string;
  slug: string;
  name: string;
  myRole: ClubRole;
  /** An admin or manager: makes and changes the club's collections. */
  canCurate: boolean;
  collections: ClubCollection[];
}

/** One item, as requests spell it. */
export type CollectionEntry = { source: 'catalog'; id: string } | { source: 'library'; kind: CatalogKind; id: string };

export interface CollectionInput {
  title: string;
  description: string;
  entries: CollectionEntry[];
  coverItemId: string | null;
  coverModuleId?: string | null;
  audience: CollectionAudience;
  /** Make it the club's (its admins and managers). */
  clubSlug?: string;
}

export interface CollectionSaved {
  id: string;
  status: CatalogStatus;
  audience?: CollectionAudience;
  pending?: boolean;
  /** Own modules and parts shared to the catalog for their own review. */
  submitted?: string[];
  notShared?: { id: string; error: string }[];
}

export interface CollectionAddResult {
  added: { itemId: string; kind: CatalogKind; id: string }[];
  /** Ones you (or the club) already had. */
  skipped: string[];
  failed: { itemId: string; error: string }[];
}

/** A collection's text waiting for review: new, and (for a change) what's public now. */
export interface CollectionReviewEntry {
  id: string;
  isUpdate: boolean;
  by: string;
  email: string | null;
  createdAt: number;
  owner: WarningSubject | null;
  title: string;
  description: string;
  coverUrl: string | null;
  old: { title: string; description: string; coverUrl: string | null } | null;
  itemCount: number;
}

export interface ModeratedCollection extends CollectionSummary {
  status?: CatalogStatus;
  reason?: string | null;
  owner: WarningSubject | null;
}

export interface CatalogCopy {
  copyId: string;
  itemId: string;
  kind: CatalogKind;
  version: number;
  latest: number;
  updateAvailable: boolean;
}

/** A catalog item's title, description and tags. */
export interface CatalogText {
  title: string;
  description: string;
  tags: string[];
}

export interface ModerationEntry {
  versionId: string;
  itemId: string;
  kind: CatalogKind;
  /** The text sent with this version (it becomes public when approved). */
  title: string;
  description: string;
  tags: string[];
  /** An update that changes the text: what the public sees now. Older servers leave it out. */
  current?: CatalogText | null;
  version: number;
  isUpdate: boolean;
  note: string | null;
  by: string;
  /** Who sent it; `email` only for site admins. */
  submitter: { name: string; email?: string } | null;
  createdAt: number;
  previewUrl: string;
  /** Its uploaded picture, reviewed with it. */
  coverUrl?: string | null;
  /** Who it belongs to, for a warning. */
  owner: WarningSubject | null;
  /** From a trusted club: its own admins and managers review it. */
  trustedClub?: boolean;
}

export type WarningSubject = { kind: 'user' | 'org'; id: string };
export type WarningSeverity = 'note' | 'warning' | 'final';

/** A warning, as the notices list and the admin and club histories show it. */
export interface WarningSummary {
  id: string;
  scope: 'site' | 'club';
  severity: WarningSeverity;
  reason: string;
  link: string | null;
  createdAt: number;
  acknowledgedAt: number | null;
  /** Who sent it: only in the admin and club histories. */
  issuedBy: { id: string; name: string } | null;
  /** Club warnings: the club it's from. */
  club: { id: string; name: string; slug: string } | null;
  to: { kind: 'user'; id: string; name: string } | { kind: 'org'; id: string; name: string; slug: string };
}

export interface WarningInput {
  severity: WarningSeverity;
  reason: string;
  link?: string;
}

export interface AdminSettings {
  requireEmailVerification: boolean;
  smtp: {
    host: string | null;
    port: number | null;
    user: string | null;
    from: string | null;
    /** true if a password is saved in the DB, without ever sending the value itself. */
    passSet: boolean;
    /** Which config is actually in effect right now — null means neither is configured. */
    source: 'database' | 'env' | null;
    active: boolean;
  };
  /** "Oldest desktop allowed": what an admin set (null = the code's own), and what's in force. */
  desktop: {
    minimumSet: string | null;
    minimum: string;
    recommended: string;
    codeMinimum: string;
  };
  /** Public catalogs: off until turned on. */
  catalog?: { modules: boolean; parts: boolean; layouts?: boolean; venues?: boolean; review: CatalogReview; anonymousBrowse: boolean; coverMaxBytes?: AdminJobSetting<number> };
  /** Background jobs: the switch, what applies, and the env var forcing it if any. */
  jobs?: {
    backups: AdminJobSetting<boolean>;
    dailyCompaction: AdminJobSetting<boolean>;
  };
  /** The demo account: on or off, how often it resets, and what it has now. */
  demo?: DemoStatus & { items: number };
  /** Privacy: data downloads (and more), each with its default and whether the server forces it. */
  privacy?: {
    settings: PrivacySettingState[];
    /** The privacy page's notice (markdown), '' when none yet. */
    notice?: string;
    /** Who to ask: what applies, what an admin saved, and the env var forcing it. */
    contact?: { value: string | null; setting: string | null; forcedBy: string | null };
  };
  /** Sign-in: how long web and desktop sign-ins last unused, and the longest they can last. */
  signIn?: { settings: SignInSettingState[] };
  /** The server's env-only settings, read only (never a secret's value). */
  serverSetup?: { name: string; value: string; env: string; why: ServerSetupWhy }[];
  updatedAt: number;
}

/** Hours, or 'never' (only for the longest a sign-in can last). */
export type SignInValue = number | 'never';

export interface SignInSettingState {
  key: 'webIdleHours' | 'webMaxHours' | 'desktopIdleHours' | 'desktopMaxHours';
  app: 'web' | 'desktop';
  kind: 'idle' | 'max';
  label: string;
  help: string;
  /** Hours. */
  builtIn: number;
  /** Hours. */
  min: number;
  /** Hours. */
  max: number;
  allowNever: boolean;
  envVar: string;
  value: SignInValue;
  setting: SignInValue | null;
  forcedBy: string | null;
}

export interface PrivacySettingState {
  key: string;
  label: string;
  help: string;
  unit: 'hours' | 'days' | 'mb';
  builtIn: number;
  min: number;
  max: number;
  envVar: string;
  value: number;
  setting: number | null;
  forcedBy: string | null;
}

export interface AdminJobSetting<T> {
  value: T;
  setting: T;
  forcedBy: string | null;
}

export type ServerSetupWhy = 'secret' | 'restart' | 'deploy' | 'bootstrap';

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  isDemoAccount: boolean;
  isGlobalAdmin: boolean;
  isModerator?: boolean;
  emailVerified: boolean;
  createdAt: number;
  layoutCount: number;
  /** Content size (doc snapshot + sidecar + unflushed updates), not raw disk usage. */
  layoutSizeBytes: number;
}

export interface AdminUserStats {
  orgs: number;
  layouts: number;
  layoutSizeBytes: number;
  customParts: number;
  modules: number;
  activeSessions: number;
}

export interface AdminUserDetail {
  user: AdminUser;
  stats: AdminUserStats;
  orgMemberships: { orgId: string; name: string; slug: string; role: ClubRole }[];
  layouts: { id: string; title: string; updatedAt: number; sizeBytes: number }[];
}

export interface AdminOrg {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  memberCount: number;
  layoutCount: number;
  layoutSizeBytes: number;
  /** Waiting to be deleted (hidden; Restore or Erase now). */
  deletionDueAt?: number | null;
}

export interface AdminOrgDetail {
  org: { id: string; name: string; slug: string; createdAt: number; trusted?: boolean; trustedAt?: number | null };
  stats: { members: number; layouts: number; layoutSizeBytes: number };
  members: { userId: string; email: string; displayName: string; role: ClubRole; joinedAt: number }[];
  layouts: { id: string; title: string; updatedAt: number; sizeBytes: number }[];
}

export interface AdminLayout {
  id: string;
  title: string;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  ownerUserEmail: string | null;
  ownerOrgName: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  docVersion: number;
  sizeBytes: number;
}

export interface AdminGlobalPart {
  id: string;
  partNumber: string;
  displayName: string;
  category: string;
  spriteMime: string;
  createdAt: number;
}

export interface AdminAuditEvent {
  id: number;
  layoutId: string | null;
  resourceKind: string | null;
  resourceId: string | null;
  userId: string | null;
  userName: string | null;
  eventType: string;
  payload: unknown;
  createdAt: number;
}

export interface AuditEventSummary {
  id: number;
  layoutId: string | null;
  resourceKind: 'layout' | 'custom_part' | 'module' | 'org' | null;
  resourceId: string | null;
  userId: string | null;
  userName: string | null;
  eventType: string;
  payload: unknown;
  docVersion: number | null;
  createdAt: number;
}

export interface CustomPartSummary {
  id: string;
  partNumber: string;
  displayName: string;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  /** The caller's role on it (newer servers). */
  role?: 'owner' | 'editor' | 'viewer';
  /** Who owns it, by name (newer servers). */
  owner?: OwnerInfo | null;
  /** Empty for a set. */
  spriteMime: 'image/gif' | 'image/png' | '';
  /** A set of other parts: no picture of its own (newer servers). */
  kind?: 'set';
  createdAt: number;
  updatedAt: number;
  credit?: Credit | null;
}

export interface ModuleSummary {
  id: string;
  title: string;
  /** The caller's role on it (list responses). */
  role?: 'owner' | 'editor' | 'viewer';
  owner?: OwnerInfo | null;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  docVersion: number;
  hasSidecar: boolean;
  /** When its picture was made (the picture URL's cache key); null or missing: none yet. */
  thumbnailAt?: number | null;
  /** The picture's longest side in pixels (older servers leave it out). */
  thumbnailSide?: number | null;
  /** The newest saved version's number; 0 or missing: no history yet. */
  latestVersion?: number;
  createdAt: number;
  updatedAt: number;
  credit?: Credit | null;
}

/** One saved version of a module. */
export interface ModuleVersion {
  version: number;
  note: string | null;
  createdAt: number;
  /** Who saved it (null when that account is gone). */
  author: string | null;
  hasThumbnail: boolean;
  bytes: number;
}

/** A version's picture, or null when it has none. */
export function moduleVersionThumbnailUrl(moduleId: string, v: Pick<ModuleVersion, 'version' | 'hasThumbnail'>, size?: 'small'): string | null {
  return v.hasThumbnail ? `/api/modules/${encodeURIComponent(moduleId)}/versions/${v.version}/thumbnail${size ? `?size=${size}` : ''}` : null;
}

/**
 * A module's picture, or null when it has none yet (show a placeholder).
 * `small` is a 256 px copy for list rows; without it, the full 1024 px one.
 */
export function moduleThumbnailUrl(m: Pick<ModuleSummary, 'id' | 'thumbnailAt'>, size?: 'small'): string | null {
  return m.thumbnailAt ? `/api/modules/${encodeURIComponent(m.id)}/thumbnail?v=${m.thumbnailAt}${size ? `&size=${size}` : ''}` : null;
}

/** Pictures made before they were 1024 px are 256: sharp in lists, soft on cards. */
export const LOW_RES_THUMBNAIL = 512;

/** An old, small picture its editors could redraw (open the module, or ⋯ › Refresh picture). */
export function lowResThumbnail(m: Pick<ModuleSummary, 'thumbnailAt' | 'thumbnailSide'>): boolean {
  return !!m.thumbnailAt && typeof m.thumbnailSide === 'number' && m.thumbnailSide < LOW_RES_THUMBNAIL;
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  myRole: ClubRole;
  /** A trusted club reviews what's published under its name (older servers leave it out). */
  trusted?: boolean;
  /** May I save new things to it? False when only its admins and managers may add (older servers leave it out). */
  canAdd?: boolean;
  /** A trusted club's admins and managers: how much waits in its review queue. */
  pendingReviews?: number;
  /** What my roles in it let me do (older servers leave it out: see clubCan). */
  permissions?: ClubPermission[];
  /** I hold its Admin role. */
  isAdmin?: boolean;
  /** The names of the roles I hold in it, in the club's order (older servers leave it out). */
  roleNames?: string[];
  /** Its logo's address, or null (older servers leave it out). */
  logoUrl?: string | null;
}

/** One of a club's roles. `key` names the four it starts with; a club's own roles have none. */
export interface ClubRoleSummary {
  id: string;
  key: 'admin' | 'manager' | 'member' | 'viewer' | null;
  name: string;
  permissions: ClubPermission[];
  position: number;
  memberCount: number;
}

export interface ModerationClub {
  id: string;
  slug: string;
  name: string;
  trusted: boolean;
  trustedAt: number | null;
}

/** A trusted club's own review queue. */
export interface ClubReview {
  items: {
    versionId: string;
    itemId: string;
    kind: CatalogKind;
    title: string;
    description: string;
    version: number;
    isUpdate: boolean;
    note: string | null;
    submitter: string | null;
    createdAt: number;
    previewUrl: string;
    /** An update that changes the text: what the public sees now (the title and description above are the new ones). */
    current?: CatalogText | null;
  }[];
  collections: CollectionReviewEntry[];
  /** New pictures for the club's public items (older servers leave it out). */
  covers?: CoverReviewEntry[];
  published: (CatalogItem & { status: CatalogStatus; reason: string | null })[];
  publicCollections: { id: string; title: string; status: CatalogStatus; reason: string | null }[];
}

export interface OrgDetail extends OrgSummary {
  description?: string;
  /** Members (not only admins) may add layouts, venues and modules. */
  membersCanCreate?: boolean;
  memberCount?: number;
  adminCount?: number;
  /** Who can join; older servers leave it out (invite only). */
  joinPolicy?: JoinPolicy;
  /** Shown in the Clubs directory. */
  listed?: boolean;
  /** Requests waiting (admins only). */
  pendingRequests?: number;
}

/** Who can join a club: only by invite, by asking, or anyone signed in. */
export type JoinPolicy = 'invite' | 'request' | 'open';

/** A club as people outside it see it in the directory. */
export interface ClubSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  memberCount: number;
  joinPolicy: JoinPolicy;
  listed: boolean;
  myStatus: ClubRole | 'requested' | null;
  /** Its logo's address, or null (older servers leave it out). */
  logoUrl?: string | null;
}

export interface JoinRequestSummary {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  message: string;
  createdAt: number;
}

export interface OrgMemberSummary {
  userId: string;
  role: ClubRole;
  /** Every role they hold (older servers leave it out). */
  roleIds?: string[];
  joinedAt: number;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /**
   * Roughly when they were last active, for the people who run the club
   * (and yourself); null when it isn't shown (older servers leave it out).
   */
  lastActive?: 'today' | 'week' | 'month' | 'older' | null;
}

export interface OrgInviteSummary {
  id: string;
  invitedEmail: string;
  role: ClubRole;
  /** The club role it gives (older servers leave it out). */
  roleId?: string;
  expiresAt: number;
  /** The invite's link, for the admin to send themselves. */
  inviteUrl?: string;
}

export interface CollaboratorSummary {
  userId: string;
  role: 'viewer' | 'editor' | 'owner';
  addedAt: number;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /** A custom part they have only because these shared sets brought it. */
  viaSets?: string[];
}

/** A custom part that comes along when its set is shared. */
export interface SetPartSummary {
  id: string;
  partNumber: string;
  displayName: string;
}

/** What moving (or copying) a set to a club does with the custom parts in it (server access/setMoves.ts). */
export interface SetMovePlan {
  /** Move with it (never when copying). */
  move: SetPartSummary[];
  /** The club gets its own copy: when moving, those another of your sets uses (they stay yours); when copying, all of yours. */
  copy: SetPartSummary[];
  /** The club already has a part with that number; the set uses the club's. */
  inClub: SetPartSummary[];
  /** Not yours to move; they stay where they are. */
  notYours: SetPartSummary[];
}

export interface InviteSummary {
  id: string;
  invitedEmail: string;
  role: 'viewer' | 'editor';
  expiresAt: number;
}

export interface RemotePackage {
  name: string;
  version: string;
  fileName: string;
  sourceUrl: string;
}

export interface PartLibrary {
  id: string;
  name: string;
  slug: string;
  sourceUrl: string | null;
  diskPath: string;
  partCount: number;
  defaultEnabled: boolean;
  locked: boolean;
  installedAt: number;
  updatedAt: number;
}

export interface OrgPartLibrary {
  id: string;
  name: string;
  slug: string;
  partCount: number;
  defaultEnabled: boolean;
  /** When true, org admins cannot disable this library — always enabled for everyone. */
  locked: boolean;
  /** Effective state for this org (includes defaultEnabled + override). */
  enabled: boolean;
  /** Whether the org has an explicit override row (never true for locked libraries). */
  explicitOverride: boolean;
}

/** Base64 of bytes, in chunks so large images don't overflow the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Moderation's lists: waiting for review, waiting in trusted clubs' own queues, public, unpublished. */
export type ModerationView = 'waiting' | 'trusted' | 'public' | 'unpublished';
export interface ModerationFilter {
  kind?: CatalogKind | '';
  q?: string;
  /** When sent (waiting) or last changed (public, unpublished), in ms. */
  from?: number | undefined;
  to?: number | undefined;
  sort?: 'oldest' | 'newest';
}
export type ModeratedItem = CatalogItem & { status: CatalogStatus; reason: string | null; updatedAt: number; owner: WarningSubject | null };
export interface ModerationCounts {
  waiting: number;
  trusted: number;
  covers: number;
  trustedCovers: number;
  public: number;
  unpublished: number;
  collections: number;
}
