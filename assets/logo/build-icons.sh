#!/usr/bin/env bash
# Renders every logo and icon file the web app ships from logo.svg, the one
# source: a 32 x 32 viewBox on a 4-unit stud grid, so brick edges land on
# whole pixels at 16, 24, 32, 48 px and every larger multiple of 16.
# Needs rsvg-convert (librsvg) and magick (ImageMagick 7).
# Usage: assets/logo/build-icons.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
pub="$root/apps/web/public"
src="$here/logo.svg"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

tile='<rect width="32" height="32" rx="7" fill="#1E3A5F"/>'
grep -qF "$tile" "$src" || { echo "logo.svg: expected the navy tile $tile" >&2; exit 1; }
# Platform variants, same artwork:
# - full bleed: the navy square without rounded corners (iOS rounds it itself);
sed 's/ rx="7"//' "$src" > "$tmp/fullbleed.svg"
# - maskable: full bleed, the bricks scaled by 3/4 about the center so their
#   farthest corners sit inside the 40 % radius safe circle. Edges on the
#   4-unit grid move to multiples of 3 units, still whole pixels at 192/512.
sed -E 's#^(<svg[^>]*>)<rect width="32" height="32" rx="7" (fill="[^"]+"/>)(.*)</svg>$#\1<rect width="32" height="32" \2<g transform="translate(4 4) scale(.75)">\3</g></svg>#' \
  "$src" > "$tmp/maskable.svg"
grep -q 'scale(.75)' "$tmp/maskable.svg" || { echo "could not make the maskable variant" >&2; exit 1; }

png() { rsvg-convert -w "$2" -h "$2" "$1" -o "$3"; }

for s in 16 32 48; do png "$src" "$s" "$tmp/$s.png"; done
magick "$tmp/16.png" "$tmp/32.png" "$tmp/48.png" "$pub/favicon.ico"
\cp -f "$tmp/32.png" "$pub/favicon.png"
\cp -f "$src" "$pub/favicon.svg"
\cp -f "$src" "$pub/icon.svg"
png "$src" 256 "$pub/logo.png"
\cp -f "$pub/logo.png" "$root/logo.png"
png "$src" 192 "$pub/icon-192.png"
png "$src" 512 "$pub/icon-512.png"
png "$tmp/maskable.svg" 192 "$pub/icon-maskable-192.png"
png "$tmp/maskable.svg" 512 "$pub/icon-maskable-512.png"
png "$tmp/fullbleed.svg" 180 "$pub/apple-touch-icon.png"
echo "icons written to $pub and $root/logo.png"
