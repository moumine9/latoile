import { createRunner } from './collector/runner.js';
import { AcliClient } from './collector/acli.js';
import { GlabClient } from './collector/glab.js';
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
  const acli = new AcliClient({ run, bin: config.acliBin, log });
  const glab = new GlabClient({ run, bin: config.glabBin, projects: config.gitlabProjects, log });
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

  return {
    graph: buildGraph(traversal),
    context: buildContext(traversal),
  };
}

export default buildContextGraph;
