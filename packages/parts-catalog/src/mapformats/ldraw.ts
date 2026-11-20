// BlueBrick's LDraw map format — port of desktop import/mapformats/
// LDrawMap.cpp (from BlueBrick's SaveLoadManager), so files travel
// between the tools:
//   .ldr  every "0 STEP" starts a new layer
//   .mpd  every submodel ("0 FILE") is a layer named after it; the main
//         model's MLCAD HIDE marks hidden layers
// Bricks are placed with each part's <LDraw> remap; parts BlueBrickParts
// marks as ignorable (an XML without an image, e.g. sleeper plates) are
// skipped. MLCAD groups (BTG / GROUP), "0 !BLUEBRICK RULER" lines and the
// Author / LUG / Event / Date / comment header are understood.
//
// Writing: remapped parts, sleepers under rails, groups, rulers. Area,
// grid and text layers can't be expressed in LDraw and are written as a
// comment only. Parts without a numeric color (sets, logos) are
// skipped, as in BlueBrick.

import type { BbmMap, Brick, ColorSpec, Group, Layer, LayerBrick, LayerRuler, RulerItem } from '@cld/model';
import { formatNumber } from '@cld/bbm/browser';
import { rebuildConnectivity } from '../connectivity.js';
import type { PartMetadata } from '../types.js';
import { MapLibrary, makeId, newBrickLayer, newMap, partNumberOf, rotated, type MapReadResult } from './library.js';

const f = Math.fround;
const LDU_PER_STUD = 20;
const HIDE = '0 MLCAD HIDE ';
const BTG = '0 MLCAD BTG ';
const GROUP = '0 GROUP ';
const RULER = '0 !BLUEBRICK RULER 1 ';

/** A part the library knows as an XML without an image (BlueBrick's "ignorable"). */
const isIgnorable = (meta: PartMetadata) => meta.kind === 'leaf' && !meta.spritePath;

// BlueBrick's splitLDrawLine: whitespace-separated, but "double quoted"
// runs stay one token (without the quotes).
function splitLine(line: string): string[] {
  const out: string[] = [];
  line.split('"').forEach((part, i) => {
    if (!part) return;
    if (i % 2) out.push(part);
    else out.push(...part.split(/[ \t]+/).filter((s) => s !== ''));
  });
  return out;
}

const restAfterToken = (line: string, token: string | undefined) =>
  token === undefined ? line.trim() : line.slice(line.indexOf(token) + token.length).trim();

// QString::toDouble / toFloat / toInt: 0 for anything unparseable, and
// (like the .bbm reader) for numbers out of range, so the map can be saved.
const toDouble = (s: string | undefined): number => {
  const t = (s ?? '').trim();
  const v = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t) ? Number(t) : 0;
  return Number.isFinite(v) ? v : 0;
};
const toInt = (s: string | undefined): number => {
  const t = (s ?? '').trim();
  return /^[+-]?\d+$/.test(t) ? Number(t) : 0;
};

/** "<part>.<color>" split at the last dot. */
function splitPartAndColor(partNumber: string): [string, string] {
  const dot = partNumber.lastIndexOf('.');
  return dot < 0 ? [partNumber, ''] : [partNumber.slice(0, dot), partNumber.slice(dot + 1)];
}

/** QFileInfo::completeBaseName: the file name up to its last dot. */
function completeBaseName(path: string): string {
  const name = path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}

function readColor(token: string): ColorSpec {
  if (/^0x/i.test(token)) {
    const v = Number.parseInt(token.slice(2), 16);
    return { kind: 'argb', argb: (Number.isFinite(v) ? v >>> 0 : 0).toString(16).padStart(8, '0') };
  }
  return { kind: 'known', name: token };
}

function readPoint(token: string | undefined): { x: number; y: number } {
  const xy = (token ?? '').split('|').filter((s) => s !== '');
  return { x: toDouble(xy[0]), y: toDouble(xy[1]) };
}

