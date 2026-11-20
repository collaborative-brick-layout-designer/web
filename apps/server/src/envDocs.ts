// The environment variables the server reads, for the README's
// configuration table (scripts/gen-env-docs.ts writes it; envDocs.test.ts
// checks the README matches and that every variable the code reads is
// listed). The usage limits, privacy and sign-in settings add their own
// rows from LIMITS, PRIVACY_SETTINGS and SIGN_IN_SETTINGS, so those stay in
// step by themselves.

import { LIMITS } from './limits/limits.js';
import { PRIVACY_SETTINGS } from './privacy/settings.js';
import { SIGN_IN_SETTINGS } from './auth/signInSettings.js';

export interface EnvVarDoc {
  name: string;
  /** The value when it isn't set. */
  default: string;
  /** Where an admin can change it in the web app instead, or '' when only the environment sets it. */
  inApp: string;
  notes: string;
}

export const ENV_VARS: readonly EnvVarDoc[] = [
  { name: 'PUBLIC_URL', default: '`http://localhost:3000`', inApp: '', notes: 'The address people type, scheme, host and port. Used for sign-in callbacks, emailed links and the desktop sign-in page; browser WebSockets are only accepted from this origin.' },
  { name: 'HTTP_PORT', default: '`3000`', inApp: '', notes: 'The port the server listens on (`PORT` also works). With `docker-compose.yml` it is the port on your computer instead: the container listens on 3000.' },
  { name: 'DB_PATH', default: '`./data/cbld.sqlite`', inApp: '', notes: 'The SQLite database. `/data/cbld.sqlite` in Docker.' },
  { name: 'PARTS_DIR', default: '`./data/parts`', inApp: '', notes: 'Where part libraries and uploaded parts live. `/parts` in Docker.' },
  { name: 'COOKIE_SECURE', default: '`true` when `NODE_ENV=production`', inApp: '', notes: 'Send sign-in cookies over HTTPS only. Turn on behind TLS.' },
  { name: 'TRUST_PROXY', default: '`false`', inApp: '', notes: 'Behind a reverse proxy: the proxy IPs / CIDRs (`127.0.0.1`, `172.16.0.0/12,127.0.0.1`), so client IPs come from `X-Forwarded-For` (the right-most address that isn’t a listed proxy). `true` trusts every hop and lets clients pick their address; the server warns about it. Leave `false` when exposed directly.' },
  { name: 'NODE_ENV', default: '`development`', inApp: '', notes: '`production` in the Docker image.' },
  { name: 'APP_VERSION', default: 'the server package version', inApp: '', notes: 'The version `GET /api/version` reports.' },
  { name: 'ENABLE_PASSWORD_AUTH', default: '`false`', inApp: '', notes: 'Allow email and password accounts. New accounts confirm their email first (see SMTP).' },
  { name: 'BOOTSTRAP_ADMIN_EMAIL', default: '', inApp: '', notes: 'A site admin created on first start when no account has this email. An account that already has it is never made an admin: promote it from Admin › Users.' },
  { name: 'BOOTSTRAP_ADMIN_PASSWORD', default: '', inApp: '', notes: 'Its password (at least 12 characters).' },
  { name: 'GOOGLE_CLIENT_ID', default: '', inApp: '', notes: 'With `GOOGLE_CLIENT_SECRET`: sign in with Google.' },
  { name: 'GOOGLE_CLIENT_SECRET', default: '', inApp: '', notes: '' },
  { name: 'GITHUB_CLIENT_ID', default: '', inApp: '', notes: 'With `GITHUB_CLIENT_SECRET`: sign in with GitHub.' },
  { name: 'GITHUB_CLIENT_SECRET', default: '', inApp: '', notes: '' },
  { name: 'OAUTH_MOCK_ORIGIN', default: '', inApp: '', notes: 'Tests only, ignored when `NODE_ENV=production`: send GitHub and Google sign-in to the end-to-end tests’ stand-in at this origin (`apps/web/e2e/oauthMock.ts`).' },
  { name: 'OIDC_ISSUER_URL', default: '', inApp: '', notes: 'With `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: any OpenID Connect provider (Microsoft Entra, Auth0, Keycloak…). Each linked account remembers its issuer; if you change this address, people linked under the old one cannot sign in and are told to ask an admin.' },
  { name: 'OIDC_CLIENT_ID', default: '', inApp: '', notes: '' },
  { name: 'OIDC_CLIENT_SECRET', default: '', inApp: '', notes: '' },
  { name: 'SMTP_HOST', default: '', inApp: 'Admin › Site settings › SMTP server (wins once saved)', notes: 'With `SMTP_FROM`: invites and email confirmations are emailed. Without it, invites are copy-paste links and confirmation links go to the server log.' },
  { name: 'SMTP_PORT', default: '`587`', inApp: 'Admin › Site settings › SMTP server', notes: '' },
  { name: 'SMTP_USER', default: '', inApp: 'Admin › Site settings › SMTP server', notes: '' },
  { name: 'SMTP_PASS', default: '', inApp: 'Admin › Site settings › SMTP server', notes: '' },
  { name: 'SMTP_FROM', default: '', inApp: 'Admin › Site settings › SMTP server', notes: 'The sender address.' },
  { name: 'CBLD_SECRET_KEY', default: 'unset (the key file is used)', inApp: '', notes: 'The key the saved SMTP password is encrypted with, at least 16 characters (for example from `openssl rand -base64 32`). Unset, the server makes and uses the key file `cbld-secret.key` beside the database (`/data` in Docker). Change or lose the key and the SMTP password has to be entered again in Admin › Site settings.' },
  { name: 'BACKUPS_ENABLED', default: 'unset (the switch decides; on)', inApp: 'Admin › Site settings › Background jobs', notes: 'When set, forces the daily database backup on or off.' },
  { name: 'BACKUPS_DIR', default: '`/backups`', inApp: '', notes: 'Where backups go.' },
  { name: 'PUSH_ENABLED', default: 'unset (the switch decides; on)', inApp: 'Admin › Site settings › Notifications', notes: 'When set, forces browser pop-up notifications (Web Push) on or off for the whole site.' },
  { name: 'VAPID_PUBLIC_KEY', default: 'unset (the server makes a key pair and keeps it)', inApp: '', notes: 'With `VAPID_PRIVATE_KEY`, the Web Push key pair to use instead of the one the server makes (for several servers serving one site). Both or neither. Never share the private key.' },
  { name: 'VAPID_PRIVATE_KEY', default: 'unset', inApp: '', notes: 'The private half of `VAPID_PUBLIC_KEY`. Kept out of logs and pages.' },
  { name: 'VAPID_SUBJECT', default: 'unset (`PUBLIC_URL`)', inApp: '', notes: 'The contact push services may use about this site\'s notifications: a `mailto:` address or an `https:` page.' },
  { name: 'IMPORTS_SERVER_BACKUP', default: 'unset (the switch decides; on)', inApp: 'Admin › Model import', notes: 'When set, forces the server’s importer on or off as the backup for models a browser can’t read itself. Off: models are read only in people’s browsers.' },
  { name: 'IMPORTS_ENABLED', default: 'unset (the switch decides; on)', inApp: 'Admin › Model import', notes: 'When set, forces importing LDraw, Studio and LDD files on or off for the whole site.' },
  { name: 'IMPORT_CONVERTER', default: '`/opt/bld-import-server/bin/bld-import-server`', inApp: '', notes: 'The desktop app’s converter that imports LDraw, Studio and LDD files (in the Docker image already). Missing or too old: import is off, and Admin › Model import says why.' },
  { name: 'IMPORT_LDRAW_DIR', default: 'unset (Admin › Model import downloads it)', inApp: 'Admin › Model import', notes: 'An LDraw library folder (with `LDConfig.ldr` and `parts/`) to use instead of the one the server downloads. Read only.' },
  { name: 'IMPORT_LDD_ASSETS', default: 'unset (an admin uploads it)', inApp: 'Admin › Model import', notes: 'LEGO Digital Designer’s `Assets.lif` (or `db.lif`, or the folder holding it) to use instead of an uploaded one. Read only; never backed up, and never served whole: people’s browsers get one brick’s shape at a time.' },
  { name: 'IMPORT_LDD_LDRAW_XML', default: 'unset (an admin uploads it)', inApp: 'Admin › Model import', notes: 'A newer LDD to LDraw mapping (`ldraw.xml`) than LDD’s own. Read only.' },
  { name: 'IMPORT_STUDIO_LDRAW_DIR', default: 'unset (optional)', inApp: 'Admin › Model import', notes: 'BrickLink Studio’s own LDraw library folder, for Studio-only parts. Read only.' },
  { name: 'DAILY_COMPACTION_ENABLED', default: 'unset (the switch decides; on)', inApp: 'Admin › Site settings › Background jobs', notes: 'When set, forces the daily compaction of layout histories on or off.' },
  { name: 'COLLECTION_COVER_MAX_BYTES', default: 'unset (5 MB)', inApp: 'Admin › Site settings › Public catalogs', notes: 'When set, forces the largest collection and catalog cover picture, in bytes (at most 7 MB).' },
  { name: 'LIMITS_ENFORCE', default: 'unset (the switch decides; on)', inApp: 'Admin › Site settings › Usage limits', notes: '`on` or `off` forces whether usage limits are enforced. Read-only accounts and clubs stay read-only either way.' },
  { name: 'CBLD_DATA_FIX', default: 'unset', inApp: '', notes: 'A one-time data fix to run at this start (`clamp-drawing-values`, `strip-catalog-budgets`; several: comma separated), for one restart. Each runs once (recorded in `data_fixes`); without it the server looks (writing nothing) and, only when there is something to fix, logs that one waits. Before a fix writes, the server copies the database as it was to `BACKUPS_DIR` as `cbld-before-fix-<name>.sqlite` (with no copy, the fix doesn\'t run); delete that file once the fix is known to be good. Try `clamp-drawing-values` first on a copy: `node dist/ops/clampDrawingValuesCli.js --db <file>` in the Docker image (from `/app/apps/server`), or `pnpm --filter @cld/server data-fix:clamp-drawing-values --db <file>` from a checkout.' },
  { name: 'PRIVACY_CONTACT', default: 'unset', inApp: 'Admin › Site settings › Privacy', notes: 'When set, forces the privacy contact (an email address or a web address) shown on the privacy page.' },
];

