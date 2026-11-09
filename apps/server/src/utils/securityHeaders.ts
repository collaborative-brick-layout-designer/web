// Defence-in-depth headers for responses that carry user- or
// admin-supplied bytes: everything under /api/* (JSON, exports, custom
// part XML/sprites, background images) and /parts/* (bundled and
// admin-installed part libraries, which are extracted from arbitrary
// zips and could contain .html/.svg).
//
// `default-src 'none'; sandbox` means that even if such a response is
// ever rendered as a document on our origin (opened directly, sniffed as
// HTML, an SVG with script), it gets an opaque origin with scripts
// disabled — so it can't read cookies or call the API as the victim.
// Images rendered through <img> are unaffected: CSP on an image response
// only applies when the image itself is navigated to.
//
// The SPA's HTML (index.html, served from `/` and as the fallback for
// client routes) gets SPA_CSP instead: scripts only from our own origin,
// no plugins, no framing, no <base> tricks. It's a second wall in case a
// bug ever lets user text reach the page as markup.

import type { FastifyInstance } from 'fastify';

export const SANDBOX_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** Where sign-in avatars are served from (routes/auth/oauth.ts). */
export const AVATAR_HOSTS = ['https://*.googleusercontent.com', 'https://avatars.githubusercontent.com'] as const;

/**
 * The policy for the SPA's HTML. Styles allow 'unsafe-inline' because
 * components set style attributes. Images come from this server (parts,
 * covers, logos, background pictures), data:/blob: (exports and
 * previews), and the two hosts sign-in avatars live on (Google's
 * `picture`, GitHub's `avatar_url`): no other host, so nothing a user
 * writes into a layout can make a viewer's browser call one.
 */
export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${AVATAR_HOSTS.join(' ')}`,
  "font-src 'self' data:",
  // 'self' covers same-origin ws(s): in current browsers; older Safari
  // needs the scheme spelled out.
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Whether a request path is API or parts-library bytes. The path is
 * percent-decoded first: Fastify routes `/%61pi/...` to `/api/...`, so
 * matching the raw URL let an encoded prefix skip the sandbox.
 */
export function isSandboxedPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape: Fastify answers 400 itself; match the raw path.
  }
  return [path, decoded].some((p) => p.startsWith('/api/') || p.startsWith('/parts/'));
}

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if (isSandboxedPath(req.url)) {
      reply.header('Content-Security-Policy', SANDBOX_CSP);
      reply.header('X-Content-Type-Options', 'nosniff');
    } else if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      reply.header('Content-Security-Policy', SPA_CSP);
    }
    return payload;
  });
}

/**
 * Options for the static servers of the part libraries (/parts/*). The
 * libraries are extracted from zips, so a .git folder, a .env or other
 * dotfile inside one is never served.
 */
export const PARTS_STATIC_OPTIONS = {
  decorateReply: false,
  dotfiles: 'deny',
  cacheControl: true,
  maxAge: '30d',
  immutable: true,
} as const;
