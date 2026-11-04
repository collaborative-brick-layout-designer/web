// "Try the demo" on the sign-in page: POST /api/auth/demo (JSON, no body
// or `{}`) signs the visitor in as the one demo account while an admin has
// the demo switched on (demo/demoAccount.ts). Works whether or not
// password sign-in is enabled. The sign-in ends at the next reset (24
// hours at most), so a reset that is due runs first.

import type { FastifyInstance } from 'fastify';
import { createSession } from '../../auth/session.js';
import { setSessionCookie } from '../../auth/cookie.js';
import { getPlatformSettings } from '../../auth/platformSettings.js';
import { DEMO_USER_ID, demoResetDue, ensureDemoUser } from '../../demo/demoAccount.js';
import { demoResetRunning, runDemoReset } from '../../demo/reset.js';

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
    const { token, expiresAt } = await createSession(DEMO_USER_ID);
    setSessionCookie(reply, token, expiresAt);
    return reply.send({ ok: true });
  });
}