const cell = (s: string) => s.replace(/[\\|]/g, (c) => `\\${c}`);

function bytes(n: number): string {
  const MB = 1024 * 1024;
  return n >= 1024 * MB && n % (1024 * MB) === 0 ? `${n / (1024 * MB)} GB` : `${Math.round(n / MB)} MB`;
}

/** The README's configuration tables (between the env-table markers). */
export function envTablesMarkdown(): string {
  const lines: string[] = [];
  lines.push('| Variable | When unset | Also in the app | Notes |', '|---|---|---|---|');
  for (const v of ENV_VARS) lines.push(`| \`${v.name}\` | ${cell(v.default) || '—'} | ${cell(v.inApp) || '—'} | ${cell(v.notes)} |`);
  lines.push('', '**Usage limits.** Each is also set in Admin › Site settings › Usage limits (and per person or club); the variable sets the default the admin starts from.', '');
  lines.push('| Variable | Built-in default | Limit |', '|---|---|---|');
  for (const l of LIMITS) {
    const value = l.unit === 'bytes' ? bytes(l.builtIn) : l.unit === 'per_minute' ? `${l.builtIn} a minute` : l.unit === 'per_day' ? `${l.builtIn} a day` : String(l.builtIn);
    lines.push(`| \`${l.envVar}\` | ${value} | ${cell(l.label)}: ${cell(l.help)} |`);
  }
  lines.push('', '**Privacy.** Each is also set in Admin › Site settings › Privacy; when the variable is set to a whole number in range, it wins and the page says so.', '');
  lines.push('| Variable | Built-in default | Range | Setting |', '|---|---|---|---|');
  for (const p of PRIVACY_SETTINGS) {
    const unit = p.unit === 'mb' ? 'MB' : p.unit;
    lines.push(`| \`${p.envVar}\` | ${p.builtIn} ${unit} | ${p.min}–${p.max} | ${cell(p.label)}: ${cell(p.help)} |`);
  }
  lines.push(
    '',
    '**Sign-in.** How long a sign-in lasts, on the website and in the desktop app. Each is also set in Admin › Site settings › Sign-in; when the variable is set to a duration in range (`30d` or `30` for days, `12h` for hours, `never` for the longest), it wins and the page says so. A change applies to existing sign-ins the next time they are used. A demo sign-in always ends with its demo space (1 hour after it was made by default, at most 24 hours), whatever is set here.',
    '',
  );
  lines.push('| Variable | Built-in default | Range | Setting |', '|---|---|---|---|');
  const span = (h: number) => (h % 24 === 0 ? `${h / 24} days` : `${h} hours`);
  for (const s of SIGN_IN_SETTINGS) {
    const where = s.app === 'web' ? 'Website' : 'Desktop app';
    const range = `${span(s.min).replace(/^1 hours$/, '1 hour')}–${span(s.max)}${s.allowNever ? ', or `never`' : ''}`;
    lines.push(`| \`${s.envVar}\` | ${span(s.builtIn)} | ${range} | ${where}, ${cell(s.label.toLowerCase())}: ${cell(s.help)} |`);
  }
  return lines.join('\n');
}

export const ENV_TABLE_START = '<!-- env-table:start (generated by `pnpm --filter @cld/server docs:env`; do not edit) -->';
export const ENV_TABLE_END = '<!-- env-table:end -->';

/** `readme` with its generated block replaced by the current tables. */
export function withEnvTables(readme: string): string {
  const start = readme.indexOf(ENV_TABLE_START);
  const end = readme.indexOf(ENV_TABLE_END);
  if (start < 0 || end < start) throw new Error('README has no env-table markers');
  return `${readme.slice(0, start + ENV_TABLE_START.length)}\n${envTablesMarkdown()}\n${readme.slice(end)}`;
}
