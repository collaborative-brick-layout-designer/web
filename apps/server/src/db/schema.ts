import { blob, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// All timestamps are unix-millis (Drizzle "timestamp_ms" mode). Kept portable to
// Postgres `timestamptz` later by treating columns as opaque time-ordered ints.

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  passwordHash: text('password_hash'),
  /**
   * True only for the one demo account (demo/demoAccount.ts), which an
   * admin switches on in Admin › Settings. Nobody else has it.
   */
  isDemoAccount: integer('is_demo_account', { mode: 'boolean' }).notNull().default(false),
  isGlobalAdmin: integer('is_global_admin', { mode: 'boolean' }).notNull().default(false),
  /**
   * Site moderator: reviews and unpublishes public catalog items, and
   * nothing else an admin can do. Global admins can moderate too.
   */
  isModerator: integer('is_moderator', { mode: 'boolean' }).notNull().default(false),
  /**
   * Password-auth accounts start unverified and must confirm via the
   * emailed link (see email_verifications below) before they can log in.
   * OAuth/OIDC accounts are always created verified — the provider has
   * already proven the email — so this defaults true and password
   * registration explicitly sets it false.
   */
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  /**
   * Last time this account made a signed-in request, rounded to a few
   * minutes (metrics/activity.ts throttles the write). Powers the admin
   * DAU/WAU/MAU numbers and "not seen in 6 months". Only the newest
   * time is kept: no history, no pages, no IP. Null until first seen
   * after this column was added.
   */
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  /**
   * "Delete my account" (0026): when they asked, and when the account is
   * erased for good (privacy/accountDeletion.ts). Both null unless a
   * deletion is waiting. Signing in before `deletionDueAt` cancels it.
   */
  deletionRequestedAt: integer('deletion_requested_at', { mode: 'timestamp_ms' }),
  deletionDueAt: integer('deletion_due_at', { mode: 'timestamp_ms' }),
  /**
   * Restricted (0027), answering a privacy request: the account and what
   * it owns alone are frozen (read only) without being deleted. Null when
   * not restricted.
   */
  restrictedAt: integer('restricted_at', { mode: 'timestamp_ms' }),
}, (t) => ({
  // The admin "new users" graph and the active-user counts.
  createdIdx: index('users_created_at_idx').on(t.createdAt),
  lastSeenIdx: index('users_last_seen_at_idx').on(t.lastSeenAt),
}));

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    /**
     * When the person signed in (0040): the longest a sign-in can last
     * counts from here (auth/signInSettings.ts). Sessions from before 0040
     * got the migration's time. Filled in on insert when left out.
     */
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // "Log out everywhere" / user delete cascade look sessions up by user.
    userIdx: index('sessions_user_id_idx').on(t.userId),
  }),
);

// Personal access tokens for non-browser clients (the desktop app's live
// sync). Only a sha256 of the secret is stored, like sessions; `prefix`
// and `last4` are kept in the clear so the settings page can tell tokens
// apart. `scopes` is a space-separated list (see auth/apiTokens.ts).
// Expiry slides forward on use; revocation keeps the row (revokedAt) so
// the Devices list and audit trail still show it.
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    last4: text('last4').notNull(),
    scopes: text('scopes').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    // The Devices list and "revoke everything for this user".
    userIdx: index('api_tokens_user_id_idx').on(t.userId),
  }),
);

// Pending OAuth 2.0 device-authorization grants (RFC 8628). Both codes
// are stored as sha256 hashes: the device code is a bearer secret, and
// the short user code would otherwise be readable from a DB dump while
// it is still approvable. A row is single use — once its token is
// minted, status becomes 'consumed' and further polls fail.
export const deviceCodes = sqliteTable(
  'device_codes',
  {
    id: text('id').primaryKey(),
    deviceCodeHash: text('device_code_hash').notNull().unique(),
    userCodeHash: text('user_code_hash').notNull().unique(),
    clientName: text('client_name').notNull(),
    scopes: text('scopes').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'consumed'] }).notNull(),
    /** The approving (or denying) user; null while pending. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Current minimum poll interval in seconds (grows on slow_down). */
    interval: integer('interval').notNull(),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    expiresIdx: index('device_codes_expires_at_idx').on(t.expiresAt),
  }),
);

export const oauthAccounts = sqliteTable(
  'oauth_accounts',
  {
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerUserId] }),
  }),
);

