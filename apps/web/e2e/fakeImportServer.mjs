// The end-to-end tests' stand-in for the desktop's import converter
// (bld-import-server, desktop docs/import-server.md): the same command line
// and JSON, a two-part model's numbers, a real picture. The e2e stack
// (.github/actions/e2e-stack) writes it out with this node's path as its
// first line and __BBM__ replaced, and points IMPORT_CONVERTER at it. The
// real converter is checked against the desktop app in the desktop repo.
import fs from 'node:fs';
import p from 'node:path';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
const SANDBOX = { rlimits: true, noNewPrivs: true, netns: false, seccomp: true, socketBlocked: true, execBlocked: true, forkBlocked: true };
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('bld-import-server 2.1.11');
  process.exit(0);
}
if (args[0] === '--sandbox-check') {
  console.log(JSON.stringify({ ok: true, sandbox: SANDBOX }));
  process.exit(0);
}
const req = JSON.parse(fs.readFileSync(args[args.length - 1], 'utf8'));
const base = p.basename(req.input);
const out = { ok: true, version: '2.1.11', sandbox: SANDBOX };
const ldr = /\.(ldr|mpd)$/i.test(base);
const stats = { ldrawResolved: 2, lddRendered: 0, unresolved: 1 };
if (req.command === 'analyse') {
  fs.writeFileSync(p.join(req.outDir, 'preview.png'), PNG);
  Object.assign(out, {
    format: base.endsWith('.io') ? 'studio' : /\.lxf/i.test(base) ? 'ldd' : 'ldraw',
    kindLabel: base.endsWith('.io') ? 'Studio import' : /\.lxf/i.test(base) ? 'LDD import' : 'LDraw import',
    title: 'Two straights',
    designer: 'Robin',
    suggestedName: 'Two straights',
    partKey: 'Two_straights',
    part: {
      widthStuds: 8, heightStuds: 2, pxPerStud: 32, contentStuds: { x: 0, y: 0, width: 8, height: 2 }, baseOnGrid: true,
      snapMargin: { left: 0, top: 0, right: 0, bottom: 0 },
      connections: [{ type: '1', x: -4, y: 0, angle: 180 }, { type: '1', x: 4, y: 0, angle: 0 }],
      stats, warnings: ['1 part(s) aren’t in your LDraw library, so they’re left out of the picture: 3001.'], sprite: 'preview.png',
    },
  });
  if (ldr) out.layout = { sheets: 4, bricks: 300, warnings: [], partlyRead: false };
} else if (req.options.mode === 'parts') {
  fs.copyFileSync('__BBM__', p.join(req.outDir, 'layout.bbm'));
  Object.assign(out, { mode: 'parts', bbm: 'layout.bbm', sheets: 4, bricks: 300, warnings: [] });
} else {
  const name = req.options.name || 'Two straights';
  const key = name.replace(/[^A-Za-z0-9]+/g, '_');
  fs.mkdirSync(p.join(req.outDir, 'part'), { recursive: true });
  fs.writeFileSync(p.join(req.outDir, 'part', key + '.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<part>\n  <Author>${req.options.author || ''}</Author>\n  <Description>\n    <en>${name}</en>\n  </Description>\n  <PixelsPerStud>32</PixelsPerStud>\n</part>\n`);
  fs.writeFileSync(p.join(req.outDir, 'part', key + '.png'), PNG);
  Object.assign(out, { mode: 'part', partKey: key, displayName: name, xml: `part/${key}.xml`, sprite: `part/${key}.png`, spriteMime: 'image/png',
    widthStuds: req.options.quarterTurns % 2 ? 2 : 8, heightStuds: req.options.quarterTurns % 2 ? 8 : 2, connections: 2 - (req.options.drop || []).length, stats, warnings: [] });
}
console.log(JSON.stringify(out));
