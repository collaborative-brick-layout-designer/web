// A Studio file of an engine, for the trains-from-a-model journeys: a 28 x 6
// stud base, two bogie plates 9 studs either side of its middle, four wheel
// holders round them and a magnet coupler 15 studs out at each end. Its
// parts come in the file itself (Studio's CustomParts), each a flat plate,
// so the e2e stack's tiny LDraw library draws it. Stored (not encrypted),
// as Studio's older versions write them.

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries: { name: string; text: string }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.text, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

/** A flat w x d stud plate at the part's origin (LDraw: 20 LDU a stud, -y up). */
function plate(name: string, w: number, d: number): string {
  const x = w * 10;
  const z = d * 10;
  return `0 ${name}\n4 16 ${-x} -8 ${-z} ${x} -8 ${-z} ${x} -8 ${z} ${-x} -8 ${z}\n`;
}

const MODEL = [
  '0 FILE Santa Fe engine.io',
  '0 Santa Fe engine',
  '0 Author: Test Builder',
  '1 4 0 0 0 1 0 0 0 1 0 0 0 1 base.dat',
  '1 0 180 8 0 1 0 0 0 1 0 0 0 1 4092a.dat',
  '1 0 -180 8 0 1 0 0 0 1 0 0 0 1 4092a.dat',
  '1 0 130 16 0 1 0 0 0 1 0 0 0 1 2878c01.dat',
  '1 0 230 16 0 1 0 0 0 1 0 0 0 1 2878c01.dat',
  '1 0 -130 16 0 1 0 0 0 1 0 0 0 1 2878c01.dat',
  '1 0 -230 16 0 1 0 0 0 1 0 0 0 1 2878c01.dat',
  '1 7 300 0 0 1 0 0 0 1 0 0 0 1 2920.dat',
  '1 7 -300 0 0 1 0 0 0 1 0 0 0 1 2920.dat',
  '0 NOFILE',
  '',
].join('\n');

/** The engine as a .io file's bytes. */
export function engineIo(): Uint8Array {
  return zip([
    { name: 'model.ldr', text: MODEL },
    { name: 'CustomParts/base.dat', text: plate('Engine base', 28, 6) },
    { name: 'CustomParts/4092a.dat', text: plate('Bogie plate', 2, 4) },
    { name: 'CustomParts/2878c01.dat', text: plate('Wheel holder', 1, 6) },
    { name: 'CustomParts/2920.dat', text: plate('Magnet coupler', 2, 2) },
  ]);
}
