// Guessing a model's trucks and couplers (trains design 3.3, Phase 6): an
// imported model's parts, seen from above, say where its wheels and magnets
// are. Bogie plates and motors are the trucks' pivots; failing those, wheel
// clusters; failing those, a quarter of the length in from each end. The
// desktop's src/track/StockGuess.cpp is the twin; both run
// fixtures/contracts/truck-guess.json and keep its `parts` word for word.

/** Part ids by what they are on a car (the contract's `parts`). */
export const STOCK_PARTS = {
  _about: 'Part ids by what they are on a car. Wheels and bogies under it, couplers at its ends.',
  clusterGap: 6,
  minCouplerSpan: 4,
  bogie: ['4092a', '4092b', '18626', '2686', '2686c01', '2686c02'],
  motor: ['2894c01', '87574c01', '88002*', '2683c01', '2684c01', '579c01', '579c02', '579c03', '579p01c01', '579p01c02', '579p01c03', '501ac01', '501bc01', '501cc01'],
  wheel: ['2878', '2878c01', '2878c02', '38339', '38339c01', '38339c02', '38340', '57878', '55423', '85489a', '85489b', '85489ac01', '4180c01', '4180c02', '243c01', '244c01', '244c02', '244c03', '245c01', '245c02', '447c01', '867', '50254', '2927'],
  coupler: ['2920', '4022', '4022c01', '4022c02', '4023', '4023c01', '4023c02', '29084', '64414', '64422', '64417c01', '2609b', '2609bc01', '2609c', '2609cc01', '2609d', '2609dc01', '30159b', '30159bc01', '753c01', '753c02', '2607bc01', '499c01', '735', '290'],
};

export interface GuessRef {
  /** The part's file name, as the model names it (folders and .dat allowed). */
  id: string;
  /** Its origin seen from above, studs (y down). */
  x: number;
  y: number;
}

export interface GuessRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StockGuess {
  /** Clockwise quarter turns that make the model run along x, its front to the right. */
  quarterTurns: 0 | 1;
  /** Coupler to coupler, studs. */
  length: number;
  width: number;
  bodyLength: number;
  /** [front, rear]: studs from the picture's middle along the car. */
  trucks: [number, number];
  /** What the trucks came from: bogie plates or motors, wheels, or neither (the quick-car default). */
  trucksFrom: 'bogies' | 'wheels' | 'none';
  /** Whether magnets (couplers) were found at both ends. */
  couplersFrom: 'found' | 'none';
}

type PartClass = 'bogie' | 'motor' | 'wheel' | 'coupler';
const CLASSES: readonly PartClass[] = ['bogie', 'motor', 'wheel', 'coupler'];

/** A model's part file name as the table lists it: no folders, no .dat, lower case. */
export function stockPartId(file: string): string {
  const base = file.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
  return base.endsWith('.dat') ? base.slice(0, -4) : base;
}

function classOf(id: string): PartClass | null {
  for (const c of CLASSES) {
    for (const e of STOCK_PARTS[c]) {
      if (e.endsWith('*') ? id.startsWith(e.slice(0, -1)) : id === e) return c;
    }
  }
  return null;
}

/** The middles of runs of values no more than `gap` apart, lowest first. */
function clusters(values: number[], gap: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const v of sorted) {
    const last = runs[runs.length - 1];
    if (last && v - last[last.length - 1]! <= gap) last.push(v);
    else runs.push([v]);
  }
  return runs.map((r) => r.reduce((s, v) => s + v, 0) / r.length);
}

const r2 = (v: number) => Math.floor(v * 100 + 0.5) / 100 || 0;

/**
 * Where a model's trucks and couplers are. `refs`: its parts from above;
 * `bounds`: its footprint; `centre`: the picture's middle (all studs, one frame).
 */
export function guessStock(refs: readonly GuessRef[], bounds: GuessRect, centre: { x: number; y: number }): StockGuess {
  const alongX = bounds.width >= bounds.height;
  // A clockwise quarter turn takes (x, y) to (-y, x) about the middle.
  const along = (p: { x: number; y: number }) => (alongX ? p.x - centre.x : -(p.y - centre.y));
  const lo = alongX ? bounds.x - centre.x : -(bounds.y + bounds.height - centre.y);
  const hi = alongX ? bounds.x + bounds.width - centre.x : -(bounds.y - centre.y);
  const width = alongX ? bounds.height : bounds.width;
  const at: Record<PartClass, number[]> = { bogie: [], motor: [], wheel: [], coupler: [] };
  for (const r of refs) {
    const c = classOf(stockPartId(r.id));
    if (c) at[c].push(along(r));
  }
  const pivots = clusters([...at.bogie, ...at.motor], STOCK_PARTS.clusterGap);
  const wheels = clusters(at.wheel, STOCK_PARTS.clusterGap);
  let trucksFrom: StockGuess['trucksFrom'] = 'none';
  let front = 0;
  let rear = 0;
  if (pivots.length >= 2) {
    trucksFrom = 'bogies';
    front = pivots[pivots.length - 1]!;
    rear = pivots[0]!;
  } else if (wheels.length >= 2) {
    trucksFrom = 'wheels';
    front = wheels[wheels.length - 1]!;
    rear = wheels[0]!;
  }
  const c = at.coupler;
  const span = c.length >= 2 ? Math.max(...c) - Math.min(...c) : 0;
  const found = c.length >= 2 && span >= STOCK_PARTS.minCouplerSpan;
  const bodyLength = found ? Math.max(1, span - 2) : hi - lo;
  const length = found ? span : bodyLength + 2;
  if (trucksFrom === 'none') {
    front = length / 4;
    rear = -length / 4;
  }
  return {
    quarterTurns: alongX ? 0 : 1,
    length: r2(length),
    width: r2(width),
    bodyLength: r2(bodyLength),
    trucks: [r2(front), r2(rear)],
    trucksFrom,
    couplersFrom: found ? 'found' : 'none',
  };
}

/** A record's fields from a guess (the quick-car defaults for the rest). */
export function stockFromGuess(g: Pick<StockGuess, 'length' | 'width' | 'bodyLength' | 'trucks'>): { length: number; width: number; bodyLength: number; trucks: { at: number; swivelMax: number }[] } {
  return { length: g.length, width: g.width, bodyLength: g.bodyLength, trucks: g.trucks.map((at) => ({ at, swivelMax: 30 })) };
}
