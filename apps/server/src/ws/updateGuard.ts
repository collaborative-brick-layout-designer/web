// A check on the bytes of a shared layout before the server reads them,
// the same check the desktop runs (desktop src/sync/UpdateGuard.cpp, same
// rules, same limits, same test vectors: fixtures/contracts/update-guard.json).
//
// Whatever the server takes it also stores and sends to every desktop, and
// the desktop's Yjs (yrs) refuses some updates the web's Yjs reads: so the
// server refuses them on the way in, and both apps hold the same layout.
// The walk follows the update v1 encoding without allocating, and refuses:
//
// - more than MAX_UPDATE_BYTES;
// - a count or length longer than the bytes left could hold;
// - values nested deeper than MAX_NESTING;
// - content kinds the desktop can't read, or a layout never holds (weak links,
//   JSON content, XML hooks);
// - strings with a NUL character in them;
// - an empty block (GC, skip, or an item of no content);
// - deleted ranges that are empty, out of order, or a client's listed twice;
// - a clock (where a change sits in its editor's run of changes) past
//   MAX_CLOCK;
// - a client id past MAX_CLIENT.
//
// Where yrs reads a field differently from Yjs, the walk follows yrs, like
// the desktop's. Two such fields: JSON content (yrs reads one string more
// than its count) and an XML hook (Yjs reads a name after it, yrs nothing).
// Neither app writes either, and Yjs reads the rest of such an update out of
// step with yrs, and writes back what it read the Yjs way, which the desktop
// then can't read: a room that took one would send every desktop a layout it
// refuses. So the server refuses both (the desktop's own guard reads them
// the yrs way).

/** The largest update or state vector read (the desktop's kMaxUpdateBytes). */
export const MAX_UPDATE_BYTES = 64 * 1024 * 1024;

/** How deep values may nest (the desktop's kMaxNesting). The layout model nests 5 deep. */
export const MAX_NESTING = 256;

/**
 * The highest clock read (the desktop's kMaxClock), in blocks (to their
 * end), the ids they point at, deleted ranges and state vectors. The
 * desktop's yrs keeps clocks as 32-bit numbers and works out the gap before
 * a block with signed 32-bit arithmetic, which goes wrong past this. A clock
 * counts one editor's changes in one session: real layouts stay far below it.
 */
export const MAX_CLOCK = 0x7fff_ffff;

/**
 * The highest client id read. Yjs picks 32-bit ids, yrs 53-bit ones (the
 * largest whole number a JavaScript number holds exactly); Yjs can't read a
 * larger one back once it has stored it (its document then can't be
 * written out at all).
 */
export const MAX_CLIENT = Number.MAX_SAFE_INTEGER;

// Block info byte.
const GC = 0;
const SKIP = 10;
const HAS_ORIGIN = 0x80;
const HAS_RIGHT_ORIGIN = 0x40;
const HAS_PARENT_SUB = 0x20;

class Refused extends Error {}

class Walk {
  private p = 0;
  private readonly b: Uint8Array;
  /** When set, update() lists each block of structs' client id here, in order. */
  clients: number[] | null = null;
  /** Where the next block of the client being read starts. */
  private clock = 0;
  /** It holds JSON content (refused once the rest is read, as the desktop would refuse it otherwise). */
  private json = false;

  constructor(bytes: Uint8Array) {
    this.b = bytes;
  }

  private left(): number {
    return this.b.length - this.p;
  }

  private fail(why: string): never {
    throw new Refused(why);
  }

  private u8(): number {
    if (this.p >= this.b.length) this.fail('it ends early');
    return this.b[this.p++]!;
  }

  private skip(n: number): void {
    if (n > this.left()) this.fail('it ends early');
    this.p += n;
  }

