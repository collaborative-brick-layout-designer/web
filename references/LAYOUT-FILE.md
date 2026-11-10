# The layout file (`.bld-layout`)

Collaborative Brick Layout Designer saves a layout as a single `.bld-layout` file. Both the
desktop and the web app read and write it. A BlueBrick `.bbm` is still
available as an export (File › Export as BlueBrick Map), and it keeps only
what BlueBrick supports.

## Container

A `.bld-layout` file is a plain ZIP archive (PKZIP 2.0: no ZIP64 and no
encryption). Entry names are UTF-8. Each entry is either stored or deflated.
Readers must accept both, and must ignore entries they don't know.

| Entry | Required | Contents |
|---|---|---|
| `manifest.json` | yes | `{"format":"bld-layout","version":1,"generator":"…"}`. Writers put it first and store it uncompressed. |
| `layout.bbm` | yes | The map exactly as a `.bbm` file holds it (desktop docs/bbm-schema.md). |
| `sidecar.json` | no | Labels, modules, venue, background image, saved views and the budget. Same shape as the `.bbm.bld` sidecar (desktop docs/bbm-bld-schema.md), with two differences listed below. Left out when the layout has none of these. |
| `background.<ext>` | no | The background image's bytes, named by `sidecar.json`'s `backgroundImage.file`. |
| `parts/<file>` | no | The parts the layout uses that aren't in the bundled BlueBrick library. Each is a `<PartNumber>.<Color>.xml` (`.set.xml` for a set) with the sprites beside it (`.png`, `.gif`, `.jpg`). Sets bring their subparts too. |

`sidecar.json` differs from a `.bbm.bld` sidecar in two ways:

- It has no `bbmHashSha256`. The layout is in the same file, so it can't drift.
- In `backgroundImage`, `file` (the entry name) replaces `path`, a location on
  one machine. Only a writer that couldn't read the image keeps `path`, and it
  warns that it did.

## Budget

`sidecar.json` (and the `.bbm.bld` sidecar) carries the layout's budget, how
many of each part the layout may use, as `budgetLimits`:

```json
"budgetLimits": { "3001.1": 12, "3005.4": 0 }
```

- Part number → a whole number of 0 or more. 0 means none of that part. A
  part without an entry is unlimited or forbidden by the reader's
  preference, as in BlueBrick.
- Present, even as `{}`, when the layout has a budget; absent when it has
  none. The budget is shared with everyone who edits the layout.
- In the live doc it is a Y.Map at `meta.budgetLimits` (part number →
  limit), not part of `meta.cache`, so two people changing different rows
  merge. A sidecar coming in (upload, `.bld-layout`) lands there, and the
  sidecar going out carries it.
- A BlueBrick `.bbb` file is the same list in XML; both apps import and
  export it.

## Saved views

