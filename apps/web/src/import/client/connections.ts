// Where an imported model's track snaps on: the desktop's toBlueBrickMap
// (src/import/ldraw/LDrawReader.cpp) places the model's parts as BlueBrick
// parts, its connectivity links them, and externalConnections
// (src/import/ImportConnections.cpp) keeps the connection points nothing
// is linked to, relative to the picture's centre, tidied to half studs and
// 11.25° steps.

import type { BbmMap, Brick } from '@cld/model';
import { MapLibrary, newBrickLayer, newMap, rebuildConnectivity, type PartMetadata } from '@cld/parts-catalog/browser';
import type { LDrawPartRef, LDrawReadResult } from './ldrawReader';
import type { MeshLoader } from './meshLoader';

export interface ImportedConnection {
  type: string;
  x: number;
  y: number;
  angle: number;
}

const LDU_PER_STUD = 20;
const f = Math.fround;

/** C's std::remainder: the quotient rounded half to even. */
export function remainder(x: number, y: number): number {
  const q = x / y;
  let n = Math.round(q);
  if (Math.abs(q - Math.trunc(q)) === 0.5 && n % 2 !== 0) n -= 1;
  return x - y * n;
}

function partNumberFromFilename(name: string): string {
  let s = name.trim();
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (cut >= 0) s = s.slice(cut + 1);
  if (s.toLowerCase().endsWith('.dat')) s = s.slice(0, -4);
  return s.toUpperCase();
}

const SAME_TRACK: Record<string, string> = { '53401': '2865', '53400': '2867', '74746': '2865', '74747': '2867', '75541': '2859', '75542': '2861', '53404': '2859', '53407': '2861' };
const ORIGIN_ALONG_X: Record<string, number> = { '53404': -320, '53407': -320 };

/** The desktop's resolvePartKey: exact color, any color, earlier numbers, base numbers, the same track. */
function resolvePartKey(ref: LDrawPartRef, pn: string, color: number, lib: MapLibrary, keys: string[], formerNames: (n: string) => string[]): PartMetadata | null {
  const names = [pn];
  for (const alias of ref.aliases ?? []) {
    const a = partNumberFromFilename(alias);
    if (!names.includes(a)) names.push(a);
  }
  for (const n of [...names]) for (const old of formerNames(n)) if (!names.includes(old.toUpperCase())) names.push(old.toUpperCase());
  const candidates: string[] = [];
  const add = (n: string) => {
    if (!candidates.includes(n)) candidates.push(n);
  };
  for (const n of names) {
    add(n);
    const formed = /^(.*\d)(?:C\d\d)?-F\d+$/i.exec(n);
    if (formed) add(formed[1]!.toUpperCase());
    const assembly = /^(.*\d)C\d\d$/i.exec(n);
    if (assembly) add(assembly[1]!.toUpperCase());
  }
  for (const n of [...candidates]) if (SAME_TRACK[n]) add(SAME_TRACK[n]);
  for (const pnc of candidates) {
    const exact = lib.meta(`${pnc}.${color}`);
    if (exact) return exact;
    const any = lib.meta(pnc);
    if (any) return any;
    const prefix = `${pnc.toLowerCase()}.`;
    for (const k of keys) if (k.startsWith(prefix)) return lib.meta(k) ?? null;
  }
  return null;
}

/** The part's own top-down box centre, placed by the reference (BlueBrick frame, LDU). */
function geometryCentre(ref: LDrawPartRef, loader: MeshLoader): { x: number; y: number; size: number } | null {
  const mesh = loader.loadPart(ref.filename, ref.colorCode);
  if (!mesh || mesh.triColor.length === 0) return null;
  let xmin = Infinity,
    xmax = -Infinity,
    zmin = Infinity,
    zmax = -Infinity;
  for (let i = 0; i < mesh.tri.length; i += 3) {
    const x = mesh.tri[i]!,
      z = mesh.tri[i + 2]!;
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
  }
  const cx = (xmin + xmax) / 2,
    cz = (zmin + zmax) / 2;
  const wx = ref.m[0]! * cx + ref.m[2]! * cz + ref.x;
  const wz = ref.m[6]! * cx + ref.m[8]! * cz + ref.z;
  return { x: wx, y: -wz, size: Math.max(xmax - xmin, zmax - zmin) };
}

