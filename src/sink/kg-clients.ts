/**
 * Knowledge-graph-backed decorators for the traversal client contracts —
 * the heart of partial incremental refresh.
 *
 * Each issue (and its GitLab context) is served from Neo4j when its own
 * `last_seen` is within the caller's freshness budget, and live-fetched
 * otherwise. A traversal therefore only pays live latency for the stale
 * frontier of the neighborhood instead of all-or-nothing.
 *
 * Graph-served issues are marked with `provenance: 'knowledge_graph'` so the
 * pipeline excludes them from re-ingestion — `last_seen` must keep meaning
 * "last verified against Jira/GitLab", never "last read back from the graph".
 */
import type { GitlabSource, IssueSource } from '../collector/traversal.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { GitlabContext, LogFn, NormalizedIssue } from '../types.js';

/** Mutable tally shared by both decorators; the pipeline reports it. */
export interface GraphServeTally {
  issues: number;
  gitlabContexts: number;
}

export interface KgClientOptions {
  graph: KnowledgeGraph;
  /** Serve stored data at most this old; older falls through to live. */
  maxAgeSeconds: number;
  tally: GraphServeTally;
  log?: LogFn;
}

export class KnowledgeGraphIssueSource implements IssueSource {
  constructor(
    private inner: IssueSource,
    private opts: KgClientOptions
  ) {}

  async fetchIssue(key: string): Promise<NormalizedIssue | null> {
    const { graph, maxAgeSeconds, tally, log = () => {} } = this.opts;
    try {
      const stored = await graph.storedIssue(key);
      if (stored && stored.ageSeconds <= maxAgeSeconds) {
        tally.issues += 1;
        log(`Serving ${key} from knowledge graph (${stored.ageSeconds}s old)`);
        return { ...stored.issue, provenance: 'knowledge_graph' };
      }
    } catch (err) {
      log(`Knowledge graph read failed for ${key}, fetching live (${err instanceof Error ? err.message : String(err)})`);
    }
    return this.inner.fetchIssue(key);
  }
}

export class KnowledgeGraphGitlabSource implements GitlabSource {
  constructor(
    private inner: GitlabSource,
    private opts: KgClientOptions
  ) {}

  async fetchForKey(key: string): Promise<GitlabContext> {
    const { graph, maxAgeSeconds, tally, log = () => {} } = this.opts;
    try {
      const stored = await graph.storedGitlabContext(key);
      if (stored && stored.ageSeconds <= maxAgeSeconds) {
        tally.gitlabContexts += 1;
        log(`Serving GitLab data for ${key} from knowledge graph (${stored.ageSeconds}s old)`);
        return stored.context;
      }
    } catch (err) {
      log(`Knowledge graph read failed for ${key} GitLab data, fetching live (${err instanceof Error ? err.message : String(err)})`);
    }
    return this.inner.fetchForKey(key);
  }
}