// Pending email-verification tokens for password-auth signups. One row
// per outstanding (unconsumed) verification link; a fresh register or
// resend deletes any prior row for the user before inserting a new one,
// so a user has at most one live token at a time.
export const emailVerifications = sqliteTable('email_verifications', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * Platform-wide settings, admin-configurable via /api/admin/settings.
 * Singleton table: always exactly one row, id fixed to
 * PLATFORM_SETTINGS_ID (see auth/platformSettings.ts). DB values here
 * take precedence over the equivalent .env vars when set (a null SMTP
 * field falls back to env.smtp) — see auth/platformSettings.ts for the
 * merge logic and the transporter-cache invalidation it triggers.
 */
export const platformSettings = sqliteTable('platform_settings', {
  id: text('id').primaryKey(),
  /**
   * Require clicking an emailed link before a password-auth account can
   * log in. Defaults true (matches pre-existing always-on behaviour).
   * Turning this off does NOT retroactively verify existing unverified
   * accounts in the database — it makes the login/register routes stop
   * checking the flag at all, which has the same practical effect
   * (nothing blocks their login) without an irreversible bulk UPDATE.
   */
  requireEmailVerification: integer('require_email_verification', { mode: 'boolean' }).notNull().default(true),
  /**
   * SMTP override. All fields null = "use env.smtp (or none)". Any
   * non-null smtpHost is treated as "DB config is in use" — see
   * mergeSmtpConfig in auth/platformSettings.ts. smtpPass is stored in
   * plaintext in SQLite (matches SMTP_PASS's own trust model — this DB
   * file already holds password hashes and session tokens) and is
   * NEVER returned by GET /api/admin/settings; the API returns
   * `smtpPassSet: boolean` instead.
   */
  smtpHost: text('smtp_host'),
  smtpPort: integer('smtp_port'),
  smtpUser: text('smtp_user'),
  smtpPass: text('smtp_pass'),
  smtpFrom: text('smtp_from'),
  /**
   * Global usage limits set by an admin, as a JSON object of
   * limit key -> number (see limits/limits.ts). Keys left out use the
   * env var (LIMIT_*) or the built-in default. Null = nothing set here.
   */
  limits: text('limits'),
  /**
   * "Oldest desktop allowed": desktop apps older than this are asked to
   * update (426 update_required) instead of connecting. Null = the code's
   * own minimum (compat.ts DESKTOP_MINIMUM); a value below that minimum
   * is ignored, since those apps don't work with this server anyway.
   */
  minDesktopVersion: text('min_desktop_version'),
  /** The public module catalog. Off until an admin turns it on. */
  moduleCatalogEnabled: integer('module_catalog_enabled', { mode: 'boolean' }).notNull().default(false),
  /** The public parts catalog. Off until an admin turns it on. */
  partsCatalogEnabled: integer('parts_catalog_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Public layouts in the catalog. Off until an admin turns it on. */
  layoutCatalogEnabled: integer('layout_catalog_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Public venues in the catalog. Off until an admin turns it on. */
  venueCatalogEnabled: integer('venue_catalog_enabled', { mode: 'boolean' }).notNull().default(false),
  /**
   * Review before publishing: 'moderators' (a moderator approves each
   * submission) or 'none' (published straight away).
   */
  catalogReview: text('catalog_review', { enum: ['moderators', 'none'] }).notNull().default('moderators'),
  /** Whether people who aren't signed in may browse the catalogs (adding always needs an account). */
  catalogAnonymousBrowse: integer('catalog_anonymous_browse', { mode: 'boolean' }).notNull().default(true),
  /**
   * Admin › Settings › "Enforce usage limits". On by default (collab runs
   * with limits on). The LIMITS_ENFORCE env var, when set, overrides it.
   */
  limitsEnforced: integer('limits_enforced', { mode: 'boolean' }).notNull().default(true),
  /**
   * Admin › Settings › Background jobs. Each env var (BACKUPS_ENABLED,
   * DAILY_COMPACTION_ENABLED), when set, overrides its switch.
   */
  backupsEnabled: integer('backups_enabled', { mode: 'boolean' }).notNull().default(true),
  dailyCompactionEnabled: integer('daily_compaction_enabled', { mode: 'boolean' }).notNull().default(true),
  /**
   * No longer used: demo layouts don't expire any more (the one demo
   * account resets instead). Left in place so no column is dropped.
   */
  demoTtlSweepEnabled: integer('demo_ttl_sweep_enabled', { mode: 'boolean' }).notNull().default(true),
  /** No longer used (see demoTtlSweepEnabled). */
  demoLayoutTtlDays: integer('demo_layout_ttl_days').notNull().default(30),
  /**
   * Admin › Settings › Demo account. Off by default; turning it on makes
   * the one demo account (demo/demoAccount.ts) and shows "Try the demo"
   * on the sign-in page.
   */
  demoEnabled: integer('demo_enabled', { mode: 'boolean' }).notNull().default(false),
  /** How often the demo account's things are wiped and the samples put back. */
  demoResetEvery: text('demo_reset_every', { enum: ['1h', '6h', 'daily'] }).notNull().default('daily'),
  /** When the demo account was last reset. Null until the first reset. */
  demoLastResetAt: integer('demo_last_reset_at', { mode: 'timestamp_ms' }),
  /**
   * Admin › Settings › Public catalogs: the biggest picture a curator can
   * upload as a collection's cover (before it's re-encoded). The
   * COLLECTION_COVER_MAX_BYTES env var, when set, overrides it.
   */
  collectionCoverMaxBytes: integer('collection_cover_max_bytes').notNull().default(5 * 1024 * 1024),
  /**
   * Admin › Settings › Privacy (0025): a JSON object of privacy setting
   * key -> number (see privacy/settings.ts): how often people may
   * download their data, the biggest download, how long it is kept.
   * Keys left out use the built-in default; a PRIVACY_* env var forces one.
   */
  privacy: text('privacy'),
  /**
   * The site's privacy notice (markdown) and who to ask about personal
   * data (an email address or a web address), shown on /privacy (0027).
   * Null until an admin writes them; PRIVACY_CONTACT forces the contact.
   */
  privacyNotice: text('privacy_notice'),
  privacyContact: text('privacy_contact'),
  /**
   * Admin › Settings › Sign-in (0040): a JSON object of sign-in setting key
   * -> hours or "never" (see auth/signInSettings.ts): how long a web or
   * desktop sign-in lasts unused, and the longest it can last. Keys left
   * out use the built-in default; a SIGN_IN_* env var forces one.
   */
  signIn: text('sign_in'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

export const orgs = sqliteTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  /** A line or two about the club, shown on its page. */
  description: text('description'),
  /**
   * Whether members (not only admins) may add layouts, venues and modules
   * to the club. On by default.
   */
  membersCanCreate: integer('members_can_create', { mode: 'boolean' }).notNull().default(true),
  /**
   * Who created the club, for the "clubs a person may create" limit.
   * Null for clubs made before this column existed (they don't count).
   */
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  /**
   * Who can join: 'invite' (only with an admin's invite, the default),
   * 'request' (people ask and an admin approves), or 'open' (anyone
   * signed in joins with one click, as a member).
   */
  joinPolicy: text('join_policy', { enum: ['invite', 'request', 'open'] }).notNull().default('invite'),
  /** Shown in the Clubs directory to everyone signed in. Off by default. */
  listed: integer('listed', { mode: 'boolean' }).notNull().default(false),
  /**
   * A trusted club: its own admins and managers review what's published
   * under its name (modules, parts and collections) instead of the site's
   * moderators. Set by a site admin or moderator; off by default.
   */
  trusted: integer('trusted', { mode: 'boolean' }).notNull().default(false),
  /** When it was last trusted (null: never, or not now). */
  trustedAt: integer('trusted_at', { mode: 'timestamp_ms' }),
  /**
   * Deleting the club (0028): it waits first (the Privacy setting's days),
   * hidden from everyone: its memberships are set aside in
   * `deletionPlan` (JSON: members, whether it was listed, and what
   * happens to its public catalog items) so Restore puts them back. All
   * null unless a deletion is waiting.
   */
  deletionRequestedAt: integer('deletion_requested_at', { mode: 'timestamp_ms' }),
  deletionDueAt: integer('deletion_due_at', { mode: 'timestamp_ms' }),
  /** Who deleted it (no FK: the club's members see the name in their notice; an erased account's id stays). */
  deletedBy: text('deleted_by'),
  deletionPlan: text('deletion_plan'),
});

export const orgMembers = sqliteTable(
  'org_members',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['admin', 'manager', 'member'] }).notNull(),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    // "Which orgs am I in" is on every list endpoint; the PK is (org, user).
    userIdx: index('org_members_user_id_idx').on(t.userId),
  }),
);

