// The imported part's XML: the desktop's writeImportedModelAsLibraryPart
// (src/import/ImportToPart.cpp), as QXmlStreamWriter writes it with
// auto-formatting (two spaces): Author, Description, PixelsPerStud,
// ImportedFrom, Designer, ImportSource, ConnexionList, PickShape, SnapMargin.

import type { ImportedConnection } from './connections';
import type { Margins } from './rasterize';

export interface PartXmlInput {
  author: string;
  /** What was typed in the preview; the file name without its extension when empty. */
  displayName: string;
  sourceFile: string;
  format: 'ldraw' | 'studio' | 'ldd';
  /** The model file's own time (File.lastModified), ms; omitted when unknown. */
  sourceModified: number | null;
  /** YYYY-MM-DD, the day it's made. */
  date: string;
  pxPerStud: number;
  quarterTurns: number;
  align: '' | 'bottom' | 'box';
  nudge: { x: number; y: number };
  droppedConnections: { x: number; y: number }[];
  designer: string;
  designerUrl: string;
  connections: ImportedConnection[];
  pickShape: { x: number; y: number }[][];
  snapMargin: Margins;
}

// eslint-disable-next-line no-control-regex
const INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

/** QXmlStreamWriter's text escaping. */
function text(s: string): string {
  return s.replace(INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** QXmlStreamWriter's attribute escaping. */
function attr(s: string): string {
  return text(s).replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');
}

/** QString::number(v, 'f', digits). */
export function fixed(v: number, digits: number): string {
  const s = v.toFixed(digits);
  // Qt writes "-0.0000" for a negative zero or a tiny negative number, as printf does.
  return (Object.is(v, -0) || (v < 0 && /^0\.?0*$/.test(s))) && !s.startsWith('-') ? `-${s}` : s;
}

/** QString::number(v, 'g', 6): printf's %g. */
export function g6(v: number): string {
  if (v === 0) return Object.is(v, -0) ? '-0' : '0';
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
  const exp = Math.floor(Math.log10(Math.abs(Number(v.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const [m, e] = v.toExponential(5).split('e');
    const mant = m!.includes('.') ? m!.replace(/0+$/, '').replace(/\.$/, '') : m!;
    const n = Number(e);
    return `${mant}e${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
  }
  const s = v.toFixed(Math.max(0, 5 - exp));
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function partXml(p: PartXmlInput): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<part>'];
  const el = (indent: number, name: string, value: string) => out.push(`${' '.repeat(indent)}<${name}>${text(value)}</${name}>`);
  el(2, 'Author', p.author || 'Collaborative Brick Layout Designer import');
  out.push('  <Description>');
  el(4, 'en', p.displayName.trim() || p.sourceFile.replace(/\.(ldr|dat|mpd|io|lxf|lxfml)$/i, ''));
  out.push('  </Description>');
  if (p.pxPerStud !== 8) el(2, 'PixelsPerStud', String(p.pxPerStud));
  out.push(`  <ImportedFrom file="${attr(p.sourceFile)}" format="${attr(p.format)}" date="${attr(p.date)}"/>`);
  if (p.designer) {
    out.push(`  <Designer${p.designerUrl ? ` url="${attr(p.designerUrl)}"` : ''}>${text(p.designer)}</Designer>`);
  }
  out.push('  <ImportSource>');
  el(4, 'SourcePath', p.sourceFile);
  if (p.sourceModified !== null) el(4, 'SourceModified', new Date(p.sourceModified).toISOString());
  if (p.quarterTurns % 4) el(4, 'QuarterTurns', String(((p.quarterTurns % 4) + 4) % 4));
  if (p.align) el(4, 'Align', p.align);
  if (p.nudge.x !== 0 || p.nudge.y !== 0) out.push(`    <Nudge x="${fixed(p.nudge.x, 4)}" y="${fixed(p.nudge.y, 4)}"/>`);
  for (const d of p.droppedConnections) out.push(`    <DroppedConnection x="${fixed(d.x, 4)}" y="${fixed(d.y, 4)}"/>`);
  out.push('  </ImportSource>');
  if (p.connections.length) {
    out.push('  <ConnexionList>');
    for (const c of p.connections) {
      out.push('    <connexion>');
      el(6, 'type', c.type);
      out.push('      <position>');
      el(8, 'x', fixed(c.x, 4));
      el(8, 'y', fixed(c.y, 4));
      out.push('      </position>');
      el(6, 'angle', fixed(c.angle, 2));
      out.push('    </connexion>');
    }
    out.push('  </ConnexionList>');
  }
  if (p.pickShape.length) {
    out.push('  <PickShape>');
    for (const ring of p.pickShape) {
      out.push('    <ring>');
      for (const pt of ring) {
        out.push('      <point>');
        el(8, 'x', g6(pt.x));
        el(8, 'y', g6(pt.y));
        out.push('      </point>');
      }
      out.push('    </ring>');
    }
    out.push('  </PickShape>');
  }
  out.push('  <SnapMargin>');
  el(4, 'left', String(p.snapMargin.left));
  el(4, 'right', String(p.snapMargin.right));
  el(4, 'top', String(p.snapMargin.top));
  el(4, 'bottom', String(p.snapMargin.bottom));
  out.push('  </SnapMargin>');
  out.push('</part>');
  return out.join('\n') + '\n';
}
