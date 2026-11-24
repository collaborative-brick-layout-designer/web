// Any model the browser imports, as the desktop's prepareImport picks its
// path (src/ui/ImportPipeline.cpp): LDraw files are read as they are; a
// Studio .io is unpacked (studioReader.ts) and drawn the same way, its own
// custom parts first, from Studio's library when the site has one; an LDD
// model is drawn from LDD's own brick shapes (fromLDDGeometry), its snap
// points found by placing it as LDraw parts through ldraw.xml, or, without
// LDD's database, drawn as the LDraw model ldraw.xml makes of it. Without
// either, only the server can compose it from BlueBrick's sprites.

import { bakeLdd, lddDesignIds, readMaterials } from './lddGeom';
import { LddMapping } from './lddMapping';
import { readLDD } from './lddReader';
import type { LddSource } from './lddSource';
import { externalConnections, toBlueBrickMap } from './connections';
import { LDrawFiles } from './library';
import { MeshLoader } from './meshLoader';
import { Palette } from './palette';
import { emptyPart, formerNames, friendlyImportWarnings, prepareLDraw, type PrepareOptions, type PreparedPart } from './prepare';
import { IMPORT_RASTER, rasterizeMeshTopDown } from './rasterize';
import { readStudioIo } from './studioReader';
import { stockGuessFor } from './stockGuess';

export type ModelFormat = 'ldraw' | 'studio' | 'ldd';

export function formatOf(fileName: string): ModelFormat {
  return /\.io$/i.test(fileName) ? 'studio' : /\.(lxf|lxfml)$/i.test(fileName) ? 'ldd' : 'ldraw';
}

export const KIND_LABEL: Record<ModelFormat, string> = { ldraw: 'LDraw import', studio: 'Studio import', ldd: 'LDD import' };

/** The model needs the server: the desktop composes it from BlueBrick's sprites, the browser can't. */
export class NeedsServer extends Error {}

export interface ModelOptions extends Omit<PrepareOptions, 'source'> {
  /** The LDraw (or Studio) library; null when the site has none. */
  source: PrepareOptions['source'] | null;
  /** LDD's database and mapping (LDD files). */
  ldd?: LddSource | null;
}

export async function prepareModel(fileName: string, bytes: Uint8Array, opts: ModelOptions): Promise<PreparedPart> {
  const format = formatOf(fileName);
  if (format === 'ldd') return prepareLdd(fileName, bytes, opts);
  if (!opts.source) throw new NeedsServer('This site has no LDraw library for the browser to draw with.');
  const withSource = { ...opts, source: opts.source };
  if (format === 'studio') {
    const read = await readStudioIo(bytes);
    if (!read.ok) {
      const out = emptyPart(fileName, KIND_LABEL.studio);
      out.error = `Could not read ${fileName}: ${read.error}`;
      return out;
    }
    return prepareLDraw(fileName, '', { ...withSource, read }, KIND_LABEL.studio);
  }
  return prepareLDraw(fileName, new TextDecoder().decode(bytes), withSource, KIND_LABEL.ldraw);
}

async function prepareLdd(fileName: string, bytes: Uint8Array, opts: ModelOptions): Promise<PreparedPart> {
  const out = emptyPart(fileName, KIND_LABEL.ldd);
  const read = await readLDD(fileName, bytes);
  if (!read.ok) {
    out.error = `Could not read ${fileName}: ${read.error}`;
    return out;
  }
  out.title = read.title.trim();
  out.designer = read.author;
  const mapping = new LddMapping();
  const haveMapping = mapping.load((await opts.ldd?.mapping()) ?? null);

  if (opts.ldd?.hasAssets) {
    const ids = lddDesignIds(read);
    const [shapes, materialsXml] = await Promise.all([
      opts.ldd.shapes(ids, (done, total) => opts.onFetch?.({ done, total }), opts.signal),
      opts.ldd.materials(),
    ]);
    opts.signal?.throwIfAborted();
    opts.onDraw?.();
    const baked = bakeLdd(read, shapes, readMaterials(materialsXml));
    const rast = baked.mesh.triColor.length ? rasterizeMeshTopDown(baked.mesh, IMPORT_RASTER) : null;
    out.warnings = friendlyImportWarnings(baked.errors, true);
    out.stats.lddRendered = baked.rendered;
    out.stats.unresolved = baked.skipped;
    if (!rast?.image) {
      out.error = 'LDD’s brick database on this site has no geometry for this model.';
      return out;
    }
    out.sprite = rast.image;
    out.widthStuds = Math.round(rast.spriteStuds.width);
    out.heightStuds = Math.round(rast.spriteStuds.height);
    out.snapMargin = rast.snapMargin;
    out.contentStuds = { ...rast.meshBoundsXZ, x: rast.meshBoundsXZ.x - rast.spriteStuds.x, y: rast.meshBoundsXZ.y - rast.spriteStuds.y };
    out.baseOnGrid = rast.baseOnGrid;
    // Snap points need LDraw part numbers: through ldraw.xml (its built-in
    // track even without one). LDD's mesh frame and the LDraw model's top
    // view line up. With an LDraw library, each part's real centre is checked.
    const ldraw = mapping.toLDraw(read);
    out.stockGuess = stockGuessFor(haveMapping ? ldraw : read, rast.meshBoundsXZ, rast.spriteStuds);
    let loader: MeshLoader | undefined;
    let moved: Record<string, string[]> = {};
    if (opts.source) {
      const files = new LDrawFiles(opts.source);
      await files.load(
        ldraw.parts.map((p) => p.filename),
        opts.signal ? { signal: opts.signal } : {},
      );
      loader = new MeshLoader(files, new Palette());
      moved = await opts.source.moved();
    }
    const placed = toBlueBrickMap(ldraw, opts.parts, (n) => formerNames(moved, n), loader);
    out.connections = externalConnections(placed, opts.parts, { x: rast.spriteStuds.x + rast.spriteStuds.width / 2, y: rast.spriteStuds.y + rast.spriteStuds.height / 2 });
    return out;
  }

  // No brick database: the LDraw model LDD itself would export.
  if (!haveMapping || !opts.source) throw new NeedsServer('This site has neither LDD’s brick database nor the LDraw parts this browser would need.');
  const ldraw = mapping.toLDraw(read);
  return prepareLDraw(fileName, '', { ...opts, source: opts.source, read: { ...ldraw, title: read.title, author: read.author } }, KIND_LABEL.ldd);
}