/**
 * The model placed as BlueBrick parts, one sheet: 20 LDU a stud, y = −z,
 * angle = atan2(m2, m0), then each part's <LDraw> remap and, with the
 * geometry, the check that the remapped centre is the part's real one.
 */
export function toBlueBrickMap(src: LDrawReadResult, lib: MapLibrary, formerNames: (n: string) => string[] = () => [], geometry?: MeshLoader): BbmMap {
  const map = newMap();
  map.author = 'LDraw import';
  if (src.title) map.comment = src.title;
  const keys = [...lib.catalog.keys()].sort();
  const bricks: Brick[] = [];
  for (const ref of src.parts) {
    const pn = partNumberFromFilename(ref.filename);
    let partNumber = `${pn}.${ref.colorCode}`;
    let angle = (Math.atan2(ref.m[2]!, ref.m[0]!) * 180) / Math.PI;
    let x = ref.x;
    let y = src.lddAxes ? ref.z : -ref.z;
    if (!src.lddAxes) {
      const along = ORIGIN_ALONG_X[pn];
      if (along !== undefined) {
        x += ref.m[0]! * along;
        y -= ref.m[6]! * along;
      }
      const meta = resolvePartKey(ref, pn, ref.colorCode, lib, keys, formerNames);
      if (meta) {
        partNumber = meta.colorCode ? `${meta.partNumber}.${meta.colorCode}` : meta.partNumber;
        angle -= meta.ldraw?.angle ?? 0;
        const tx = meta.ldraw?.translation?.x ?? 0;
        const ty = meta.ldraw?.translation?.y ?? 0;
        if (tx !== 0 || ty !== 0) {
          const r = (angle * Math.PI) / 180;
          const c = Math.cos(r),
            s = Math.sin(r);
          x += -tx * c - ty * s;
          y += -tx * s + ty * c;
        }
        if (geometry) {
          const g = geometryCentre(ref, geometry);
          if (g && Math.hypot(g.x - x, g.y - y) > 0.25 * g.size) {
            x = g.x;
            y = g.y;
          }
        }
      }
    }
    const meta = lib.meta(partNumber);
    const b: Brick = meta ? lib.newBrick(meta) : { id: '', displayArea: { x: 0, y: 0, width: 0, height: 0 }, myGroup: '', partNumber, orientation: 0, activeConnectionPointIndex: 0, altitude: 0, connexions: [] };
    b.partNumber = partNumber;
    b.orientation = f(angle);
    b.altitude = f(ref.y / LDU_PER_STUD);
    lib.placeByImageCentre(b, { x: x / LDU_PER_STUD, y: y / LDU_PER_STUD });
    bricks.push(b);
  }
  map.layers.push(newBrickLayer('Imported', bricks));
  return map;
}

function tidyPosition(v: number): number {
  const half = Math.round(v * 2) / 2;
  return Math.abs(v - half) < 0.03 ? half : v;
}

function tidyAngle(deg: number): number {
  const step = Math.round(deg / 11.25) * 11.25;
  return remainder(Math.abs(deg - step) < 0.1 ? step : deg, 360);
}

/** The free connection points, relative to `origin` (studs). */
export function externalConnections(map: BbmMap, lib: MapLibrary, origin: { x: number; y: number }): ImportedConnection[] {
  rebuildConnectivity(map, lib.catalog);
  const out: ImportedConnection[] = [];
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    for (const brick of layer.bricks) {
      const meta = lib.meta(brick.partNumber);
      if (!meta) continue;
      const centre = lib.imageCentre(brick);
      const r = (brick.orientation * Math.PI) / 180;
      const c = Math.cos(r),
        s = Math.sin(r);
      meta.connections.forEach((cp, i) => {
        if (!cp.type) return;
        if (i < brick.connexions.length && brick.connexions[i]!.linkedTo) return;
        const wx = centre.x + (cp.x * c - cp.y * s);
        const wy = centre.y + (cp.x * s + cp.y * c);
        out.push({ type: cp.type, x: tidyPosition(wx - origin.x), y: tidyPosition(wy - origin.y), angle: tidyAngle(cp.angle + brick.orientation) });
      });
    }
  }
  return out;
}
