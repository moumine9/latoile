import { createRunner } from './collector/runner.js';
import { AcliClient } from './collector/acli.js';
import { JiraHttpClient } from './collector/jira-http.js';
import { GitlabHttpClient } from './collector/gitlab-http.js';
import { traverse, type TraverseDeps } from './collector/traversal.js';
import { parseMrUrl, resolveJiraKeyFromMr, type MrApiSource, type ResolvedMrEntry } from './collector/mr-entry.js';
import { buildGraph, buildContext } from './model/graph.js';
import { config as defaultConfig, type Config } from './config.js';
import { SqliteCacheStore, type CacheStore } from './cache/store.js';
import { CachedIssueSource, CachedGitlabSource } from './cache/cached-clients.js';
import type { GraphSink } from './sink/graph-sink.js';
import type { KnowledgeGraph } from './sink/knowledge-graph.js';
import {
  KnowledgeGraphGitlabSource,
  KnowledgeGraphIssueSource,
  type GraphServeTally,
} from './sink/kg-clients.js';
import type { ContextResult, GraphResult, LogFn, TraversalResult } from './types.js';

/** Both payloads produced by a full pipeline run. */
export type ContextGraph = {
  graph: GraphResult;
  context: ContextResult;
  /** Issues served from the knowledge graph instead of live (partial refresh). */
  graphServedIssues?: number;
}

export type BuildContextGraphOptions = {
  config?: Config;
  clients?: TraverseDeps;
  log?: LogFn;
  maxDepth?: number;
  maxNodes?: number;
  /** Skip cached reads for this run (fresh results are still written back). */
  refresh?: boolean;
  /** Knowledge-graph sink override — mainly for tests. `null` disables the sink for this run. */
  sink?: GraphSink | null;
  /**
   * Partial incremental refresh: with a knowledge graph available, issues
   * whose stored data is at most this old are served from the graph and only
   * the stale frontier is fetched live.
   */
  maxAgeSeconds?: number;
  /** Read handle for partial refresh; supplied by the MCP layer or tests. */
  knowledgeGraph?: KnowledgeGraph;
}

// One knowledge-graph sink per process, created lazily on first use so the
// neo4j driver is never loaded when the sink is unconfigured.
let sharedSinkPromise: Promise<GraphSink | undefined> | undefined;

function getSharedSink(config: Config, log: LogFn): Promise<GraphSink | undefined> {
  if (!config.neo4jEnabled || !config.neo4jUri) return Promise.resolve(undefined);
  if (!sharedSinkPromise) {
    sharedSinkPromise = import('./sink/neo4j-sink.js')
      .then(({ createNeo4jSink }) =>
        createNeo4jSink(
          { uri: config.neo4jUri, user: config.neo4jUser, password: config.neo4jPassword },
          log
        )
      )
      .catch((err) => {
        log(`Knowledge graph unavailable (${err instanceof Error ? err.message : String(err)})`);
        return undefined;
      });
  }
  return sharedSinkPromise;
}

/** Closes the shared knowledge-graph sink (idempotent); used on shutdown. */
export async function closeSharedSink(): Promise<void> {
  const sink = await sharedSinkPromise;
  sharedSinkPromise = undefined;
  await sink?.close();
}

export type CreateClientsOptions = {
  /** Cache store override — mainly for tests. Defaults to the shared SQLite store. */
  cache?: CacheStore;
  refresh?: boolean;
}

// One store per process: DatabaseSync handles are cheap but there is no reason
// to reopen the file on every API request.
let sharedStore: CacheStore | undefined;

function getSharedStore(config: Config): CacheStore {
  if (!sharedStore) sharedStore = new SqliteCacheStore(config.cachePath);
  return sharedStore;
}

/**
 * Builds the collector clients from configuration. Exposed so tests can swap the
 * underlying exec function.
 */
