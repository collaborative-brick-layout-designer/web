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
| `POST /api/imports` | **multipart**, one part `file` (the model, filename with its extension), no other fields | 202 job; 415 `unsupported_type`; 413 `file_too_large`; 429 `import_rate_limited` (Retry-After) or `too_many_open_imports`; 409 `import_unavailable` (import off here, with `reason` and `message`); 415 `not_multipart`; 403 for the demo account |
| `GET /api/imports/:id` | | the job: `{ id, fileName, state, step, position, error, analysis, result }` |
| `GET /api/imports/:id/preview.png` | | the preview picture (PNG), while the job is `ready` |
| `POST /api/imports/:id/convert` | `{ mode: "part"\|"parts", quarterTurns, align: ""\|"bottom"\|"box", nudge: [x, y], drop: [indices], name, designer, designerUrl, category, target }` with `target` `{ kind: "new", title?, orgSlug? }`, `{ kind: "layout", layoutId, sheetId?, at?: { x, y }, clientPlaces?: true }` or `{ kind: "library", orgSlug? }` (mode `"part"` only) | 202 job; 400 `invalid_target`; 403 / 404 as Upload part for a club the person can't add parts to |
| `DELETE /api/imports/:id` | | 204: cancelled, its files deleted |
| `POST /api/imports/client` | JSON (up to 96 MB): what the browser's importer made. Mode `"part"`: `{ partKey, displayName, xmlBase64, spriteBase64 (PNG), widthStuds, heightStuds, category, connections?, stats?, warnings?, target }`; mode `"parts"`: `{ bbm (the .bbm's text), title?, sheets?, stats?, warnings?, target }` | 200 with the same `result` a job ends with; 400 `invalid_mode` / `invalid_target` / `missing_files` / `invalid_size`; 422 `damaged_layout`; the part's own checks as Upload part; 409 `import_unavailable` when import is off; 403 for the demo account |
| `GET /api/import-library` | | `{ enabled, ldraw: version \| null, studio: version \| null }` |
| `GET /api/import-library/:lib/:version/file?name=…` | | one LDraw part file as text, looked up in the desktop's search order; 204 when there's none |
| `POST /api/import-library/:lib/:version/files` | `{ names: string[] }` (1 to 256) | `{ version, files: { [name]: text \| null }, more: [names that didn't fit in 16 MB] }` |
| `GET /api/import-library/:lib/:version/ldconfig` | | LDConfig.ldr |
| `GET /api/import-library/:lib/:version/moved` | | `{ [newName]: [earlier names] }` from the `0 ~Moved to` stubs |
| `GET /api/import-library/ldd/:version/geometry?id=<designID>` | | one LDD brick's shape (binary); 204 when there's none |
| `POST /api/import-library/ldd/:version/geometry` | `{ ids: [designID] }` (1 to 256, digits) | `{ version, files: { [id]: base64 \| null }, more }` |
| `GET /api/import-library/ldd/:version/materials` | | LDD's Materials.xml |
| `GET /api/import-library/ldd-mapping/:version/ldraw-xml` | | the LDD → LDraw mapping |
| `GET /api/admin/imports` | | converter, libraries, settings, queue (site admins) |
| `PATCH /api/admin/imports` | `{ enabled?: boolean, serverBackup?: boolean, limits?: { maxUploadMb?, perHour?, perUserAtOnce?, atOnce?, timeoutSeconds?, memoryMb? } }` | the same view |
| `POST /api/admin/imports/ldraw/download` | none | downloads `https://library.ldraw.org/library/updates/complete.zip` |
| `DELETE /api/admin/imports/ldraw` | | |
| `POST /api/admin/imports/ldd/assets` | **multipart** `file`: LDD's `Assets.lif` (up to 1.5 GB) | 422 if it isn't a LIF archive |
| `DELETE /api/admin/imports/ldd/assets` | | |
| `POST /api/admin/imports/ldd/mapping` | **multipart** `file`: an `ldraw.xml` (or lxf2ldr's `ldraw.xml.p`), up to 32 MB | |
| `POST /api/admin/imports/ldd/mapping/community` | none | fetches lxf2ldr's `ldraw.xml.p` (GPL-3) from gitlab.com |
| `DELETE /api/admin/imports/ldd/mapping` | | |
| `POST /api/admin/imports/studio` | **multipart** `file`: a zip of Studio's `ldraw` folder, up to 1 GB | |
| `DELETE /api/admin/imports/studio` | | |

Admin library routes answer 422 (`library_failed`, `not_that_kind_of_file`) when a download or file doesn't work out, 409 (`forced_by_env`) when an env var names that library, 413 when a file is too big. No import route answers 5xx.

Every route is in the security route probes
(`apps/server/src/security/routeProbes.test.ts`). The upload routes'
JSON body limit stays at the server's 10 MB; their multipart file limit is
the route's own (above). A WAF in front must let these multipart bodies
through at those sizes.

## Where it goes

The convert body's `target` (`apps/server/src/imports/apply.ts`):

- **`new`**: a new layout, made on the server (Home, a dropped file: no
  layout is open, so there's nothing to undo).
- **`layout` with `clientPlaces: true`**: the layout open in the editor.
  The server makes the custom part (mode `part`) and answers with the parts
  to put down in the job's `result.toPlace` (`{ bricks, groups }`, as the
  .bbm or the new part has them). The editor puts them down itself
  (`apps/web/src/import/placeImport.ts`) in one transaction with its own
  origin, so **one Undo takes the whole import back and Redo brings it
  back**, and everyone in the layout gets it through the editor's sync. The
  editor deletes the job once it has placed them.
- **`library`** (mode `part` only): the part is saved to the person, or to
  the club `orgSlug` names (the same checks as Upload part: a member whose
  roles add parts there, checked before the converter runs). Nothing is
  placed and no layout is made: Home's Custom parts and the Parts panel's
  "Import from a model file", and Upload part's link to it. From the Parts
  panel, "Save and place it here" saves it this way and then the editor
  places it as above (undoable).
- **Deprecated:** `layout` without `clientPlaces` still places the parts as
  the server's change in the layout's room, outside anyone's undo, for an
  editor page loaded before 2026-11-19. Remove it in the release after.

The part's owner for `layout` is the layout's club when the person may add
parts there, else the person; for `new`, `orgSlug`'s club likewise.

## The preview

`apps/web/src/import/ImportDialog.tsx` takes about 90% of the window (all of
a phone's): the picture fills the room, the choices sit in a column beside it
(under it on a narrow screen). `PreviewCanvas.tsx` and `previewView.ts` zoom
and pan it as the desktop's `ImportPreviewDialog` does: fitted until you zoom,
the wheel or a trackpad pinch zooms towards the pointer, a drag pans, two
fingers pinch on a touch screen, and −, +, Fit and 100% (one picture pixel to
one screen pixel) sit above it, between 5% and 3200%. Only the picture is
scaled; the stud grid, the part's middle and the connection points are drawn
in screen pixels, so they stay sharp. The view is held in the picture's own
studs, so a nudge keeps the zoom and slides the grid under the model. The
arrow keys over the picture nudge it, as the desktop's do.

## As an engine or car

Trains › Rolling stock › **Import a model…** (trains design Phase 6;
the desktop's Trains panel has the same) opens this dialog with
`purpose: 'stock'`. The model becomes a custom part as above (category
"Rolling stock"), and an engine or car drawn with it:

- **Truck guess.** While drawing it, the browser's importer looks at the
  model's parts from above (`client/stockGuess.ts`, the shared
  `guessStock` in `packages/parts-catalog/src/track/stockGuess.ts`): bogie
  plates and train motors are the trucks' pivots, else clusters of wheel
  parts, else a quarter of the length in from each end; the outermost
  magnet couplers give the length. The part table and vectors on three
  LDraw OMR models are the shared contract
  `fixtures/contracts/truck-guess.json`. The analysis carries it as
  `part.stock`; the server's converter doesn't, so after a fallback the
  guess is from the footprint alone.
- **The preview** turns the model to run front to the right (the guess's
  quarter turn) and shows it with a marker on each truck and coupler
  (`StockSetup.tsx`): drag one, or type its number, and **Turn around**
  when the other end is the front. Lining up and snap points aren't
  offered: a car isn't track.
- **Add to rolling stock** makes the part, then the record in the open
  layout (`look.mode` `model`, `look.partKey` `custom:<id>`, `model: {
  partKey, file, format, importedAt }`), optionally on the roster of
  whoever the part was saved to; the roster's `model_part_id` names the
  part. A `.bld-layout` carries the part in `parts/`, and the server's
  downloads name it by its part number.

## In the browser

The browser's own importer reads and draws LDraw (`.ldr`, `.mpd`, `.dat`),
BrickLink Studio (`.io`) and LDD (`.lxf`, `.lxfml`) models itself, in a Web
Worker, so the server only hands it library files and saves the result. The
server's converter reads a model the browser can't manage, while Admin ›
Model import › **Server import as a backup** is on (the default;
`IMPORTS_SERVER_BACKUP` forces it, and the page says so). Off, the server
reads nothing (`/api/imports/status` says `reason: "backup_off"`, uploads to
`POST /api/imports` are refused) and such a model isn't imported: the dialog
says so in a line.

**LDD files** (`lddReader.ts`, `lddMapping.ts`, `lddGeom.ts`,
`lddSource.ts`): the desktop's readLDD, LDDLDrawMapping, readLDDGeom and
LDDMeshBuilder. As the desktop's prepareImport: with LDD's brick database on
the site, every brick is drawn from LDD's own shape (`Primitives/LOD0/<designID>.g`,
painted from `Materials.xml`), and the model is placed as LDraw parts through
`ldraw.xml` (its built-in train track even without one) only to find where
track snaps on, each part's real centre checked against the LDraw library
when there is one. Without the database, the LDraw model `ldraw.xml` makes of
it is drawn from the LDraw library; without either, only the server can
compose it from BlueBrick's sprites, so it goes to the server.

**LDD's database on the server** (`apps/server/src/imports/lddFiles.ts`): the
table of contents of the uploaded `Assets.lif` (and the `db.lif` nested in
it) is read once per install (11,394 entries in 9 ms for LDD 4.3) into an
index of entry → offset and size; each brick is one seek and one read. A
request names a design ID (digits only), never a path: the shape of that
brick, or `Materials.xml`. Never the file, never a listing (Aaron,
2026-11-19: one brick at a time to signed-in people).

**Studio files** (`studioReader.ts`, `zip.ts`): the desktop's readStudioIo and
SafeZip. An `.io` is a ZIP; Studio 2.1 and later encrypt every entry with
ZipCrypto under Studio's published password (tried, then an empty one). The
reader inflates with the browser's own `DecompressionStream` (never past the
size an entry claims), checks every CRC, keeps the desktop's limits (128 MB
model, 64 MB a custom part, 512 MB and 5000 of them in all) and words every
refusal as the desktop does (AES, an unknown password, damage, too big). It
takes `model.ldr` (else another `.ldr`, `model2.ldr` last, never
`modelv1.ldr`); `CustomParts/*.dat` with plain names become the model's own
parts, found before the site's library and never fetched from it. A Studio
file is drawn from Studio's own library when the site has one (the status's
`browser.studio`), else the LDraw library, as the desktop does.

