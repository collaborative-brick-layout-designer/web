// The environment variables the server reads, for the README's
// configuration table (scripts/gen-env-docs.ts writes it; envDocs.test.ts
// checks the README matches and that every variable the code reads is
// listed). The usage limits and privacy settings add their own rows from
// LIMITS and PRIVACY_SETTINGS, so those stay in step by themselves.

import { LIMITS } from './limits/limits.js';
import { PRIVACY_SETTINGS } from './privacy/settings.js';

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
  { name: 'HTTP_PORT', default: '`3000`', inApp: '', notes: 'The port the server listens on (`PORT` also works).' },
  { name: 'DB_PATH', default: '`./data/cbld.sqlite`', inApp: '', notes: 'The SQLite database. `/data/cbld.sqlite` in Docker.' },
  { name: 'PARTS_DIR', default: '`./data/parts`', inApp: '', notes: 'Where part libraries and uploaded parts live. `/parts` in Docker.' },
  { name: 'COOKIE_SECURE', default: '`true` when `NODE_ENV=production`', inApp: '', notes: 'Send sign-in cookies over HTTPS only. Turn on behind TLS.' },
  { name: 'TRUST_PROXY', default: '`false`', inApp: '', notes: 'Behind a reverse proxy: the proxy IPs / CIDRs (`127.0.0.1`, `172.16.0.0/12,127.0.0.1`), so client IPs come from `X-Forwarded-For` (the right-most address that isn’t a listed proxy). `true` trusts every hop and lets clients pick their address; the server warns about it. Leave `false` when exposed directly.' },
  { name: 'NODE_ENV', default: '`development`', inApp: '', notes: '`production` in the Docker image.' },
  { name: 'APP_VERSION', default: 'the server package version', inApp: '', notes: 'The version `GET /api/version` reports.' },
  { name: 'ENABLE_PASSWORD_AUTH', default: '`false`', inApp: '', notes: 'Allow email and password accounts. New accounts confirm their email first (see SMTP).' },
  { name: 'BOOTSTRAP_ADMIN_EMAIL', default: '', inApp: '', notes: 'A site admin created on first start when no account has this email.' },
  { name: 'BOOTSTRAP_ADMIN_PASSWORD', default: '', inApp: '', notes: 'Its password (at least 12 characters).' },
  { name: 'GOOGLE_CLIENT_ID', default: '', inApp: '', notes: 'With `GOOGLE_CLIENT_SECRET`: sign in with Google.' },
  { name: 'GOOGLE_CLIENT_SECRET', default: '', inApp: '', notes: '' },
  { name: 'GITHUB_CLIENT_ID', default: '', inApp: '', notes: 'With `GITHUB_CLIENT_SECRET`: sign in with GitHub.' },
  { name: 'GITHUB_CLIENT_SECRET', default: '', inApp: '', notes: '' },
  { name: 'OIDC_ISSUER_URL', default: '', inApp: '', notes: 'With `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: any OpenID Connect provider (Microsoft Entra, Auth0, Keycloak…).' },
  { name: 'OIDC_CLIENT_ID', default: '', inApp: '', notes: '' },
  { name: 'OIDC_CLIENT_SECRET', default: '', inApp: '', notes: '' },
  { name: 'SMTP_HOST', default: '', inApp: 'Admin › Site settings › SMTP server (wins once saved)', notes: 'With `SMTP_FROM`: invites and email confirmations are emailed. Without it, invites are copy-paste links and confirmation links go to the server log.' },
  { name: 'SMTP_PORT', default: '`587`', inApp: 'Admin › Site settings › SMTP server', notes: '' },
  { name: 'SMTP_USER', default: '', inApp: 'Admin › Site settings › SMTP server', notes: '' },
  { name: 'SMTP_PASS', default: '', inApp: 'Admin › Site settings › SMTP server', notes: '' },
  { name: 'SMTP_FROM', default: '', inApp: 'Admin › Site settings › SMTP server', notes: 'The sender address.' },
  { name: 'BACKUPS_ENABLED', default: 'unset (the switch decides; on)', inApp: 'Admin › Site settings › Background jobs', notes: 'When set, forces the daily database backup on or off.' },
  { name: 'BACKUPS_DIR', default: '`/backups`', inApp: '', notes: 'Where backups go.' },
  { name: 'DAILY_COMPACTION_ENABLED', default: 'unset (the switch decides; on)', inApp: 'Admin › Site settings › Background jobs', notes: 'When set, forces the daily compaction of layout histories on or off.' },
  { name: 'COLLECTION_COVER_MAX_BYTES', default: 'unset (5 MB)', inApp: 'Admin › Site settings › Public catalogs', notes: 'When set, forces the largest collection and catalog cover picture, in bytes (at most 7 MB).' },
  { name: 'LIMITS_ENFORCE', default: 'unset (the switch decides; on)', inApp: 'Admin › Site settings › Usage limits', notes: '`on` or `off` forces whether usage limits are enforced.' },
  { name: 'CBLD_DATA_FIX', default: 'unset', inApp: '', notes: 'A one-time data fix to run at this start (`clamp-drawing-values`), for one restart. Each runs once (recorded in `data_fixes`); without it the server only logs that one waits. Try it first on a copy: `node dist/ops/clampDrawingValuesCli.js --db <file>` in the Docker image (from `/app/apps/server`), or `pnpm --filter @cld/server data-fix:clamp-drawing-values --db <file>` from a checkout.' },
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
    const value = l.unit === 'bytes' ? bytes(l.builtIn) : l.unit === 'per_minute' ? `${l.builtIn} a minute` : String(l.builtIn);
    lines.push(`| \`${l.envVar}\` | ${value} | ${cell(l.label)}: ${cell(l.help)} |`);
  }
  lines.push('', '**Privacy.** Each is also set in Admin › Site settings › Privacy; when the variable is set to a whole number in range, it wins and the page says so.', '');
  lines.push('| Variable | Built-in default | Range | Setting |', '|---|---|---|---|');
  for (const p of PRIVACY_SETTINGS) {
    const unit = p.unit === 'mb' ? 'MB' : p.unit;
    lines.push(`| \`${p.envVar}\` | ${p.builtIn} ${unit} | ${p.min}–${p.max} | ${cell(p.label)}: ${cell(p.help)} |`);
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