export function createClients(
  config: Config = defaultConfig,
  log: LogFn = () => {},
  options: CreateClientsOptions = {}
): TraverseDeps {
  const run = createRunner({
    delayMs: config.cliDelayMs,
    retries: config.cliRetries,
    timeoutMs: config.cliTimeoutMs,
    log,
  });

  // Use the direct Jira HTTP client when credentials are configured — ~15×
  // faster than acli. Falls back to acli when any credential is missing.
  const acli =
    config.jiraUrl && config.jiraEmail && config.jiraToken
      ? new JiraHttpClient({ baseUrl: config.jiraUrl, email: config.jiraEmail, token: config.jiraToken, log })
      : new AcliClient({ run, bin: config.acliBin, log });

  const glab = new GitlabHttpClient({
    projects: config.gitlabProjects,
    groups: config.gitlabGroups,
    activeDays: config.gitlabActiveDays,
    concurrency: config.gitlabConcurrency,
    fetchChangedFiles: config.gitlabFetchChangedFiles,
    log,
  });

  if (!config.cacheEnabled && !options.cache) return { acli, glab };

  const cacheOpts = {
    store: options.cache ?? getSharedStore(config),
    ttlMs: config.cacheTtlMs,
    refresh: options.refresh,
    log,
  };
  return {
    acli: new CachedIssueSource(acli, cacheOpts),
    glab: new CachedGitlabSource(glab, cacheOpts),
  };
}

/**
 * Runs the full pipeline for a Jira entry key and returns both the renderable
 * graph and the normalized LLM context payload.
 */
/**
 * Copy of the traversal result without knowledge-graph-served issues, so the
 * sink never bumps `last_seen` for data that was read back from the graph
 * rather than verified live. Relations stay intact: edge upserts MATCH both
 * endpoints, and graph-served endpoints already exist in the database.
 */
function withoutGraphServedIssues(traversal: TraversalResult): TraversalResult {
  const liveIssues = new Map(
    [...traversal.issues].filter(([, node]) => node.provenance !== 'knowledge_graph')
  );
  if (liveIssues.size === traversal.issues.size) return traversal;
  return { ...traversal, issues: liveIssues };
}

export async function buildContextGraph(
  entryKey: string,
  options: BuildContextGraphOptions = {}
): Promise<ContextGraph> {
  const config = options.config || defaultConfig;
  const log = options.log || (() => {});
  let clients = options.clients || createClients(config, log, { refresh: options.refresh });

  // Partial incremental refresh: fresh-enough issues come from the knowledge
  // graph, only the stale frontier hits Jira/GitLab.
  const tally: GraphServeTally = { issues: 0, gitlabContexts: 0 };
  if (options.knowledgeGraph && options.maxAgeSeconds !== undefined && !options.refresh) {
    const kgOpts = {
      graph: options.knowledgeGraph,
      maxAgeSeconds: options.maxAgeSeconds,
      tally,
      log,
    };
    clients = {
      acli: new KnowledgeGraphIssueSource(clients.acli, kgOpts),
      glab: new KnowledgeGraphGitlabSource(clients.glab, kgOpts),
    };
  }

  const traversal = await traverse(entryKey, clients, {
    maxDepth: options.maxDepth ?? config.maxDepth,
    maxNodes: options.maxNodes ?? config.maxNodes,
    log,
  });
  if (tally.issues > 0) {
    log(`Partial refresh: ${tally.issues} issue(s) served from the knowledge graph`);
  }

  // Feed the knowledge graph. Fire-safe: a sink failure never fails the run.
  const sink = options.sink === null ? undefined : options.sink ?? (await getSharedSink(config, log));
  if (sink) {
    try {
      await sink.ingest(withoutGraphServedIssues(traversal));
    } catch (err) {
      log(`Knowledge graph write failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  log(`Building graph visualization and context payloads...`);
  return {
    graph: buildGraph(traversal, config.jiraBaseUrl),
    context: buildContext(traversal),
    graphServedIssues: tally.issues,
  };
}

/** ContextGraph plus how the MR entry point was resolved to a Jira key. */
export type MrContextGraph = {
  resolvedFrom: ResolvedMrEntry;
} & ContextGraph

/**
 * Runs the pipeline starting from a GitLab merge-request URL: fetches the MR,
 * extracts its Jira key (source branch → title → description), then traverses
 * from that key as usual.
 */
export async function buildContextGraphFromMr(
  mrUrl: string,
  options: BuildContextGraphOptions = {},
  mrSource?: MrApiSource
): Promise<MrContextGraph> {
  const log = options.log || (() => {});
  const parsed = parseMrUrl(mrUrl);
  if (!parsed) {
    throw new Error(
      `Not a GitLab merge request URL: ${mrUrl} (expected https://<host>/<group>/<project>/-/merge_requests/<iid>)`
    );
  }
  const source = mrSource ?? new GitlabHttpClient({ host: parsed.host, log });
  const resolved = await resolveJiraKeyFromMr(parsed, source, log);
  const result = await buildContextGraph(resolved.key, options);
  return { ...result, resolvedFrom: resolved };
}

export default buildContextGraph;
