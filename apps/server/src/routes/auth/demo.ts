// "Try the demo" on the sign-in page: POST /api/auth/demo (JSON, no body
// or `{}`) gives the visitor a private demo space of their own (a new
// demo account with a copy of the samples, demo/demoAccount.ts) and signs
// them in to it, while an admin has the demo switched on. Works whether
// or not password sign-in is enabled. The sign-in and the space end a fixed
// time after they were made (Admin › Settings › Demo account; 1 hour by
// default). A reset that is due (the template's samples) runs first.
//
// Limits: a few a minute from one address (behind the proxy, the real
// client's: TRUST_PROXY), and at most Admin › Settings › Demo account's
// number of spaces at once ("The demo is busy right now").

import type { FastifyInstance } from 'fastify';
import { createSession } from '../../auth/session.js';
import { setSessionCookie } from '../../auth/cookie.js';
import { getPlatformSettings } from '../../auth/platformSettings.js';
import { createDemoSpace, demoResetDue, demoSessionEnd, ensureDemoUser, liveDemoSpaces } from '../../demo/demoAccount.js';
import { copySamplesTo, demoResetRunning, runDemoReset, sweepDemoSpaces } from '../../demo/reset.js';
import { publish } from '../../events/audience.js';

export async function demoAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/demo', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const settings = await getPlatformSettings();
    if (!settings.demoEnabled) return reply.code(404).send({ error: 'demo_off' });
    await ensureDemoUser();
    // Never reset yet (just switched on), or a reset is due (the timer looks
    // every few minutes): put the samples in first. A reset already running
    // would sign this visitor straight out again: wait for it.
    if (!settings.demoLastResetAt || demoResetDue(settings, new Date())) await runDemoReset();
    else await demoResetRunning();
    // Room for one more? Spaces whose time is up go first.
    if ((await liveDemoSpaces()) >= settings.demoMaxSpaces) {
      await sweepDemoSpaces();
      if ((await liveDemoSpaces()) >= settings.demoMaxSpaces) {
        return reply.code(503).send({ error: 'demo_busy', message: 'The demo is busy right now. Try again in a few minutes.' });
      }
    }
    const now = Date.now();
    const space = await createDemoSpace(new Date(await demoSessionEnd(now)), new Date(now));
    await copySamplesTo(space.id, new Date(now));
    const { token, expiresAt } = await createSession(space.id);
    setSessionCookie(reply, token, expiresAt);
    // Admin › Settings › Demo account's count of live spaces (the space's id, so two
    // changes close together aren't squashed into one hint).
    await publish({ kind: 'admin', action: 'demo-space', id: space.id }, { ownerless: true });
    return reply.send({ ok: true });
  });
}