interface PendingGroup {
  id: string;
  partNumber: string;
  parent: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export interface LDrawReadOptions {
  /** .mpd (submodels are layers) rather than .ldr (steps are layers). */
  mpd: boolean;
}

export function readLDrawMap(text: string, lib: MapLibrary, opts: LDrawReadOptions): MapReadResult {
  const map = newMap();
  const groups = new Map<string, PendingGroup>();
  let layer: LayerBrick | LayerRuler | null = null;
  let layerName = '';
  let pendingGroup = '';
  let skippedUnknown = 0;

  const groupsFor = (items: readonly { myGroup: string }[]): Group[] => {
    const out: Group[] = [];
    const done = new Set<string>();
    const pending = items.filter((it) => it.myGroup).map((it) => it.myGroup);
    while (pending.length) {
      const id = pending.pop()!;
      if (done.has(id)) continue;
      done.add(id);
      for (const g of groups.values()) {
        if (g.id !== id) continue;
        out.push({ id: g.id, partNumber: g.partNumber, myGroup: g.parent });
        if (g.parent) pending.push(g.parent);
      }
    }
    return out;
  };

  const finalizeLayer = () => {
    if (!layer) return;
    if (layer.type === 'brick') {
      layer.bricks.sort((a, b) => a.altitude - b.altitude);
      layer.groups = groupsFor(layer.bricks);
    } else {
      layer.groups = groupsFor(layer.rulerItems);
    }
    map.layers.push(layer);
    layer = null;
  };

  const currentLayer = <T extends 'brick' | 'ruler'>(type: T): Extract<Layer, { type: T }> => {
    if (layer && layer.type !== type) finalizeLayer();
    if (!layer) {
      const name = layerName || `Layer ${map.layers.length + 1}`;
      if (type === 'brick') layer = newBrickLayer(name);
      else {
        const b = newBrickLayer(name);
        layer = { type: 'ruler', id: b.id, name, visible: true, transparency: 100, hullProperties: b.hullProperties, rulerItems: [], groups: [] };
      }
    }
    return layer as Extract<Layer, { type: T }>;
  };

  const groupNamed = (name: string): PendingGroup => {
    let g = groups.get(name);
    if (!g) {
      const hash = name.lastIndexOf('#');
      g = { id: makeId(), partNumber: hash > 0 ? name.slice(0, hash) : '', parent: '' };
      groups.set(name, g);
    }
    return g;
  };

  // "0 MLCAD BTG <group>" applies to the next item only.
  const takePendingGroup = () => {
    const id = pendingGroup;
    pendingGroup = '';
    return id;
  };

  const parseDate = (s: string) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (!m) return;
    const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const d = new Date(year, month - 1, day);
    if (d.getDate() === day && d.getMonth() === month - 1) map.date = { day, month, year };
  };

  const parseBrick = (t: string[], i: number) => {
    if (t.length < i + 14) return;
    // Only parts; references to submodels (.ldr) are layers, not bricks.
    const file = t.slice(i + 13).join(' ');
    if (!/\.dat$/i.test(file)) return;
    const color = t[i]!;
    let x = toDouble(t[i + 1]);
    const y = toDouble(t[i + 2]);
    let z = -toDouble(t[i + 3]);
    const a = toDouble(t[i + 4]);
    const c = toDouble(t[i + 6]);
    let partNumber = `${completeBaseName(file).toUpperCase()}.${color}`;

    const meta = lib.meta(partNumber);
    if (meta && isIgnorable(meta)) return;
    let angle = (Math.atan2(c, a) * 180) / Math.PI;
    if (meta) {
      const ld = meta.ldraw;
      if (ld) {
        angle -= ld.angle;
        const tr = ld.translation;
        if (tr.x !== 0 || tr.y !== 0) {
          const off = rotated({ x: -tr.x, y: tr.y }, angle);
          x += off.x;
          z += off.y;
        }
      }
      // The part's current number (old names map to it).
      partNumber = partNumberOf(meta);
    } else {
      skippedUnknown++;
    }

    const bricks = currentLayer('brick').bricks;
    const b: Brick = meta
      ? lib.newBrick(meta)
      : { id: makeId(), displayArea: { x: 0, y: 0, width: 0, height: 0 }, myGroup: '', partNumber, orientation: 0, activeConnectionPointIndex: 0, altitude: 0, connexions: [] };
    b.orientation = f(angle);
    b.altitude = f(y);
    // The LDraw origin is the sprite centre.
    lib.placeByImageCentre(b, { x: x / LDU_PER_STUD, y: z / LDU_PER_STUD });
    b.myGroup = takePendingGroup();
    bricks.push(b);
  };