// Club roles (0033): each club sets up its own roles. Every club starts
// with Admin, Manager, Member and Viewer (`key` names those four; a role a
// club made itself has no key). `permissions` is a JSON array of
// permission names (access/clubPermissions.ts); the Admin role always has
// every one. A member holds one or more roles and gets the union.
// org_members.role stays as the strongest built-in role a person holds
// ('member' for custom roles only), for the places that only need that.
export const clubRoles = sqliteTable(
  'club_roles',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    key: text('key', { enum: ['admin', 'manager', 'member', 'viewer'] }),
    name: text('name').notNull(),
    permissions: text('permissions').notNull(),
    position: integer('position').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    orgIdx: index('club_roles_org_id_idx').on(t.orgId),
  }),
);

export const memberRoles = sqliteTable(
  'member_roles',
  {
    orgId: text('org_id').notNull(),
    userId: text('user_id').notNull(),
    roleId: text('role_id')
      .notNull()
      .references(() => clubRoles.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId, t.roleId] }),
    member: foreignKey({ columns: [t.orgId, t.userId], foreignColumns: [orgMembers.orgId, orgMembers.userId] }).onDelete('cascade'),
    roleIdx: index('member_roles_role_id_idx').on(t.roleId),
  }),
);

// Pending org-membership invites. Same shape as layout_invites but for
// joining an org. Auto-cleared on accept; admins can also revoke.
export const orgInvites = sqliteTable('org_invites', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  invitedEmail: text('invited_email').notNull(),
  invitedBy: text('invited_by')
    .notNull()
    .references(() => users.id),
  role: text('role', { enum: ['admin', 'manager', 'member'] }).notNull(),
  /** The club role the invite gives (0033); null: the built-in one `role` names. */
  roleId: text('role_id'),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }),
});

// Asks to join a club whose admins approve newcomers. One per person per
// club; approving or declining deletes it (the audit log keeps the record).
export const orgJoinRequests = sqliteTable(
  'org_join_requests',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** An optional short note to the admins. */
    message: text('message'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    orgUser: uniqueIndex('org_join_requests_org_user_idx').on(t.orgId, t.userId),
    userIdx: index('org_join_requests_user_id_idx').on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// Layouts (Phase 2)
// ---------------------------------------------------------------------------

export const layouts = sqliteTable(
  'layouts',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    // Exactly one of (ownerUserId, ownerOrgId) is non-null. Drizzle/SQLite has
    // no native check-constraint helper here; the resolveResourceRole helper
    // and REST handlers enforce the invariant.
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    ownerOrgId: text('owner_org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    // No longer used: demo layouts used to expire. Always null now; left in
    // place so no column is dropped.
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    // Yjs binary doc snapshot. In Phase 2, populated from a fresh seed (empty
    // Y.Doc) on create OR derived from the imported .bbm. Phase 4's WS server
    // hydrates this on first connect.
    docSnapshot: blob('doc_snapshot').notNull(),
    docVersion: integer('doc_version').notNull().default(0),
    sidecarSnapshot: blob('sidecar_snapshot'),
    // Public-share token. Null = layout is private (default). Non-null
    // = anyone with the token URL can view the layout read-only without
    // signing in. The token is the only secret — owners rotate it by
    // disabling and re-enabling sharing.
    publicShareToken: text('public_share_token').unique(),
    /**
     * Last time anyone opened the layout (REST get or a live editor
     * connection), throttled. Feeds the admin "not opened in 90 days"
     * list. Null until first opened after this column was added.
     */
    lastOpenedAt: integer('last_opened_at', { mode: 'timestamp_ms' }),
    /**
     * Author credit (0024). `copiedFromId`: the item this one was copied
     * from (no FK: the original may go), shown as "based on ‹title› by
     * ‹author›". `deletedAuthorId`: when the author's account was deleted,
     * their old id (created_by then points at someone else, for the FK),
     * so the credit reads "Builder #…" instead of naming that someone.
     */
    copiedFromId: text('copied_from_id'),
    deletedAuthorId: text('deleted_author_id'),
  },
  (t) => ({
    // The admin "layouts created / edited" graphs.
    createdIdx: index('layouts_created_at_idx').on(t.createdAt),
    updatedIdx: index('layouts_updated_at_idx').on(t.updatedAt),
    // Both power admin per-owner aggregate queries (layout count + size
    // by user/org) — see routes/admin.ts. Without these, GROUP BY
    // owner_user_id / owner_org_id is a full table scan.
    ownerUserIdx: index('layouts_owner_user_id_idx').on(t.ownerUserId),
    ownerOrgIdx: index('layouts_owner_org_id_idx').on(t.ownerOrgId),
  }),
);

export const layoutCollaborators = sqliteTable(
  'layout_collaborators',
  {
    layoutId: text('layout_id')
      .notNull()
      .references(() => layouts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['viewer', 'editor', 'owner'] }).notNull(),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.layoutId, t.userId] }),
    // "Layouts shared with me" — the PK leads with layout_id.
    userIdx: index('layout_collaborators_user_id_idx').on(t.userId),
  }),
);

export const layoutInvites = sqliteTable('layout_invites', {
  id: text('id').primaryKey(),
  layoutId: text('layout_id')
    .notNull()
    .references(() => layouts.id, { onDelete: 'cascade' }),
  invitedEmail: text('invited_email').notNull(),
  role: text('role', { enum: ['viewer', 'editor', 'owner'] }).notNull(),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }),
  /**
   * Who sent it (0033). The invite holds only while they still manage the
   * layout's sharing. Null on invites made before 0033: the audit log's
   * `share` row names the sender for those.
   */
  invitedBy: text('invited_by').references(() => users.id, { onDelete: 'cascade' }),
});

// User → user layout transfers (Phase 6 / PLAN.md §3.5). When the new
// owner is a user (not an org), the transfer requires the recipient to
// accept via a token link before ownership flips. Transfers TO an org
// commit immediately and don't use this table.
export const layoutTransfers = sqliteTable('layout_transfers', {
  id: text('id').primaryKey(),
  layoutId: text('layout_id')
    .notNull()
    .references(() => layouts.id, { onDelete: 'cascade' }),
  /** Caller who initiated the transfer. */
  initiatedBy: text('initiated_by')
    .notNull()
    .references(() => users.id),
  /**
   * Email of the recipient. We don't FK to users because the recipient
   * may not yet have an account at invite time — same shape as
   * layout_invites. Email-match enforced at acceptance time.
   */
  recipientEmail: text('recipient_email').notNull(),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

// Phase 4 will fill this with y-update binary records between snapshots.
// We declare it now so the migration sticks once and Phase 4 doesn't need
// to alter a populated layouts table.
export const layoutUpdates = sqliteTable(
  'layout_updates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    layoutId: text('layout_id')
      .notNull()
      .references(() => layouts.id, { onDelete: 'cascade' }),
    doc: text('doc', { enum: ['main', 'sidecar'] }).notNull(),
    updateBytes: blob('update_bytes').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    // Every WS write hits this by layoutId (docHub.ts), and the admin
    // per-owner size aggregate joins through it — see routes/admin.ts.
    layoutIdx: index('layout_updates_layout_id_idx').on(t.layoutId),
  }),
);

