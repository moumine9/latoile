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
import type { ContextResult, GraphResult, LogFn } from './types.js';

/** Both payloads produced by a full pipeline run. */
export interface ContextGraph {
  graph: GraphResult;
  context: ContextResult;
}

export interface BuildContextGraphOptions {
  config?: Config;
  clients?: TraverseDeps;
  log?: LogFn;
  maxDepth?: number;
  maxNodes?: number;
  /** Skip cached reads for this run (fresh results are still written back). */
  refresh?: boolean;
  /** Knowledge-graph sink override — mainly for tests. `null` disables the sink for this run. */
  sink?: GraphSink | null;
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

export interface CreateClientsOptions {
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
export async function buildContextGraph(
  entryKey: string,
  options: BuildContextGraphOptions = {}
): Promise<ContextGraph> {
  const config = options.config || defaultConfig;
  const log = options.log || (() => {});
  const clients = options.clients || createClients(config, log, { refresh: options.refresh });

  const traversal = await traverse(entryKey, clients, {
    maxDepth: options.maxDepth ?? config.maxDepth,
    maxNodes: options.maxNodes ?? config.maxNodes,
    log,
  });

  // Feed the knowledge graph. Fire-safe: a sink failure never fails the run.
  const sink = options.sink === null ? undefined : options.sink ?? (await getSharedSink(config, log));
  if (sink) {
    try {
      await sink.ingest(traversal);
    } catch (err) {
      log(`Knowledge graph write failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  log(`Building graph visualization and context payloads...`);
  return {
    graph: buildGraph(traversal, config.jiraBaseUrl),
    context: buildContext(traversal),
  };
}

/** ContextGraph plus how the MR entry point was resolved to a Jira key. */
export interface MrContextGraph extends ContextGraph {
  resolvedFrom: ResolvedMrEntry;
}

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
