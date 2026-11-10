# Desktop and web live editing: end-to-end test

`apps/web/e2e/test/desktopLiveSync.spec.ts` (DESKTOP-LIVE-SYNC phase P5)
proves that the desktop app and the web editor, editing one layout on a
real server, end up with the same layout. The desktop side is
`bld_sync_driver`, a small headless program in the desktop repo that uses
the desktop's own `SyncSession` and `LayoutMerge` and is driven by
commands on stdin. The web side is the editor in the browser.

It needs both repos: the desktop repo's driver (Rust and Qt) and this
repo's server and web app. CI runs it on main and at night
(`.github/workflows/live-smoke.yml`, which builds the driver from the
desktop repo's main), with `liveSmoke.spec.ts` below. Without
`BLD_SYNC_DRIVER` set, both specs skip with a message saying so.

`apps/web/e2e/test/liveSmoke.spec.ts` (full review area 4, Idea 1) is the
live collaboration smoke test: two browsers and the driver on one layout.
Presence (each browser lists the other and the desktop; the desktop sees
both), a move each way, a drop and reconnect on each side (the edits
arrive), a role change (lowered to view only, the desktop changes nothing
on the server) and a sign-out (its sign-in revoked on the website ends its
connection; the browsers carry on).

## What it covers

1. The desktop joins a layout made on the web (from
   `packages/bbm/tests/fixtures/tight-corner.bbm`) and sees every brick.
2. Interleaved edits: the web nudges a brick (arrow keys), the desktop
   moves another and turns a third. The server's `export.bbm`, the
   desktop's map and the browser's bricks all agree, brick by brick
   (id, position, orientation).
3. Undo on the desktop reverts only the desktop's edits, on the server
   and in the browser; the web's edit stays.
4. Presence: the web draws the desktop's cursor, and the desktop sees
   the web user's cursor.
5. Offline: the desktop disconnects; both sides edit, including one
   brick both move. The desktop's edits don't reach the server, not even
   after it reconnects, until they are resolved. Resolving with "keep
   mine" for the clash gives the expected merged layout on the server, in
   the browser and on the desktop.

Custom part upload from the desktop is not covered yet.

## Running it

1. Build the driver in the desktop repo (`collaborative-layout-designer`):

   ```sh
   cmake -S . -B build-sync -G Ninja -DBLD_SYNC=ON
   cmake --build build-sync --target bld_sync_driver
   ```

   The binary is `build-sync/src/app/bld_sync_driver`.

2. Start the API server from `apps/server`, as for the other e2e specs
   (see the header of `apps/web/playwright.config.ts`):

   ```sh
   export DB_PATH=/tmp/cld-e2e.sqlite ENABLE_PASSWORD_AUTH=true \
          COOKIE_SECURE=false PUBLIC_URL=http://localhost:5173 \
          PARTS_DIR=<parts library> BACKUPS_DIR=/tmp/cld-e2e-backups
   npx tsx src/db/migrate.ts && npx tsx src/index.ts
   ```

3. Run the spec from `apps/web` with the same `DB_PATH`:

   ```sh
   BLD_SYNC_DRIVER=<desktop repo>/build-sync/src/app/bld_sync_driver \
     npx playwright test e2e/test/desktopLiveSync.spec.ts
   ```

Environment:

| Variable          | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `BLD_SYNC_DRIVER` | Path to `bld_sync_driver`. Unset: the spec is skipped.     |
| `BLD_SYNC_SERVER` | API server the driver connects to (default `http://127.0.0.1:3000`). |
| `DB_PATH`         | The server's database, for e-mail verification (as for every e2e spec). |

The spec signs a user in, gets the driver an API token through the
device sign-in (`/api/auth/device/code`, `approve`, `token`), and passes
it to the driver in `BLD_SYNC_TOKEN`.

## The driver's commands

One command per line; each answers with one line, `ok[ <result>]` or
`error <message>`. The full list is at the top of
`src/app/bld_sync_driver.cpp` in the desktop repo: `open`, `wait-synced`,
`status`, `move`, `rotate`, `undo`, `redo`, `name`, `cursor`,
`disconnect`, `reconnect`, `resolve mine|server|merge-default`,
`dump [shared]`, `peers`, `quit`.
