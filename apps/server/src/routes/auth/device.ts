// OAuth 2.0 Device Authorization Grant (RFC 8628) — how the desktop app
// signs in. The app has no browser session of its own, so:
//
//   1. app    POST /api/auth/device/code   → device_code + user_code
//   2. app    shows "go to <verification_uri>, enter XXXX-XXXX"
//   3. user   opens /device in the web app (signed in), confirms the
//             code, sees the client name + requested scopes, approves
//   4. app    POST /api/auth/device/token  (polling every `interval`s)
//             → authorization_pending … then an access token (a
//               `bld_pat_…` API token, see auth/apiTokens.ts)
//
// Steps 1 and 4 are public (the device isn't signed in yet); step 3's
// lookup/approve/deny endpoints need the web session and, like every
// route without `config.apiToken`, refuse Bearer-token requests. Both
// codes are stored hashed and a grant mints at most one token.
//
// Request bodies are JSON (the RFC specifies form encoding; the only
// client is ours, and the server has no form parser).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, lt } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { requireUser } from '../../auth/cookie.js';
import { isDemoUser } from '../../demo/demoAccount.js';
import { createApiToken, parseScopes, scopesOf } from '../../auth/apiTokens.js';
import { writeAuditEvent } from '../../audit/writeAuditEvent.js';
import { env } from '../../env.js';

export const DEVICE_CODE_TTL_S = 600;
export const DEVICE_POLL_INTERVAL_S = 5;
/** RFC 8628 §3.5: on slow_down the interval grows by 5 seconds. */
const SLOW_DOWN_STEP_S = 5;
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * User-code alphabet: the 20 consonants RFC 8628 §6.1 suggests — no
 * vowels (no accidental words), no 0/O or 1/I/L look-alikes.
 */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;

const CLIENT_NAME_MAX = 64;
const DEFAULT_CLIENT_NAME = 'Desktop app';

/** Expired grants linger this long (so a late poll still gets expired_token) before being swept. */
const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Uniformly random user code (rejection sampling keeps it unbiased). */
function generateUserCode(): string {
  const limit = 256 - (256 % USER_CODE_ALPHABET.length);
  let out = '';
  while (out.length < USER_CODE_LENGTH) {
    for (const b of randomBytes(USER_CODE_LENGTH * 2)) {
      if (b >= limit) continue;
      out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return out;
}

/** "bcdf-ghjk", "BCDFGHJK", " BCDF GHJK " → "BCDFGHJK"; null if malformed. */
export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const c of code) if (!USER_CODE_ALPHABET.includes(c)) return null;
  return code;
}

function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Trimmed, control-character-free display name for the approval page. */
function cleanClientName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_CLIENT_NAME;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CLIENT_NAME_MAX);
  return name || DEFAULT_CLIENT_NAME;
}

/** RFC 6749 §5.2-style error response. */
function oauthError(reply: FastifyReply, error: string, extra: Record<string, unknown> = {}) {
  reply.header('Cache-Control', 'no-store');
  return reply.code(400).send({ error, ...extra });
}

