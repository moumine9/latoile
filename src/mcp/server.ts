/**
 * MCP server for latoile — exposes the context pipeline as tools over stdio so
 * agents (Claude Code, Cursor, ...) can pull the full Jira+GitLab context of a
 * ticket mid-conversation.
 *
 * Register in Claude Code with:
 *   claude mcp add latoile -- node <repo>/dist/src/mcp/server.js
 *
 * Tools (all return structuredContent alongside the JSON text):
 *   get_context(jiraKey, maxDepth?, maxNodes?, refresh?) — full traversal;
 *     streams pipeline progress as MCP progress notifications when the client
 *     sends a progressToken, and as logging notifications otherwise.
 *   get_context_from_mr(mrUrl, ...) — same, but entry point is a GitLab MR
 *     link; the Jira key is extracted from the MR's branch/title/description.
 *   search_issues(query, limit?) — JQL full-text search, newest-updated first.
 *   get_issue(jiraKey) — single issue fetch (no traversal, cache-backed).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
import { config } from '../config.js';
import type { KnowledgeGraph } from '../sink/knowledge-graph.js';
import type { NormalizedIssue } from '../types.js';

/** Pipeline runner — injectable so tests can stub the expensive traversal. */
export type PipelineFn = (key: string, options: BuildContextGraphOptions) => Promise<ContextGraph>;

/** Receives pipeline progress: a human-readable message and a monotonic step count. */
export type ProgressFn = (message: string, step: number) => void;

export interface GetContextArgs {
  jiraKey: string;
  maxDepth?: number;
  maxNodes?: number;
  refresh?: boolean;
}

/** Result shape of an MCP tool callback. */
export interface ToolResult {
  // Index signature required by the SDK's CallToolResult contract.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function okResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * get_context handler, exported separately from the server wiring so it can be
 * unit tested without a transport.
 */
export async function getContextTool(
  args: GetContextArgs,
  run: PipelineFn = buildContextGraph,
  onProgress?: ProgressFn
): Promise<ToolResult> {
  const key = args.jiraKey.trim().toUpperCase();
  if (!isJiraKey(key)) {
    return errorResult(`"${args.jiraKey}" is not a valid Jira key (expected e.g. PV2-17830).`);
  }
  let step = 0;
  try {
    const { context } = await run(key, {
      maxDepth: args.maxDepth,
      maxNodes: args.maxNodes,
      refresh: args.refresh,
      log: (msg) => {
        step += 1;
        console.error(`[latoile] ${msg}`);
        onProgress?.(msg, step);
      },
    });
    return okResult({ ...context });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`latoile pipeline failed: ${message}`);
  }
}

/** Pipeline runner for MR entry points — injectable for tests. */
export type MrPipelineFn = (mrUrl: string, options: BuildContextGraphOptions) => Promise<MrContextGraph>;

export interface GetContextFromMrArgs {
  mrUrl: string;
  maxDepth?: number;
  maxNodes?: number;
  refresh?: boolean;
}

