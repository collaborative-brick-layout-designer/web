// LEGO Digital Designer models: the desktop's readLDD (src/import/ldd/
// LDDReader.cpp). An .lxf is a ZIP holding the LXFML document (named
// LXFML, else any .lxfml); an .lxfml is the document itself. Each brick
// becomes a reference "<designID>.<material>.dat" in LDD's own axes (+Y
// up), 25 LDU to an LDD unit, its first bone's transform (stored column-
// major, made row-major here). An assembly (a minifigure's parts) places
// each part on its own.

import { completeBaseName } from './prepare';
import { emptyRead, type LDrawPartRef, type LDrawReadResult } from './ldrawReader';
import { scanXml, xmlDouble, xmlInt } from './xmlScan';
import { SafeZip } from './zip';

const LDD_TO_LDU = 25;
const MAX_MODEL_BYTES = 64 * 1024 * 1024;

interface LddTransform {
  m: number[];
  t: [number, number, number];
  ok: boolean;
}

function parseTransform(s: string | undefined): LddTransform {
  const parts = (s ?? '').split(',');
  if (parts.length < 12) return { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], ok: false };
  const col = parts.slice(0, 9).map(xmlDouble);
  return {
    m: [col[0]!, col[3]!, col[6]!, col[1]!, col[4]!, col[7]!, col[2]!, col[5]!, col[8]!],
    t: [xmlDouble(parts[9]), xmlDouble(parts[10]), xmlDouble(parts[11])],
    ok: true,
  };
}

async function lxfmlOf(name: string, bytes: Uint8Array): Promise<{ xml: string | null; error: string }> {
  if (name.toLowerCase().endsWith('.lxfml')) return { xml: new TextDecoder().decode(bytes), error: '' };
  const zip = new SafeZip(bytes);
  if (!zip.valid) return { xml: null, error: `Not a readable LDD .lxf archive: ${name}` };
  const entry = zip.find('LXFML', true) ?? zip.entries.find((e) => !e.isDir && e.name.toLowerCase().endsWith('.lxfml'));
  if (!entry) return { xml: null, error: `No LXFML entry found inside ${name}` };
  try {
    return { xml: new TextDecoder().decode(await zip.read(entry, MAX_MODEL_BYTES)), error: '' };
  } catch {
    return { xml: null, error: `The LXFML inside ${name} is damaged` };
  }
}

export async function readLDD(name: string, bytes: Uint8Array): Promise<LDrawReadResult> {
  const out = emptyRead();
  out.lddAxes = true;
  const lower = name.toLowerCase();
  if (!lower.endsWith('.lxf') && !lower.endsWith('.lxfml')) {
    out.error = `Not a .lxf or .lxfml file: ${name}`;
    return out;
  }
  const { xml, error } = await lxfmlOf(name, bytes);
  if (xml === null) {
    out.error = error;
    return out;
  }
  const scan = scanXml(xml);
  const tags = scan.tags;
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!;
    if (tag.kind === 'end') continue;
    if (tag.name === 'LXFML') {
      out.title = tag.attrs.get('name') ?? '';
      if (!out.title) out.title = completeBaseName(name);
      continue;
    }
    if (tag.name !== 'Brick') continue;
    const designID = tag.attrs.get('designID') ?? '';
    const parts: { designID: string; matId: number; xform: LddTransform | null }[] = [];
    if (tag.kind === 'start') {
      for (i++; i < tags.length; i++) {
        const t = tags[i]!;
        if (t.kind === 'end' && t.name === 'Brick') break;
        if (t.kind === 'end') continue;
        if (t.name === 'Part') parts.push({ designID: t.attrs.get('designID') ?? '', matId: xmlInt((t.attrs.get('materials') ?? '').split(',')[0]) ?? 0, xform: null });
        if (t.name === 'Bone') {
          if (parts.length === 0) parts.push({ designID: '', matId: 0, xform: null });
          const last = parts[parts.length - 1]!;
          if (!last.xform?.ok) last.xform = parseTransform(t.attrs.get('transformation'));
        }
      }
    }
    let placed = parts;
    const assembly = parts.length > 1 && parts.every((p) => p.designID !== '');
    if (!assembly && parts.length > 0) {
      const single = { ...parts[0]!, designID };
      const withTransform = parts.find((p) => p.xform?.ok);
      if (withTransform) single.xform = withTransform.xform;
      placed = [single];
    }
    for (const p of placed) {
      if (!p.xform?.ok || !p.designID) continue;
      const ref: LDrawPartRef = {
        colorCode: p.matId > 0 ? p.matId : 1,
        x: p.xform.t[0] * LDD_TO_LDU,
        y: p.xform.t[1] * LDD_TO_LDU,
        z: p.xform.t[2] * LDD_TO_LDU,
        m: [...p.xform.m],
        filename: p.matId > 0 ? `${p.designID}.${p.matId}.dat` : `${p.designID}.dat`,
      };
      out.parts.push(ref);
    }
  }
  out.ok = !scan.error;
  if (scan.error) out.error = `LXFML parse error: ${scan.error}`;
  return out;
}
