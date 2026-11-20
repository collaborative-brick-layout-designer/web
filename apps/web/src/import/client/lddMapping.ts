// LDD design IDs and materials → LDraw parts and colors, from ldraw.xml:
// the desktop's LDDLDrawMapping (src/import/ldd/LDDLDrawMapping.cpp), with
// its built-in train track (missing from LDD's own ldraw.xml) and lxf2ldr's
// per-part corrections. Used to place an LDD model as LDraw parts, so its
// track gets snap points.

import type { LDrawPartRef, LDrawReadResult } from './ldrawReader';
import { scanXml, xmlDouble, xmlInt } from './xmlScan';

interface Transformation {
  tx: number;
  ty: number;
  tz: number;
  ax: number;
  ay: number;
  az: number;
  angle: number;
  exists: boolean;
}

// { LDD design ID, LDraw file, tx, ty, tz, angle about +Y }
const BUILTIN_TRACK: [string, string, number, number, number, number][] = [
  ['53401', '53401.dat', 6, -0.32, 2.8, 1.570796],
  ['53400', '53400.dat', -6.4, -0.32, -2.2, -1.374447],
  ['74746', '74746.dat', 6, -0.32, 2.8, 1.570796],
  ['2865', '2865.dat', 6, -0.32, 2.8, 1.570796],
  ['74747', '74747.dat', -6.4, -0.32, -2.24, -1.374447],
  ['2867', '2867.dat', -6.4, -0.32, -2.24, -1.374447],
  ['75541', '75541.dat', -12.4, -0.32, -2.8, -1.570796],
  ['75542', '75542.dat', -12.4, -0.32, -2.8, -1.570796],
  ['64573', '88492.dat', 0, -0.32, 0, 1.570796],
  ['64572', '88493.dat', 0, -0.32, 0, 1.570796],
  ['85976', '85976.dat', -7.74, -0.32, -0.54, -1.178097],
  ['85977', '85977.dat', -6, -5.12, -2, -1.570796],
];

type Mat3 = number[];

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
  return r;
}

/** Right-handed rotation about (x, y, z) by `radians` (Rodrigues), quarter-turn noise snapped. */
function axisAngle(x: number, y: number, z: number, radians: number): Mat3 {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len === 0 || radians === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  x /= len;
  y /= len;
  z /= len;
  const c = Math.cos(radians),
    s = Math.sin(radians),
    ic = 1 - c;
  const m = [x * x * ic + c, x * y * ic - z * s, x * z * ic + y * s, y * x * ic + z * s, y * y * ic + c, y * z * ic - x * s, x * z * ic - y * s, y * z * ic + x * s, z * z * ic + c];
  return m.map((v) => (Math.abs(v) < 1e-6 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-6 ? Math.sign(v) : v));
}

export class LddMapping {
  private readonly brickToLdraw = new Map<string, string>();
  private readonly aliases = new Map<string, string[]>();
  private readonly materialToLdraw = new Map<number, number>();
  private readonly transformations = new Map<string, Transformation>();
  /** Whether a file was loaded with anything in it (the desktop's haveMapping). */
  loaded = false;

  /** Parse ldraw.xml; true when it held mappings (successive loads merge). */
  load(text: string | null): boolean {
    if (!text) return false;
    const scan = scanXml(text);
    let added = 0;
    for (const t of scan.tags) {
      if (t.kind === 'end') continue;
      const a = t.attrs;
      if (t.name === 'Material') {
        const ldraw = xmlInt(a.get('ldraw'));
        const lego = xmlInt(a.get('lego'));
        if (ldraw !== null && lego !== null) {
          this.materialToLdraw.set(lego, ldraw);
          added++;
        }
      } else if (t.name === 'Brick' || t.name === 'Assembly') {
        const ldraw = (a.get('ldraw') ?? '').trim();
        const lego = (a.get('lego') ?? '').trim();
        if (ldraw && lego) {
          this.brickToLdraw.set(lego, ldraw);
          const all = this.aliases.get(lego) ?? [];
          if (!all.some((x) => x.toLowerCase() === ldraw.toLowerCase())) all.push(ldraw);
          this.aliases.set(lego, all);
          added++;
        }
      } else if (t.name === 'Transformation') {
        const ldraw = (a.get('ldraw') ?? '').trim();
        if (!ldraw) continue;
        this.transformations.set(ldraw, {
          exists: true,
          tx: xmlDouble(a.get('tx')),
          ty: xmlDouble(a.get('ty')),
          tz: xmlDouble(a.get('tz')),
          ax: xmlDouble(a.get('ax')),
          ay: xmlDouble(a.get('ay')),
          az: xmlDouble(a.get('az')),
          angle: xmlDouble(a.get('angle')),
        });
        added++;
      }
    }
    const ok = added > 0 && !scan.error;
    this.loaded = this.loaded || ok;
    return ok;
  }

  partFor(designId: string): string {
    return this.brickToLdraw.get(designId) ?? BUILTIN_TRACK.find((t) => t[0] === designId)?.[1] ?? '';
  }

  partsFor(designId: string): string[] {
    return this.aliases.get(designId) ?? [];
  }

  colorFor(material: number): number {
    return this.materialToLdraw.get(material) ?? -1;
  }

  transformFor(dat: string): Transformation {
    const own = this.transformations.get(dat);
    if (own) return own;
    const t = BUILTIN_TRACK.find((b) => b[1].toLowerCase() === dat.toLowerCase());
    return t ? { exists: true, tx: t[2], ty: t[3], tz: t[4], ax: 0, ay: 1, az: 0, angle: t[5] } : { exists: false, tx: 0, ty: 0, tz: 0, ax: 0, ay: 1, az: 0, angle: 0 };
  }

  /** The LDraw model LDD would export (lxf2ldr's way): LDraw parts, colors and axes. */
  toLDraw(ldd: LDrawReadResult): LDrawReadResult {
    const F: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];
    const out: LDrawReadResult = { ...ldd, parts: [], primitives: [], lddAxes: false, warnings: [] };
    for (const ref of ldd.parts) {
      const designId = ref.filename.split('.')[0]!;
      let dat = this.partFor(designId);
      if (!dat) dat = `${designId}.dat`;
      const color = this.colorFor(ref.colorCode);
      let rot: Mat3 = [...ref.m];
      let px = ref.x,
        py = ref.y,
        pz = ref.z;
      const t = this.transformFor(dat);
      if (t.exists) {
        rot = mul(ref.m, axisAngle(t.ax, t.ay, t.az, -t.angle));
        const mx = -t.tx,
          my = -t.ty,
          mz = -t.tz;
        px += 25 * (rot[0]! * mx + rot[1]! * my + rot[2]! * mz);
        py += 25 * (rot[3]! * mx + rot[4]! * my + rot[5]! * mz);
        pz += 25 * (rot[6]! * mx + rot[7]! * my + rot[8]! * mz);
      }
      const m = mul(mul(F, rot), F);
      const o: LDrawPartRef = {
        colorCode: color >= 0 ? color : ref.colorCode,
        x: px,
        y: -py,
        z: -pz,
        m,
        filename: dat,
        aliases: this.partsFor(designId).filter((a) => a.toLowerCase() !== dat.toLowerCase()),
      };
      out.parts.push(o);
    }
    return out;
  }
}
