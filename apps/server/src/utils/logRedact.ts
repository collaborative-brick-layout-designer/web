// Request logs record each URL. Some URLs carry a secret: invite, club
// invite and transfer links, public share links, email verification links,
// and the OAuth callback's ?code=&state=. Anyone who can read the logs
// could replay them, so the logged URL masks those parts. Authorization
// and Cookie headers were never logged (Fastify's default serializer
// leaves headers out) and still aren't.

const SECRET_SEGMENT = /(\/(?:invites|org-invites|module-invites|part-invites|transfers|public-layouts|verify-email|reset)\/)[^/?#]+/g;
const SECRET_QUERY = /([?&](?:code|state|token|key|t)=)[^&#]*/gi;

export function redactUrl(url: string): string {
  return url.replace(SECRET_SEGMENT, '$1[redacted]').replace(SECRET_QUERY, '$1[redacted]');
}

interface LoggedRequest {
  method: string;
  url: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number | undefined };
}

/** Fastify's default `req` log fields, with the URL masked. */
export function requestSerializer(req: LoggedRequest): {
  method: string;
  url: string;
  host?: string;
  remoteAddress?: string;
  remotePort?: number;
} {
  const out: { method: string; url: string; host?: string; remoteAddress?: string; remotePort?: number } = {
    method: req.method,
    url: redactUrl(req.url),
  };
  if (req.host !== undefined) out.host = req.host;
  if (req.ip !== undefined) out.remoteAddress = req.ip;
  if (req.socket?.remotePort !== undefined) out.remotePort = req.socket.remotePort;
  return out;
}