// Per-layout audit log (PLAN.md §3.1 / §4.7). Append-only. payload is a
// JSON string because SQLite has no jsonb; queries on this table read the
// whole row and parse it client-side, which keeps us portable to Postgres
// without a column type change.
export const auditEvents = sqliteTable(
  'audit_events',
  {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /**
   * Layout-specific audits keep this column populated. New non-layout
   * resource events (custom parts, modules) leave it null and use the
   * generic `(resource_kind, resource_id)` pair below. Kept as a
   * convenience column so existing layout-audit queries keep working
   * without a migration; intentionally NOT a foreign key when null,
   * so generic events don't trigger cascade-on-delete behaviour.
   */
  layoutId: text('layout_id'),
  /**
   * Resource kind for generic audits. Null for legacy layout-only rows
   * (where layout_id is set instead). Either (layout_id) or
   * (resource_kind + resource_id) must be set; never both, never
   * neither. Enforced in the writer, not in the schema.
   */
  resourceKind: text('resource_kind', { enum: ['layout', 'custom_part', 'module', 'venue', 'org', 'user', 'part_library', 'platform_settings', 'catalog_item', 'catalog_collection'] }),
  resourceId: text('resource_id'),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull(), // JSON string
  docVersion: integer('doc_version'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  /**
   * Who did it, once their account is erased (0026): "Deleted user #abc123"
   * (user_id is then null). Null while the account exists.
   */
  actorLabel: text('actor_label'),
  },
  (t) => ({
    // The two audit read paths: per-layout and per-(kind, id), newest first.
    layoutCreatedIdx: index('audit_events_layout_id_created_at_idx').on(t.layoutId, t.createdAt),
    resourceCreatedIdx: index('audit_events_resource_created_at_idx').on(
      t.resourceKind,
      t.resourceId,
      t.createdAt,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Custom parts + reusable modules (Phase 6.5)
// ---------------------------------------------------------------------------

// User- or org-uploaded part definition. Same shape as a BlueBrickParts
// XML+sprite pair, persisted in the database. The bundled BlueBrickParts
// library is NOT modelled here — those are static, served from /parts/*
// by Fastify. Only USER-uploaded parts hit this table.
export const customParts = sqliteTable(
  'custom_parts',
  {
  id: text('id').primaryKey(),
  /** Identifier the user picked. Unique within an owner. */
  partNumber: text('part_number').notNull(),
  displayName: text('display_name').notNull(),
  ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  ownerOrgId: text('owner_org_id').references(() => orgs.id, { onDelete: 'cascade' }),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  /**
   * When true, this part is visible to ALL users as part of the global
   * catalog and can only be managed by platform admins. ownerUserId and
   * ownerOrgId are null for global parts.
   */
  isGlobal: integer('is_global', { mode: 'boolean' }).notNull().default(false),
  /**
   * Parts-browser category label. Bundled parts derive this from the
   * XML's parent folder name; custom parts let the uploader specify a
   * string (e.g. "My Org Tracks"). Defaults to 'Custom'.
   */
  category: text('category').notNull().default('Custom'),
  /** Full XML payload — same shape as a BlueBrickParts file. */
  xmlBlob: blob('xml_blob').notNull(),
  /** Sprite bytes (gif/png). */
  spriteBlob: blob('sprite_blob').notNull(),
  // '' (with an empty sprite_blob) for a set: a <group> of other parts,
  // drawn by them. The enum is TypeScript's only, so no migration.
  spriteMime: text('sprite_mime', { enum: ['image/gif', 'image/png', ''] }).notNull(),
  /**
   * Author credit (0024). `copiedFromId`: the item this one was copied
   * from (no FK: the original may go), shown as "based on ‹title› by
   * ‹author›". `deletedAuthorId`: when the author's account was deleted,
   * their old id (created_by then points at someone else, for the FK),
   * so the credit reads "Builder #…" instead of naming that someone.
   */
  copiedFromId: text('copied_from_id'),
  deletedAuthorId: text('deleted_author_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    createdIdx: index('custom_parts_created_at_idx').on(t.createdAt),
    ownerUserIdx: index('custom_parts_owner_user_id_idx').on(t.ownerUserId),
    ownerOrgIdx: index('custom_parts_owner_org_id_idx').on(t.ownerOrgId),
  }),
);

export const customPartCollaborators = sqliteTable(
  'custom_part_collaborators',
  {
    customPartId: text('custom_part_id')
      .notNull()
      .references(() => customParts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['viewer', 'editor', 'owner'] }).notNull(),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.customPartId, t.userId] }),
    userIdx: index('custom_part_collaborators_user_id_idx').on(t.userId),
  }),
);

// Pending custom-part invites for unregistered emails (Phase 7 backlog).
// Once the recipient registers + accepts, accepted_at is set and a
// custom_part_collaborators row is created.
// Invites to a custom part by an emailed link, the same shape as
// module_invites: the recipient signs in with the invited, verified email
// and accepts. Single use, expires, and holds only while its sender still
// manages the part's sharing. Pending ones go when the part changes hands.
// `invited_by` and `created_at` came with invite links (0036); the table
// had no writer before, so a null sender never holds.
export const customPartInvites = sqliteTable(
  'custom_part_invites',
  {
    id: text('id').primaryKey(),
    customPartId: text('custom_part_id')
      .notNull()
      .references(() => customParts.id, { onDelete: 'cascade' }),
    invitedEmail: text('invited_email').notNull(),
    role: text('role', { enum: ['viewer', 'editor'] }).notNull(),
    token: text('token').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }),
    invitedBy: text('invited_by').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    partIdx: index('custom_part_invites_custom_part_id_idx').on(t.customPartId),
  }),
);

// Custom parts someone has only because a set of them was shared with
// them (0038): sharing a set by invite brings along the sharer's own parts
// it's made of, as viewers. One row per (set, part, person); while a row
// is left the part stays shared, and taking the set back takes the part
// back too, unless it was shared on its own (then it has no row here).
export const customPartSetShares = sqliteTable(
  'custom_part_set_shares',
  {
    setId: text('set_id')
      .notNull()
      .references(() => customParts.id, { onDelete: 'cascade' }),
    partId: text('part_id')
      .notNull()
      .references(() => customParts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.setId, t.partId, t.userId] }),
    partUserIdx: index('custom_part_set_shares_part_user_idx').on(t.partId, t.userId),
    userIdx: index('custom_part_set_shares_user_id_idx').on(t.userId),
  }),
);

