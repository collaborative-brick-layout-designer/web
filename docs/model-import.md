# Importing LDraw, Studio and LDD models

People can import LDraw (`.ldr`, `.mpd`, `.dat`), BrickLink Studio (`.io`)
and LEGO Digital Designer (`.lxf`, `.lxfml`) files on the website. The
server runs the **desktop app's own importer**, `bld-import-server`
(desktop repo `docs/import-server.md`), so the part or layout is the one
the desktop app makes from the same file and choices (the desktop's
`ImportServerTest` checks this byte for byte).

Code: `apps/server/src/imports/` (converter, jobs, libraries, apply,
settings), `apps/server/src/routes/imports.ts`, `apps/web/src/import/`.

## Routes

Signed in, website only (desktop tokens are refused: the desktop imports
on its own). Bodies are JSON unless marked multipart.

| Route | Body | Answer |
|---|---|---|
| `GET /api/imports/status` | | `{ available, reason, message, extensions, maxUploadBytes, perHour, libraries: { ldraw, ldd, lddMapping, studio } }` |
| `POST /api/imports` | **multipart**, one part `file` (the model, filename with its extension), no other fields | 202 job; 415 `unsupported_type`; 413 `file_too_large`; 429 `import_rate_limited` (Retry-After) or `too_many_open_imports`; 503 `import_unavailable`; 403 for the demo account |
| `GET /api/imports/:id` | | the job: `{ id, fileName, state, step, position, error, analysis, result }` |
| `GET /api/imports/:id/preview.png` | | the preview picture (PNG), while the job is `ready` |
| `POST /api/imports/:id/convert` | `{ mode: "part"\|"parts", quarterTurns, align: ""\|"bottom"\|"box", nudge: [x, y], drop: [indices], name, designer, designerUrl, category, target }` with `target` `{ kind: "new", title?, orgSlug? }` or `{ kind: "layout", layoutId, sheetId?, at?: { x, y } }` | 202 job |
| `DELETE /api/imports/:id` | | 204: cancelled, its files deleted |
| `GET /api/admin/imports` | | converter, libraries, settings, queue (site admins) |
| `PATCH /api/admin/imports` | `{ enabled?: boolean, limits?: { maxUploadMb?, perHour?, perUserAtOnce?, atOnce?, timeoutSeconds?, memoryMb? } }` | the same view |
| `POST /api/admin/imports/ldraw/download` | none | downloads `https://library.ldraw.org/library/updates/complete.zip` |
| `DELETE /api/admin/imports/ldraw` | | |
| `POST /api/admin/imports/ldd/assets` | **multipart** `file`: LDD's `Assets.lif` (up to 1.5 GB) | 422 if it isn't a LIF archive |
| `DELETE /api/admin/imports/ldd/assets` | | |
| `POST /api/admin/imports/ldd/mapping` | **multipart** `file`: an `ldraw.xml` (or lxf2ldr's `ldraw.xml.p`), up to 32 MB | |
| `POST /api/admin/imports/ldd/mapping/community` | none | fetches lxf2ldr's `ldraw.xml.p` (GPL-3) from gitlab.com |
| `DELETE /api/admin/imports/ldd/mapping` | | |
| `POST /api/admin/imports/studio` | **multipart** `file`: a zip of Studio's `ldraw` folder, up to 1 GB | |
| `DELETE /api/admin/imports/studio` | | |

Every route is in the security route probes
(`apps/server/src/security/routeProbes.test.ts`). The upload routes'
JSON body limit stays at the server's 10 MB; their multipart file limit is
the route's own (above). A WAF in front must let these multipart bodies
through at those sizes.

## Jobs

`apps/server/src/imports/jobs.ts`. Each upload is a job, in memory:
`queued → analysing → ready → (queued →) converting → done`, or `failed` /
`cancelled`. Two steps, each one run of the converter: **analyse** (the
preview) and **convert** (the choices made in it).

- Per person: `perHour` steps an hour (each analyse and each convert,
  default 30), `perUserAtOnce` running at once (default 1), and at most 3
  jobs open. Route rate limits on top (30 uploads a minute).
- Server-wide: `atOnce` running (default 2); the rest wait in line, and
  each person sees their place.
- `timeoutSeconds` (default 180) of wall time, then SIGKILL; the same as
  the converter's CPU limit. `memoryMb` (default 4096) is its address-space
  limit.
- All of these are in Admin › Model import (limits clamp to safe ranges).

## Sandbox

The converter locks itself down before Qt starts or anything is read
(desktop `docs/import-server.md`, "Sandbox"):

| Limit | Value |
|---|---|
| CPU time | `RLIMIT_CPU` = the timeout (180 s by default) |
| Wall time | the same, SIGKILL from the server |
| Address space | `RLIMIT_AS` = `memoryMb` (4096 MB by default; LDD's Assets.lif is mapped) |
| File size | `RLIMIT_FSIZE` 256 MB |
| Open files | `RLIMIT_NOFILE` 256 |
| Core files | none |
| Processes | no new ones: seccomp refuses `fork`, `vfork`, `clone` without `CLONE_THREAD`, and `execve`; threads only |
| Network | **seccomp makes `socket()` fail for every family**, so no connection can be made. Where the host allows an unprivileged user namespace it also enters an empty network namespace; Docker's default seccomp profile refuses that, so in the image it is the seccomp filter that enforces it (`sandbox.netns: false`, `socketBlocked: true`) |
| Privileges | `PR_SET_NO_NEW_PRIVS`; the same non-root uid as the server (the image's `node`, 1000) |
| Environment | empty except `QT_QPA_PLATFORM=offscreen`, `HOME` and `TMPDIR` (the job's folder) |
| Output | at most 4 MB of JSON on stdout; stderr is read and dropped |

The server runs `bld-import-server --sandbox-check` (it tries a TCP socket,
`execv` and `fork`) and refuses a converter where any succeeds: import is
then off, and Admin says why.

## Files

- Uploads and results: `<data>/import-jobs/<job id>/` (`in/<file>`,
  `out/`, `request.json`). Deleted when the job is done (before it says
  done), fails, is cancelled, or sits for 30 minutes; a sweep every 5
  minutes deletes any folder no live job owns; at start the whole folder
  is deleted, so a crash leaves nothing. The upload keeps its own name,
  made safe (no folders, no special characters).
- Nothing about the file is logged: not its name or contents, nor the
  converter's stderr. The part's XML keeps the model's file name in
  `<ImportedFrom>`, as a desktop upload does; `<ImportSource>` (the
  server's folder) is stripped.
- Libraries: `<data>/import-libraries/` (`ldraw/`, `ldd/Assets.lif`,
  `ldd/ldraw.xml`, `studio/`, and `*.json` notes). `<data>` is the folder
  of the database (`/data` in Docker): no new mount. Sizes: LDraw ~1 GB
  unpacked (150 MB download), Assets.lif ~500 MB, ldraw.xml ~2 MB.
  Never served (no route reads them; `/parts` serves `PARTS_DIR` only),
  never in a backup (backups copy the database and `bgimages/`), never in
  a data download.

## Libraries

Admin › Model import. An env var names a path to use instead, read only,
and the page says so: `IMPORT_LDRAW_DIR`, `IMPORT_LDD_ASSETS`,
`IMPORT_LDD_LDRAW_XML`, `IMPORT_STUDIO_LDRAW_DIR`. `IMPORT_CONVERTER`
points at another converter; `IMPORTS_ENABLED` forces the switch.

- LDraw: the official complete.zip (CC BY 2.0), downloaded on the admin's
  click and unpacked with limits (200,000 files, 4 GB, ratio 200, no paths
  out of the folder).
- LDD: the admin uploads `Assets.lif` (checked to be a LIF archive). The
  mapping: lxf2ldr's community `ldraw.xml.p` (GPL-3), fetched on the
  admin's click (not bundled), or an upload.
- Studio: optional; a zip of Studio's `ldraw` folder.

## The image

`Dockerfile` stage `converter` runs `docker/fetch-import-server.mjs`:
compat.json › `importServer.pinned` names the desktop release and the
SHA-256 of its `bld-import-server-linux-x86_64.tar.gz`; a mismatch stops
the build; no pinned version builds the image without it (import off).
The runtime adds the system libraries Qt needs (`libgl1 libegl1
libfontconfig1 libfreetype6 libglib2.0-0 libdbus-1-3 libxkbcommon0`).
`compat.json › importServer.minimum` is the oldest converter the server
runs (`CONVERTER_MINIMUM` in `compat.ts`).
