// The LDraw library files a model needs, fetched before it's drawn. The
// site resolves each name the way the desktop's LDrawLibrary::resolve does
// (apps/server/src/imports/libraryFiles.ts), so here a name is only ever a
// key: the files a model came with first (a Studio file's CustomParts, by
// their file name, as the desktop's overlay folders), then the site's.
//
// The desktop reads a part's sub-files as it draws it; the browser can't
// wait on the network while it draws, so it walks the references first:
// the model's parts, then what they refer to, and so on, a batch a round.

/** Where library files come from (the site, or a folder in tests). */
export interface LibrarySource {
  /** Each name's text (null when the library has none). Names are as written in the files. */
  fetch(names: string[], signal?: AbortSignal): Promise<Map<string, string | null>>;
  /** LDConfig.ldr (the colors), or null. */
  ldconfig(): Promise<string | null>;
  /** "~Moved to" stubs: new name → earlier names (lower-case, no .dat). */
  moved(): Promise<Record<string, string[]>>;
}

/** The cache key for a reference: lower-case, forward slashes (the desktop's resolve cache). */
export function refKey(name: string): string {
  return name.trim().toLowerCase().replace(/\\/g, '/');
}

function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

export interface FetchProgress {
  done: number;
  total: number;
}

/** A type-1 line's file name, as the desktop's mesh loader reads it (null for any other line). */
export function subfileOf(line: string): string | null {
  const toks = line.split(/\s+/).filter(Boolean);
  if (toks.length < 15 || toks[0] !== '1') return null;
  const name = toks.slice(14).join(' ').trim();
  return name || null;
}

export class LDrawFiles {
  private readonly texts = new Map<string, string | null>();
  private readonly overlay: Map<string, string>;

  constructor(
    private readonly source: LibrarySource,
    overlay?: Map<string, string>,
  ) {
    this.overlay = new Map([...(overlay ?? new Map<string, string>())].map(([k, v]) => [k.toLowerCase(), v]));
  }

  /** A file's text: the model's own first; undefined when it was never fetched. */
  get(name: string): string | null | undefined {
    const key = refKey(name);
    const own = this.overlay.get(baseName(key));
    if (own !== undefined) return own;
    return this.texts.get(key);
  }

  /** Whether `name` resolves to a file (after `load`). */
  has(name: string): boolean {
    return this.get(name) != null;
  }

  /**
   * Fetch `roots` and everything they refer to, a round at a time.
   * `onProgress` sees the files fetched so far and the total known so far.
   */
  async load(roots: Iterable<string>, opts: { signal?: AbortSignal; onProgress?: (p: FetchProgress) => void; batch?: number } = {}): Promise<void> {
    const batch = opts.batch ?? 200;
    const seen = new Set<string>();
    let pending: string[] = [];
    const want = (name: string) => {
      const key = refKey(name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      // The model's own files need no fetching, but what they use might.
      const own = this.overlay.get(baseName(key));
      if (own !== undefined) {
        for (const line of own.split(/\r?\n/)) {
          const child = subfileOf(line);
          if (child) want(child);
        }
        return;
      }
      if (!this.texts.has(key)) pending.push(name);
    };
    for (const r of roots) want(r);
    let done = 0;
    let total = pending.length;
    opts.onProgress?.({ done, total });
    while (pending.length) {
      opts.signal?.throwIfAborted();
      const round = pending;
      pending = [];
      for (let i = 0; i < round.length; i += batch) {
        const names = round.slice(i, i + batch);
        const got = await this.source.fetch(names, opts.signal);
        for (const n of names) {
          const text = got.get(n) ?? null;
          this.texts.set(refKey(n), text);
          done++;
          if (text) {
            for (const line of text.split(/\r?\n/)) {
              const child = subfileOf(line);
              if (child) want(child);
            }
          }
        }
        total = done + pending.length + (round.length - i - names.length);
        opts.onProgress?.({ done, total });
      }
    }
  }
}
