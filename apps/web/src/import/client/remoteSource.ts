// The site's import libraries over HTTP (apps/server/src/routes/
// importLibraries.ts), for the browser's importer: part files a batch at a
// time, kept in the browser's Cache Storage under each file's own versioned
// URL, so the next import of the same parts fetches nothing. A library
// update changes the version, so old copies simply aren't asked for again
// (and are cleared the next time).

import type { LibrarySource } from './library';

const CACHE_PREFIX = 'cbld-import-';
const BATCH = 200;

export class RemoteLibrary implements LibrarySource {
  private cache: Promise<Cache | null> | null = null;
  /** For progress and tests: how many files came over the network. */
  fetched = 0;

  constructor(
    private readonly lib: 'ldraw' | 'studio',
    private readonly version: string,
    private readonly origin = '',
  ) {}

  private base(): string {
    return `${this.origin}/api/import-library/${this.lib}/${this.version}`;
  }

  private fileUrl(name: string): string {
    return `${this.base()}/file?name=${encodeURIComponent(name)}`;
  }

  private open(): Promise<Cache | null> {
    if (!this.cache) {
      this.cache = (async () => {
        try {
          if (typeof caches === 'undefined') return null;
          const name = `${CACHE_PREFIX}${this.lib}-${this.version}`;
          // Copies from libraries since replaced.
          for (const k of await caches.keys()) if (k.startsWith(`${CACHE_PREFIX}${this.lib}-`) && k !== name) await caches.delete(k);
          return await caches.open(name);
        } catch {
          return null; // private browsing, blocked storage: fetch every time
        }
      })();
    }
    return this.cache;
  }

  async fetch(names: string[], signal?: AbortSignal): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const cache = await this.open();
    const missing: string[] = [];
    for (const n of names) {
      const hit = cache ? await cache.match(this.fileUrl(n)).catch(() => undefined) : undefined;
      if (hit) out.set(n, hit.status === 204 ? null : await hit.text());
      else missing.push(n);
    }
    for (let i = 0; i < missing.length; i += BATCH) {
      let ask = missing.slice(i, i + BATCH);
      while (ask.length) {
        const res = await fetch(`${this.base()}/files`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ names: ask }),
          ...(signal ? { signal } : {}),
        });
        if (!res.ok) throw new Error(`The site’s parts library answered ${res.status}.`);
        const body = (await res.json()) as { files: Record<string, string | null>; more: string[] };
        for (const [n, text] of Object.entries(body.files)) {
          out.set(n, text);
          this.fetched++;
          if (cache) {
            const r = text === null ? new Response(null, { status: 204 }) : new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
            void cache.put(this.fileUrl(n), r).catch(() => undefined);
          }
        }
        ask = body.more ?? [];
      }
    }
    return out;
  }

  private async text(path: string): Promise<string | null> {
    const res = await fetch(`${this.base()}/${path}`, { credentials: 'include' });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`The site’s parts library answered ${res.status}.`);
    return res.text();
  }

  ldconfig(): Promise<string | null> {
    return this.text('ldconfig');
  }

  async moved(): Promise<Record<string, string[]>> {
    const t = await this.text('moved');
    return t ? (JSON.parse(t) as Record<string, string[]>) : {};
  }
}
