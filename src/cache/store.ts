/**
 * Fetch-result cache.
 *
 * The pipeline's cost is I/O (Jira issue fetches, GitLab searches), not graph
 * computation, so the cache stores raw fetch results keyed by a namespaced
 * string (`jira:KEY-123`, `gitlab:KEY-123`) with a fetched-at timestamp.
 * The graph itself is always rebuilt in memory.
 *
 * `CacheStore` is deliberately storage-agnostic so a different backend (e.g. a
 * persistent knowledge graph) can be swapped in later without touching the
 * pipeline.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type CacheStore = {
  /** Returns the raw JSON string stored for `key` if it is younger than `ttlMs`. */
  get(key: string, ttlMs: number): string | undefined;
  set(key: string, value: string): void;
  close(): void;
}

type CacheRow = {
  value: string;
  fetched_at: number;
}

/** Single-file SQLite cache using the Node built-in driver. */
export class SqliteCacheStore implements CacheStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fetch_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      )
    `);
  }

  get(key: string, ttlMs: number): string | undefined {
    const stmt = this.db.prepare('SELECT value, fetched_at FROM fetch_cache WHERE key = ?');
    const row = stmt.get(key) as CacheRow | undefined;
    if (!row) return undefined;
    // Inclusive comparison so a TTL of 0 always means "stale".
    if (Date.now() - row.fetched_at >= ttlMs) return undefined;
    return row.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO fetch_cache (key, value, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`
      )
      .run(key, value, Date.now());
  }

  close(): void {
    this.db.close();
  }
}
