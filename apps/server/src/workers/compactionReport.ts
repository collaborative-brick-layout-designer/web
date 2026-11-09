// Layouts the last daily compaction had to skip (a saved copy that can't be
// read), for Admin › Dashboard. Kept in memory: the next run says again.

let skipped: string[] = [];

export function setCompactionSkipped(ids: readonly string[]): void {
  skipped = [...ids];
}

export function compactionSkipped(): readonly string[] {
  return skipped;
}
