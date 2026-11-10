// Sign-in with Google and GitHub, through openid-client (which the server
// already depended on; arctic, used before, is no longer supported).
//
// Each provider is an openid-client Configuration with its endpoints written
// out, so the server never fetches discovery documents at start. Google is
// OpenID Connect: its ID token is checked (issuer, audience, expiry) when the
// code is exchanged. GitHub is plain OAuth 2.0, with no ID token.

import * as client from 'openid-client';
import { env } from '../env.js';

export type ProviderId = 'google' | 'github' | 'oidc';

export interface NormalisedProfile {
  providerUserId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Where the provider sends the person back. The same address is in the
 * GitHub OAuth app and the Google client settings:
 * `${PUBLIC_URL}/api/auth/<provider>/callback`.
 */
export const callbackUrl = (provider: ProviderId): string => `${env.publicUrl}/api/auth/${provider}/callback`;

export interface OAuthProvider {
  id: 'google' | 'github';
  config: client.Configuration;
  scope: string;
  /** Google is OpenID Connect and sends PKCE; GitHub takes the state alone. */
  pkce: boolean;
  /** Where the profile is read, with the access token. */
  profileUrls: { user: string; emails?: string };
}

/**
 * The end-to-end tests point both providers at a stand-in on this origin
 * (apps/web/e2e/oauthMock.ts), never in production.
 */
function mockOrigin(): string | null {
  const o = process.env.OAUTH_MOCK_ORIGIN;
  return o && env.nodeEnv !== 'production' ? o.replace(/\/$/, '') : null;
}

function googleProvider(): OAuthProvider | null {
  if (!env.google) return null;
  const mock = mockOrigin();
  const issuer = mock ? `${mock}/google` : 'https://accounts.google.com';
  const config = new client.Configuration(
    {
      issuer,
      authorization_endpoint: mock ? `${mock}/google/auth` : 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: mock ? `${mock}/google/token` : 'https://oauth2.googleapis.com/token',
      userinfo_endpoint: mock ? `${mock}/google/userinfo` : 'https://openidconnect.googleapis.com/v1/userinfo',
      code_challenge_methods_supported: ['S256'],
    },
    env.google.clientId,
    env.google.clientSecret,
  );
  if (mock?.startsWith('http:')) client.allowInsecureRequests(config);
  return {
    id: 'google',
    config,
    scope: 'openid email profile',
    pkce: true,
    profileUrls: { user: mock ? `${mock}/google/userinfo` : 'https://openidconnect.googleapis.com/v1/userinfo' },
  };
}

function githubProvider(): OAuthProvider | null {
  if (!env.github) return null;
  const mock = mockOrigin();
  const web = mock ? `${mock}/github` : 'https://github.com';
  const api = mock ? `${mock}/github-api` : 'https://api.github.com';
  const config = new client.Configuration(
    {
      issuer: web,
      authorization_endpoint: `${web}/login/oauth/authorize`,
      token_endpoint: `${web}/login/oauth/access_token`,
    },
    env.github.clientId,
    env.github.clientSecret,
  );
  if (mock?.startsWith('http:')) client.allowInsecureRequests(config);
  return {
    id: 'github',
    config,
    scope: 'read:user user:email',
    pkce: false,
    profileUrls: { user: `${api}/user`, emails: `${api}/user/emails` },
  };
}

export const google = googleProvider();
export const github = githubProvider();

// ---- Single sign-on (any OpenID Connect provider) --------------------------
//
// OIDC_ISSUER_URL names the provider (Microsoft Entra, Auth0, Keycloak…); its
// endpoints come from the discovery document, read the first time someone
// signs in and kept. A read that fails isn't kept, so the next sign-in tries
// again: a provider that is down for a minute doesn't need a restart here.

let oidcDiscovery: Promise<client.Configuration> | null = null;

/** The single sign-on provider's configuration, from its discovery document. */
export function oidcConfig(): Promise<client.Configuration> {
  if (!env.oidc) return Promise.reject(new Error('single sign-on is not set up'));
  if (!oidcDiscovery) {
    const mock = mockOrigin();
    const insecure = mock !== null && env.oidc.issuerUrl.startsWith(`${mock}/`);
    oidcDiscovery = client
      .discovery(new URL(env.oidc.issuerUrl), env.oidc.clientId, env.oidc.clientSecret, undefined, insecure ? { execute: [client.allowInsecureRequests] } : undefined)
      .catch((err: unknown) => {
        oidcDiscovery = null;
        throw err;
      });
  }
  return oidcDiscovery;
}

/** Tests only: forget the discovery document, so the next sign-in reads it again. */
export function forgetOidcDiscovery(): void {
  oidcDiscovery = null;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  enabled: boolean;
}

export function listProviders(): ProviderInfo[] {
  return [
    { id: 'google', label: 'Google', enabled: !!google },
    { id: 'github', label: 'GitHub', enabled: !!github },
    { id: 'oidc', label: 'Single sign-on', enabled: !!env.oidc },
  ];
}
