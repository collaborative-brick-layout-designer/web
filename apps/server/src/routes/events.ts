// GET /api/events — the live change stream (Server-Sent Events).
//
// Signed in with the session cookie (the web app's EventSource) or a
// desktop API token with any scope. Each message is one small hint (see
// events/hub.ts); a comment line every 25 s keeps proxies from timing the
// stream out. The response is never compressed or buffered
// (X-Accel-Buffering: no, Cache-Control: no-transform).

import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { requireUser } from '../auth/cookie.js';
import { API_SCOPES } from '../auth/apiTokens.js';
import { perPerson } from '../utils/rateLimits.js';
import {
  HEARTBEAT_MS,
  addConnection,
  closeAll,
  heartbeatAll,
  removeConnection,
  type EventConnection,
} from '../events/hub.js';

let heartbeat: NodeJS.Timeout | null = null;

/** End every stream and the heartbeat. Open streams would keep the server from closing. */
export function stopEvents(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  closeAll();
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  if (!heartbeat) {
    heartbeat = setInterval(heartbeatAll, HEARTBEAT_MS);
    heartbeat.unref();
  }

  app.get(
    '/api/events',
    // Opening the stream is rate-limited; the stream itself is one request.
    // Counted per person, not per address: a club at a show shares one
    // Wi-Fi address, and each phone reopens its stream on every page load
    // and every wake-up, so a per-address count cut their live updates.
    {
      config: {
        apiToken: API_SCOPES,
        // 60: someone clicking through pages fast in two tabs reopened it
        // past 30 and filled the console with refusals.
        rateLimit: perPerson(60, '1 minute'),
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
        ...(env.publicUrl ? { 'access-control-allow-origin': env.publicUrl, 'access-control-allow-credentials': 'true' } : {}),
      });
      // Tell EventSource how long to wait before reconnecting, then say hello.
      res.write('retry: 5000\n\n: connected\n\n');

      let open = true;
      const conn: EventConnection = {
        userId: user.id,
        openedAt: Date.now(),
        recent: new Map(),
        write: (chunk) => {
          if (!open || res.destroyed || res.writableEnded) return false;
          res.write(chunk);
          return true;
        },
        close: () => {
          if (!open) return;
          open = false;
          removeConnection(conn);
          if (!res.writableEnded) res.end();
        },
      };
      addConnection(conn);
      const done = () => conn.close();
      req.raw.on('close', done);
      res.on('close', done);
      res.on('error', done);
    },
  );
}