**The library files** (`apps/server/src/imports/libraryFiles.ts`,
`apps/server/src/routes/importLibraries.ts`), for signed-in people while
import is on:

- `:lib` is `ldraw` or `studio`. `:version` is the library install's id: a
  hash of its path, install time, LDConfig's release line and file time.
  `GET /api/import-library` gives the current one; an update changes it.
- A name is looked up the way the desktop's `LDrawLibrary::resolve` does:
  any case, a folder hint (`s/`, `48/`) first, then `parts`, `p`, `p/48`,
  `p/8`, `parts/s`, the same under `Unofficial/`, then the root. Each folder
  is indexed once (lower-case names). The name only picks an index entry:
  `..`, absolute paths, more than two folders, characters outside LDraw's,
  and anything but `.dat`/`.ldr` are refused (400), and a folder hint must
  be plain letters and digits that stay inside the library.
- Files over 8 MB aren't served. A batch answers at most 16 MB and lists
  the rest in `more`, for the next batch.
- Answers under the current version are `private, max-age=31536000,
  immutable` with an ETag; under an older version they're still answered
  (a page open across an update keeps working) but `no-store`. A missing
  file is a 204 or a `null`, never a 4xx: the browser asks for names it
  can't know exist, and bursts of 4xx get people banned by the WAF.
