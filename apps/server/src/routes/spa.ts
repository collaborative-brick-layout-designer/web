// The web app's files (apps/web/dist): each as it is, and the page itself
// for every other address, so a refresh on /library or /orgs/... opens it.
// Two kinds of address are never the page: the API's, and a built file's
// (/assets/<name>-<hash>.js). One of those that isn't there (an open page
// asking for a file of the version before) is a plain 404: with the page in
// its place, the browser and anything caching on the way took HTML for a script.

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export async function registerSpa(app: FastifyInstance, dir: string, indexHtml: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: dir,
    prefix: '/',
    decorateReply: false,
    wildcard: false,
  });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    if (req.url.startsWith('/assets/')) {
      return reply.code(404).header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'no-store').send('Not found');
    }
    reply.header('content-type', 'text/html; charset=utf-8');
    // Don't cache — the SPA bundle hash is in the linked assets;
    // if `index.html` itself is cached, deploys break for users
    // whose browser still has the previous version.
    reply.header('cache-control', 'no-cache');
    return reply.send(indexHtml);
  });
}
