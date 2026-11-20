// LDD's brick database and the LDD → LDraw mapping, from the site
// (apps/server/src/routes/importLibraries.ts): a brick's shape by its
// design ID, a batch at a time, kept in Cache Storage under its versioned
// URL; Materials.xml; ldraw.xml.

export interface LddSource {
  /** LDD's own brick shapes (the site has its database). */
  readonly hasAssets: boolean;
  shapes(ids: string[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Map<string, Uint8Array | null>>;
  materials(): Promise<string | null>;
  /** ldraw.xml, or null without one. */
  mapping(): Promise<string | null>;
}

const BATCH = 200;
const CACHE_PREFIX = 'cbld-import-ldd-';

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class RemoteLdd implements LddSource {
  private cache: Promise<Cache | null> | null = null;

  constructor(
    private readonly assets: string | null,
    private readonly mappingVersion: string | null,
    private readonly origin = '',
  ) {}

  get hasAssets(): boolean {
    return !!this.assets;
  }

  private base(): string {
    return `${this.origin}/api/import-library/ldd/${this.assets}`;
  }

  private open(): Promise<Cache | null> {
    if (!this.cache) {
      this.cache = (async () => {
        try {
          if (typeof caches === 'undefined' || !this.assets) return null;
          const name = `${CACHE_PREFIX}${this.assets}`;
          for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== name) await caches.delete(k);
          return await caches.open(name);
        } catch {
          return null;
        }
      })();
    }
    return this.cache;
  }

  async shapes(ids: string[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Map<string, Uint8Array | null>> {
    const out = new Map<string, Uint8Array | null>();
    if (!this.assets) return out;
    const cache = await this.open();
    const url = (id: string) => `${this.base()}/geometry?id=${id}`;
    const missing: string[] = [];
    for (const id of ids) {
      const hit = cache ? await cache.match(url(id)).catch(() => undefined) : undefined;
      if (hit) out.set(id, hit.status === 204 ? null : new Uint8Array(await hit.arrayBuffer()));
      else missing.push(id);
    }
    onProgress?.(out.size, ids.length);
    for (let i = 0; i < missing.length; i += BATCH) {
      let ask = missing.slice(i, i + BATCH);
      while (ask.length) {
        signal?.throwIfAborted();
        const res = await fetch(`${this.base()}/geometry`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: ask }),
          ...(signal ? { signal } : {}),
        });
        if (!res.ok) throw new Error(`The site’s LDD library answered ${res.status}.`);
        const body = (await res.json()) as { files: Record<string, string | null>; more: string[] };
        for (const [id, b64] of Object.entries(body.files)) {
          const bytes = b64 === null ? null : fromBase64(b64);
          out.set(id, bytes);
          if (cache) void cache.put(url(id), bytes === null ? new Response(null, { status: 204 }) : new Response(bytes as BodyInit)).catch(() => undefined);
        }
        onProgress?.(out.size, ids.length);
        ask = body.more ?? [];
      }
    }
    return out;
  }

  async materials(): Promise<string | null> {
    if (!this.assets) return null;
    const res = await fetch(`${this.base()}/materials`, { credentials: 'include' });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`The site’s LDD library answered ${res.status}.`);
    return res.text();
  }

  async mapping(): Promise<string | null> {
    if (!this.mappingVersion) return null;
    const res = await fetch(`${this.origin}/api/import-library/ldd-mapping/${this.mappingVersion}/ldraw-xml`, { credentials: 'include' });
    if (!res.ok) throw new Error(`The site’s LDD mapping answered ${res.status}.`);
    return res.text();
  }
}