  const parseRuler = (t: string[], i: number) => {
    // <type> #id dist unit color guideColor fontColor thick guideThick
    // [dash] unit "font" <geometry>. BlueBrick writes nothing at all for
    // an empty dash pattern, so detect that from the token count.
    const linear = t[i] === 'LINEAR';
    const geometry = linear ? 6 : 3;
    const hasDash = t.length - (i + 1) >= 11 + geometry;
    let k = i + 2; // skip type and id
    const displayDistance = t[k++] === 'true';
    const displayUnit = t[k++] === 'true';
    const color = readColor(t[k++] ?? '');
    const guidelineColor = readColor(t[k++] ?? '');
    const measureFontColor = readColor(t[k++] ?? '');
    const lineThickness = f(toDouble(t[k++]));
    const guidelineThickness = f(toDouble(t[k++]));
    const guidelineDashPattern: number[] = [];
    if (hasDash) for (const v of (t[k++] ?? '').split('|').filter((s) => s !== '')) guidelineDashPattern.push(f(toDouble(v)));
    const unit = toInt(t[k++]);
    const font = (t[k++] ?? '').split('|');
    const measureFont = { family: font[0] ?? '', size: f(toDouble(font[1] ?? '8')), style: font[2] ?? 'Regular' };
    if (t.length < k + geometry) return;
    const common = {
      id: makeId(),
      myGroup: '',
      color,
      lineThickness,
      displayDistance,
      displayUnit,
      guidelineColor,
      guidelineThickness,
      guidelineDashPattern,
      unit,
      measureFont,
      measureFontColor,
    };
    let item: RulerItem;
    if (linear) {
      const point1 = readPoint(t[k++]);
      const point2 = readPoint(t[k++]);
      k += 2; // attached brick ids: bricks get new ids on load, as in BlueBrick
      const allowOffset = t[k++] === 'true';
      const offsetDistance = f(toDouble(t[k]));
      const x = Math.min(point1.x, point2.x);
      const y = Math.min(point1.y, point2.y);
      item = {
        ...common,
        kind: 'linear',
        displayArea: { x, y, width: Math.abs(point2.x - point1.x), height: Math.abs(point2.y - point1.y) },
        point1,
        point2,
        attachedBrick1Id: '',
        attachedBrick2Id: '',
        offsetDistance,
        allowOffset,
      };
    } else {
      const center = readPoint(t[k++]);
      const radius = f(toDouble(t[k]));
      item = {
        ...common,
        kind: 'circular',
        displayArea: { x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius },
        center,
        radius,
        attachedBrickId: '',
      };
    }
    item.myGroup = takePendingGroup();
    currentLayer('ruler').rulerItems.push(item);
  };

  const parseMeta = (line: string, t: string[], i: number): void => {
    if (i >= t.length) return;
    const key = t[i]!;
    if (key.startsWith('Author')) map.author = restAfterToken(line, t[1]);
    else if (key.startsWith('Lug')) map.lug = restAfterToken(line, t[1]);
    else if (key.startsWith('Event')) map.event = restAfterToken(line, t[1]);
    else if (key.startsWith('Date')) parseDate(restAfterToken(line, t[1]));
    else if (key.startsWith('//')) {
      const next = t[i + 1] ?? '';
      if (next.startsWith('LUG')) map.lug = restAfterToken(line, t[2]);
      else if (next.startsWith('Event')) map.event = restAfterToken(line, t[2]);
      else if (next.startsWith('Date')) parseDate(restAfterToken(line, t[2]));
      else map.comment += `${line.slice(5)}\n`;
    } else if (key === 'MLCAD') {
      if (t[i + 1] === 'HIDE') {
        if (t[i + 2] === '0') parseMeta(line, t, i + 3);
        else if (t[i + 2] === '1') parseBrick(t, i + 3);
        if (layer) layer.visible = false;
      } else if (t[i + 1] === 'BTG' && t.length > 3) {
        pendingGroup = groupNamed(line.slice(line.indexOf(t[3]!)).trim()).id;
      }
    } else if (key === 'GROUP' && t.length > 3) {
      const g = groupNamed(line.slice(line.indexOf(t[3]!)).trim());
      const parent = takePendingGroup();
      if (parent) g.parent = parent;
    } else if (key === '!BLUEBRICK' && t[i + 1] === 'RULER') {
      parseRuler(t, i + 3);
    }
  };

