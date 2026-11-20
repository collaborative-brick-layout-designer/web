// Reading an LDraw model: the desktop's readLDraw (src/import/ldraw/
// LDrawReader.cpp). Type-1 references, type-2/3/4 geometry, the title (the
// first comment, or the first "0 FILE" name without its extension) and the
// main model's "0 Author:". A multi-part file (.mpd, Studio's model.ldr)
// is flattened: the first "0 FILE" block is the model, its references to
// the other blocks are replaced by those blocks' contents, placed and
// colored; lines before the first "0 FILE" belong to the model too.

import { qtInt } from './palette';

export interface LDrawPartRef {
  colorCode: number;
  x: number;
  y: number;
  z: number;
  /** 3×3 row-major. */
  m: number[];
  filename: string;
  /** Other files that are the same part (LDD's ldraw.xml), for finding it in the parts library. */
  aliases?: string[];
}

export interface LDrawPrimitive {
  /** 2 line, 3 triangle, 4 quad. */
  kind: 2 | 3 | 4;
  colorCode: number;
  v: [number, number, number][];
}

export interface LDrawReadResult {
  ok: boolean;
  error: string;
  parts: LDrawPartRef[];
  primitives: LDrawPrimitive[];
  title: string;
  author: string;
  /** LDD axes (+Y up): readLDD's results. */
  lddAxes: boolean;
  /** Files that came with the model (a Studio file's CustomParts), by lower-case name. */
  overlay?: Map<string, string>;
  warnings: string[];
}

export function emptyRead(): LDrawReadResult {
  return { ok: false, error: '', parts: [], primitives: [], title: '', author: '', lddAxes: false, warnings: [] };
}

/** Qt's QString::toDouble: the number, or null when it isn't one. */
export function qtDouble(s: string): number | null {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  const l = s.toLowerCase();
  if (l === 'inf' || l === '+inf') return Infinity;
  if (l === '-inf') return -Infinity;
  if (l === 'nan') return NaN;
  return null;
}

/** toInt() / toDouble() without the ok flag: 0 when it isn't a number. */
const int0 = (s: string) => qtInt(s) ?? 0;
const dbl0 = (s: string) => qtDouble(s) ?? 0;

interface Block {
  parts: LDrawPartRef[];
  primitives: LDrawPrimitive[];
}

const MAX_DEPTH = 32;
const MAX_ITEMS = 1_000_000;

interface Placement {
  m: number[];
  t: number[];
  color: number;
}

const IDENTITY: Placement = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], color: 16 };

function apply(p: Placement, v: readonly number[]): number[] {
  const out = [0, 0, 0];
  for (let r = 0; r < 3; r++) out[r] = p.t[r]! + p.m[r * 3]! * v[0]! + p.m[r * 3 + 1]! * v[1]! + p.m[r * 3 + 2]! * v[2]!;
  return out;
}
const colorOf = (p: Placement, c: number) => (c === 16 ? p.color : c);

function then(p: Placement, ref: LDrawPartRef): Placement {
  const t = apply(p, [ref.x, ref.y, ref.z]);
  const m = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] = p.m[r * 3]! * ref.m[c]! + p.m[r * 3 + 1]! * ref.m[3 + c]! + p.m[r * 3 + 2]! * ref.m[6 + c]!;
  return { m, t, color: colorOf(p, ref.colorCode) };
}

class Flattener {
  private items = 0;
  constructor(
    private readonly blocks: Map<string, Block>,
    private readonly out: LDrawReadResult,
  ) {}

  add(block: Block, at: Placement, depth: number, stack: string[]): boolean {
    for (const ref of block.parts) {
      const key = ref.filename.trim().toLowerCase();
      const sub = this.blocks.get(key);
      if (sub && !stack.includes(key)) {
        if (depth >= MAX_DEPTH) return false;
        stack.push(key);
        const ok = this.add(sub, then(at, ref), depth + 1, stack);
        stack.pop();
        if (!ok) return false;
        continue;
      }
      if (++this.items > MAX_ITEMS) return false;
      const p = then(at, ref);
      this.out.parts.push({ ...ref, colorCode: p.color, x: p.t[0]!, y: p.t[1]!, z: p.t[2]!, m: p.m });
    }
    for (const prim of block.primitives) {
      if (++this.items > MAX_ITEMS) return false;
      this.out.primitives.push({ kind: prim.kind, colorCode: colorOf(at, prim.colorCode), v: prim.v.map((v) => apply(at, v) as [number, number, number]) });
    }
    return true;
  }
}

/** QString::trimmed's whitespace. */
// eslint-disable-next-line no-control-regex
const trim = (s: string) => s.replace(/^[\s\u0000- ]+|[\s\u0000- ]+$/g, '');

export function readLDraw(text: string): LDrawReadResult {
  const r = emptyRead();
  const blocks = new Map<string, Block>();
  const single: Block = { parts: [], primitives: [] };
  const ignored: Block = { parts: [], primitives: [] };
  let current = single;
  let main: Block | null = null;
  let mainKey = '';
  let firstComment = true;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = trim(line);
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const code = qtInt(parts[0]!);
    if (code === null) continue;

    if (code === 0 && parts.length > 2 && parts[1] === 'FILE') {
      const name = trim(trimmed.slice(trimmed.indexOf('FILE') + 4));
      if (firstComment) {
        let title = name;
        for (const ext of ['.io', '.ldr', '.mpd', '.dat']) if (title.toLowerCase().endsWith(ext)) title = title.slice(0, -ext.length);
        r.title = title;
        firstComment = false;
      }
      const key = name.toLowerCase();
      if (blocks.has(key)) {
        current = ignored;
        continue;
      }
      current = { parts: [], primitives: [] };
      blocks.set(key, current);
      if (!main) {
        main = current;
        mainKey = key;
      }
      continue;
    }
    if (code === 0 && !r.author && parts.length > 1 && (main === null || current === main) && parts[1]!.toLowerCase() === 'author:') {
      r.author = trim(trimmed.slice(trimmed.indexOf(':') + 1)).slice(0, 120);
      continue;
    }
    if (code === 0 && firstComment) {
      if (parts.length > 1) r.title = trim(trimmed.slice(1));
      firstComment = false;
      continue;
    }
    if (code === 1) {
      if (parts.length < 15) continue;
      current.parts.push({
        colorCode: int0(parts[1]!),
        x: dbl0(parts[2]!),
        y: dbl0(parts[3]!),
        z: dbl0(parts[4]!),
        m: parts.slice(5, 14).map(dbl0),
        filename: parts.slice(14).join(' '),
      });
      continue;
    }
    if (code === 2 || code === 3 || code === 4) {
      if (parts.length < 2 + 3 * code) continue;
      const v: [number, number, number][] = [];
      for (let i = 0; i < code; i++) v.push([dbl0(parts[2 + i * 3]!), dbl0(parts[3 + i * 3]!), dbl0(parts[4 + i * 3]!)]);
      current.primitives.push({ kind: code, colorCode: int0(parts[1]!), v });
    }
  }

  if (!main) {
    r.parts = single.parts;
    r.primitives = single.primitives;
    r.ok = true;
    return r;
  }
  const flat = new Flattener(blocks, r);
  const stack: string[] = [];
  if (!flat.add(single, IDENTITY, 0, stack)) {
    r.error = 'The model is too large or its submodels nest too deeply.';
    return r;
  }
  stack.push(mainKey);
  if (!flat.add(main, IDENTITY, 0, stack)) {
    r.parts = [];
    r.primitives = [];
    r.error = 'The model is too large or its submodels nest too deeply.';
    return r;
  }
  r.ok = true;
  return r;
}
