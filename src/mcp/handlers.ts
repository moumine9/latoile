/**
 * MCP tool handlers, kept free of transport/registration concerns so each can
 * be unit tested by calling it directly with stubbed dependencies (see
 * test/mcp.test.ts, test/knowledge-graph.test.ts, test/mr-entry.test.ts).
 */
import {
  buildContextGraph,
  buildContextGraphFromMr,
  createClients,
  type BuildContextGraphOptions,
  type ContextGraph,
  type MrContextGraph,
} from '../pipeline.js';
import { isJiraKey } from '../collector/jiraKeys.js';
import { searchIssues, type IssueSearchResult } from '../collector/search.js';
import { getSharedKnowledgeGraph } from './lifecycle.js';
import { errorResult, okResult, type ToolResult } from './tool-result.js';
import type { KnowledgeGraph } from '../sink/knowledge-graph.js';
import type { NormalizedIssue } from '../types.js';

/** Pipeline runner — injectable so tests can stub the expensive traversal. */
export type PipelineFn = (key: string, options: BuildContextGraphOptions) => Promise<ContextGraph>;

/** Receives pipeline progress: a human-readable message and a monotonic step count. */
export type ProgressFn = (message: string, step: number) => void;

/** Builds the pipeline `log` callback that feeds both stderr and onProgress. */
function progressLogger(onProgress?: ProgressFn): (msg: string) => void {
  let step = 0;
  return (msg: string) => {
    step += 1;
    console.error(`[latoile] ${msg}`);
    onProgress?.(msg, step);
  };
}

/* ------------------------------ get_context ------------------------------- */

export type GetContextArgs = {
  jiraKey: string;
  maxDepth?: number;
  maxNodes?: number;
  refresh?: boolean;
  /** Serve from the knowledge graph when its data is at most this old. */
  maxAgeSeconds?: number;
}

export async function getContextTool(
  args: GetContextArgs,
  run: PipelineFn = buildContextGraph,
  onProgress?: ProgressFn,
  graph?: KnowledgeGraph
): Promise<ToolResult> {
  const key = args.jiraKey.trim().toUpperCase();
  if (!isJiraKey(key)) {
    return errorResult(`"${args.jiraKey}" is not a valid Jira key (expected e.g. PV2-17830).`);
  }

  // Incremental refresh, two tiers. Tier 1: the whole stored neighborhood is
  // fresh — answer straight from the graph, zero live calls. Tier 2 (below):
  // traverse, but serve each fresh issue from the graph and live-fetch only
  // the stale frontier. Any graph failure falls through to fully live.
  let kg: KnowledgeGraph | undefined;
  if (args.maxAgeSeconds !== undefined && !args.refresh) {
    try {
      kg = graph ?? (await getSharedKnowledgeGraph());
      const stored = kg ? await kg.storedContext(key, args.maxDepth, args.maxNodes) : undefined;
      if (stored?.found && stored.ageSeconds !== undefined && stored.ageSeconds <= args.maxAgeSeconds) {
        return okResult({
          entry: stored.entry,
          items: stored.items,
          repositories: stored.repositories,
          traceability: stored.traceability,
          ageSeconds: stored.ageSeconds,
          source: 'knowledge_graph',
        });
      }
    } catch (err) {
      console.error(`[latoile] stored-context lookup failed, falling back to live: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const { context, graphServedIssues } = await run(key, {
      maxDepth: args.maxDepth,
      maxNodes: args.maxNodes,
      refresh: args.refresh,
      maxAgeSeconds: args.maxAgeSeconds,
      knowledgeGraph: kg,
      log: progressLogger(onProgress),
    });
    if (graphServedIssues && graphServedIssues > 0) {
      return okResult({ ...context, source: 'partial', graphServedIssues });
    }
    return okResult({ ...context, source: 'live' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`latoile pipeline failed: ${message}`);
  }
}

/* -------------------------- get_context_from_mr --------------------------- */

/** Pipeline runner for MR entry points — injectable for tests. */
export type MrPipelineFn = (mrUrl: string, options: BuildContextGraphOptions) => Promise<MrContextGraph>;

export type GetContextFromMrArgs = {
  mrUrl: string;
  maxDepth?: number;
  maxNodes?: number;
  refresh?: boolean;
}

export async function getContextFromMrTool(
  args: GetContextFromMrArgs,
  run: MrPipelineFn = buildContextGraphFromMr,
  onProgress?: ProgressFn
): Promise<ToolResult> {
  try {
    const { context, resolvedFrom } = await run(args.mrUrl, {
      maxDepth: args.maxDepth,
      maxNodes: args.maxNodes,
      refresh: args.refresh,
      log: progressLogger(onProgress),
    });
    return okResult({
      ...context,
      resolved_from: {
        jira_key: resolvedFrom.key,
        found_in: resolvedFrom.foundIn,
        mr_iid: resolvedFrom.mrIid,
        mr_project: resolvedFrom.mrProject,
        mr_title: resolvedFrom.mrTitle,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`latoile MR resolution failed: ${message}`);
  }
}

/* ------------------------------ search_issues ----------------------------- */

export async function searchIssuesTool(
  query: string,
  limit: number | undefined,
  search: typeof searchIssues = searchIssues
): Promise<ToolResult> {
  if (!query.trim()) return errorResult('Search query must not be empty.');
  try {
    const results: IssueSearchResult[] = await search(query, { limit });
    return okResult({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Jira search failed: ${message}`);
  }
}

/* -------------------------------- get_issue ------------------------------- */

/** Minimal issue source contract needed by get_issue; matches the traversal's. */
export type IssueFetcher = {
  fetchIssue(key: string): Promise<NormalizedIssue | null>;
}

export async function getIssueTool(jiraKey: string, fetcher?: IssueFetcher): Promise<ToolResult> {
  const key = jiraKey.trim().toUpperCase();
  if (!isJiraKey(key)) {
    return errorResult(`"${jiraKey}" is not a valid Jira key (expected e.g. PV2-17830).`);
  }
  try {
    const source = fetcher ?? createClients(undefined, (msg) => console.error(`[latoile] ${msg}`)).acli;
    const issue = await source.fetchIssue(key);
    if (!issue) return errorResult(`${key} was not found or is not accessible.`);
    return okResult({ ...issue });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Jira fetch failed: ${message}`);
  }
}

/* ------------------------- knowledge-graph tools -------------------------- */

const KG_UNCONFIGURED =
  'Knowledge graph is not configured. Set LATOILE_NEO4J_URI (and LATOILE_NEO4J_PASSWORD) to enable it — see PLAN-NEO4J.md.';

type KgHandler = (graph: KnowledgeGraph) => Promise<object>;

/** Shared wrapper: not-configured error, structured result, error mapping. */
export async function withKnowledgeGraph(
  handler: KgHandler,
  graph?: KnowledgeGraph
): Promise<ToolResult> {
  const kg = graph ?? (await getSharedKnowledgeGraph());
  if (!kg) return errorResult(KG_UNCONFIGURED);
  try {
    return okResult(await handler(kg));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Knowledge graph query failed: ${message}`);
  }
}