/** get_context_from_mr handler. */
export async function getContextFromMrTool(
  args: GetContextFromMrArgs,
  run: MrPipelineFn = buildContextGraphFromMr,
  onProgress?: ProgressFn
): Promise<ToolResult> {
  let step = 0;
  try {
    const { context, resolvedFrom } = await run(args.mrUrl, {
      maxDepth: args.maxDepth,
      maxNodes: args.maxNodes,
      refresh: args.refresh,
      log: (msg) => {
        step += 1;
        console.error(`[latoile] ${msg}`);
        onProgress?.(msg, step);
      },
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

/** search_issues handler. */
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

/** Minimal issue source contract needed by get_issue; matches the traversal's. */
export interface IssueFetcher {
  fetchIssue(key: string): Promise<NormalizedIssue | null>;
}

/** get_issue handler. */
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

const looseObject = (): ReturnType<typeof z.looseObject> => z.looseObject({});

/* ------------------------- knowledge-graph tools -------------------------- */

const KG_UNCONFIGURED =
  'Knowledge graph is not configured. Set LATOILE_NEO4J_URI (and LATOILE_NEO4J_PASSWORD) to enable it — see PLAN-NEO4J.md.';

// One read handle per process, created lazily like the sink.
let sharedGraphPromise: Promise<KnowledgeGraph | undefined> | undefined;

function getSharedKnowledgeGraph(): Promise<KnowledgeGraph | undefined> {
  if (!config.neo4jEnabled || !config.neo4jUri) return Promise.resolve(undefined);
  if (!sharedGraphPromise) {
    sharedGraphPromise = import('../sink/knowledge-graph.js')
      .then(({ createKnowledgeGraph }) =>
        createKnowledgeGraph(
          { uri: config.neo4jUri, user: config.neo4jUser, password: config.neo4jPassword },
          (msg) => console.error(`[latoile] ${msg}`)
        )
      )
      .catch((err) => {
        console.error(`[latoile] knowledge graph connection failed: ${err instanceof Error ? err.message : String(err)}`);
        // Reset so the next tool call retries instead of caching the failure.
        sharedGraphPromise = undefined;
        return undefined;
      });
  }
  return sharedGraphPromise;
}

type KgHandler = (graph: KnowledgeGraph) => Promise<Record<string, unknown>>;

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

export function graphStatsTool(graph?: KnowledgeGraph): Promise<ToolResult> {
  return withKnowledgeGraph(async (kg) => kg.stats(), graph);
}

export function createMcpServer(run: PipelineFn = buildContextGraph): McpServer {
  const server = new McpServer(
    { name: 'latoile', version: '0.1.0' },
    { capabilities: { logging: {} } }
  );

  /** Forwards a pipeline log line to the client as a logging notification. */
  const sendLog = (message: string): void => {
    void server.server
      .sendLoggingMessage({ level: 'info', logger: 'latoile', data: message })
      .catch(() => {});
  };

  server.registerTool(
    'get_context',
    {
      title: 'Get Jira+GitLab context graph',
      description:
        'Fetches the full context of a Jira issue: recursively walks its relationship graph ' +
        '(parent, subtasks, siblings, links, mentions) and enriches each issue with GitLab ' +
        'merge requests, branches, and commits. Returns a normalized JSON payload designed ' +
        'for LLM consumption. Results are served from a short-TTL cache; pass refresh=true ' +
        'to force live fetches. Progress is streamed via MCP progress notifications when a ' +
        'progressToken is provided.',
      inputSchema: {
        jiraKey: z.string().describe('Entry-point Jira issue key, e.g. PV2-17830'),
        maxDepth: z.number().int().min(0).max(5).optional().describe('Traversal depth from the entry issue (default 1)'),
        maxNodes: z.number().int().min(1).max(500).optional().describe('Hard cap on fetched issues (default 50)'),
        refresh: z.boolean().optional().describe('Bypass the cache and fetch everything live'),
      },
      outputSchema: {
        entry: z.string().describe('The entry-point Jira key'),
        items: z.array(looseObject()).describe('One unified work-item object per resolved issue'),
        traceability: looseObject().describe('Jira-key ↔ merge-request link table'),
      },
    },
    (args, extra) => {
      const progressToken = extra._meta?.progressToken;
      return getContextTool(args, run, (message, step) => {
        sendLog(message);
        if (progressToken !== undefined) {
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: step, message },
            })
            .catch(() => {});
        }
      });
    }
  );

  server.registerTool(
    'get_context_from_mr',
    {
      title: 'Get Jira+GitLab context from a merge request link',
      description:
        'Resolves a GitLab merge request URL to its Jira issue (key extracted from the ' +
        'source branch, title, or description) and returns the same full context graph ' +
        'as get_context, plus a resolved_from block describing the resolution. Use this ' +
        'when you have an MR link instead of a Jira key — e.g. when reviewing an MR.',
      inputSchema: {
        mrUrl: z.string().describe('GitLab MR URL, e.g. https://gitlab.com/group/project/-/merge_requests/123'),
        maxDepth: z.number().int().min(0).max(5).optional().describe('Traversal depth from the resolved issue (default 1)'),
        maxNodes: z.number().int().min(1).max(500).optional().describe('Hard cap on fetched issues (default 50)'),
        refresh: z.boolean().optional().describe('Bypass the cache and fetch everything live'),
      },
      outputSchema: {
        entry: z.string().describe('The resolved entry-point Jira key'),
        resolved_from: z.object({
          jira_key: z.string(),
          found_in: z.enum(['source_branch', 'title', 'description']),
          mr_iid: z.number(),
          mr_project: z.string(),
          mr_title: z.string(),
        }),
        items: z.array(looseObject()).describe('One unified work-item object per resolved issue'),
        traceability: looseObject().describe('Jira-key ↔ merge-request link table'),
      },
    },
    (args, extra) => {
      const progressToken = extra._meta?.progressToken;
      return getContextFromMrTool(args, buildContextGraphFromMr, (message, step) => {
        sendLog(message);
        if (progressToken !== undefined) {
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: step, message },
            })
            .catch(() => {});
        }
      });
    }
  );

  server.registerTool(
    'search_issues',
    {
      title: 'Search Jira issues by text',
      description:
        'Full-text Jira search (summary and description/comments), newest-updated first. ' +
        'Use this to find the issue key when only a topic or phrase is known, then call ' +
        'get_context with the key.',
      inputSchema: {
        query: z.string().describe('Free-text search query'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum results (default 8)'),
      },
      outputSchema: {
        results: z.array(
          z.object({
            key: z.string(),
            summary: z.string(),
            type: z.string().describe('Issue type name, e.g. Bug'),
          })
        ),
      },
    },
    (args) => searchIssuesTool(args.query, args.limit)
  );

  server.registerTool(
    'get_issue',
    {
      title: 'Get a single Jira issue',
      description:
        'Fetches one Jira issue (summary, status, assignee, parent, subtasks, links, ' +
        'mentions, doc links) without walking the relationship graph or GitLab. Much ' +
        'faster than get_context; cache-backed.',
      inputSchema: {
        jiraKey: z.string().describe('Jira issue key, e.g. PV2-17830'),
      },
      outputSchema: {
        key: z.string(),
        title: z.string().optional(),
        status: z.string().optional(),
      },
    },
    (args) => getIssueTool(args.jiraKey)
  );

  server.registerTool(
    'find_connection',
    {
      title: 'Find how two Jira issues are connected',
      description:
        'Shortest path between two issues in the accumulated knowledge graph (offline — ' +
        'no live Jira/GitLab calls). Traverses any relationship: parent chains, links, ' +
        'mentions, shared MRs, commits, people. Only covers tickets laToile has already ' +
        'seen; run get_context on a ticket to teach the graph about it.',
      inputSchema: {
        keyA: z.string().describe('First Jira key'),
        keyB: z.string().describe('Second Jira key'),
        maxHops: z.number().int().min(1).max(15).optional().describe('Path length cap (default 8)'),
      },
      outputSchema: {
        found: z.boolean(),
        nodes: z.array(looseObject()),
        relationships: z.array(z.string()),
      },
    },
    (args) => findConnectionTool(args.keyA, args.keyB, args.maxHops)
  );

  server.registerTool(
    'known_context',
    {
      title: 'What laToile already knows about an issue',
      description:
        'Instant, offline snapshot of an issue from the knowledge graph: stored fields, ' +
        'every known neighbor (issues, MRs, commits, people, docs), and ageSeconds since ' +
        'the last live refresh. Use it before get_context — if the data is fresh enough, ' +
        'skip the slow live traversal.',
      inputSchema: { jiraKey: z.string().describe('Jira issue key') },
      outputSchema: {
        found: z.boolean(),
        issue: looseObject().optional(),
        neighbors: z.array(looseObject()).optional(),
        ageSeconds: z.number().optional().describe('Seconds since last live refresh'),
      },
    },
    (args) => knownContextTool(args.jiraKey)
  );

  server.registerTool(
    'person_activity',
    {
      title: "A person's activity in the knowledge graph",
      description:
        'Issues assigned to and MRs/commits authored by a person (case-insensitive name ' +
        'substring), within a recency window. Useful for "who knows about this area?". ' +
        'Offline; covers only what laToile has already ingested.',
      inputSchema: {
        name: z.string().describe('Person name or fragment, e.g. "alice"'),
        sinceDays: z.number().int().min(1).max(365).optional().describe('Recency window (default 90)'),
      },
      outputSchema: {
        matches: z.array(looseObject()),
        sinceDays: z.number(),
      },
    },
    (args) => personActivityTool(args.name, args.sinceDays)
  );

  server.registerTool(
    'graph_stats',
    {
      title: 'Knowledge graph size and freshness',
      description:
        'Node and relationship counts by type plus oldest/newest timestamps — how much ' +
        'laToile remembers and how fresh it is.',
      inputSchema: {},
      outputSchema: {
        nodes: z.array(looseObject()),
        relationships: z.array(looseObject()),
      },
    },
    () => graphStatsTool()
  );

  return server;
}

async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error('[latoile] MCP server listening on stdio');
}

// Only start the transport when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((err) => {
    console.error('[latoile] fatal:', err);
    process.exit(1);
  });
}