// Reusable named module: a saved selection of bricks (and their relative
// positions / per-brick metadata) that can be dropped into any layout the
// owner has access to. Mirrors desktop's `Module` but elevates it to a
// first-class shareable asset.
export const modules = sqliteTable(
  'modules',
  {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  ownerOrgId: text('owner_org_id').references(() => orgs.id, { onDelete: 'cascade' }),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  /** Y.Doc snapshot bytes — same persistence story as layouts. */
  docSnapshot: blob('doc_snapshot').notNull(),
  docVersion: integer('doc_version').notNull().default(0),
  /** Optional sidecar (subset of layout sidecar — no venue, no rulers). */
  sidecarSnapshot: blob('sidecar_snapshot'),
  /**
   * A small picture of the module (about 256 px on its longest side), made
   * by the editor when the module is saved. Null until the first save (or
   * the first open, which backfills it).
   */
  thumbnail: blob('thumbnail'),
  thumbnailMime: text('thumbnail_mime', { enum: ['image/png', 'image/webp'] }),
  /** When the picture was last made: the cache key in its URL. */
  thumbnailAt: integer('thumbnail_at', { mode: 'timestamp_ms' }),
  /** The newest saved version's number (module_versions); 0 until the first save with versions. */
  latestVersion: integer('latest_version').notNull().default(0),
  /**
   * The module this one was copied from (no FK: the original may go), so
   * "Add all" from a club collection can skip what you already copied.
   * Null for modules made from scratch, and for copies made before 0021.
   */
  copiedFromId: text('copied_from_id'),
  /** See custom_parts.deletedAuthorId (0024). */
  deletedAuthorId: text('deleted_author_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    createdIdx: index('modules_created_at_idx').on(t.createdAt),
    ownerUserIdx: index('modules_owner_user_id_idx').on(t.ownerUserId),
    ownerOrgIdx: index('modules_owner_org_id_idx').on(t.ownerOrgId),
  }),
);

// Each save of a module is a version: its contents, picture and an optional
// "What changed" note. The newest few are kept (MODULE_VERSIONS_KEPT).
export const moduleVersions = sqliteTable(
  'module_versions',
  {
    id: text('id').primaryKey(),
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    /** 1, 2, 3… per module. */
    version: integer('version').notNull(),
    docSnapshot: blob('doc_snapshot').notNull(),
    thumbnail: blob('thumbnail'),
    thumbnailMime: text('thumbnail_mime', { enum: ['image/png', 'image/webp'] }),
    note: text('note'),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    moduleVersionIdx: uniqueIndex('module_versions_module_version_idx').on(t.moduleId, t.version),
  }),
);

export const moduleCollaborators = sqliteTable(
  'module_collaborators',
  {
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['viewer', 'editor', 'owner'] }).notNull(),
    addedAt: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.moduleId, t.userId] }),
    userIdx: index('module_collaborators_user_id_idx').on(t.userId),
  }),
);

// Invites to a module by an emailed link (0034), the same shape as
// layout_invites: the recipient signs in with the invited, verified email
// and accepts. Single use, expires, and holds only while its sender still
// manages the module's sharing. Pending ones go when the module changes
// hands.
export const moduleInvites = sqliteTable(
  'module_invites',
  {
    id: text('id').primaryKey(),
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    invitedEmail: text('invited_email').notNull(),
    role: text('role', { enum: ['viewer', 'editor'] }).notNull(),
    token: text('token').notNull().unique(),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    moduleIdx: index('module_invites_module_id_idx').on(t.moduleId),
  }),
);

// User → user module transfers (mirror of layout_transfers). Org-recipient
// transfers commit immediately and don't write here.
export const moduleTransfers = sqliteTable('module_transfers', {
  id: text('id').primaryKey(),
  moduleId: text('module_id')
    .notNull()
    .references(() => modules.id, { onDelete: 'cascade' }),
  initiatedBy: text('initiated_by')
    .notNull()
    .references(() => users.id),
  recipientEmail: text('recipient_email').notNull(),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

// ---------------------------------------------------------------------------
// Part libraries — system-installed, org-selectable.
//
// A `part_library` is a named collection of parts installed by a platform
// admin (uploaded as a zip, or pulled from a URL). Every library's parts are
// served as bundled parts scoped to their library slug.
//
// `org_part_libraries` is a join table: when a row exists, the org has that
// library enabled. Orgs that have no rows default to seeing only the built-in
// parts (same as today). A library marked `default_enabled` is automatically
// made available to all orgs without an explicit row.
// ---------------------------------------------------------------------------
export const partLibraries = sqliteTable('part_libraries', {
  id: text('id').primaryKey(),
  /** Human-readable display name. */
  name: text('name').notNull(),
  /** URL slug — used as the category prefix for parts in this library. */
  slug: text('slug').notNull().unique(),
  /** Source URL if installed from a remote zip; null for manual uploads. */
  sourceUrl: text('source_url'),
  /** Number of parts in the library (denormalised for the UI). */
  partCount: integer('part_count').notNull().default(0),
  /** When true, all orgs see this library without an explicit opt-in. */
  defaultEnabled: integer('default_enabled', { mode: 'boolean' }).notNull().default(false),
  /** When true, org admins cannot disable this library — it is always on for everyone. */
  locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
  installedAt: integer('installed_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Explicit per-org library opt-in/opt-out. */
export const orgPartLibraries = sqliteTable(
  'org_part_libraries',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    libraryId: text('library_id')
      .notNull()
      .references(() => partLibraries.id, { onDelete: 'cascade' }),
    /** true = explicitly enabled; false = explicitly disabled (overrides defaultEnabled). */
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.orgId, t.libraryId] }) }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type DeviceCode = typeof deviceCodes.$inferSelect;
export type OAuthAccount = typeof oauthAccounts.$inferSelect;
export type EmailVerification = typeof emailVerifications.$inferSelect;
export type PlatformSettings = typeof platformSettings.$inferSelect;
export type Layout = typeof layouts.$inferSelect;
export type NewLayout = typeof layouts.$inferInsert;
export type LayoutCollaborator = typeof layoutCollaborators.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type PartLibrary = typeof partLibraries.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type OrgInvite = typeof orgInvites.$inferSelect;
export type LayoutTransfer = typeof layoutTransfers.$inferSelect;
export type CustomPart = typeof customParts.$inferSelect;
export type CustomPartCollaborator = typeof customPartCollaborators.$inferSelect;
export type CustomPartInvite = typeof customPartInvites.$inferSelect;
export type CustomPartSetShare = typeof customPartSetShares.$inferSelect;
export type Module = typeof modules.$inferSelect;
export type ModuleCollaborator = typeof moduleCollaborators.$inferSelect;
export type ModuleTransfer = typeof moduleTransfers.$inferSelect;

export const venueLibrary = sqliteTable('venue_library', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  ownerOrgId: text('owner_org_id').references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** Serialised Venue JSON. */
  data: text('data').notNull(),
  /**
   * Who made it (0024). No FK, so a deleted author's id stays and the
   * credit reads "Builder #…". Null for club venues saved before 0024.
   */
  createdBy: text('created_by'),
  /** The venue this one was copied from (no FK), as on layouts. */
  copiedFromId: text('copied_from_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
export type VenueLibraryEntry = typeof venueLibrary.$inferSelect;

/**
 * Per-account appearance and help settings (theme, color, bigger text,
 * expert mode, help icons, tours seen). One row per user; `prefs` is a
 * validated JSON object (see routes/preferences.ts) so new keys don't
 * need a migration. `updatedAt` lets clients that cache the settings
 * (the desktop app) decide which copy is newer.
 */
export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  prefs: text('prefs').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export type UserPreferencesRow = typeof userPreferences.$inferSelect;

/**
 * Tiny daily rollup for the admin dashboard: things the database keeps
 * no history of (active users, requests, errors, refusals, live
 * sessions, disk size). One row per (UTC day, metric, key); `key`
 * narrows a metric (a route, a client kind, a layout id) and is '' when
 * unused. Aggregate only: never a URL trail, never an IP, and person
 * ids are only ever counted, not stored (see metrics/rollup.ts).
 * Rows older than ROLLUP_RETENTION_DAYS are swept daily.
 */
export const dailyStats = sqliteTable(
  'daily_stats',
  {
    day: text('day').notNull(),
    metric: text('metric').notNull(),
    key: text('key').notNull().default(''),
    value: integer('value').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.day, t.metric, t.key] }),
    // "Collecting since" and per-metric range scans.
    metricDayIdx: index('daily_stats_metric_day_idx').on(t.metric, t.day),
  }),
);
export type DailyStat = typeof dailyStats.$inferSelect;

