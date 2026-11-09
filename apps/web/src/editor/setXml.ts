// A set's XML: BlueBrick's `.set.xml`, a <group> of other parts with
// where each sits. Save selection as set writes one (the desktop's
// MainWindow::onSaveSelectionAsSet writes the same), and renaming a set
// changes only its English name (desktop saveload::renameSetXml), so the
// layouts that placed it keep working.

import { stripInvalidXmlChars } from '@cld/bbm/browser';
import type { Brick } from '@cld/model';
import type { PartWire } from '../api';

export interface SetSubpart {
  partKey: string;
  x: number;
  y: number;
  angle: number;
}

/**
 * The sub-parts of a set made from `picked`, around their middle. A custom
 * part goes by its number, as it does in a desktop's set and in a layout
 * file, not by the `custom:<id>` the website places it as.
 */
export function setSubparts(picked: readonly Brick[], index: ReadonlyMap<string, PartWire>): SetSubpart[] {
  if (picked.length === 0) return [];
  // The middle of the display-area centres (the hull-box centres for parts
  // without an explicit offset, which covers the standard parts).
  const centre = (b: Brick) => ({ x: b.displayArea.x + b.displayArea.width / 2, y: b.displayArea.y + b.displayArea.height / 2 });
  let sumX = 0;
  let sumY = 0;
  for (const b of picked) {
    const c = centre(b);
    sumX += c.x;
    sumY += c.y;
  }
  const cx = sumX / picked.length;
  const cy = sumY / picked.length;
  return picked.map((b) => {
    const part = index.get(b.partNumber.toLowerCase());
    const c = centre(b);
    return {
      partKey: part?.source === 'custom' ? part.partNumber : b.partNumber,
      x: c.x - cx,
      y: c.y - cy,
      angle: b.orientation,
    };
  });
}

export function buildSetXml(name: string, subparts: readonly SetSubpart[]): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push('<group>');
  lines.push(`\t<Author>Collaborative Brick Layout Designer</Author>`);
  lines.push(`\t<Description>`);
  lines.push(`\t\t<en>${escXml(name)}</en>`);
  lines.push(`\t</Description>`);
  lines.push(`\t<CanUngroup>true</CanUngroup>`);
  lines.push(`\t<SubPartList>`);
  for (const sp of subparts) {
    lines.push(`\t\t<SubPart id="${escXml(sp.partKey)}">`);
    lines.push(`\t\t\t<position>`);
    lines.push(`\t\t\t\t<x>${sp.x.toFixed(6)}</x>`);
    lines.push(`\t\t\t\t<y>${sp.y.toFixed(6)}</y>`);
    lines.push(`\t\t\t</position>`);
    lines.push(`\t\t\t<angle>${sp.angle.toFixed(4)}</angle>`);
    lines.push(`\t\t</SubPart>`);
  }
  lines.push(`\t</SubPartList>`);
  lines.push('</group>');
  return lines.join('\n') + '\n';
}

/**
 * `xml` with its English name set to `name`: the `<en>` in its
 * `<Description>` replaced, or added when there is none. Everything else,
 * other languages included, stays as it was.
 */
export function renameSetXml(xml: string, name: string): string {
  const en = `<en>${escXml(name)}</en>`;
  const desc = /<Description>([\s\S]*?)<\/Description>/.exec(xml);
  if (desc) {
    const inner = desc[1]!;
    const next = /<en>[\s\S]*?<\/en>/.test(inner) ? inner.replace(/<en>[\s\S]*?<\/en>/, () => en) : `${en}${inner}`;
    return xml.slice(0, desc.index) + `<Description>${next}</Description>` + xml.slice(desc.index + desc[0].length);
  }
  if (/<Description\s*\/>/.test(xml)) return xml.replace(/<Description\s*\/>/, () => `<Description>${en}</Description>`);
  return xml.replace(/<group(\s[^>]*)?>/, (open) => `${open}<Description>${en}</Description>`);
}

/**
 * The part number a set named `name` is saved under: the name with the
 * characters a file name can't hold swapped out, as the desktop names its
 * `<name>.set.xml` (whose part number is the name without `.set.xml`).
 */
export function setPartNumber(name: string): string {
  // Control characters are what we're stripping out here.
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  safe = safe.replace(/^[. ]+|[. ]+$/g, '') || 'Set';
  return safe.replace(/\.set$/i, '') || 'Set';
}

/**
 * The part inside a set that the set's number `partNumber` would clash
 * with, or null. Placing such a set would find the set itself for that
 * part, nesting copies of itself, so the name is refused.
 */
export function partNamedLikeSet(partNumber: string, subparts: readonly Pick<SetSubpart, 'partKey'>[]): string | null {
  const own = partNumber.toLowerCase();
  return subparts.find((sp) => sp.partKey.toLowerCase() === own)?.partKey ?? null;
}

// Characters XML 1.0 doesn't allow (a pasted name with one made a file
// BlueBrick won't open) are cleaned as @cld/bbm's writer and the desktop do.
function escXml(s: string): string {
  return stripInvalidXmlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