  let firstFile = true;
  const hiddenLayers: string[] = [];
  for (const line of text.split(/\r?\n|\r/)) {
    const t = splitLine(line);
    if (t.length === 0) continue;
    if (t[0] === '0' && t.length > 1) {
      if (opts.mpd && t[1] === 'FILE') {
        // The first FILE is the main model; each later one is a layer.
        if (!firstFile) {
          finalizeLayer();
          layerName = completeBaseName(line.slice(7).trim());
        }
        firstFile = false;
      } else if (t[1] === 'STEP') {
        if (!opts.mpd) finalizeLayer();
      } else if (opts.mpd && t[1] === 'MLCAD' && t[2] === 'HIDE' && t.length > 17 && /\.ldr$/i.test(t[17]!)) {
        hiddenLayers.push(completeBaseName(t[17]!));
      } else {
        parseMeta(line, t, 1);
      }
    } else if (t[0] === '1') {
      parseBrick(t, 1);
    }
  }
  finalizeLayer();

  for (const l of map.layers) if (hiddenLayers.includes(l.name)) l.visible = false;
  rebuildConnectivity(map, lib.catalog);
  const warnings = skippedUnknown > 0 ? [`${skippedUnknown} part(s) aren't in your parts library, so they were left out.`] : [];
  return { map, warnings };
}

// ------------------------------------------------------------------ writing

const fmt = (v: number) => formatNumber(v, 'g7');

function colorToken(c: ColorSpec): string {
  return c.kind === 'known' ? `"${c.name}" ` : `"0x${c.argb.toLowerCase().padStart(8, '0')}" `;
}

class Writer {
  readonly lines: string[] = [];
  private used = new Set<string>();
  constructor(
    private readonly map: BbmMap,
    private readonly lib: MapLibrary,
  ) {}

  line(s: string) {
    this.lines.push(s);
  }

  header(fileName: string) {
    const m = this.map;
    this.line(`0 ${completeBaseName(fileName)}`);
    this.line(`0 Name: ${fileName}`);
    this.line(`0 Author: ${m.author}`);
    this.line('0 Unofficial Model');
    this.line('0');
    this.line(`0 // LUG: ${m.lug}`);
    this.line(`0 // Event: ${m.event}`);
    this.line(`0 // Date: ${pad2(m.date.day)}/${pad2(m.date.month)}/${String(m.date.year).padStart(4, '0')}`);
    for (const c of m.comment.split(/[\r\n]/)) if (c) this.line(`0 // ${c}`);
    this.line('0');
  }

  layer(layer: Layer, useMlcadHide: boolean) {
    const hide = useMlcadHide && !layer.visible;
    switch (layer.type) {
      case 'brick':
        return this.bricks(layer, hide);
      case 'ruler':
        return this.rulers(layer, hide);
      case 'area':
        return this.line('0 // Area layer not implemented yet, see you maybe in BB 1.9');
      case 'grid':
        return this.line('0 // Grid layer not implemented yet, see you maybe in BB 1.9');
      case 'text':
        return this.line('0 // Text layer not implemented yet, see you maybe in BB 1.9');
    }
  }

  private static groupName(g: Group) {
    return `${g.partNumber ?? ''}#${g.id}`;
  }

  private belongsTo(groupId: string, groups: readonly Group[]) {
    if (!groupId) return;
    const g = groups.find((x) => x.id === groupId);
    if (!g) return;
    this.line(BTG + Writer.groupName(g));
    this.used.add(g.id);
  }

  private groupsOf(groups: readonly Group[], members: readonly string[], hide: boolean) {
    // Include ancestors of used groups so nested groups survive.
    for (let grew = true; grew; ) {
      grew = false;
      for (const g of groups) {
        if (this.used.has(g.id) && g.myGroup && !this.used.has(g.myGroup)) {
          this.used.add(g.myGroup);
          grew = true;
        }
      }
    }
    for (const g of groups) {
      if (!this.used.has(g.id)) continue;
      let count = members.filter((id) => id === g.id).length;
      count += groups.filter((o) => o.myGroup === g.id).length;
      if (g.myGroup) for (const p of groups) if (p.id === g.myGroup) this.line(BTG + Writer.groupName(p));
      this.line(`${hide ? HIDE : ''}${GROUP}${count} ${Writer.groupName(g)}`);
    }
    this.used.clear();
  }

