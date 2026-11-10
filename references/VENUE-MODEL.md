# Venue model

A venue is the room a layout goes in. The web editor and the desktop app share this model. It appears in three places:

- `.bld-venue` files, tagged `"schema": "bld-venue/1"`;
- the `venue` field of a layout's sidecar (`.bbm.bld`, or `meta.cache` in a live layout);
- the server's venue library (`/api/venues`), stored without the `schema` tag.

Both apps must read and write every field below the same way. `packages/bbm/tests/fixtures/grand-lobby.bld-venue` (the desktop repo has the same file at `fixtures/venues/grand-lobby.bld-venue`) is the shared test: each app reads it, writes it back, and must get the same JSON.

## Coordinates

- Coordinates are in **studs** (1 stud = 8 mm, so 1 ft ≈ 38.098 studs).
- **x** grows to the east and **y** to the south, as on the map.
- Angles are in degrees, clockwise from east. So 90 is south and 270 is north.

## Fields

| Field | Type | Written |
|---|---|---|
| `name` | string | always |
| `enabled` | bool: whether to draw it and check against it | always |
| `minWalkwayStuds` | number | always |
| `bounds` | `{x, y, w, h}`, the reserved layout area (all 0 when none) | always |
| `edges[]` | the outline, as `{kind, doorWidthStuds, label, poly[]}`. `kind` is 0 for a wall, 1 for a door, 2 for an opening | always |
| `edges[].estimated` | `true` when the edge is not measured yet | only when true |
| `obstacles[]` | `{label, poly[]}`, a closed polygon | always |
| `obstacles[].kind` | `column`, `stairs`, `elevator`, `counter` or `railing` | only when set; absent means "other" |
| `obstacles[].upDegrees` | stairs: the direction of going up | only when set |
| `power[]` | `{x, y, kind: "wall" \| "floor", label?, amps?, volts?}` | only when there is at least one |
| `notes[]` | `{x, y, text, estimated?}` | only when there is at least one |
| `dimensions[]` | `{from{x,y}, to{x,y}, label?, estimated?}`, drawn as a dimension line | only when there is at least one |
| `lengthUnit` | `"m"` or `"studs"`: the unit the venue's lengths are shown in (the Venue Designer's Units pick). Both apps show wall lengths in it wherever the venue is drawn: the designer, the layout editor and the public page. Stored lengths stay in studs | only when not feet and inches; absent, or a value an app doesn't know, means feet and inches |
| `floorPlan` | `{image, x, y, studsPerPx, opacity}`: the floor-plan image traced in the Venue Designer. `image` is a `data:image/…` URL, downscaled to at most 2400 px. `x`, `y` place its top-left corner. `studsPerPx` comes from calibration, and `opacity` is 0–1 | only when there is one; drawn only in the designer |

Rules for optional fields:

- `label` is written only when it is not empty.
- `amps` and `volts` are written only when above 0.
- `estimated` is written only when true.
- An `obstacles[].kind` this build doesn't know reads as "other".

## Unknown fields

A field an app doesn't know, at any level, is kept when the venue is read and written again. This way an older build doesn't lose what a newer one added.

## Drawing

Both apps draw the venue the same way. The web's `editor/render/venueDraw.ts` and the desktop's `rendering/VenueDraw.cpp` compute the same geometry, and each has a test checking the same numbers. Sizes are in studs unless given in px. Line widths in px stay the same at every zoom.

**Outline edges**
- Walls, doors and openings keep their existing pens.
- An estimated edge is drawn at 45% opacity, and its label ends in " (est.)".

**Obstacles**

| Kind | Fill | Outline | Extra marks |
|---|---|---|---|
| column | `rgba(60,60,60,0.75)` | `rgb(40,40,40)` 1 px | none |
| stairs | `rgba(214,180,196,0.55)` | `rgb(120,80,100)` 1 px | treads and an arrow (below) |
| elevator | `rgba(150,150,170,0.45)` | `rgb(70,70,90)` 1 px | both diagonals of the bounding box |
| counter | `rgba(170,125,70,0.45)` | `rgb(110,80,40)` 1 px | none |
| railing | no fill | `rgb(40,40,40)` 3 px | none |
| other | `rgba(120,120,120,0.4)` | `rgb(90,90,90)` 1 px | none |

Stairs with an `upDegrees` also get:
- **Treads:** lines across the stairs, perpendicular to the way up, every 10 studs.
- **Arrow:** runs from 15% to 85% of the way up, along the middle of the stairs. Its head strokes are `min(20% of the length, 30% of the width)` long, going back and ±0.6 of that sideways.

**Power points**
- A circle with a radius of 6 studs, outlined in `rgb(220,100,20)` 2 px.
- Floor outlets are filled in that color; wall outlets are filled white.
- The label "label · N A · N V" goes to the right, leaving out empty parts.

**Notes**
- The text sits at the note's position.
- Estimated notes are italic and grey (`rgb(120,120,120)`), and end in " (est.)".

**Measurements**
- A line between the two points, with end ticks 5 studs to each side of the line, in `rgb(40,90,140)` 1.5 px.
- The label is centred 8 studs to the line's left (above a left-to-right line) and turned to read left to right.
- Estimated measurements are dashed and grey, and their labels end in " (est.)".
## Venue Designer

Both apps open the venue in the same full-screen editor, with the same tools and rules. On the web the tools live in `venues/designer/`, and `designerState.ts` holds each tool's clicks, typed sizes, Enter and Esc. The desktop has the same in `src/venue/`.

**Tools, with their keys:** Select V, Wall W, Room R, Door D, Opening O, Column C, Stairs S, Elevator E, Counter K, Railing L, Power P, Note N, Measure M.

**Typed lengths** can be written as `12'6"`, `40′ 4″`, `12ft 6in`, `6 1/2"`, `3.2m` or `80 studs`. A bare number is inches in feet-and-inches mode.
- A two-corner tool takes a size such as `40' x 20'`.
- Lengths are shown to the quarter inch.

**Snapping** goes, in order of priority:
1. to a corner within 8 px;
2. to 45° steps from the last point (Shift turns this off);
3. onto a wall;
4. to whole inches.

**Editing with Select**
- Moves go in whole inches.
- Dragging a corner of the outline moves every wall that meets there.
- Each drag is one undo step.

**Doors and openings** are cut into a wall. The wall is split into the part before, the door or opening, and the part after, and both wall parts keep its label and estimated flag.

**Rooms** become four walls, one per side, labelled north, east, south and west. They are ordered clockwise from the north-west corner.

**Power** placed on a wall is a wall outlet; placed anywhere else, it is a floor outlet.

**Floor plan calibration:** click two points, then enter the real distance between them. The image is rescaled and the first point stays where it is.
