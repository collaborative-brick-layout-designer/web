# Security

## Reporting a vulnerability

Please **do not file public GitHub issues** for security problems. Instead,
open a private vulnerability report via GitHub's "Report a vulnerability"
form on the repository, or email the maintainers.

## Layered scanning

This project runs the following automated checks:

| Check | Where | When | Gates merge/release? |
|---|---|---|---|
| `pnpm typecheck` | local + CI | every commit / PR | yes (CI) |
| `pnpm test` (vitest) | local + CI | every commit / PR | yes (CI) |
| Conventional Commits lint | local + CI | every commit / PR | yes (CI) |
| **CodeQL** (JS/TS, security-extended) | GitHub | PRs, push to main, weekly | results in Security tab |
| **Dependency Review** | GitHub | PRs only | yes — fails on `high` severity or disallowed licenses |
| **OSV-Scanner** | GitHub | PRs | yes — fails on known CVEs in deps |
| **Gitleaks** | local pre-commit + GitHub | every commit / PR | yes (CI); local hook is best-effort |
| **Trivy** image scan | GitHub | nightly + release | nightly = report-only; release = fails on `CRITICAL` |
| **Dependabot** | GitHub | weekly | opens PRs (npm + actions + docker) |

## Credential handling

- **Sessions**: random 24-byte tokens; only the SHA-256 of the token is
  stored in the `sessions` table. A read of the database does not yield
  bearer tokens. (Verified by `apps/server/src/auth/session.test.ts`.)
- **Sign-in lifetimes**: a web session ends after its idle window without
  use (30 days by default; each use in the second half pushes it back) and
  at its longest, counted from `sessions.created_at` (90 days by default),
  however much it is used. Desktop tokens work the same way from
  `api_tokens.created_at` (90 and 180 days). Both are set in Admin › Site
  settings › Sign-in or forced with `SIGN_IN_*`, and are checked at every
  request and every WebSocket revalidation. Demo sessions end at the next
  demo reset and after 24 hours at most, are never pushed back, and each
  reset signs every demo visitor out. (Verified by
  `apps/server/src/auth/signInLifetimes.test.ts` and
  `apps/server/src/demo/demo.test.ts`.)
- **Passwords**: argon2id via `@node-rs/argon2`; never stored in plaintext.
- **Cookies**: `HttpOnly`, `SameSite=Lax`, `Secure` in production
  (`COOKIE_SECURE=true`).
- **OAuth account linking**: when a provider's email collides with an
  existing user, the user is shown a link-confirmation prompt rather than
  silently auto-merged. Prevents account takeover via a hostile provider
  claiming the same email. (Verified by `apps/server/src/auth/users.test.ts`.)
- **OAuth state + PKCE**: short-lived `cld_oauth_state` and
  `cld_oauth_verifier` cookies; mismatch → 400.

## Local scanning

`lefthook` installs git hooks via `pnpm install`. To run scans manually:

```sh
pnpm test          # full unit + integration suite
pnpm typecheck     # all workspaces
pnpm audit         # pnpm's built-in vuln check (production deps only)
pnpm scan:deps     # OSV-Scanner against package manifests + lockfile (needs Go)
pnpm scan:secrets  # gitleaks against the full history (requires gitleaks installed)
```

Install gitleaks locally to enable the pre-commit secret-scan hook:
<https://github.com/gitleaks/gitleaks#installing>. Without it the hook
prints a notice and continues.

## Skipping a hook

`--no-verify` bypasses lefthook. CI runs the same checks again, so a local
bypass cannot ship; use it only for clearly-safe situations.
