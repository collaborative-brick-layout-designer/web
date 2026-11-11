// Token management for the signed-in web user: list their API tokens
// (desktop sign-ins) and revoke them. Web-session only — those routes
// don't carry `config.apiToken`, so a token can't list or revoke tokens.
// The two token routes are about the calling token itself:
// GET /api/tokens/current tells a desktop who its own token belongs to
// (its display name for cursors on live layouts), and
// DELETE /api/tokens/current ends that one sign-in (the desktop's Sign
// Out), without opening the account routes to tokens.
// Secrets are never returned; tokens are minted only by the device-code
// flow (routes/auth/device.ts).

import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/cookie.js';
import { API_SCOPES, apiTokenLifetime, listApiTokens, revokeApiToken, scopesOf } from '../auth/apiTokens.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import type { ApiToken } from '../db/schema.js';
import { perPerson } from '../utils/rateLimits.js';

function toListItem(t: ApiToken) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    last4: t.last4,
    scopes: scopesOf(t),
    createdAt: t.createdAt.getTime(),
    lastUsedAt: t.lastUsedAt?.getTime() ?? null,
    expiresAt: t.expiresAt.getTime(),
  };
}

export async function tokenRoutes(app: FastifyInstance) {
  app.get('/api/tokens', async (req) => {
    const user = requireUser(req);
    return { tokens: (await listApiTokens(user.id)).map(toListItem) };
  });

  app.get('/api/tokens/current', { config: { apiToken: 'layouts:read' } }, async (req, reply) => {
    const user = requireUser(req);
    if (!req.apiToken) return reply.code(400).send({ error: 'not_a_token' });
    // When this sign-in ends if it isn't used again (idleSeconds from its
    // last use) and at the latest (longestAt): the desktop shows the date
    // when it signs out while the server can't be reached.
    const lifetime = await apiTokenLifetime(req.apiToken.id);
    return {
      user: { id: user.id, displayName: user.displayName },
      token: { id: req.apiToken.id, scopes: req.apiToken.scopes, ...(lifetime ?? {}) },
    };
  });

  // The desktop's Sign Out: the token ends itself, whatever its scopes.
  // A token that has already ended gets the usual 401, which the desktop
  // reads as "nothing left to end".
  app.delete(
    '/api/tokens/current',
    { config: { apiToken: API_SCOPES, rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      if (!req.apiToken) return reply.code(400).send({ error: 'not_a_token' });
      const revoked = await revokeApiToken(user.id, req.apiToken.id);
      if (!revoked) return reply.code(404).send({ error: 'not_found' });
      await writeAuditEvent({
        resourceKind: 'user',
        resourceId: user.id,
        userId: user.id,
        eventType: 'api_token_revoke',
        payload: { tokenId: revoked.id, name: revoked.name, self: true },
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/tokens/:id',
    { config: { rateLimit: perPerson(30, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      const revoked = await revokeApiToken(user.id, req.params.id);
      if (!revoked) return reply.code(404).send({ error: 'not_found' });
      await writeAuditEvent({
        resourceKind: 'user',
        resourceId: user.id,
        userId: user.id,
        eventType: 'api_token_revoke',
        payload: { tokenId: revoked.id, name: revoked.name },
      });
      return { ok: true };
    },
  );
}