/**
 * Per-person and per-club limit overrides, and suspension. One row per
 * subject; `limits` is a JSON object of limit key -> number that wins
 * over the global value (raise or lower). A suspended subject is
 * read-only (see limits/enforce.ts).
 */
export const limitOverrides = sqliteTable(
  'limit_overrides',
  {
    subjectKind: text('subject_kind', { enum: ['user', 'org'] }).notNull(),
    subjectId: text('subject_id').notNull(),
    limits: text('limits').notNull().default('{}'),
    suspended: integer('suspended', { mode: 'boolean' }).notNull().default(false),
    suspendedReason: text('suspended_reason'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.subjectKind, t.subjectId] }) }),
);
export type LimitOverride = typeof limitOverrides.$inferSelect;

/**
 * Daily per-person and per-club counters for spotting abuse: requests,
 * refused requests, uploads, upload bytes, share-link views. Counts
 * only (no URLs, no IPs); swept after USAGE_RETENTION_DAYS.
 */
export const usageDaily = sqliteTable(
  'usage_daily',
  {
    day: text('day').notNull(),
    subjectKind: text('subject_kind', { enum: ['user', 'org'] }).notNull(),
    subjectId: text('subject_id').notNull(),
    metric: text('metric').notNull(),
    value: integer('value').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.day, t.subjectKind, t.subjectId, t.metric] }),
    kindMetricDayIdx: index('usage_daily_kind_metric_day_idx').on(t.subjectKind, t.metric, t.day),
    subjectIdx: index('usage_daily_subject_idx').on(t.subjectKind, t.subjectId, t.day),
  }),
);

// ---------------------------------------------------------------------------
// Public catalogs (modules and parts)
//
// Sharing makes a COPY: a catalog item holds snapshots of what was shared
// (catalog_item_versions), never a link to the original, so later edits
// change nothing until the owner shares an update. People who add an item
// get their own copy too (catalog_copies remembers which version, for the
// "Update available" badge).
// ---------------------------------------------------------------------------
export const catalogItems = sqliteTable(
  'catalog_items',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['module', 'part', 'layout', 'venue'] }).notNull(),
    /** The module, custom part, layout or venue it was shared from (no FK: the original may go). */
    sourceId: text('source_id').notNull(),
    /** Who the item belongs to: a person, or a club (whose admins and managers manage it). */
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    ownerOrgId: text('owner_org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** JSON array of lower-case tags. */
    tags: text('tags').notNull().default('[]'),
    /**
     * 'in_review' (first submission waiting), 'public', 'declined',
     * 'unpublished' (by a moderator) or 'withdrawn' (by its owner).
     */
    status: text('status', { enum: ['in_review', 'public', 'declined', 'unpublished', 'withdrawn'] }).notNull(),
    /** Why it was declined or unpublished, when a moderator said. */
    reason: text('reason'),
    /** The version people get; 0 until one is approved. */
    publicVersion: integer('public_version').notNull().default(0),
    /** How many times it was added to someone's modules or parts. */
    uses: integer('uses').notNull().default(0),
    /**
     * A picture its owner uploaded (catalog_item_covers.id); when set, the
     * catalog shows it instead of the drawn one. Null: the drawn picture.
     */
    coverImageId: text('cover_image_id'),
    /** A new uploaded picture waiting for review while the item is public; the old one stays up. */
    pendingCoverImageId: text('pending_cover_image_id'),
    /** Why the last uploaded picture was declined, until a new one is sent. */
    coverReason: text('cover_reason'),
    /**
     * Who took it down, while that stands: 'site' (a site moderator; only
     * site moderators bring it back) or 'club' (a trusted club's reviewers,
     * or a site moderator). Kept through withdrawals and new shares, and
     * cleared when a reviewer approves it again.
     */
    takenDownBy: text('taken_down_by', { enum: ['site', 'club'] }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    sourceIdx: index('catalog_items_source_idx').on(t.sourceId),
    statusIdx: index('catalog_items_status_idx').on(t.kind, t.status),
    /** Moderation's lists of what's published or unpublished, a page at a time, newest first. */
    statusUpdatedIdx: index('catalog_items_status_updated_idx').on(t.status, t.updatedAt),
  }),
);

