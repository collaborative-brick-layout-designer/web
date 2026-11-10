// A stand-in for GitHub's and Google's sign-in servers, for the e2e specs.
//
// The API server sends both providers here when it is started with
// OAUTH_MOCK_ORIGIN (never in production; auth/providers.ts) and the
// GITHUB_* / GOOGLE_* client ids the CI env sets. A spec starts it, says who
// signs in next with `next()`, and clicks "Continue with GitHub". The mock
// sends the browser straight back with a code, as a provider does after its
// consent screen, and answers the server's token and profile requests the
// way the real ones do (Google's ID token is unsigned: the server reads it
// from its token endpoint and checks its claims, not a signature).

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const OAUTH_MOCK_PORT = Number(process.env.OAUTH_MOCK_PORT ?? 3999);
export const OAUTH_MOCK_ORIGIN = `http://127.0.0.1:${OAUTH_MOCK_PORT}`;

export interface GithubPerson {
  id: number;
  login: string;
  name: string | null;
  email: string;
  verified?: boolean;
}

export interface GooglePerson {
  sub: string;
  email: string;
  name?: string;
  email_verified?: boolean;
}

interface Grant {
  provider: 'github' | 'google';
  person: GithubPerson | GooglePerson;
  challenge?: string;
  clientId: string;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

const b64 = (v: object | string) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export class OAuthMock {
  private server: Server | null = null;
  private queued: { github?: GithubPerson; google?: GooglePerson } = {};
  private grants = new Map<string, Grant>();
  private tokens = new Map<string, Grant>();

  /** Who signs in at the provider next. */
  next(provider: 'github', person: GithubPerson): void;
  next(provider: 'google', person: GooglePerson): void;
  next(provider: 'github' | 'google', person: GithubPerson | GooglePerson): void {
    (this.queued as Record<string, unknown>)[provider] = person;
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', OAUTH_MOCK_ORIGIN);
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /i, '');

      // The consent screen, already answered: back to the app with a code.
      if (url.pathname === '/github/login/oauth/authorize' || url.pathname === '/google/auth') {
        const provider = url.pathname.startsWith('/github') ? 'github' : 'google';
        const person = this.queued[provider];
        delete this.queued[provider];
        const back = new URL(url.searchParams.get('redirect_uri')!);
        if (!person) {
          back.searchParams.set('error', 'access_denied');
        } else {
          const code = randomBytes(12).toString('hex');
          this.grants.set(code, {
            provider,
            person,
            challenge: url.searchParams.get('code_challenge') ?? undefined,
            clientId: url.searchParams.get('client_id') ?? '',
          });
          back.searchParams.set('code', code);
        }
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/github/login/oauth/access_token' || url.pathname === '/google/token')) {
        const form = new URLSearchParams(await body(req));
        const grant = this.grants.get(form.get('code') ?? '');
        this.grants.delete(form.get('code') ?? '');
        // GitHub answers a bad code with 200 and an error, as the real one does.
        if (!grant) return send(url.pathname.startsWith('/github') ? 200 : 400, { error: 'bad_verification_code' });
        if (grant.challenge) {
          const verifier = form.get('code_verifier') ?? '';
          if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) return send(400, { error: 'invalid_grant' });
        }
        const token = randomBytes(12).toString('hex');
        this.tokens.set(token, grant);
        if (grant.provider === 'github') return send(200, { access_token: token, token_type: 'bearer', scope: 'read:user,user:email' });
        const now = Math.floor(Date.now() / 1000);
        const p = grant.person as GooglePerson;
        const idToken = [
          b64({ alg: 'RS256', typ: 'JWT' }),
          b64({ iss: `${OAUTH_MOCK_ORIGIN}/google`, aud: grant.clientId, sub: p.sub, email: p.email, iat: now, exp: now + 3600 }),
          b64('unsigned'),
        ].join('.');
        return send(200, { access_token: token, token_type: 'Bearer', expires_in: 3599, id_token: idToken });
      }

      const grant = this.tokens.get(bearer);
      if (!grant) return send(401, { message: 'Bad credentials' });
      if (url.pathname === '/github-api/user') {
        const p = grant.person as GithubPerson;
        return send(200, { id: p.id, login: p.login, name: p.name, avatar_url: null, email: null });
      }
      if (url.pathname === '/github-api/user/emails') {
        const p = grant.person as GithubPerson;
        return send(200, [{ email: p.email, primary: true, verified: p.verified ?? true }]);
      }
      if (url.pathname === '/google/userinfo') {
        const p = grant.person as GooglePerson;
        return send(200, { sub: p.sub, email: p.email, email_verified: p.email_verified ?? true, name: p.name });
      }
      send(404, { error: 'not_found' });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(OAUTH_MOCK_PORT, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}