export function findConnectionTool(
  keyA: string,
  keyB: string,
  maxHops?: number,
  graph?: KnowledgeGraph
): Promise<ToolResult> {
  const a = keyA.trim().toUpperCase();
  const b = keyB.trim().toUpperCase();
  if (!isJiraKey(a) || !isJiraKey(b)) {
    return Promise.resolve(errorResult('Both arguments must be valid Jira keys (e.g. PV2-17830).'));
  }
  return withKnowledgeGraph(async (kg) => ({ ...(await kg.findConnection(a, b, maxHops)) }), graph);
}

export function knownContextTool(jiraKey: string, graph?: KnowledgeGraph): Promise<ToolResult> {
  const key = jiraKey.trim().toUpperCase();
  if (!isJiraKey(key)) {
    return Promise.resolve(errorResult(`"${jiraKey}" is not a valid Jira key (expected e.g. PV2-17830).`));
  }
  return withKnowledgeGraph(async (kg) => ({ ...(await kg.knownContext(key)) }), graph);
}

export function personActivityTool(name: string, sinceDays?: number, graph?: KnowledgeGraph): Promise<ToolResult> {
  if (!name.trim()) return Promise.resolve(errorResult('Person name must not be empty.'));
  return withKnowledgeGraph(async (kg) => kg.personActivity(name.trim(), sinceDays), graph);
}

export function projectActivityTool(
  projectPath: string,
  sinceDays?: number,
  graph?: KnowledgeGraph
): Promise<ToolResult> {
  if (!projectPath.trim()) return Promise.resolve(errorResult('Project path must not be empty.'));
  return withKnowledgeGraph(async (kg) => kg.projectActivity(projectPath.trim(), sinceDays), graph);
}

export function graphStatsTool(graph?: KnowledgeGraph): Promise<ToolResult> {
  return withKnowledgeGraph(async (kg) => kg.stats(), graph);
}