/** A pending, unexpired grant by user code, for the approval page. */
async function findPendingByUserCode(raw: unknown) {
  const code = normalizeUserCode(raw);
  if (!code) return null;
  const row = await db
    .select()
    .from(schema.deviceCodes)
    .where(eq(schema.deviceCodes.userCodeHash, sha256(code)))
    .get();
  if (!row || row.status !== 'pending' || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

export async function deviceRoutes(app: FastifyInstance) {
  // ---- 1. device authorization request -----------------------------------
  app.post<{ Body: { client_name?: unknown; scope?: unknown } | undefined }>(
    '/api/auth/device/code',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body ?? {};
      if (body.scope !== undefined && typeof body.scope !== 'string') {
        return oauthError(reply, 'invalid_scope');
      }
      // Omitted → every scope (read + write).
      const scopes = parseScopes(body.scope);
      if (!scopes) return oauthError(reply, 'invalid_scope');
      const now = Date.now();
      await db
        .delete(schema.deviceCodes)
        .where(lt(schema.deviceCodes.expiresAt, new Date(now - EXPIRED_GRACE_MS)));

      const deviceCode = randomBytes(32).toString('base64url');
      // The user-code space is ~2.6e10, so a clash with a live grant is
      // vanishingly rare — but the column is unique, so retry on one.
      for (let attempt = 0; ; attempt++) {
        const userCode = generateUserCode();
        try {
          await db.insert(schema.deviceCodes).values({
            id: randomUUID(),
            deviceCodeHash: sha256(deviceCode),
            userCodeHash: sha256(userCode),
            clientName: cleanClientName(body.client_name),
            scopes: scopes.join(' '),
            status: 'pending',
            userId: null,
            interval: DEVICE_POLL_INTERVAL_S,
            lastPolledAt: null,
            createdAt: new Date(now),
            expiresAt: new Date(now + DEVICE_CODE_TTL_S * 1000),
          });
        } catch (err) {
          if (attempt < 4 && /UNIQUE/i.test(String(err))) continue;
          throw err;
        }
        const shown = formatUserCode(userCode);
        const verificationUri = `${env.publicUrl}/device`;
        reply.header('Cache-Control', 'no-store');
        return {
          device_code: deviceCode,
          user_code: shown,
          verification_uri: verificationUri,
          verification_uri_complete: `${verificationUri}?user_code=${shown}`,
          expires_in: DEVICE_CODE_TTL_S,
          interval: DEVICE_POLL_INTERVAL_S,
        };
      }
    },
  );

  // ---- 4. device access token request (polled) ---------------------------
  // 12 polls/min at the 5s interval; headroom for a couple of devices
  // behind one address.
  app.post<{ Body: { device_code?: unknown; grant_type?: unknown } | undefined }>(
    '/api/auth/device/token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body ?? {};
      if (body.grant_type !== undefined && body.grant_type !== GRANT_TYPE) {
        return oauthError(reply, 'unsupported_grant_type');
      }
      if (typeof body.device_code !== 'string' || body.device_code === '') {
        return oauthError(reply, 'invalid_request');
      }
      const row = await db
        .select()
        .from(schema.deviceCodes)
        .where(eq(schema.deviceCodes.deviceCodeHash, sha256(body.device_code)))
        .get();
      // Unknown, or already exchanged for its token (single use).
      if (!row || row.status === 'consumed') return oauthError(reply, 'invalid_grant');
      const now = Date.now();
      if (row.expiresAt.getTime() < now) return oauthError(reply, 'expired_token');
      if (row.status === 'denied') return oauthError(reply, 'access_denied');

      if (row.status === 'pending') {
        const tooSoon =
          row.lastPolledAt !== null && now - row.lastPolledAt.getTime() < row.interval * 1000;
        const interval = tooSoon ? row.interval + SLOW_DOWN_STEP_S : row.interval;
        await db
          .update(schema.deviceCodes)
          .set({ lastPolledAt: new Date(now), interval })
          .where(eq(schema.deviceCodes.id, row.id));
        return tooSoon
          ? oauthError(reply, 'slow_down', { interval })
          : oauthError(reply, 'authorization_pending');
      }

      // Approved: claim the grant atomically so two racing polls can't
      // both mint a token.
      const claimed = await db
        .update(schema.deviceCodes)
        .set({ status: 'consumed', lastPolledAt: new Date(now) })
        .where(and(eq(schema.deviceCodes.id, row.id), eq(schema.deviceCodes.status, 'approved')))
        .returning({ id: schema.deviceCodes.id });
      if (claimed.length !== 1 || !row.userId) return oauthError(reply, 'invalid_grant');

      const scopes = scopesOf(row);
      const { token, row: tokenRow } = await createApiToken(row.userId, row.clientName, scopes);
      await writeAuditEvent({
        resourceKind: 'user',
        resourceId: row.userId,
        userId: row.userId,
        eventType: 'api_token_issue',
        payload: { tokenId: tokenRow.id, name: tokenRow.name, scopes, via: 'device_code' },
      });
      reply.header('Cache-Control', 'no-store');
      return {
        access_token: token,
        token_type: 'Bearer',
        scope: scopes.join(' '),
        // Until it ends unused (each use pushes it back; Admin › Settings › Sign-in).
        expires_in: Math.max(0, Math.round((tokenRow.expiresAt.getTime() - Date.now()) / 1000)),
      };
    },
  );

  // ---- 3. the signed-in user's side (web /device page) -------------------
  // Session only: none of these carry `config.apiToken`.
  const confirmLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  app.post<{ Body: { user_code?: unknown } | undefined }>(
    '/api/auth/device/lookup',
    { config: confirmLimit },
    async (req, reply) => {
      requireUser(req);
      const row = await findPendingByUserCode(req.body?.user_code);
      if (!row) return reply.code(404).send({ error: 'invalid_code' });
      return {
        clientName: row.clientName,
        scopes: scopesOf(row),
        expiresAt: row.expiresAt.getTime(),
      };
    },
  );

  for (const [path, status] of [
    ['/api/auth/device/approve', 'approved'],
    ['/api/auth/device/deny', 'denied'],
  ] as const) {
    app.post<{ Body: { user_code?: unknown } | undefined }>(
      path,
      { config: confirmLimit },
      async (req, reply) => {
        const user = requireUser(req);
        // No desktop tokens for the demo account (denying is fine).
        if (status === 'approved' && isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_use_desktop' });
        const row = await findPendingByUserCode(req.body?.user_code);
        if (!row) return reply.code(404).send({ error: 'invalid_code' });
        const res = await db
          .update(schema.deviceCodes)
          .set({ status, userId: user.id })
          .where(and(eq(schema.deviceCodes.id, row.id), eq(schema.deviceCodes.status, 'pending')))
          .returning({ id: schema.deviceCodes.id });
        if (res.length !== 1) return reply.code(404).send({ error: 'invalid_code' });
        return { ok: true };
      },
    );
  }
}