  // Same arithmetic as BlueBrick's saveOneBrickInLDRAW, in 32-bit float,
  // so the written numbers match it digit for digit.
  private oneBrick(partNumber: string, color: string, altitude: number, orientation: number, x: number, z: number, remap: PartMetadata | undefined, hide: boolean) {
    x = f(f(x) * 20);
    z = f(f(z) * 20);
    let y = f(altitude);
    let angle = f(orientation);
    const ld = remap?.ldraw;
    if (ld) {
      const tr = ld.translation;
      if (tr.x !== 0 || tr.y !== 0) {
        // GDI Matrix.Rotate(-angle) applied to (tx, ty).
        const r = (-angle * Math.PI) / 180;
        const c = f(Math.cos(r));
        const s = f(Math.sin(r));
        const tx = f(tr.x);
        const ty = f(tr.y);
        x = f(x + f(f(tx * c) - f(ty * s)));
        z = f(z + f(f(tx * s) + f(ty * c)));
      }
      if (y === 0) y = f(ld.preferredHeight);
      angle = f(angle + f(ld.angle));
    }
    angle = f(angle * f(f(Math.PI) / 180));
    const cosA = f(Math.cos(angle));
    const sinA = f(Math.sin(angle));
    const cs = fmt(cosA);
    this.line(
      `${hide ? HIDE : ''}1 ${color} ${fmt(x)} ${fmt(y)} ${fmt(z)} ${cs} 0 ${fmt(sinA)} 0 1 0 ${fmt(f(-sinA))} 0 ${cs} ${partNumber}.DAT`,
    );
  }

  // BlueBrick's Brick.Center + OffsetFromOriginalImage, in float.
  private centre(b: Brick): { x: number; y: number; cx: number; cy: number; ox: number; oy: number } {
    const a = b.displayArea;
    const off = this.lib.imageOffset(b.partNumber, b.orientation);
    const cx = f(f(a.x) + f(f(a.width) * 0.5));
    const cy = f(f(a.y) + f(f(a.height) * 0.5));
    const ox = f(off.x);
    const oy = f(off.y);
    return { x: f(cx + ox), y: f(cy + oy), cx, cy, ox, oy };
  }

  // Connection i's world position as BlueBrick's updateConnectionPosition
  // gets it: the local point through a GDI+ rotation matrix, in float.
  private connection(b: Brick, meta: PartMetadata, i: number): { x: number; y: number } {
    const c = this.centre(b);
    const cp = meta.connections[i]!;
    const r = (f(b.orientation) * Math.PI) / 180;
    const cos = f(Math.cos(r));
    const sin = f(Math.sin(r));
    const px = f(cp.x);
    const py = f(cp.y);
    return { x: f(c.x + f(f(px * cos) + f(py * f(-sin)))), y: f(c.y + f(f(px * sin) + f(py * cos))) };
  }