- Never a listing and never a whole library. Rate limit: 600 a minute per
  person.

**The importer** (`apps/web/src/import/client/`) is a TypeScript port of the
desktop's converter, step for step, with the desktop file it follows named
at the top of each module: `ldrawReader.ts` (readLDraw, MPD flattening),
`library.ts` and `remoteSource.ts` (the files a model uses, fetched a round
at a time: the model's parts, then what they use; kept in Cache Storage
under their versioned URLs), `meshLoader.ts` and `bake.ts`
(LDrawMeshLoader, bakeMeshFromLDraw), `rasterize.ts` (rasterizeMeshTopDown
and baseLattice: 32 px a stud, 4× supersampled z-buffer, outlines,
see-through parts), `connections.ts` (toBlueBrickMap, externalConnections),
`prepare.ts` (prepareImport, the warnings, the suggested name),
`align.ts` (rotatePart, alignPart, finishPreview), `pickShape.ts`,
`partXml.ts` (the part XML as QXmlStreamWriter writes it), `convert.ts`, and
`layout.ts` (parts placed one by one: the shared `readLDrawMap` and
`writeBbm`). The 8 px/stud GIF isn't made: the site never kept it.

It runs in a Web Worker (`worker.ts`; the page's side is
`apps/web/src/import/browserImport.ts`): progress ("Fetching 213 parts…
120/213", "Drawing…"), and Cancel ends the worker at once. The dialog
(`ImportDialog.tsx`) uses it for the files the status's `browser` names,
when the browser has workers and off-screen canvases. When the browser
can't (no workers, the worker crashes or runs out of memory, the library
can't be reached), the server's converter takes over and the dialog says so
in a line ("Your browser couldn't read this one, so the server is reading it
instead."). A model's own problem (no part has geometry, parts that refer to
each other without end) is shown, not handed on: the server would say the
same. `canImport` (importApi.ts) opens the import for a file when either can.

**Parity with the converter** (`apps/web/src/import/client/test-node/`):
`importer.test.ts` runs in CI on a tiny library written for the tests
(`fixtures/minilib`, also the e2e stack's library). `parity.test.ts` runs
the real converter on the same files and compares, opt-in:

| Env var | |
|---|---|
| `BLD_IMPORT_SERVER` | `bld-import-server` (a release asset, with `plugins/imageformats/libqgif.so`: see below) |
| `BLD_LDRAW_LIBRARY` | library.ldraw.org's `complete.zip`, unpacked (without it only the tiny library is compared) |
| `BLD_PARTS_DIR` | BlueBrick parts (default: the repo's `parts-library/parts`) |
| `BLD_PARITY_MODELS` | more folders of `.ldr` / `.mpd` models, colon-separated |

Exact: the footprint, the model's bounds (±1e-6), whether its base is on the
grid, the snap margin, the connection points (±1e-4), the counts, the
warnings, the title, designer, suggested name and key; the part XML line for
line but for the date, the source path and time; the parts placed one by one
(part, place, size, angle, height, links). With tolerance: the picture is the
same size, its see-through masks (alpha > 127) overlap with an IoU of at
least 0.995, and where both show, colors differ by at most 2/255 on average;
the `<PickShape>` has as many rings covering the same area within 2% (Qt
simplifies the outline its own way). On the fixtures and the library's
models the pictures came out identical but for a level or two on a few
pixels, and 4 of 5 outlines point for point.
Studio files are compared the same way: the fixtures packed as Studio packs
them (ZipCrypto), and one with its own custom part on the tiny library.
LDD models (`BLD_LDD_ROOT`: a folder with LDD's `Assets.lif` and `ldraw.xml`)
are compared three ways each: from LDD's shapes, with and without the LDraw
library, and as the LDraw model `ldraw.xml` makes of them; the `.lxf` too.

The v2.1.11 converter bundle has no Qt image-format plugins, so it can't
read BlueBrick's GIF sprites: parts placed one by one get a 2 × 2 stud
placeholder size instead of their own (the 32 × 32 baseplate, say). The
browser's result is the desktop app's; compare against a bundle with
`plugins/imageformats/libqgif.so` added (all cases then match).

**The result** goes to `POST /api/imports/client` and is saved exactly as a
job's result is (`applyPartFiles` / `applyLayoutText` in `apply.ts`): the
custom part through `createCustomPart`'s checks and limits, a layout through
`readBbm` and the growth limits.

**WAF** (new in this release):

| Method | Path shape | Body |
|---|---|---|
| GET | `/api/import-library` | none |
| GET | `/api/import-library/(ldraw\|studio)/[0-9a-f]{16}/file?name=<part name>` | none |
| POST | `/api/import-library/(ldraw\|studio)/[0-9a-f]{16}/files` | JSON `{ "names": [...] }`, small (≤ 256 names) |
| GET | `/api/import-library/(ldraw\|studio)/[0-9a-f]{16}/ldconfig` | none |
| GET | `/api/import-library/(ldraw\|studio)/[0-9a-f]{16}/moved` | none |
| POST | `/api/imports/client` | JSON, up to 96 MB (base64 PNG and XML, or a .bbm's text) |
| GET | `/api/import-library/ldd/[0-9a-f]{16}/geometry?id=[0-9]{1,10}` | none |
| POST | `/api/import-library/ldd/[0-9a-f]{16}/geometry` | JSON `{ "ids": [...] }`, ≤ 256 design IDs |
| GET | `/api/import-library/ldd/[0-9a-f]{16}/materials` | none |
| GET | `/api/import-library/ldd-mapping/[0-9a-f]{16}/ldraw-xml` | none |

Part names hold `\` and `/` (`s\3001s01.dat`), so the `name` query
carries `%5C` / `%2F`; that is expected, not traversal.

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
The runtime adds the system libraries Qt needs (`libfontconfig1
libfreetype6 libglib2.0-0 libdbus-1-3 libxkbcommon0 libx11-6`; the bundle brings
libglvnd's GL dispatch libraries itself, so no Mesa).
`compat.json › importServer.minimum` is the oldest converter the server
runs (`CONVERTER_MINIMUM` in `compat.ts`).