export const catalogItemVersions = sqliteTable(
  'catalog_item_versions',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => catalogItems.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** 'in_review', 'public' (approved: it was or is the public one) or 'declined'. */
    status: text('status', { enum: ['in_review', 'public', 'declined'] }).notNull(),
    submittedBy: text('submitted_by').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    reason: text('reason'),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    /**
     * A module or a layout: its Y.Doc (a layout's is a cleaned copy: no
     * history, no local file paths, no background picture). A venue: its
     * Venue JSON (UTF-8), notes left out.
     */
    docSnapshot: blob('doc_snapshot'),
    /** A part: its XML, sprite and number. */
    partNumber: text('part_number'),
    category: text('category'),
    xmlBlob: blob('xml_blob'),
    spriteBlob: blob('sprite_blob'),
    spriteMime: text('sprite_mime'),
    /** The preview picture (a module's thumbnail; a part's sprite is its own). */
    thumbnail: blob('thumbnail'),
    thumbnailMime: text('thumbnail_mime'),
    /**
     * A layout or venue: what its public page shows without opening it, as
     * JSON (size in studs, a layout's parts list). Null for modules and parts.
     */
    summary: text('summary'),
    /**
     * The title, description and tags (JSON) sent with this version. They
     * become the item's when it's approved; until then the public sees the
     * approved ones. Null on versions from before they were kept here.
     */
    title: text('title'),
    description: text('description'),
    tags: text('tags'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    itemVersionIdx: uniqueIndex('catalog_item_versions_item_version_idx').on(t.itemId, t.version),
    /** Moderation's queue, a page at a time, oldest first. */
    statusCreatedIdx: index('catalog_item_versions_status_created_idx').on(t.status, t.createdAt),
  }),
);

/** Someone's copy of a catalog item (a module or custom part), and which version it came from. */
export const catalogCopies = sqliteTable(
  'catalog_copies',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => catalogItems.id, { onDelete: 'cascade' }),
    copyId: text('copy_id').notNull(),
    version: integer('version').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.itemId, t.copyId] }),
    copyIdx: index('catalog_copies_copy_idx').on(t.copyId),
  }),
);

// ---------------------------------------------------------------------------
// Catalog collections: a named, ordered set of public catalog items
// ("Starter town", "Train yard basics"). Moderators and admins make
// official ones (which can be featured); anyone signed in can submit one,
// reviewed like catalog items. An item that leaves the catalog drops out
// of every collection (catalog_collection_items rows are deleted), and
// its curator gets a note; a collection with no items left is hidden.
// ---------------------------------------------------------------------------
export const catalogCollections = sqliteTable(
  'catalog_collections',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** The item whose picture is the cover; null means the first module's (or first item's). */
    coverItemId: text('cover_item_id').references(() => catalogItems.id, { onDelete: 'set null' }),
    /** Its curator. */
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Made by a moderator or site admin: published without review, and may be featured. */
    official: integer('official', { mode: 'boolean' }).notNull().default(false),
    featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
    /** As catalog_items.status: 'in_review' is a first submission waiting. */
    status: text('status', { enum: ['in_review', 'public', 'declined', 'unpublished', 'withdrawn'] }).notNull(),
    /** Why it (or its last change) was declined, or why it was unpublished. */
    reason: text('reason'),
    /**
     * A change to a public collection waiting for review, as JSON
     * {title, description, coverItemId, itemIds}; the public one stays as
     * it is until it's approved.
     */
    pending: text('pending'),
    pendingAt: integer('pending_at', { mode: 'timestamp_ms' }),
    /** For the curator: items that left the catalog and were taken out. */
    curatorNote: text('curator_note'),
    /**
     * A club's collection: its admins and managers curate it, and every
     * member sees it. Null for a person's own (or an official) collection.
     */
    orgId: text('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    /**
     * Who sees it: 'everyone' (the public catalog, under the person's or the
     * club's name; its text is reviewed, and `status` follows that review)
     * or 'private' (only its curator, or only the club's members; never
     * reviewed, and `status` stays 'public', meaning live for them).
     */
    audience: text('audience', { enum: ['everyone', 'private'] }).notNull().default('everyone'),
    /** A club collection its curators put at the top for the club's members. */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** A club collection's cover can be one of the club's own modules. */
    coverModuleId: text('cover_module_id').references(() => modules.id, { onDelete: 'set null' }),
    /**
     * A picture its curators uploaded (catalog_collection_covers.id); when
     * set, it's the cover, whatever item is chosen.
     */
    coverImageId: text('cover_image_id'),
    /** As catalog_items.taken_down_by: who unpublished it, kept through audience changes and withdrawals. */
    takenDownBy: text('taken_down_by', { enum: ['site', 'club'] }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    statusIdx: index('catalog_collections_status_idx').on(t.status, t.featured),
    ownerIdx: index('catalog_collections_owner_idx').on(t.ownerUserId),
    orgIdx: index('catalog_collections_org_idx').on(t.orgId),
  }),
);

/**
 * Collections' own cover pictures: re-encoded as WebP (at most 1200 px
 * wide, no metadata) and a small copy for cards. A collection has at most
 * two: the one showing, and a new one waiting for review. Counted in the
 * collection owner's (or club's) space.
 */
export const catalogCollectionCovers = sqliteTable(
  'catalog_collection_covers',
  {
    id: text('id').primaryKey(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => catalogCollections.id, { onDelete: 'cascade' }),
    image: blob('image').notNull(),
    small: blob('small').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    collectionIdx: index('catalog_collection_covers_collection_idx').on(t.collectionId),
  }),
);

/**
 * Catalog items' own cover pictures, the same as collections': WebP at most
 * 1200 px wide with no metadata, and a small copy for cards. At most two
 * per item: the one showing, and one waiting for review. Counted in the
 * item owner's (or club's) space.
 */
export const catalogItemCovers = sqliteTable(
  'catalog_item_covers',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => catalogItems.id, { onDelete: 'cascade' }),
    image: blob('image').notNull(),
    small: blob('small').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    itemIdx: index('catalog_item_covers_item_idx').on(t.itemId),
  }),
);

export const catalogCollectionItems = sqliteTable(
  'catalog_collection_items',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => catalogCollections.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => catalogItems.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.collectionId, t.itemId] }),
    itemIdx: index('catalog_collection_items_item_idx').on(t.itemId),
  }),
);

/**
 * A collection's own library modules: the curator's, or the club's (not
 * necessarily in the public catalog). `position` shares one order with
 * catalog_collection_items and catalog_collection_parts. Only modules the
 * collection's owner owns show; one that's deleted or moves away is taken
 * out, and the curators get a note.
 */
export const catalogCollectionModules = sqliteTable(
  'catalog_collection_modules',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => catalogCollections.id, { onDelete: 'cascade' }),
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.collectionId, t.moduleId] }),
    moduleIdx: index('catalog_collection_modules_module_idx').on(t.moduleId),
  }),
);

/** The same for a collection's own custom parts (the curator's, or the club's). */
export const catalogCollectionParts = sqliteTable(
  'catalog_collection_parts',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => catalogCollections.id, { onDelete: 'cascade' }),
    partId: text('part_id')
      .notNull()
      .references(() => customParts.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.collectionId, t.partId] }),
    partIdx: index('catalog_collection_parts_part_idx').on(t.partId),
  }),
);

