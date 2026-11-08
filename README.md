<p align="center">
  <img src="logo.png" alt="Collaborative Brick Layout Designer logo" width="96" height="96">
</p>

# Collaborative Brick Layout Designer

A web app for planning LEGO train and town layouts together: live editing in
the browser, clubs, shared modules, venues, custom parts and a public catalog.
It is also the server for the
[Collaborative Brick Layout Designer desktop app](https://github.com/collaborative-brick-layout-designer/desktop),
and reads and writes the same files (`.bld-layout`, and BlueBrick's
`.bbm`). Self-hosted as one Docker container.

![The editor with a town layout: track, roads, buildings and labels, the parts library and sheets on the right](docs/screenshots/editor-dark.png)
[View in light mode](docs/screenshots/editor-light.png)
*The editor: a town layout with track, roads and buildings, the parts library and the sheets beside it.*

![The venue designer: the hall's walls, doors, stairs and obstacles](docs/screenshots/venue-dark.png)
[View in light mode](docs/screenshots/venue-light.png)
*Venues: draw the hall, then get warned when track comes too close to a wall or a walkway.*

![The home page: your layouts and venues](docs/screenshots/home-dark.png)
[View in light mode](docs/screenshots/home-light.png)
*Home: your layouts and venues, and a short tour for new builders.*

---

## ⚠️ Vibe-coded warning

> **This codebase was vibe-coded with an AI assistant** (Anthropic's Claude),
> directed and reviewed by a person. The web app says so too, on its About page.
>
> It works, the tests pass, and the architecture is reasonable — but every
> line was generated through iterative prompting, not hand-written by a
> careful human. Treat it accordingly:
>
> - **Audit before you trust.** Especially anything touching auth, file
>   uploads, the WebSocket layer, or SQL. AI assistants are great at
>   producing plausible-looking code; security review is on you.
> - **Bugs may be subtle.** The test suite covers a lot, but AI-generated
>   code has a knack for hiding edge cases behind confident-looking comments.
> - **No production guarantees.** Self-host at your own risk. Don't expose
>   it to the open internet without a reverse proxy, TLS, rate-limiting,
>   and a backup plan.
> - **Refactor liberally.** If something looks weird, it probably is.
>   Don't preserve cruft just because the AI wrote it that way.
>
> Pull requests, issues, and "this is wrong, here's why" comments very
> welcome.

---

## What it does

**For everyone**
- A browser editor with BlueBrick's parts library: connection snapping,
  sheets, groups and sets, flex track with a bend handle, rulers, text,
  anchored labels, electric circuits, saved views and pictures, budgets and
  part lists. It works on a phone (view, and light editing by touch), a
  tablet and a desktop.
- **Live editing** with [Yjs](https://yjs.dev/) over WebSocket: everyone's
  changes and cursors appear as they happen, and undo only undoes your own.
- **Venues**: draw the hall with walls, doors, obstacles, power points and
  measurements, then start layouts from it.
- **Modules**: save part of a layout as a module, give it its own look, pin
  it in place, edit it, and drop it into other layouts.
- **Files**: open and download `.bld-layout` (the shared layout file) and
  BlueBrick `.bbm`; open LDraw, TrackDesigner and nControl maps.
- Guided tours, ⓘ help beside each setting, light, dark and color themes,
  and settings that follow your account to the desktop app.

**Clubs.** Members share layouts, modules, venues and parts. A club is
joined by invite, by request or openly. What each member may do comes from
the **roles** they hold, and each role is a set of **permissions**: view,
edit or start layouts, add modules and parts, manage venues, send to the
catalog, invite people, manage members and roles, download the club's data,
and delete club items. Someone with several roles may do everything those
roles allow.
- Every club starts with **Admin**, **Manager**, **Member** and **Viewer**,
  and its admins can change them or add the club's own, such as Track crew.
- **Admin** always has every permission and can't be edited; only admins
  change the club's settings, hand it over, or delete it (with a waiting
  period and Restore). A club always keeps one admin.
- People who may *invite* answer join requests, and invite, remove or warn
  people whose roles can do less than theirs; people who may *manage
  members and roles* give and take any role but Admin, and remove anyone
  but an admin.

Things saved to a club keep their author's credit, and the author can *Take
back* something they gave to a club (or someone who may *delete club items*
can *Give back*).

**Public catalog.** When the site admin turns it on, people publish modules,
parts, layouts and venues, and arrange them in collections with cover
pictures. Visitors who aren't signed in can browse (a site setting). A
moderator reviews submissions, unless the site skips review; a **trusted
club** reviews what is published under its own name.

**Site roles**
- **Moderators** review the catalog (Admin › Moderation).
- **Site admins** run everything under Admin: users, clubs, layouts, parts
  and part libraries, usage limits and heavy use, privacy requests, the
  audit log and the site settings.
- **The demo account** ("Try the demo" on the sign-in page, when an admin
  turns it on) is shared by every visitor, holds sample layouts, and resets
  on a schedule. Each reset signs every visitor out (a demo sign-in lasts 24
  hours at most), and their page offers "Start again".

**Privacy.** People download all their data and delete their account from
their Profile; nobody else ever sees their email address. See
[Privacy and GDPR](#privacy-and-gdpr) for the admin's side.

---

## Self-hosting with Docker

```sh
mkdir brick-layouts && cd brick-layouts
curl -fsSLO https://raw.githubusercontent.com/collaborative-brick-layout-designer/web/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/collaborative-brick-layout-designer/web/main/.env.example
# Edit .env: PUBLIC_URL, BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD,
# and a way to sign in (an OAuth provider, or ENABLE_PASSWORD_AUTH=true with SMTP).
docker compose up -d
```

Then open `PUBLIC_URL` (by default http://localhost:3000) and sign in as the
bootstrap admin. The image is `ghcr.io/collaborative-brick-layout-designer/web`:
`:latest` is the newest release, `:nightly` follows `main`, and `:vX.Y.Z`
pins a release.

### First steps as the admin

1. **Admin › Part libraries › Download default library** fetches
   [BlueBrickParts](https://github.com/Lswbanban/BlueBrickParts) (about 27 MB)
   into the parts volume and turns it on. The Download Center on the same page
   adds community packs (4DBrix, TrixBrix, BrickTracks…).
2. **Admin › Site settings**: email (SMTP), whether new accounts confirm their
   email, the public catalogs, the demo account, background jobs, privacy
   (contact, notice and how long things are kept) and usage limits.
3. Make a club, or let people make their own.

### Volumes

| Volume | Mounted at | Holds |
|---|---|---|
| `cbld-data` | `/data` | The SQLite database (`cbld.sqlite`), layout background pictures (`bgimages/`) and data downloads waiting to be fetched (`exports/`) |
| `cbld-parts` | `/parts` | Part libraries and uploaded parts |
| `cbld-backups` | `/backups` | The daily database backups |

They survive restarts, upgrades and recreating the container. To use host
folders instead (Unraid, Synology), replace the `volumes:` lines:

```yaml
    volumes:
      - /mnt/user/appdata/cbld/data:/data
      - /mnt/user/appdata/cbld/parts:/parts
      - /mnt/user/appdata/cbld/backups:/backups
```

### Upgrading and migrations

```sh
docker compose pull
docker compose up -d
```

Database migrations run by themselves when the server starts, before it
accepts requests. They only move forward, so take a backup before a big
upgrade (see below). Running from source, `pnpm --filter @cld/server db:migrate`
applies them by hand, and `pnpm --filter @cld/server db:generate` makes a new
one after a change to `apps/server/src/db/schema.ts`.

### Reverse proxy, TLS and firewalls

The container has no TLS on purpose: put Caddy, Traefik, nginx or a
Cloudflare Tunnel in front, and then set:

- `PUBLIC_URL` to the address people use (`https://layouts.example.org`).
  Browser WebSockets from any other origin are refused.
- `COOKIE_SECURE=true`.
- `TRUST_PROXY` to the proxy's address or network (`127.0.0.1` for a
  proxy or Cloudflare Tunnel on the same host, `172.16.0.0/12` for a
  Docker network), so rate limits and logs see the real client IPs. The
  client is then the right-most `X-Forwarded-For` address that isn't one
  of these. Avoid `true`: it trusts every hop, so a client can pick the
  address the server sees (the server warns about it at start-up).

The server's own rate limits count **per person** for anything signed
in (a club at a show shares one Wi-Fi address), and per address only for
signing in, signing up and other signed-out requests. A proxy or WAF
that limits by IP on top should allow for many people behind one
address: don't limit `/api/events` (the live stream, reopened on every
page load and wake-up) or `/api/metrics/client` more tightly than the
server does.

The proxy must pass **WebSocket upgrades** on `/ws/layout/:id` (live
editing) and allow these **request body sizes**. A web application
firewall (WAF) needs the same exceptions:

| Requests | Largest body |
|---|---|
| Everything by default | 10 MiB |
| `PUT /api/layouts/:id/snapshot` and `PUT /api/modules/:id/snapshot` (binary layout and module data, `application/octet-stream`) | 50 MiB |
| One WebSocket message on `/ws/layout/:id` | 16 MiB |
| `PUT /api/catalog/collections/:id/cover` and `PUT /api/catalog/items/:id/cover` (a cover picture of up to 7 MB, sent as base64 JSON) | about 9.4 MiB |

nginx, for example: `client_max_body_size 50m;`, and for `/ws/`:
`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade"; proxy_read_timeout 1h;`.
Cloudflare's free plan accepts bodies up to 100 MB.

#### Operations: the 4xx profile (CrowdSec and other WAFs)

WAF scenarios such as CrowdSec's `http-probing` ban an address after a
burst of 404/403/400 answers, and at a show a whole club shares one
venue Wi-Fi address. So everyday use of the site and the desktop app
gets **no 4xx answers at all**: opening layouts (also ones with parts
this server doesn't have), browsing the catalog and collections,
viewing shared links signed out, live editing while someone else
deletes things, and the desktop's parts and library sync. The apps
check before they ask:

- part sprites are fetched only for parts the parts catalog
  (`/api/parts/catalog`) lists; a missing part is drawn locally as a
  placeholder, never requested;
- pictures are asked for only when the list says one exists (a
  catalog item's `previewUrl` is `''` without one, a module's
  `thumbnailAt` is empty);
- after a live "deleted" hint the deleted thing's own queries aren't
  refetched, only the lists that showed it;
- an old share link (`/api/public-layouts/<token>`, switched off or its
  layout deleted) answers `200 {"layout": null}`;
- the desktop downloads only the files the parts manifest lists, and
  only the ones whose hash changed.

What may still answer 4xx, one request at a time rather than in bursts:

| Answer | When |
|---|---|
| 401 on `/api/*` | the session ended (signed out in another tab, account deleted, a demo reset, or a sign-in past its longest) |
| 403 / 404 on `/api/layouts/:id`, `/api/modules/:id`, `/api/venues/:id`, `/api/orgs/:slug/*` | a link to something deleted, or not shared with you; a club's manage page just after you handed the club over |
| 404 on `/api/auth/password/verify-email/:token`, `/api/invites/*`, `/api/transfers/*`, `/api/org-invites/*` | an emailed link used twice or expired |
| 400 / 409 / 413 | a form refused (a taken part number, a file too big) |
| 429 | the server's own rate limits |

The web e2e journeys fail when a normal journey draws any 4xx
(`apps/web/e2e/quietNetwork.ts`), so this stays true.

With CrowdSec, keep `http-probing` on (it still catches real probing)
and, if the paths above ever trip it for a club, whitelist the app's own
paths in a parser (`/etc/crowdsec/parsers/s02-enrich/cld-whitelist.yaml`):

```yaml
name: local/cld-app-paths
description: "Collaborative Brick Layout Designer: the app's own paths may 404 now and then"
whitelist:
  reason: "app paths that may answer 401/403/404 in normal use"
  expression:
    - evt.Meta.http_status in ['401', '403', '404'] && evt.Meta.http_path matches '^/api/(layouts|modules|venues|orgs|auth/password/verify-email|invites|transfers|org-invites)/'
```

Leave `/parts/`, `/api/catalog/` and `/api/public-layouts/` out of it:
the apps never ask there for what isn't listed, so 404s there are
probing.

### Backups

Every night the server writes a consistent copy of the database to
`BACKUPS_DIR` as `cbld-YYYY-MM-DD.sqlite.gz` and keeps 7 daily, 3 weekly and
12 monthly copies. Turn it off or on in Admin › Site settings › Background
jobs (or force it with `BACKUPS_ENABLED`).

These copies hold the database only. Back up the `/data` volume (for the
background pictures) and `/parts` (for uploaded parts) with your usual tools
too, and keep a copy somewhere else.

To restore: stop the container, unzip a backup over the database
(`gunzip -c cbld-2026-10-01.sqlite.gz > /data/cbld.sqlite`, and delete any
`cbld.sqlite-wal` and `cbld.sqlite-shm` beside it), then start it again.

### Background jobs and logs

The server logs to standard output (`docker compose logs -f`). Its jobs:

- **Daily**: the backup, compacting each layout's edit history, and
  clearing out old demo layouts.
- **Hourly**: the privacy clean-up (old data downloads, accounts and clubs
  whose waiting time is over, expired sign-ins and invites, old records).
  At start-up it logs `[privacy] clean-up scheduled hourly`, and after a run
  that removed something, one line such as
  `[privacy] clean-up: 2 sessions, 1 invite, 0 exports, 0 accounts, 0 clubs`.
  It always runs: keeping personal data longer than promised isn't optional.
- **Every few minutes**: the demo reset, when the demo account is on and a
  reset is due.

---

## Configuration

Most settings are changed in the app, under **Admin › Site settings**, and
take effect without a restart:
- email confirmation for new accounts;
- the public catalogs (each on or off), review, anonymous browsing and the
  cover picture size;
- the demo account and its reset schedule;
- background jobs;
- privacy settings, the privacy notice and contact;
- how long people stay signed in, on the website and in the desktop app;
- usage limits (and per person or club, under Heavy use);
- the oldest desktop app version allowed.

Trusted clubs are switched on in Admin › Clubs.

**How long sign-ins last** (Admin › Site settings › Sign-in). A web sign-in
ends after 30 days without a visit, and after 90 days at most however often
it is used; a desktop sign-in after 90 days unused and 180 days at most. Each
is a setting (the longest can be "never"), and a `SIGN_IN_*` variable below
forces one. A change applies to every sign-in the next time it is used;
saving signs nobody out. Demo sign-ins end at each demo reset, and after 24
hours at most.

Environment variables set what the app can't (addresses, sign-in providers,
paths). Where a variable and an in-app setting overlap, setting the variable
**forces** the value and the settings page says so. These tables are
generated from the code (`pnpm --filter @cld/server docs:env`); a test fails
when they fall behind.

<!-- env-table:start (generated by `pnpm --filter @cld/server docs:env`; do not edit) -->
| Variable | When unset | Also in the app | Notes |
|---|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | — | The address people type, scheme, host and port. Used for sign-in callbacks, emailed links and the desktop sign-in page; browser WebSockets are only accepted from this origin. |
| `HTTP_PORT` | `3000` | — | The port the server listens on (`PORT` also works). |
| `DB_PATH` | `./data/cbld.sqlite` | — | The SQLite database. `/data/cbld.sqlite` in Docker. |
| `PARTS_DIR` | `./data/parts` | — | Where part libraries and uploaded parts live. `/parts` in Docker. |
| `COOKIE_SECURE` | `true` when `NODE_ENV=production` | — | Send sign-in cookies over HTTPS only. Turn on behind TLS. |
| `TRUST_PROXY` | `false` | — | Behind a reverse proxy: the proxy IPs / CIDRs (`127.0.0.1`, `172.16.0.0/12,127.0.0.1`), so client IPs come from `X-Forwarded-For` (the right-most address that isn’t a listed proxy). `true` trusts every hop and lets clients pick their address; the server warns about it. Leave `false` when exposed directly. |
| `NODE_ENV` | `development` | — | `production` in the Docker image. |
| `APP_VERSION` | the server package version | — | The version `GET /api/version` reports. |
| `ENABLE_PASSWORD_AUTH` | `false` | — | Allow email and password accounts. New accounts confirm their email first (see SMTP). |
| `BOOTSTRAP_ADMIN_EMAIL` | — | — | A site admin created on first start when no account has this email. |
| `BOOTSTRAP_ADMIN_PASSWORD` | — | — | Its password (at least 12 characters). |
| `GOOGLE_CLIENT_ID` | — | — | With `GOOGLE_CLIENT_SECRET`: sign in with Google. |
| `GOOGLE_CLIENT_SECRET` | — | — |  |
| `GITHUB_CLIENT_ID` | — | — | With `GITHUB_CLIENT_SECRET`: sign in with GitHub. |
| `GITHUB_CLIENT_SECRET` | — | — |  |
| `OIDC_ISSUER_URL` | — | — | With `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: any OpenID Connect provider (Microsoft Entra, Auth0, Keycloak…). |
| `OIDC_CLIENT_ID` | — | — |  |
| `OIDC_CLIENT_SECRET` | — | — |  |
| `SMTP_HOST` | — | Admin › Site settings › SMTP server (wins once saved) | With `SMTP_FROM`: invites and email confirmations are emailed. Without it, invites are copy-paste links and confirmation links go to the server log. |
| `SMTP_PORT` | `587` | Admin › Site settings › SMTP server |  |
| `SMTP_USER` | — | Admin › Site settings › SMTP server |  |
| `SMTP_PASS` | — | Admin › Site settings › SMTP server |  |
| `SMTP_FROM` | — | Admin › Site settings › SMTP server | The sender address. |
| `BACKUPS_ENABLED` | unset (the switch decides; on) | Admin › Site settings › Background jobs | When set, forces the daily database backup on or off. |
| `BACKUPS_DIR` | `/backups` | — | Where backups go. |
| `DAILY_COMPACTION_ENABLED` | unset (the switch decides; on) | Admin › Site settings › Background jobs | When set, forces the daily compaction of layout histories on or off. |
| `COLLECTION_COVER_MAX_BYTES` | unset (5 MB) | Admin › Site settings › Public catalogs | When set, forces the largest collection and catalog cover picture, in bytes (at most 7 MB). |
| `LIMITS_ENFORCE` | unset (the switch decides; on) | Admin › Site settings › Usage limits | `on` or `off` forces whether usage limits are enforced. |
| `CBLD_DATA_FIX` | unset | — | A one-time data fix to run at this start (`clamp-drawing-values`), for one restart. Each runs once (recorded in `data_fixes`); without it the server only logs that one waits. Try it first on a copy: `node dist/ops/clampDrawingValuesCli.js --db <file>` in the Docker image (from `/app/apps/server`), or `pnpm --filter @cld/server data-fix:clamp-drawing-values --db <file>` from a checkout. |
| `PRIVACY_CONTACT` | unset | Admin › Site settings › Privacy | When set, forces the privacy contact (an email address or a web address) shown on the privacy page. |

**Usage limits.** Each is also set in Admin › Site settings › Usage limits (and per person or club); the variable sets the default the admin starts from.

| Variable | Built-in default | Limit |
|---|---|---|
| `LIMIT_CLUBS_PER_USER` | 5 | Clubs a person can create: How many clubs one person may start. People must confirm their email first. |
| `LIMIT_NEW_ACCOUNT_CLUBS` | 1 | Clubs in an account’s first week: Lower cap for brand-new accounts, so a throwaway account can’t make many clubs. |
| `LIMIT_LAYOUTS_PER_USER` | 500 | Layouts per person: Personal layouts one person may keep. |
| `LIMIT_LAYOUTS_PER_CLUB` | 2000 | Layouts per club: Layouts a club may keep. |
| `LIMIT_STORAGE_PER_USER` | 2 GB | Space per person: Layouts, custom parts, modules, venues, background pictures and collection covers one person owns. |
| `LIMIT_STORAGE_PER_CLUB` | 10 GB | Space per club: The same, for everything a club owns. |
| `LIMIT_STORAGE_PER_CLUB_MEMBER` | 256 MB | Extra club space per member: Clubs get this much more space for each member, so bigger clubs have more room. |
| `LIMIT_CUSTOM_PARTS_PER_USER` | 2000 | Custom parts per person: Parts one person may upload. |
| `LIMIT_CUSTOM_PARTS_PER_CLUB` | 5000 | Custom parts per club: Parts a club may hold. |
| `LIMIT_UPLOAD_BYTES` | 50 MB | Largest single upload: The biggest one file (layout, picture or part) that can be sent at once. |
| `LIMIT_MEMBERS_PER_CLUB` | 500 | Members per club: People one club may have. |
| `LIMIT_SHARE_LINKS_PER_USER` | 200 | Share links per person: Personal layouts shared with a public link at once. |
| `LIMIT_SHARE_LINKS_PER_CLUB` | 1000 | Share links per club: Club layouts shared with a public link at once. |
| `LIMIT_LIVE_EDITORS_PER_LAYOUT` | 50 | People editing one layout at once: Live connections to one layout. |
| `LIMIT_REQUESTS_PER_MINUTE_USER` | 2400 a minute | Requests per minute (browser): Requests one signed-in person may make in a minute from the web app. |
| `LIMIT_REQUESTS_PER_MINUTE_TOKEN` | 2400 a minute | Requests per minute (desktop app): Requests one desktop sign-in may make in a minute. |

**Privacy.** Each is also set in Admin › Site settings › Privacy; when the variable is set to a whole number in range, it wins and the page says so.

| Variable | Built-in default | Range | Setting |
|---|---|---|---|
| `PRIVACY_EXPORT_EVERY_HOURS` | 24 hours | 1–720 | One data download every: How often one person may ask for a download of their data. Building one takes work, so once a day is plenty. |
| `PRIVACY_EXPORT_MAX_MB` | 1024 MB | 10–4000 | Biggest data download: A download that would be bigger stops and says so; the person (or you) can ask again after tidying up. |
| `PRIVACY_EXPORT_KEEP_DAYS` | 7 days | 1–30 | Keep a data download for: After this the download link stops working and the file is deleted from the server. |
| `PRIVACY_DELETION_GRACE_DAYS` | 14 days | 7–30 | Wait before deleting an account: When someone deletes their account (or a club), it waits this long first. Signing back in (or Restore, for a club) cancels it. |
| `PRIVACY_REQUEST_DUE_DAYS` | 30 days | 7–90 | Answer a privacy request within: When you log a request in Admin › Privacy requests, it is due this long after it arrived. The law in many places gives one month. |
| `PRIVACY_AUDIT_PERSONAL_DAYS` | 365 days | 30–3650 | Keep email addresses in the audit log for: The audit log keeps what happened for as long as the site runs. Email addresses in it (invites, admin actions) are removed after this. It never records IP addresses or browsers. |
| `PRIVACY_EXPIRED_SIGN_IN_DAYS` | 30 days | 1–365 | Keep expired sign-ins and invites for: Expired or signed-out browser sessions, revoked desktop sign-ins, and invites and offers nobody accepted are deleted this long after they ended. |
| `PRIVACY_RECORDS_KEEP_DAYS` | 1095 days | 365–3650 | Keep erasure records and closed requests for: The record that an account or club was erased (no personal data), and privacy requests once closed, so you can show what you did. Deleted after this. |

**Sign-in.** How long a sign-in lasts, on the website and in the desktop app. Each is also set in Admin › Site settings › Sign-in; when the variable is set to a duration in range (`30d` or `30` for days, `12h` for hours, `never` for the longest), it wins and the page says so. A change applies to existing sign-ins the next time they are used. Demo sign-ins always end at each demo reset, and after 24 hours at most.

| Variable | Built-in default | Range | Setting |
|---|---|---|---|
| `SIGN_IN_WEB_IDLE` | 30 days | 1 hour–365 days | Website, sign out when not used for: Every visit starts this over, so people who keep using the site stay signed in. |
| `SIGN_IN_WEB_MAX` | 90 days | 1 hour–3650 days, or `never` | Website, sign in again after at most: Even someone who visits every day signs in again after this long. |
| `SIGN_IN_DESKTOP_IDLE` | 90 days | 1 hour–365 days | Desktop app, sign out when not used for: Every time the desktop app talks to this site it starts this over. |
| `SIGN_IN_DESKTOP_MAX` | 180 days | 1 hour–3650 days, or `never` | Desktop app, sign in again after at most: Even a desktop app in daily use asks its owner to sign in again after this long. Work on the computer is kept. |
<!-- env-table:end -->

### Sign-in providers

Each OAuth provider needs this callback URL:

```
<PUBLIC_URL>/api/auth/<google|github|oidc>/callback
```

Email and password accounts (`ENABLE_PASSWORD_AUTH=true`) confirm their email
before they can sign in, so set up SMTP first; without it the confirmation
link only goes to the server log.

### Desktop sign-in

The desktop app signs in with the OAuth 2.0 device-code flow (RFC 8628) and
then edits layouts live over the same WebSocket as the browser:

1. The app calls `POST /api/auth/device/code` and shows a code such as
   `BCDF-GHJK` and a link to `<PUBLIC_URL>/device`.
2. The person opens that page signed in, checks the code, the app's name and
   what it asks for, and approves or denies.
3. The app polls `POST /api/auth/device/token` and gets a personal access
   token (`bld_pat_…`, shown once, stored only as a hash).

Tokens end after 90 days without use, and after 180 days however much they
are used (Admin › Site settings › Sign-in changes both); then the app asks
its owner to sign in again and keeps the work on the computer. They are only
accepted as an `Authorization: Bearer` header, never in the address, and
only on the routes the desktop uses. People see and revoke their devices under Profile ›
Devices. The desktop needs no server settings.

---

## Privacy and GDPR

Whoever runs the site is responsible for the personal data on it. The app
does most of the work:

- **People help themselves.** Profile › Your data downloads everything a
  person has (once a day by default), and Profile › Delete my account deletes
  it after a waiting period (14 days by default; signing back in cancels).
  Club admins delete a club the same way, with Restore during the wait.
- **Email addresses are never shown to other people**, only to the person
  and to site admins.
- **Records are trimmed for you** by the hourly clean-up, on the schedule in
  Admin › Site settings › Privacy.

What's left for you:
- Fill in the **privacy contact** and, if you like, your own **privacy
  notice** in Admin › Site settings › Privacy. Both show on the site's
  privacy page.
- Log requests that arrive by email or letter in **Admin › Privacy
  requests**. Each has a due date (30 days by default) and a history of what
  you did: download data for the person, restrict, or delete.
- Keep the backups safe, and delete old backups you no longer need: they
  hold the same personal data.

[docs/PRIVACY-DATA.md](docs/PRIVACY-DATA.md) lists every kind of personal data
the server keeps, where, for how long, and what a download and a deletion
include.

---

## Developing

Requirements: **Node.js 24+** and **pnpm 10+**.

```sh
git clone https://github.com/collaborative-brick-layout-designer/web.git
cd collaborative-brick-layout-designer
pnpm install
cp .env.example .env      # set BOOTSTRAP_ADMIN_*, and ENABLE_PASSWORD_AUTH=true for local sign-in
pnpm --filter @cld/server db:migrate
pnpm dev
```

The Vite dev server is on http://localhost:5173 and passes `/api`, `/ws` and
`/parts` to the API server on http://localhost:3000. `pnpm --filter @cld/server dev`
or `pnpm --filter @cld/web dev` runs one of them alone. `VITE_PORT` and
`CLD_API_ORIGIN` move them, to run a second copy beside the first.

### Tests

```sh
pnpm test           # unit and integration tests (vitest), every package
pnpm typecheck
pnpm lint
```

End-to-end tests use Playwright against a running server. The steps are at
the top of [apps/web/playwright.config.ts](apps/web/playwright.config.ts):
start the API server on a test database with `ENABLE_PASSWORD_AUTH=true`,
then run `DB_PATH=<that database> pnpm --filter @cld/web exec playwright test`.
The `apps/web/e2e/test/journeys/` specs walk whole paths through the app (a
new user, club life, the catalog, deleting, privacy, phones…). CI runs them
with a core set of specs on every pull request, and every spec nightly.

`pnpm scan:secrets` and `pnpm scan:deps` run the secret and dependency scans
that CI runs.

---

## Repository layout

```
apps/
  server/           Fastify API + WebSocket + workers
    src/
      routes/       HTTP route modules
      ws/           y-websocket handler
      workers/      Backup, compaction, privacy clean-up and demo-reset jobs
      privacy/      Data downloads, account and club deletion, retention
      limits/       Usage limits
      demo/         The one demo account (Admin › Site settings › Demo account)
      db/           Drizzle schema + migrations
  web/              React + Vite SPA
    src/
      editor/       Konva canvas + Yjs editor
      layouts/      Layout list, share dialog, audit panel
      orgs/         Club pages
      catalog/      The public catalog and collections
      admin/        Admin pages
      tours/        Welcome card and guided tours (tours.json, shared with the desktop)
packages/
  bbm/              `.bbm` reader/writer (byte-exact round-trip)
  model/            Pure domain model (bricks, layers, layout)
  parts-catalog/    Parts XML scanner, connectivity and the flex solver
  ydoc/             Yjs ↔ model projection
.github/workflows/  CI (PR build), nightly, release
```

---

## CI / Releases

GitHub Actions workflows:

- **`ci.yml`**: on every pull request, lint, typecheck, build, unit tests,
  the Docker build, the OSV scan and the conventional-commit check.
- **`journeys.yml`**: the end-to-end journeys on every pull request, and
  every e2e spec nightly, split into shards of about 12 minutes by how long
  each spec took the night before (`.github/scripts/e2e-shards.mjs`), with
  their reports merged into one summary on the run page. Run it by hand with
  `gh workflow run journeys.yml --ref <branch> -f full=true`.
- **`secret-scan.yml`**: gitleaks.
- **`nightly.yml`**: on every push to `main`, pushes the `:nightly` image to
  GHCR and uploads a Trivy report.
- **`release.yml`**: on `v*` tags, publishes `:vX.Y.Z` and `:latest`, stops
  on CRITICAL Trivy findings, and writes release notes grouped by
  conventional-commit type.

Cut a release:

```sh
git tag -a v1.2.0 -m "v1.2.0 — release notes"
git push origin v1.2.0
```

---

## Contributing

- Conventional Commits enforced by lefthook + CI (`feat:`, `fix:`,
  `docs:`, `chore:`, etc.)
- Pre-commit hooks run typecheck + secret scan; pre-push runs the full
  test suite. Don't bypass with `--no-verify`.
- New features need tests. The bar for AI-generated additions is
  *higher* than for human-written code, not lower — bring fixtures.

---

## Licence

[AGPL-3.0-or-later](./LICENSE).
