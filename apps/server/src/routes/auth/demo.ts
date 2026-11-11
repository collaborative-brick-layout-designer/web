// "Try the demo" on the sign-in page: POST /api/auth/demo (JSON, no body
// or `{}`) gives the visitor a private demo space of their own (a new
// demo account with a copy of the samples, demo/demoAccount.ts) and signs
// them in to it, while an admin has the demo switched on. Works whether
// or not password sign-in is enabled. The sign-in and the space end a fixed
// time after they were made (Admin › Settings › Demo account; 1 hour by
// default). A reset that is due (the template's samples) runs first.
//
// A visitor who already has a live space (their browser sends its cookie)
// gets that one again, not a second.
//
// Limits: a few a minute from one address (behind the proxy, the real
// client's: TRUST_PROXY), at most Admin › Settings › Demo account's number
// of spaces at once from one address, and at most its number of spaces
// at once in all ("The demo is busy right now").

import type { FastifyInstance } from 'fastify';
import { createSession } from '../../auth/session.js';
import { setSessionCookie } from '../../auth/cookie.js';
import { getPlatformSettings } from '../../auth/platformSettings.js';
import { createDemoSpace, demoResetDue, demoSessionEnd, demoSpacesFrom, ensureDemoUser, isDemoSpace, liveDemoSpaces, noteDemoSpace } from '../../demo/demoAccount.js';
import { globalLimits } from '../../limits/limits.js';
import { copySamplesTo, demoResetRunning, runDemoReset, sweepDemoSpaces } from '../../demo/reset.js';
import { publish } from '../../events/audience.js';

export async function demoAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/demo', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const settings = await getPlatformSettings();
    if (!settings.demoEnabled) return reply.code(404).send({ error: 'demo_off' });
    await ensureDemoUser();
    // Never reset yet (just switched on), or a reset is due (the timer looks
    // every few minutes): put the samples in first. A reset already running
    // would sign this visitor straight out again: wait for it.
    if (!settings.demoLastResetAt || demoResetDue(settings, new Date())) await runDemoReset();
    else await demoResetRunning();
    // Already in a live space of their own: that one, again. No second space.
    if (isDemoSpace(req.user) && (req.user!.demoExpiresAt?.getTime() ?? 0) > Date.now()) {
      return reply.send({ ok: true, reused: true });
    }
    // One address can't take every space.
    const perAddress = (await globalLimits()).values.demoSpacesPerAddress;
    if (perAddress > 0 && (await demoSpacesFrom(req.ip)) >= perAddress) {
      return reply.code(429).send({
        error: 'demo_busy',
        message: `There ${perAddress === 1 ? 'is already a demo space' : `are already ${perAddress} demo spaces`} open from your network. Try again when one ends, in ${lifetimeText(settings.demoSpaceMinutes)} at most.`,
      });
    }
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
    noteDemoSpace(req.ip, space.id, space.demoExpiresAt!.getTime());
    const { token, expiresAt } = await createSession(space.id);
    setSessionCookie(reply, token, expiresAt);
    // Admin › Settings › Demo account's count of live spaces (the space's id, so two
    // changes close together aren't squashed into one hint).
    await publish({ kind: 'admin', action: 'demo-space', id: space.id }, { ownerless: true });
    return reply.send({ ok: true });
  });
}

/** "30 minutes", "1 hour", "6 hours": how long a space lasts, in words. */
function lifetimeText(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}