// ---------------------------------------------------------------------------
// Warnings (moderation). A formal warning to a person or a whole club.
//
//   - scope 'site': from a site admin or moderator, to a person or a club
//     (the club's admins and managers see and acknowledge it).
//   - scope 'club': from a club's admin or manager, to one of its members,
//     about what they do in that club (`clubOrgId`). Seen by that member,
//     the club's admins and managers, and site admins.
//
// The recipient sees it as a notice to acknowledge. Nothing is deleted
// when acknowledged: the history stays on the admin pages.
// ---------------------------------------------------------------------------
export const warnings = sqliteTable(
  'warnings',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['site', 'club'] }).notNull(),
    /** Club warnings: the club it's from. */
    clubOrgId: text('club_org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    /** Exactly one of these: the person, or the club, it's to. */
    subjectUserId: text('subject_user_id').references(() => users.id, { onDelete: 'cascade' }),
    subjectOrgId: text('subject_org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    severity: text('severity', { enum: ['note', 'warning', 'final'] }).notNull(),
    reason: text('reason').notNull(),
    /** Optional link to the thing it's about (a layout, module, part or catalog item), a site path. */
    link: text('link'),
    issuedBy: text('issued_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp_ms' }),
    acknowledgedBy: text('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    userIdx: index('warnings_subject_user_idx').on(t.subjectUserId, t.createdAt),
    orgIdx: index('warnings_subject_org_idx').on(t.subjectOrgId, t.createdAt),
    clubIdx: index('warnings_club_idx').on(t.clubOrgId, t.createdAt),
  }),
);
export type Warning = typeof warnings.$inferSelect;

/**
 * "Download my data" (0025): one zip of everything about a person (or a
 * club), built in the background and kept on disk next to the database
 * (exports/<id>.zip) until `expiresAt`. Only `requestedBy` may download
 * it: the person themselves, a club admin for a club's, or a site admin
 * answering a privacy request. Rows and files go when they expire (the
 * privacy clean-up), and when the account they are about is erased.
 */
export const dataExports = sqliteTable(
  'data_exports',
  {
    id: text('id').primaryKey(),
    /** What it is about: a person, or a club. */
    subjectKind: text('subject_kind', { enum: ['user', 'org'] }).notNull(),
    subjectId: text('subject_id').notNull(),
    /** Who asked, and the only one who may download it. */
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'cascade' }),
    /** 'self' (Profile), 'admin' (a privacy request), 'club' (a club's admins). */
    reason: text('reason', { enum: ['self', 'admin', 'club'] }).notNull(),
    status: text('status', { enum: ['building', 'ready', 'failed'] }).notNull(),
    sizeBytes: integer('size_bytes'),
    /** Why it failed, in plain words. */
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    readyAt: integer('ready_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    downloadedAt: integer('downloaded_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    requesterIdx: index('data_exports_requested_by_idx').on(t.requestedBy, t.createdAt),
    subjectIdx: index('data_exports_subject_idx').on(t.subjectKind, t.subjectId),
  }),
);
export type DataExport = typeof dataExports.$inferSelect;

/**
 * Erased accounts and clubs (0026): the minimal record that an erasure
 * happened, with no personal data. `ref` is the pseudonym the rest of the
 * site now shows ("Deleted user #abc123"); `how` says who asked; `counts`
 * is how many things went (numbers only). Kept for the Privacy setting's
 * "erasure records" days.
 */
export const erasures = sqliteTable(
  'erasures',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['user', 'org'] }).notNull(),
    ref: text('ref').notNull(),
    /** 'self' (Delete my account, after the waiting time), 'admin' (Admin › Users), 'request' (a logged privacy request). */
    how: text('how', { enum: ['self', 'admin', 'request'] }).notNull(),
    requestedAt: integer('requested_at', { mode: 'timestamp_ms' }),
    erasedAt: integer('erased_at', { mode: 'timestamp_ms' }).notNull(),
    counts: text('counts').notNull().default('{}'),
  },
  (t) => ({
    erasedIdx: index('erasures_erased_at_idx').on(t.erasedAt),
  }),
);
export type Erasure = typeof erasures.$inferSelect;

/**
 * Admin › Privacy requests (0027): requests that arrive by email or
 * letter (access, erasure, rectification, restriction, objection, other),
 * with their due date and what was done. `subjectUserId` is the account
 * it's about, when there is one; `subjectText` says who asked, in the
 * admin's words, when there isn't (after an erasure it becomes the
 * pseudonym). Closed requests are kept for the Privacy setting's
 * "records" days, then deleted.
 */
export const privacyRequests = sqliteTable(
  'privacy_requests',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['access', 'erasure', 'rectification', 'restriction', 'objection', 'other'] }).notNull(),
    subjectUserId: text('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
    subjectText: text('subject_text'),
    receivedVia: text('received_via', { enum: ['email', 'letter', 'in_person', 'other'] }).notNull(),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
    dueAt: integer('due_at', { mode: 'timestamp_ms' }).notNull(),
    status: text('status', { enum: ['open', 'waiting', 'done', 'refused'] }).notNull(),
    notes: text('notes').notNull().default(''),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    statusDueIdx: index('privacy_requests_status_due_idx').on(t.status, t.dueAt),
    subjectIdx: index('privacy_requests_subject_idx').on(t.subjectUserId),
  }),
);
export type PrivacyRequest = typeof privacyRequests.$inferSelect;

/** What happened on a privacy request, oldest first (its history). */
export const privacyRequestEvents = sqliteTable(
  'privacy_request_events',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => privacyRequests.id, { onDelete: 'cascade' }),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    by: text('by').references(() => users.id, { onDelete: 'set null' }),
    /** 'logged', 'status', 'note', 'edit', 'export', 'erase', 'restrict', 'unrestrict'. */
    kind: text('kind').notNull(),
    text: text('text').notNull().default(''),
  },
  (t) => ({
    requestIdx: index('privacy_request_events_request_idx').on(t.requestId, t.at),
  }),
);
export type PrivacyRequestEvent = typeof privacyRequestEvents.$inferSelect;

// A club's logo (0037): the picture its admins upload, re-encoded as WebP
// no bigger than 512 px a side (an SVG is drawn into one; the SVG itself is
// never kept). One per club; it goes with the club.
export const clubLogos = sqliteTable('club_logos', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  image: blob('image').notNull(),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// One-time data fixes (0039): each fix the server has run, by name, so it
// runs only once (ops/dataFixes.ts). A fix runs only when an operator asks
// for it (CBLD_DATA_FIX); `summary` is what it changed, as JSON.
export const dataFixes = sqliteTable('data_fixes', {
  id: text('id').primaryKey(),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }).notNull(),
  summary: text('summary'),
});
