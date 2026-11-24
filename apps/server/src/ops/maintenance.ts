// A short pause while the server gets ready to restart (a database
// restore, routes/adminBackups.ts): every API request and live connection
// is answered "503 maintenance, try again shortly", so nothing is written
// to a database that is about to be replaced. The health checks still
// answer, so a proxy doesn't mark the site dead for a few seconds.
//
// How the server restarts is index.ts's business (it closes cleanly, then
// exits so Docker's restart policy starts it again); tests set their own.

import type { FastifyInstance } from 'fastify';

let state: { reason: string; since: number } | null = null;

export function enterMaintenance(reason: string): void {
  state = { reason, since: Date.now() };
}
export function leaveMaintenance(): void {
  state = null;
}
export function inMaintenance(): { reason: string; since: number } | null {
  return state;
}

let restartHandler: () => void = () => {
  console.error('[maintenance] a restart was asked for, but no restart handler is set');
};
export function setRestartHandler(fn: () => void): void {
  restartHandler = fn;
}
/** Stop the server cleanly so it starts again (after the reply has gone out). */
export function requestRestart(): void {
  restartHandler();
}

const STILL_ANSWERS = /^\/api\/health(\/|$|\?)/;

export function registerMaintenanceGate(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!state) return;
    const url = req.url;
    if (!(url.startsWith('/api/') || url.startsWith('/ws/'))) return;
    if (STILL_ANSWERS.test(url)) return;
    reply.header('retry-after', '30');
    return reply.code(503).send({ error: 'maintenance', message: 'The site is restarting after a restore. Try again in a minute.' });
  });
}
