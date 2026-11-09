// Presence colors, the same in both apps (desktop src/sync/Presence.cpp;
// fixtures/contracts/presence-colors.json checks they agree).
//
// Each person has a first-choice color for a layout, from a well-mixed hash
// of their id and the layout's. The people here are taken in order of their
// ids, and each gets their first choice unless someone before them has it,
// else the next color along that nobody has. Everyone works it out from the
// same people, so everyone sees the same colors, and two people share one
// only when more than eight are here. (The old hash, (h * 31 + c) | 0, kept
// mostly the user's part: the same two people had the same color on almost
// every layout.)

export const PRESENCE_PALETTE = [
  '#f87171', // red
  '#fb923c', // orange
  '#facc15', // yellow
  '#4ade80', // green
  '#22d3ee', // cyan
  '#60a5fa', // blue
  '#a78bfa', // violet
  '#f472b6', // pink
] as const;

/** FNV-1a over the UTF-16 code units, then murmur3's finalizer. */
function mix(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A person's first-choice color on a layout (an index into PRESENCE_PALETTE). */
export function firstChoice(userId: string, layoutId: string): number {
  return mix(`${userId}:${layoutId}`) % PRESENCE_PALETTE.length;
}

/** The color of each person here (`userIds`, yourself included), the same in every app. */
export function presenceColors(userIds: readonly string[], layoutId: string): Map<string, string> {
  const ids = [...new Set(userIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const taken = new Set<number>();
  const out = new Map<string, string>();
  for (const id of ids) {
    const first = firstChoice(id, layoutId);
    let pick = first;
    if (taken.size < PRESENCE_PALETTE.length) {
      for (let k = 0; k < PRESENCE_PALETTE.length; k++) {
        const c = (first + k) % PRESENCE_PALETTE.length;
        if (!taken.has(c)) {
          pick = c;
          break;
        }
      }
    }
    taken.add(pick);
    out.set(id, PRESENCE_PALETTE[pick]!);
  }
  return out;
}
