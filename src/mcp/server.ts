/**
 * MCP server for latoile — exposes the context pipeline as tools over stdio so
 * agents (Claude Code, Cursor, ...) can pull the full Jira+GitLab context of a
 * ticket mid-conversation.
 *
 * Register in Claude Code with:
 *   claude mcp add latoile -- node <repo>/dist/src/mcp/server.js
 *
 * Tools:
 *   get_context(jiraKey, maxDepth?, maxNodes?, refresh?) → normalized LLM
 *   context payload (issues, relations, MRs, branches, commits).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildContextGraph, type BuildContextGraphOptions, type ContextGraph } from '../pipeline.js';
import { isJiraKey } from '../collector/jiraKeys.js';

/** Pipeline runner — injectable so tests can stub the expensive traversal. */
export type PipelineFn = (key: string, options: BuildContextGraphOptions) => Promise<ContextGraph>;

export interface GetContextArgs {
  jiraKey: string;
  maxDepth?: number;
  maxNodes?: number;
  refresh?: boolean;
}

/** Result shape of an MCP tool callback (text content only). */
export interface ToolResult {
  // Index signature required by the SDK's CallToolResult contract.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Tool handler, exported separately from the server wiring so it can be unit
 * tested without a transport.
 */
export async function getContextTool(args: GetContextArgs, run: PipelineFn = buildContextGraph): Promise<ToolResult> {
  const key = args.jiraKey.trim().toUpperCase();
  if (!isJiraKey(key)) {
    return {
      content: [{ type: 'text', text: `"${args.jiraKey}" is not a valid Jira key (expected e.g. PV2-17830).` }],
      isError: true,
    };
  }
  try {
    const { context } = await run(key, {
      maxDepth: args.maxDepth,
      maxNodes: args.maxNodes,
      refresh: args.refresh,
      log: (msg) => console.error(`[latoile] ${msg}`),
    });
    return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `latoile pipeline failed: ${message}` }], isError: true };
  }
}

export function createMcpServer(run: PipelineFn = buildContextGraph): McpServer {
  const server = new McpServer({ name: 'latoile', version: '0.1.0' });

  server.registerTool(
    'get_context',
    {
      title: 'Get Jira+GitLab context graph',
      description:
        'Fetches the full context of a Jira issue: recursively walks its relationship graph ' +
        '(parent, subtasks, siblings, links, mentions) and enriches each issue with GitLab ' +
        'merge requests, branches, and commits. Returns a normalized JSON payload designed ' +
        'for LLM consumption. Results are served from a short-TTL cache; pass refresh=true ' +
        'to force live fetches.',
      inputSchema: {
        jiraKey: z.string().describe('Entry-point Jira issue key, e.g. PV2-17830'),
        maxDepth: z.number().int().min(0).max(5).optional().describe('Traversal depth from the entry issue (default 1)'),
        maxNodes: z.number().int().min(1).max(500).optional().describe('Hard cap on fetched issues (default 50)'),
        refresh: z.boolean().optional().describe('Bypass the cache and fetch everything live'),
      },
    },
    (args) => getContextTool(args)
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