`sidecar.json` (and the `.bbm.bld` sidecar, and the live doc's `meta.cache`)
may hold `views`, a list of saved views in the order the Views panel shows
them. Each view is a named picture of the layout:

```json
{
  "id": "view-station",
  "name": "Station",
  "fit": false,
  "rect": { "x": 90, "y": 40, "w": 40, "h": 30 },
  "sheets": ["sheet-town"],
  "grid": false,
  "labels": false
}
```

| Field | Meaning |
|---|---|
| `id` | Unique in the layout. A view without one is dropped on reading. |
| `name` | Shown in the list and used in picture file names. |
| `fit` | `true` (the default for a new view): fit the whole layout, worked out each time a picture is made (below); `rect` is ignored and written as `null`. `false`: use `rect`. A reader treats a view with no usable `rect` as `fit`. |
| `rect` | The area in studs (`x`, `y` = top left, `w`, `h`), or `null`. Readers also accept `[x, y, w, h]`. |
| `sheets` | Layer ids shown, or `null`. `null` follows the layout's own sheet on/off. A list shows exactly those sheets, whatever their own on/off. The grid layer is not a sheet here. |
| `grid` | Draw the grid (the drawn grid layer's lines) under the picture. Missing means `true`. |
| `labels` | Show the anchored labels. Missing means `true`. |

Unknown fields of a view, and unknown sidecar keys, are kept when a file is
read and written again.

**Fit the whole layout.** The area is the bounding box of what's drawn on
the view's shown sheets: bricks, text cells, rulers and painted area cells,
plus the World, Group and Module labels when `labels` is on. The room
(venue) and the background image don't count. The box is then grown by
**4 studs** on every side. A view with nothing to show makes no picture.

**Pictures.** One picture covers the view's area at 8 px per stud times a
scale (Small 1×, Medium 2×, Large 4× on the web), rounded to whole pixels.
Picture files are named `<layout title> - <view name>.png`, both parts made
safe as file names; "Export all views" writes one per view (on the web, in
`<layout title> - views.zip`). With no saved views it makes one
"Whole layout" picture (fit, all sheets, no grid, labels on).

**Live layouts.** Views live in `meta.cache.views`. An edit replaces one
whole view; the last edit of a view wins. The server's three-way compare
(`apps/server/src/sync/compare.ts`) reports each changed view as a
`view:<id>` item, like `label:<id>` and `module:<id>`.

## Parts

`parts/` names are plain file names: no folders, no leading dot, and one of
the part extensions. Readers skip any other name and warn.

- **Desktop, saving.** The desktop carries every part it uses from outside
  its bundled library: imported parts, your own folders and server parts.
- **Desktop, opening.** It writes the parts its library lacks to
  `layout-parts/` in its app data folder, which joins the library paths.
  Where it already has a part of that number with different XML, it shows
  both before the map loads (Parts That Differ): Keep mine, Use the layout's
  (its own is backed up to `replaced-parts/<time>/` first), or Keep both.
- **Web, downloading.** The web carries the custom parts the layout uses
  (bundled parts win over a custom part of the same key, as in the editor).
- **Web, opening.** It uploads the parts the server's catalog lacks as your
  custom parts, or the organisation's when the layout is created for one.
  That happens before the layout is created, so the layout opens with them.
  A part needs a `.png` or `.gif` sprite to become a custom part.
- **A part that differs.** Where the server already has a custom part of that
  number and its XML differs from the file's (trimmed text compared), both
  apps show the two side by side (sprite, description, author) and ask, per
  part:
  - **Keep the server's / mine** (the default). The layout uses it as it is.
  - **Use the file's / the layout's.** The part is replaced: on the web by
    `PUT /api/custom-parts/:id`, which needs editor role on the part.
  - **Keep both.** The file's is added under the next free number,
    `<PartNumber>-2.<Color>` (then `-3` and on, counting the catalog and the
    file's own parts, a set's being `.set.xml`), and the opened layout's
    bricks and groups of that part switch to it.

  What happened goes in the opened layout's status notes. Bundled parts
  can't be replaced from the web: one that differs is kept and named in
  the notes.

## Versions

`version` is 1. A reader opens a file with a higher version but warns that
anything it doesn't understand is left out. A reader refuses a file whose
`manifest.json` is missing or has a different `format`.

## Opening and saving

**Desktop**
- **Opening.** The desktop unpacks the background image into its app data
  folder (`layout-assets/<sha256>.<ext>`) and points the layout at that file.
- **Saving.** New layouts save as `.bld-layout`. Saving a layout that was
  opened from a `.bbm` (or another map format) asks once whether to switch to
  `.bld-layout` or keep the old format.
- **Autosave.** Autosave writes a `.bld-layout`.

**Web**
- **Downloading.** Map › Download Layout (and Save while offline) builds the
  file in the browser. It fetches the background image from the server and
  puts it in the file (`apps/web/src/layoutFile.ts`).
- **Opening.** A `.bld-layout` opens by drop or from the New layout dialog.
  The image goes to the server with the layout (`POST /api/layouts` takes
  `backgroundImage: {type, data}`, base64), and the server points the sidecar
  at it as if it had been uploaded.

## Fixtures

Both fixtures are in the web repository (`packages/bbm/tests/fixtures/`) and
the desktop repository (`fixtures/layouts/`), and both apps' tests read both:

- **`corner-lobby.bld-layout`**, made by the desktop. It holds
  `tight-corner.bbm`, a label, a module, the Grand Lobby venue and a 4×4
  background image.
- **`web-made.bld-layout`**, the same layout opened by the web app and
  downloaded again.
- **`views.bld-layout`**, made by the web (`apps/web/src/test/viewsFixture.test.ts`,
  `BLD_UPDATE_FIXTURES=1`). Two brick sheets, `sheet-track` "Track" (bricks
  at (0,0)–(64,8)) and `sheet-town` "Town" (a brick at (100,50)–(120,60)),
  a World label at (70,−20), and two views: `view-whole` "Whole layout"
  (fit, all sheets, grid on, labels on) and `view-station` "Station" (the
  area x 90, y 40, w 40, h 30, only `sheet-town`, no grid, no labels). Both
  apps must read the two views back unchanged, and work out the fit area of
  `view-whole` as x −4, y −24, w 128, h 88 (and `view-station`, if switched
  to fit, as x 96, y 46, w 28, h 18).
- **`with-parts.bld-layout`**, made by the desktop. It holds one brick of
  `CLDTEST.1`, a part the file carries. The web's e2e opens it and gets
  `CLDTEST.1` as a custom part. Another e2e first uploads a different
  `CLDTEST.1`, answers Keep both, and gets the layout on `CLDTEST-2.1`.
