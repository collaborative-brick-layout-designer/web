function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/** An env switch that forces a setting when it is set, and leaves it alone when not. */
function forcedBool(value: string | undefined): boolean | null {
  return value === undefined || value.trim() === '' ? null : bool(value, true);
}

/** A positive whole number that forces a setting when set, and leaves it alone when not. */
function forcedInt(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * TRUST_PROXY → Fastify's `trustProxy`. Unset / "false" / "0": don't
 * trust X-Forwarded-* (req.ip is the socket peer). "true": trust any
 * proxy chain, so req.ip is the left-most X-Forwarded-For address, which
 * the client itself can write. Anything else: a comma-separated list of
 * proxy IPs / CIDRs; req.ip is then the right-most X-Forwarded-For
 * address that isn't one of them (the address the trusted proxy saw).
 * A bare hop count is rejected: Fastify dropped hop-count trust because
 * it lets direct clients spoof X-Forwarded-For.
 */
export function parseTrustProxy(value: string | undefined): boolean | string {
  const v = value?.trim() ?? '';
  if (v === '' || v === '0' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) {
    throw new Error('TRUST_PROXY hop counts are not supported; use "true" or proxy IPs/CIDRs');
  }
  return v;
}

/** The boot-time warning for a TRUST_PROXY setting, or null when it's fine. */
export function trustProxyWarning(value: boolean | string): string | null {
  if (value !== true) return null;
  return (
    'TRUST_PROXY=true trusts every X-Forwarded-For hop, so a client can choose the address that ' +
    'rate limits and logs see. Set TRUST_PROXY to the proxy addresses / CIDRs instead ' +
    '(e.g. 127.0.0.1 for a proxy on the same host, or 172.16.0.0/12 for a Docker network).'
  );
}

/** LIMITS_ENFORCE: 'on' / 'off' forces it; anything else (or unset) leaves it to the admin's switch. */
export function parseForced(value: string | undefined): 'on' | 'off' | null {
  const v = (value ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(v)) return 'on';
  if (['off', 'false', '0', 'no'].includes(v)) return 'off';
  return null;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int(process.env.HTTP_PORT ?? process.env.PORT, 3000),
  dbPath: process.env.DB_PATH ?? './data/cbld.sqlite',
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  partsDir: process.env.PARTS_DIR ?? './data/parts',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Usage limits are switched on and off in Admin › Settings. LIMITS_ENFORCE
  // (on/off) forces it either way from the server's own settings and wins
  // over the admin's switch; unset leaves it to the switch.
  limitsEnforceForced: parseForced(process.env.LIMITS_ENFORCE),

  enablePasswordAuth: bool(process.env.ENABLE_PASSWORD_AUTH, false),

  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? null,
  bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? null,

  google: providerEnv('GOOGLE'),
  github: providerEnv('GITHUB'),
  oidc: oidcEnv(),

  smtp: smtpEnv(),

  // Background workers: switched in Admin › Settings (all on by default);
  // each env var, when set, forces its switch (workers/jobs.ts).
  backupsEnabledForced: forcedBool(process.env.BACKUPS_ENABLED),
  backupsDir: process.env.BACKUPS_DIR ?? '/backups',
  dailyCompactionEnabledForced: forcedBool(process.env.DAILY_COMPACTION_ENABLED),
  // The biggest collection cover upload, in bytes: Admin › Settings (5 MB
  // by default); this env var, when set, forces it (images/covers.ts).
  collectionCoverMaxBytesForced: forcedInt(process.env.COLLECTION_COVER_MAX_BYTES),

  // One-time data fixes to run at this start (ops/dataFixes.ts): only an
  // operator turns one on, for one restart; each runs once.
  dataFix: process.env.CBLD_DATA_FIX ?? '',
};

function providerEnv(prefix: string): { clientId: string; clientSecret: string } | null {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function oidcEnv(): { issuerUrl: string; clientId: string; clientSecret: string } | null {
  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  if (!issuerUrl || !clientId || !clientSecret) return null;
  return { issuerUrl, clientId, clientSecret };
}

function smtpEnv():
  | { host: string; port: number; user: string | null; pass: string | null; from: string }
  | null {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) return null;
  return {
    host,
    port: int(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER ?? null,
    pass: process.env.SMTP_PASS ?? null,
    from,
  };
}