  /** lib0 varUint. Ten bytes hold 64 bits; Yjs never writes more. (Precision past 2^53 doesn't matter: only compared with byte counts.) */
  private varUint(): number {
    let v = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const byte = this.u8();
      v += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return v;
      scale *= 128;
    }
    this.fail('a number runs on past 64 bits');
  }

  /** A count of things that each take at least `minBytes`: never more than the bytes left could hold. */
  private count(minBytes: number, what: string): number {
    const n = this.varUint();
    if (n > Math.floor(this.left() / minBytes)) this.fail(`it claims ${n} ${what} with ${this.left()} bytes left`);
    return n;
  }

  /** lib0 varUint8Array: a length, then that many bytes. Returns where they start. */
  private bytes(): [number, number] {
    const len = this.varUint();
    if (len > this.left()) this.fail(`a ${len}-byte string with ${this.left()} bytes left`);
    const start = this.p;
    this.p += len;
    return [start, len];
  }

  /** lib0 varString, without a NUL inside. Returns its length in UTF-16 code units (the clocks it takes as content). */
  private text(): number {
    const [start, len] = this.bytes();
    const s = this.b.subarray(start, start + len);
    if (len > 0 && s.includes(0)) this.fail('a string has a NUL character in it');
    let units = 0;
    for (const c of s) if ((c & 0xc0) !== 0x80) units += c >= 0xf0 ? 2 : 1;
    return units;
  }

  /** `length` clocks from `clock` must end within MAX_CLOCK. */
  private clockInRange(clock: number, length: number): void {
    if (clock > MAX_CLOCK || length > MAX_CLOCK - clock) this.fail(`a clock is past ${MAX_CLOCK}`);
  }

  /** A client id. */
  private client(): number {
    const v = this.varUint();
    if (v > MAX_CLIENT) this.fail(`a client id is past ${MAX_CLIENT}`);
    return v;
  }

  /** An id (client, clock). */
  private id(): void {
    this.client();
    this.clockInRange(this.varUint(), 0);
  }

  /** The next block of the client being read takes `length` clocks. */
  private place(length: number): void {
    this.clockInRange(this.clock, length);
    this.clock += length;
  }

  update(): void {
    const clients = this.count(3, 'clients'); // each: block count, client id, clock
    for (let c = 0; c < clients; c++) {
      const blocks = this.count(2, 'blocks'); // each: info byte and at least one more
      const client = this.client();
      this.clients?.push(client);
      this.clock = this.varUint(); // first clock
      this.clockInRange(this.clock, 0);
      for (let i = 0; i < blocks; i++) this.block();
    }
    this.deleteSet();
    if (this.json) this.fail('it holds JSON content, which Yjs and yrs read differently');
  }

  stateVector(): void {
    const clients = this.count(2, 'clients'); // each: client id, clock
    for (let c = 0; c < clients; c++) {
      this.client();
      this.clockInRange(this.varUint(), 0);
    }
  }

  private block(): void {
    const info = this.u8();
    if (info === GC || info === SKIP) {
      // Yjs never writes an empty one, and the desktop's yrs divides by zero
      // looking up a clock after an empty GC block.
      const length = this.varUint();
      if (length === 0) this.fail('it holds an empty block');
      this.place(length);
      return;
    }
    const cantCopyParentInfo = (info & (HAS_ORIGIN | HAS_RIGHT_ORIGIN)) === 0;
    if (info & HAS_ORIGIN) this.id();
    if (info & HAS_RIGHT_ORIGIN) this.id();
    if (cantCopyParentInfo) {
      if (this.varUint() === 1) this.text(); // a root type's name
      else this.id(); // or the id of the type it's in
      if (info & HAS_PARENT_SUB) this.text(); // map key
    }
    // An item of no content (no values, an empty string, a deletion of 0)
    // takes no clock: Yjs never writes one, and applying one leaves its
    // document unable to write itself out (Y.encodeStateAsUpdate throws).
    const length = this.content(info & 0x0f);
    if (length === 0) this.fail('it holds an empty block');
    this.place(length);
  }

  /** Returns how many clocks the content takes, as yrs counts them. */
  private content(ref: number): number {
    switch (ref) {
      case 1: // deleted: a length
        return this.varUint();
      case 2: {
        // JSON: yrs reads count + 1 strings, and takes as many clocks. Read
        // through like the desktop's walk, then refused (update()).
        const n = this.varUint();
        if (n >= this.left()) this.fail(`it claims ${n + 1} JSON values with ${this.left()} bytes left`);
        for (let i = 0; i <= n; i++) this.text();
        this.json = true;
        return n + 1;
      }
      case 3: // binary
        this.bytes();
        return 1;
      case 4: // string: as many clocks as UTF-16 code units
        return this.text();
      case 5: // embed (JSON text)
        this.text();
        return 1;
      case 6: // format: key, JSON text
        this.text();
        this.text();
        return 1;
      case 7: // a nested type
        this.typeRef();
        return 1;
      case 8: {
        // values
        const n = this.count(1, 'values');
        for (let i = 0; i < n; i++) this.any(0);
        return n;
      }
      case 9: // a sub-document: guid, options
        this.text();
        this.any(0);
        return 1;
      default:
        this.fail(`unknown content kind ${ref}`);
    }
  }

  private typeRef(): void {
    const ref = this.u8();
    switch (ref) {
      case 0: // array
      case 1: // map
      case 2: // text
      case 4: // XML fragment
      case 6: // XML text
      case 9: // sub-document
      case 15: // undefined
        return;
      case 3: // XML element: its name
        this.text();
        return;
      case 5: // XML hook: Yjs reads a name after it, yrs doesn't
        return this.fail('it holds an XML hook, which Yjs and yrs read differently');
      case 7:
        return this.fail('it holds a weak link, which layouts never use');
      default:
        return this.fail(`unknown type ${ref}`);
    }
  }

  /** lib0 Any (iterative, so a deep one can't overflow the stack here either). */
  private any(depth0: number): void {
    // Pending container items: [items left, depth of those items, is object].
    const stack: [number, number, boolean][] = [];
    let depth = depth0;
    for (;;) {
      if (depth > MAX_NESTING) this.fail(`values nest more than ${MAX_NESTING} deep`);
      const tag = this.u8();
      switch (tag) {
        case 127: // undefined
        case 126: // null
        case 121: // false
        case 120: // true
          break;
        case 125: // varInt: the same continuation bit as varUint
          this.varUint();
          break;
        case 124: // float32
          this.skip(4);
          break;
        case 123: // float64
        case 122: // bigint64
          this.skip(8);
          break;
        case 119: // string
          this.text();
          break;
        case 116: // bytes
          this.bytes();
          break;
        case 118: {
          // object: key, value pairs
          const n = this.count(2, 'object entries');
          if (n > 0) stack.push([n, depth + 1, true]);
          break;
        }
        case 117: {
          // array
          const n = this.count(1, 'array items');
          if (n > 0) stack.push([n, depth + 1, false]);
          break;
        }
        default:
          this.fail(`unknown value kind ${tag}`);
      }
      // The next value: the next item of the innermost open container.
      const top = stack.at(-1);
      if (!top) return;
      if (top[2]) this.text(); // object key
      depth = top[1];
      if (--top[0] === 0) stack.pop();
    }
  }

  private deleteSet(): void {
    const clients = this.count(2, 'deleted-range clients'); // each: client id, range count
    const seen = new Set<number>();
    for (let c = 0; c < clients; c++) {
      const client = this.client();
      if (seen.has(client)) this.fail('it lists the deletions of one client twice');
      seen.add(client);
      const ranges = this.count(2, 'deleted ranges'); // each: clock, length
      let last = 0;
      for (let r = 0; r < ranges; r++) {
        const clock = this.varUint();
        const length = this.varUint();
        this.clockInRange(clock, length);
        // Both apps write each client's ranges once, in order, none empty.
        // Yjs keeps the ones it can't apply yet as differences from the one
        // before (and throws on an empty one) part-way through applying an
        // update, so ranges out of order come back with clocks nobody wrote.
        if (length === 0) this.fail('it deletes an empty range');
        if (clock < last) this.fail('its deleted ranges are out of order');
        last = clock;
      }
    }
    // Anything after the delete set is ignored (yrs does the same).
  }
}

function run(bytes: Uint8Array, walk: (w: Walk) => void): string | null {
  if (bytes.length > MAX_UPDATE_BYTES) return `${bytes.length} bytes is over the ${MAX_UPDATE_BYTES / (1024 * 1024)} MiB limit`;
  try {
    walk(new Walk(bytes));
    return null;
  } catch (err) {
    if (err instanceof Refused) return err.message;
    throw err;
  }
}

/** Null when `update` (Yjs update v1) may be read; otherwise why not, for the log. */
export function checkUpdate(update: Uint8Array): string | null {
  return run(update, (w) => w.update());
}

/** The same for a state vector (sync step 1). */
export function checkStateVector(stateVector: Uint8Array): string | null {
  return run(stateVector, (w) => w.stateVector());
}

/**
 * The client of each block of structs in `update`, in order (Yjs reads only
 * the last block of a client that has two), or null when it can't be read.
 */
export function updateClientBlocks(update: Uint8Array): number[] | null {
  const clients: number[] = [];
  const why = run(update, (w) => {
    w.clients = clients;
    w.update();
  });
  return why === null ? clients : null;
}
