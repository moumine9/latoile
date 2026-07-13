/**
 * MCP server for latoile — exposes the context pipeline as tools over stdio so
 * agents (Claude Code, Cursor, ...) can pull the full Jira+GitLab context of a
 * ticket mid-conversation.
 *
 * Register in Claude Code with:
 *   claude mcp add latoile -- node <repo>/dist/src/mcp/server.js
 *
 * This file only wires tools to the transport; the handlers live in
 * `handlers.ts`, process lifecycle in `lifecycle.ts` (both re-exported here
 * for consumers and tests).
 *
 * Tools (all return structuredContent alongside the JSON text):
 *   get_context(jiraKey, maxDepth?, maxNodes?, refresh?, maxAgeSeconds?) —
 *     full traversal, or an instant knowledge-graph answer when fresh enough;
 *     streams pipeline progress as MCP progress notifications when the client
 *     sends a progressToken, and as logging notifications always.
 *   get_context_from_mr(mrUrl, ...) — same, but entry point is a GitLab MR
 *     link; the Jira key is extracted from the MR's branch/title/description.
 *   search_issues(query, limit?) — JQL full-text search, newest-updated first.
 *   get_issue(jiraKey) — single issue fetch (no traversal, cache-backed).
 *   find_connection / known_context / person_activity / graph_stats —
 *     offline queries over the Neo4j knowledge graph.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildContextGraph, closeSharedSink } from '../pipeline.js';
import {
  findConnectionTool,
  getContextFromMrTool,
  getContextTool,
  getIssueTool,
  graphStatsTool,
  knownContextTool,
  personActivityTool,
  projectActivityTool,
  searchIssuesTool,
  type PipelineFn,
  type ProgressFn,
} from './handlers.js';
import { closeSharedKnowledgeGraph, tracked, waitForInflightToolCalls } from './lifecycle.js';

// Re-exports keep the public/test surface stable across the module split.
export * from './handlers.js';
export * from './lifecycle.js';
export * from './tool-result.js';

const looseObject = (): ReturnType<typeof z.looseObject> => z.looseObject({});

/** Extra argument shape shared by the tool callbacks below. */
interface ToolCallExtra {
  _meta?: { progressToken?: string | number };
  sendNotification(notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message: string };
  }): Promise<void>;
}

/**
 * Builds the ProgressFn for a tool call: every pipeline log line becomes an
 * MCP logging notification, plus a progress notification when the client
 * asked for one via progressToken.
 */
function progressReporter(server: McpServer, extra: ToolCallExtra): ProgressFn {
  const progressToken = extra._meta?.progressToken;
  return (message, step) => {
    void server.server
      .sendLoggingMessage({ level: 'info', logger: 'latoile', data: message })
      .catch(() => {});
    if (progressToken !== undefined) {
      void extra
        .sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: step, message },
        })
        .catch(() => {});
    }
  };
}

export function createMcpServer(run: PipelineFn = buildContextGraph): McpServer {
  const server = new McpServer(
    { name: 'latoile', version: '0.1.0' },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    'get_context',
    {
      title: 'Get Jira+GitLab context graph',
      description:
        'Fetches the full context of a Jira issue: recursively walks its relationship graph ' +
        '(parent, subtasks, siblings, links, mentions) and enriches each issue with GitLab ' +
        'merge requests, branches, and commits. Returns a normalized JSON payload designed ' +
        'for LLM consumption. Results are served from a short-TTL cache; pass refresh=true ' +
        'to force live fetches, or maxAgeSeconds to answer instantly from the knowledge ' +
        'graph when its stored data is fresh enough (source: "knowledge_graph" in the ' +
        'result). Progress is streamed via MCP progress notifications when a progressToken ' +
        'is provided.',
      inputSchema: {
        jiraKey: z.string().describe('Entry-point Jira issue key, e.g. PV2-17830'),
        maxDepth: z.number().int().min(0).max(5).optional().describe('Traversal depth from the entry issue (default 1)'),
        maxNodes: z.number().int().min(1).max(500).optional().describe('Hard cap on fetched issues (default 50)'),
        refresh: z.boolean().optional().describe('Bypass the cache and fetch everything live'),
        maxAgeSeconds: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Accept knowledge-graph data at most this old instead of a live traversal (e.g. 3600)'),
      },
      outputSchema: {
        entry: z.string().describe('The entry-point Jira key'),
        items: z.array(looseObject()).describe('One unified work-item object per resolved issue'),
        repositories: z
          .array(z.string())
          .describe('Every GitLab project touched in this context — a fix should consider all of them'),
        traceability: looseObject().describe('Jira-key ↔ merge-request link table'),
        source: z
          .enum(['live', 'knowledge_graph', 'partial'])
          .describe('live = full traversal; knowledge_graph = fully stored; partial = only the stale frontier was fetched live'),
        ageSeconds: z.number().optional().describe('Age of the stalest stored issue (knowledge_graph source only)'),
        graphServedIssues: z.number().optional().describe('Issues served from the graph during a partial refresh'),
      },
    },
    (args, extra) => tracked(getContextTool(args, run, progressReporter(server, extra)))
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
    (args, extra) => tracked(getContextFromMrTool(args, undefined, progressReporter(server, extra)))
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
    (args) => tracked(searchIssuesTool(args.query, args.limit))
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
    (args) => tracked(getIssueTool(args.jiraKey))
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
    (args) => tracked(findConnectionTool(args.keyA, args.keyB, args.maxHops))
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
    (args) => tracked(knownContextTool(args.jiraKey))
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
    (args) => tracked(personActivityTool(args.name, args.sinceDays))
  );

  server.registerTool(
    'project_activity',
    {
      title: 'Issues and MRs that touched a GitLab project',
      description:
        'What else changed in a repo: issues and merge requests whose work landed in a ' +
        'GitLab project (path substring, case-insensitive), within a recency window. ' +
        'Work items here span several repos (microservices + microfrontends), so before ' +
        'attempting a fix, check which repos the original fix touched (repositories field ' +
        'of get_context) and what else recently changed in each. Offline; covers only ' +
        'what laToile has already ingested.',
      inputSchema: {
        projectPath: z.string().describe('GitLab project path or fragment, e.g. "fee-matrix"'),
        sinceDays: z.number().int().min(1).max(365).optional().describe('Recency window (default 90)'),
      },
      outputSchema: {
        matches: z.array(looseObject()),
        sinceDays: z.number(),
      },
    },
    (args) => tracked(projectActivityTool(args.projectPath, args.sinceDays))
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
    () => tracked(graphStatsTool())
  );

  return server;
}

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // When the client disconnects (stdin EOF) the Neo4j driver's open sockets
  // would keep the process alive forever; the SDK transport does not signal
  // EOF itself, so watch stdin directly. One-shot clients close stdin right
  // after writing, so drain in-flight tool calls before tearing down.
  const shutdown = (): void => {
    void waitForInflightToolCalls()
      .then(() => Promise.allSettled([server.close(), closeSharedKnowledgeGraph(), closeSharedSink()]))
      .then(() => process.exit(0));
  };
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  console.error('[latoile] MCP server listening on stdio');
}

// Only start the transport when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((err) => {
    console.error('[latoile] fatal:', err);
    process.exit(1);
  });
}
