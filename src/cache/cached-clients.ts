/**
 * Caching decorators for the two traversal client contracts. Wrapping at this
 * level keeps `traversal.ts` and the underlying clients (acli / HTTP) unaware
 * of caching entirely.
 *
 * Null Jira results (not found / no permission) are not cached, so transient
 * failures don't stick for a whole TTL window.
 */
import type { GitlabSource, IssueSource } from '../collector/traversal.js';
import type { GitlabContext, LogFn, NormalizedIssue } from '../types.js';
import type { CacheStore } from './store.js';

export interface CachedClientOptions {
  store: CacheStore;
  ttlMs: number;
  /** When true, cached reads are skipped but fresh results are still written. */
  refresh?: boolean;
  log?: LogFn;
}

export class CachedIssueSource implements IssueSource {
  constructor(
    private inner: IssueSource,
    private opts: CachedClientOptions
  ) {}

  async fetchIssue(key: string): Promise<NormalizedIssue | null> {
    const cacheKey = `jira:${key}`;
    const { store, ttlMs, refresh, log = () => {} } = this.opts;
    if (!refresh) {
      const hit = store.get(cacheKey, ttlMs);
      if (hit !== undefined) {
        log(`Cache hit for Jira issue ${key}`);
        return JSON.parse(hit) as NormalizedIssue;
      }
    }
    const issue = await this.inner.fetchIssue(key);
    if (issue) store.set(cacheKey, JSON.stringify(issue));
    return issue;
  }
}

export class CachedGitlabSource implements GitlabSource {
  constructor(
    private inner: GitlabSource,
    private opts: CachedClientOptions
  ) {}

  async fetchForKey(key: string): Promise<GitlabContext> {
    const cacheKey = `gitlab:${key}`;
    const { store, ttlMs, refresh, log = () => {} } = this.opts;
    if (!refresh) {
      const hit = store.get(cacheKey, ttlMs);
      if (hit !== undefined) {
        log(`Cache hit for GitLab data on ${key}`);
        return JSON.parse(hit) as GitlabContext;
      }
    }
    const context = await this.inner.fetchForKey(key);
    store.set(cacheKey, JSON.stringify(context));
    return context;
  }
}
