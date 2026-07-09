import { createRunner } from './collector/runner.js';
import { AcliClient } from './collector/acli.js';
import { JiraHttpClient } from './collector/jira-http.js';
import { GitlabHttpClient } from './collector/gitlab-http.js';
import { traverse, type TraverseDeps } from './collector/traversal.js';
import { buildGraph, buildContext } from './model/graph.js';
import { config as defaultConfig, type Config } from './config.js';
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
}

/**
 * Builds the collector clients from configuration. Exposed so tests can swap the
 * underlying exec function.
 */
export function createClients(config: Config = defaultConfig, log: LogFn = () => {}): TraverseDeps {
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
  return { acli, glab };
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
  const clients = options.clients || createClients(config, log);

  const traversal = await traverse(entryKey, clients, {
    maxDepth: options.maxDepth ?? config.maxDepth,
    maxNodes: options.maxNodes ?? config.maxNodes,
    log,
  });

  log(`Building graph visualization and context payloads...`);
  return {
    graph: buildGraph(traversal, config.jiraBaseUrl),
    context: buildContext(traversal),
  };
}

export default buildContextGraph;
