import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { buildContextGraph, type ContextGraph } from '../pipeline.js';
import { isJiraKey } from '../collector/jiraKeys.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled layout: dist/src/api/server.js → repository root is three levels up.
const publicDir = path.resolve(__dirname, '../../../public');

/** Per-request traversal overrides parsed from the query string. */
export interface GraphRunOptions {
  maxDepth?: number;
  maxNodes?: number;
  /** Bypass cached reads for this run. */
  refresh?: boolean;
  log?: (msg: string) => void;
}

/** Runs the pipeline for a key; injectable so the server can be tested. */
export type GraphRunFn = (key: string, opts: GraphRunOptions) => Promise<ContextGraph>;

/** Executes an acli invocation for the search endpoint; injectable for tests. */
export type SearchRunFn = (bin: string, args: string[]) => Promise<string>;

export interface CreateAppOptions {
  run?: GraphRunFn;
  searchRun?: SearchRunFn;
}

/** Shape of one row of `acli jira workitem search --json` that we consume. */
interface RawSearchResult {
  key?: string;
  fields?: {
    summary?: string;
    issuetype?: { name?: string };
  };
}

/**
 * Escapes a user string for interpolation inside a double-quoted JQL string
 * literal. Backslashes first, then quotes, so a trailing `\` cannot swallow
 * the closing quote. Control characters are dropped.
 */
export function escapeJqlString(value: string): string {
  return value
    .replace(/[\p{Cc}]/gu, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

async function defaultSearchRun(bin: string, args: string[]): Promise<string> {
  const { createRunner } = await import('../collector/runner.js');
  const r = createRunner({
    delayMs: config.cliDelayMs,
    retries: config.cliRetries,
    timeoutMs: config.cliTimeoutMs,
  });
  return r(bin, args);
}

/**
 * Creates the Express application. The backend is "live": each request runs the
 * collector against `acli` / `glab` on demand. Query params allow overriding the
 * traversal depth / node cap per request.
 */
export function createApp(options: CreateAppOptions = {}): express.Express {
  const run: GraphRunFn = options.run || ((key, opts) => buildContextGraph(key, opts));
  const app = express();

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/search', async (req: Request, res: Response) => {
    const q = req.query.q;
    if (typeof q !== 'string' || q.trim() === '') {
      res.json([]);
      return;
    }

    try {
      const searchRun: SearchRunFn = options.searchRun || defaultSearchRun;
      const escaped = escapeJqlString(q.trim());
      const jql = `text ~ "${escaped}" OR summary ~ "${escaped}"`;
      const stdout = await searchRun(config.acliBin, [
        'jira', 'workitem', 'search',
        '--jql', jql,
        '--limit', '5',
        '--fields', 'key,summary,issuetype',
        '--json',
      ]);
      if (!stdout) {
        res.json([]);
        return;
      }

      const parsed: RawSearchResult[] = JSON.parse(stdout) as RawSearchResult[];
      const results = Array.isArray(parsed) ? parsed : [];
      const mapped = results
        .filter((r) => typeof r.key === 'string')
        .map((r) => ({
          key: r.key,
          summary: r.fields?.summary || '',
          type: r.fields?.issuetype?.name || '',
        }));
      res.json(mapped);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * Live graph endpoint. `?view=graph|context|full` selects the payload:
   *   - graph   : renderable { nodes, edges } (default)
   *   - context : normalized LLM context payload
   *   - full    : both
   */
  app.get('/api/graph/:key', async (req: Request, res: Response) => {
    const key = String(req.params.key || '').trim().toUpperCase();
    if (!isJiraKey(key)) {
      res.status(400).json({ error: `Invalid Jira key: ${req.params.key}` });
      return;
    }

    const opts: GraphRunOptions = {};
    const maxDepthRaw = req.query.maxDepth;
    if (typeof maxDepthRaw === 'string') {
      const d = Number.parseInt(maxDepthRaw, 10);
      if (Number.isFinite(d) && d >= 0) opts.maxDepth = d;
    }
    const maxNodesRaw = req.query.maxNodes;
    if (typeof maxNodesRaw === 'string') {
      const n = Number.parseInt(maxNodesRaw, 10);
      if (Number.isFinite(n) && n > 0) opts.maxNodes = n;
    }
    if (req.query.refresh === '1' || req.query.refresh === 'true') opts.refresh = true;

    const isSSE = req.headers.accept === 'text/event-stream';
    if (isSSE) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      opts.log = (msg) => {
        res.write(`data: ${JSON.stringify({ type: 'log', message: msg })}\n\n`);
      };
    }

    try {
      const { graph, context } = await run(key, opts);
      const view = typeof req.query.view === 'string' ? req.query.view : 'graph';
      let finalData: ContextGraph | ContextGraph['graph'] | ContextGraph['context'];
      if (view === 'context') {
        finalData = context;
      } else if (view === 'full') {
        finalData = { graph, context };
      } else {
        finalData = graph;
      }

      if (isSSE) {
        res.write(`data: ${JSON.stringify({ type: 'result', data: finalData })}\n\n`);
        res.end();
      } else {
        res.json(finalData);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isSSE) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  app.use(express.static(publicDir));

  return app;
}

/** Starts the server unless imported as a module. */
export function start(port: number = config.port): Server {
  const app = createApp();
  return app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`latoile backend listening on http://localhost:${port}`);
  });
}

const entryArg = process.argv[1];
const isMain = Boolean(entryArg) && fileURLToPath(import.meta.url) === path.resolve(entryArg as string);
if (isMain) {
  start();
}

export default createApp;