  private bricks(layer: LayerBrick, hide: boolean) {
    const lib = this.lib;
    const byConnection = new Map<string, Brick>();
    for (const b of layer.bricks) for (const c of b.connexions) byConnection.set(c.id, b);
    const sleepered = new Set<string>(); // connections that already got a sleeper
    const members: string[] = [];

    for (const b of layer.bricks) {
      let [pn, color] = splitPartAndColor(b.partNumber);
      if (!/^[+-]?\d+$/.test(color.trim())) continue; // sets, logos, custom parts
      const centre = this.centre(b);
      const meta = lib.meta(b.partNumber);
      if (meta?.ldraw?.alias) {
        const [aliasPn, aliasColor] = splitPartAndColor(meta.ldraw.alias);
        pn = aliasPn;
        if (aliasColor) color = aliasColor;
      }
      this.belongsTo(b.myGroup, layer.groups);
      members.push(b.myGroup);
      this.oneBrick(pn, color, b.altitude, b.orientation, centre.x, f(f(-centre.cy) - centre.oy), meta, hide);
      const sleeper = meta?.ldraw?.sleeper;
      if (!meta || !sleeper || meta.connections.length === 0) continue;

      // Rails get a sleeper at every end (once per joint).
      const [sleeperPn, sleeperColor] = splitPartAndColor(sleeper);
      const sleeperMeta = lib.meta(sleeper);
      let sleeperAltitude = f(b.altitude);
      if (sleeperMeta && sleeperAltitude !== 0) {
        sleeperAltitude = f(sleeperAltitude + f((sleeperMeta.ldraw?.preferredHeight ?? 0) - (meta.ldraw?.preferredHeight ?? 0)));
      }
      for (let i = 0; i < meta.connections.length && i < b.connexions.length; i++) {
        const conn = b.connexions[i]!;
        let add = true;
        if (conn.linkedTo) {
          if (sleepered.has(conn.linkedTo)) add = false;
          else if (sleeperPn === '767') {
            // 12V grey sleepers clip together; next to a plain plate the plate wins.
            const other = byConnection.get(conn.linkedTo);
            const otherSleeper = other ? lib.meta(other.partNumber)?.ldraw?.sleeper : undefined;
            if (otherSleeper) add = splitPartAndColor(otherSleeper)[0] === '767';
          }
        }
        if (!add) continue;
        const at = this.connection(b, meta, i);
        this.oneBrick(sleeperPn, sleeperColor, sleeperAltitude, f(f(b.orientation) + f(meta.connections[i]!.angle)), f(at.x), f(-at.y), sleeperMeta, hide);
        sleepered.add(conn.id);
      }
    }
    this.groupsOf(layer.groups, members, hide);
  }

  private rulers(layer: LayerRuler, hide: boolean) {
    const members: string[] = [];
    for (const r of layer.rulerItems) {
      this.belongsTo(r.myGroup, layer.groups);
      members.push(r.myGroup);
      let text = `${hide ? HIDE : ''}${RULER}${r.kind === 'linear' ? 'LINEAR ' : 'CIRCULAR '}#${r.id} `;
      text += `${r.displayDistance} ${r.displayUnit} `;
      text += colorToken(r.color) + colorToken(r.guidelineColor) + colorToken(r.measureFontColor);
      text += `${fmt(r.lineThickness)} ${fmt(r.guidelineThickness)} `;
      if (r.guidelineDashPattern.length) text += `${r.guidelineDashPattern.map(fmt).join('|')} `;
      text += `${Math.trunc(r.unit)} `;
      text += `"${r.measureFont.family}|${fmt(r.measureFont.size)}|${r.measureFont.style}" `;
      const point = (p: { x: number; y: number }) => `${fmt(p.x)}|${fmt(p.y)} `;
      const id = (s: string) => `#${s} `;
      if (r.kind === 'linear') {
        text += point(r.point1) + point(r.point2) + id(r.attachedBrick1Id) + id(r.attachedBrick2Id);
        text += `${r.allowOffset} ${fmt(r.offsetDistance)} `;
      } else {
        text += `${point(r.center)}${fmt(r.radius)} ${id(r.attachedBrickId)}`;
      }
      this.line(text);
    }
    this.groupsOf(layer.groups, members, hide);
  }
}

/**
 * Write `map` as LDraw text (CRLF lines); `fileName` ("name.ldr" or
 * "name.mpd") picks the flavour and names the model.
 */
export function writeLDrawMap(map: BbmMap, lib: MapLibrary, fileName: string): string {
  const w = new Writer(map, lib);
  if (/\.mpd$/i.test(fileName)) {
    // Main model referencing one submodel per layer, then the submodels.
    w.line(`0 FILE ${completeBaseName(fileName)}.ldr`);
    w.header(fileName);
    const names = map.layers.map((l) => `${l.name.trim().replace(/[ \t]/g, '_')}.ldr`);
    map.layers.forEach((l, i) => w.line(`${l.visible ? '' : HIDE}1 1 0 0 0 1 0 0 0 1 0 0 0 1 ${names[i]}`));
    w.line('0');
    map.layers.forEach((l, i) => {
      w.line(`0 FILE ${names[i]}`);
      w.line(`0 Author: ${map.author}`);
      w.line('0 Unofficial Model');
      w.line('0');
      w.layer(l, false);
      w.line('0');
    });
  } else {
    w.header(fileName);
    w.line('0');
    for (const l of map.layers) {
      w.layer(l, true);
      w.line('0 STEP');
    }
  }
  return w.lines.map((l) => `${l}\r\n`).join('');
}
