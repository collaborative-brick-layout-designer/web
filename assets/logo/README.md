# The logo

`logo.svg` is the one source for the logo and every icon: a top-down view of
a blue 2×4 and a red 2×4 meeting at a corner, with a yellow 2×2 joining them,
on a navy rounded tile. It's a 32 × 32 viewBox on a 4-unit stud grid, with
round studs and no shadows, so brick edges land on whole pixels at 16, 32,
48 px and every larger multiple of 16. Edit it by hand.

## Rebuilding the icons

```sh
assets/logo/build-icons.sh
```

It needs `rsvg-convert` (librsvg) and `magick` (ImageMagick 7), and rewrites
everything in `apps/web/public` that is a logo or icon, plus the repository's
`logo.png`:

| File | From |
| --- | --- |
| `favicon.svg`, `icon.svg` | `logo.svg` as is |
| `favicon.ico` (16, 32, 48), `favicon.png` (32) | `logo.svg` |
| `logo.png` (256), `icon-192.png`, `icon-512.png` | `logo.svg` |
| `apple-touch-icon.png` (180) | full bleed: the navy square without rounded corners, since iOS rounds it |
| `icon-maskable-192.png`, `icon-maskable-512.png` | full bleed, the bricks scaled by 3/4 to sit inside the safe zone |

`apps/web/src/pwa/test/icons.test.ts` checks that every icon is the size the
manifest and `index.html` claim, and that the SVG icons are this file.
