// How fast one live connection may send, as token buckets (a burst, then a
// steady rate). The numbers are far above what the apps send
// (routes/test/wsPacing.test.ts measures them): an edit is one message per
// action (a drag writes once, on the drop), presence goes out at most 20
// times a second, a reconnect after offline work is one sync step 2, and a
// client asks for the whole layout (sync step 1) once per connection, twice
// when an update it got couldn't be read.

/** Per-connection limits. Mutable only so tests can tighten them. */
export const wsPacing = {
  /** Messages of any kind: a burst of this many... */
  messageBurst: 1000,
  /** ...then this many a second. */
  messagesPerSecond: 250,
  /** Bytes: a burst of this many (three of the largest message taken, 16 MiB)... */
  byteBurst: 48 * 1024 * 1024,
  /** ...then this many a second. */
  bytesPerSecond: 8 * 1024 * 1024,
  /** Requests for the layout (sync step 1): a burst of this many... */
  step1Burst: 5,
  /** ...then one every this many milliseconds. */
  step1EveryMs: 10_000,
  /**
   * Bytes of the room's document one person's updates may have the grid
   * guard copy (ws/gridGuard.ts, the few updates it can't work out from the
   * keys they touch): a burst of this many, across their connections...
   */
  copyByteBurst: 16 * 1024 * 1024,
  /** ...then this many a second (a copy takes roughly 0.1 ms per KB). */
  copyBytesPerSecond: 1024 * 1024,
  /**
   * The work Yjs may do applying one person's updates (ws/yjsWork.ts, in
   * structs walked plus values copied), across their connections: a burst
   * of this many...
   */
  workBurst: 8_000_000,
  /** ...then this many a second. */
  workPerSecond: 2_000_000,
  /**
   * Bytes of a room's document the copies may take that are worked out
   * because changes waiting for another editor's land (ws/pending.ts
   * waitingCosts): a burst of this many per room...
   */
  roomCopyByteBurst: 16 * 1024 * 1024,
  /** ...then this many a second. */
  roomCopyBytesPerSecond: 1024 * 1024,
};

export class TokenBucket {
  private readonly capacity: number;
  private readonly perMs: number;
  private tokens: number;
  private last: number;

  constructor(capacity: number, perMs: number, now: number = Date.now()) {
    this.capacity = capacity;
    this.perMs = perMs;
    this.tokens = capacity;
    this.last = now;
  }

  /** Take `n` tokens if there are that many; false (and nothing taken) if not. */
  take(n = 1, now: number = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Give back `n` tokens (up to the burst): for a message found not to count. */
  give(n = 1, now: number = Date.now()): void {
    this.take(0, now);
    this.tokens = Math.min(this.capacity, this.tokens + n);
  }

  /** Whether any tokens are left (none after a charge took it below zero). */
  available(now: number = Date.now()): boolean {
    return this.take(0, now) && this.tokens > 0;
  }

  /** Take `n` tokens after the fact, below zero if need be (work already done). */
  charge(n: number, now: number = Date.now()): void {
    this.take(0, now);
    this.tokens -= n;
  }

  /** Whether it has refilled completely (nothing owed, nothing to remember). */
  full(now: number = Date.now()): boolean {
    this.take(0, now);
    return this.tokens >= this.capacity;
  }
}

const copyBuckets = new Map<string, TokenBucket>();

/** The grid guard's copy budget of one person (wsPacing.copyByteBurst / copyBytesPerSecond), shared by their connections. */
export function copyBudget(userId: string, now: number = Date.now()): TokenBucket {
  let bucket = copyBuckets.get(userId);
  if (!bucket) {
    if (copyBuckets.size >= 10_000) for (const [id, b] of copyBuckets) if (b.full(now)) copyBuckets.delete(id);
    bucket = new TokenBucket(wsPacing.copyByteBurst, wsPacing.copyBytesPerSecond / 1000, now);
    copyBuckets.set(userId, bucket);
  }
  return bucket;
}

const workBuckets = new Map<string, TokenBucket>();

/** The Yjs work budget of one person (wsPacing.workBurst / workPerSecond), shared by their connections. */
export function workBudget(userId: string, now: number = Date.now()): TokenBucket {
  let bucket = workBuckets.get(userId);
  if (!bucket) {
    if (workBuckets.size >= 10_000) for (const [id, b] of workBuckets) if (b.full(now)) workBuckets.delete(id);
    bucket = new TokenBucket(wsPacing.workBurst, wsPacing.workPerSecond / 1000, now);
    workBuckets.set(userId, bucket);
  }
  return bucket;
}

/** Forget every copy and work budget (tests). */
export function resetCopyBudgets(): void {
  copyBuckets.clear();
  workBuckets.clear();
}

/** One connection's buckets. */
export interface Pace {
  messages: TokenBucket;
  bytes: TokenBucket;
  step1: TokenBucket;
}

export function newPace(now: number = Date.now()): Pace {
  return {
    messages: new TokenBucket(wsPacing.messageBurst, wsPacing.messagesPerSecond / 1000, now),
    bytes: new TokenBucket(wsPacing.byteBurst, wsPacing.bytesPerSecond / 1000, now),
    step1: new TokenBucket(wsPacing.step1Burst, 1 / wsPacing.step1EveryMs, now),
  };
}
