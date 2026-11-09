import type { ColorSpec } from '@cld/model';
import type { XmlBuilder } from './xml.js';
import { formatBool, parseBool } from './format.js';

/**
 * Read a color block (a wrapper element containing
 *   <IsKnownColor>bool</IsKnownColor>
 *   <Name>string</Name>
 * ).
 *
 * The wrapper element name varies (`<BackgroundColor>`, `<hullColor>`,
 * `<GridColor>`, ...), so this works on the *parsed* sub-object.
 */
export function readColorSpec(node: Record<string, unknown> | undefined): ColorSpec {
  if (!node) throw new Error('missing color element');
  const known = parseBool(stringField(node, 'IsKnownColor'));
  const name = stringField(node, 'Name');
  return known ? { kind: 'known', name } : { kind: 'argb', argb: argbFromName(name) };
}

const HEX = /^[0-9a-f]{1,8}$/i;

/**
 * BlueBrick writes an unnamed color as .NET's Color.Name: lowercase hex
 * without leading zeros ("0" is clear black, "5ff0000" a nearly clear red).
 * The editor keeps every argb as 8 digits (a shorter one would read as an
 * opaque RGB), so the leading zeros come back here.
 */
function argbFromName(name: string): string {
  return HEX.test(name) ? name.toLowerCase().padStart(8, '0') : name;
}

/** Color.Name for an argb: what vanilla writes, so the bytes match it. */
function nameFromArgb(argb: string): string {
  return HEX.test(argb) ? Number.parseInt(argb, 16).toString(16) : argb;
}

/**
 * Emit a color block. Caller has already opened the wrapper element.
 */
export function writeColorSpec(b: XmlBuilder, color: ColorSpec): void {
  if (color.kind === 'known') {
    b.textElement('IsKnownColor', formatBool(true));
    b.textElement('Name', color.name);
  } else {
    b.textElement('IsKnownColor', formatBool(false));
    b.textElement('Name', nameFromArgb(color.argb));
  }
}

/** Extract a string field from a parsed XML node. Trims, asserts presence. */
function stringField(node: Record<string, unknown>, key: string): string {
  const v = node[key];
  if (v === undefined || v === null) throw new Error(`missing field: ${key}`);
  return String(v);
}
