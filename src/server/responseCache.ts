import type { DatabaseSync } from "node:sqlite";

interface CacheEntry {
  version: number;
  body: string;
  etag: string;
}

export interface VersionedCache {
  get(key: string, build: () => string): { body: string; etag: string };
}

const MAX_ENTRIES = 32;

// Caches serialized responses keyed by an arbitrary string, invalidated by the
// connection's total_changes() counter. Any write through this connection bumps
// the counter, so a cached entry can never outlive a mutation — at the cost of
// rebuilding after unrelated writes (comments, votes, chunk indexing).
export function makeVersionedCache(db: DatabaseSync): VersionedCache {
  const entries = new Map<string, CacheEntry>();

  function currentVersion(): number {
    const row = db.prepare("SELECT total_changes() AS c").get() as { c: number };
    return row.c;
  }

  return {
    get(key, build) {
      const version = currentVersion();
      const hit = entries.get(key);
      if (hit && hit.version === version) {
        // Refresh LRU position.
        entries.delete(key);
        entries.set(key, hit);
        return { body: hit.body, etag: hit.etag };
      }
      const body = build();
      const etag = `W/"${key}-${version}"`;
      entries.delete(key);
      entries.set(key, { version, body, etag });
      if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return { body, etag };
    },
  };
}
