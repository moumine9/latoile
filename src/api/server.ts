import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { buildContextGraph, type ContextGraph } from '../pipeline.js';
import { isJiraKey } from '../collector/jiraKeys.js';
import { searchIssues, type SearchRunFn } from '../collector/search.js';
import { parseMrUrl, resolveJiraKeyFromMr, type ResolvedMrEntry } from '../collector/mr-entry.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled layout: dist/src/api/server.js → repository root is three levels up.
const publicDir = path.resolve(__dirname, '../../../public');

/** Per-request traversal overrides parsed from the query string. */
export type GraphRunOptions = {
  maxDepth?: number;
  maxNodes?: number;
  /** Bypass cached reads for this run. */
  refresh?: boolean;
  log?: (msg: string) => void;
}

/** Runs the pipeline for a key; injectable so the server can be tested. */
export type GraphRunFn = (key: string, opts: GraphRunOptions) => Promise<ContextGraph>;

export type { SearchRunFn } from '../collector/search.js';
// Re-exported for existing consumers/tests; implementation lives in collector/search.ts.
export { escapeJqlString } from '../collector/search.js';

/** Resolves an MR URL to its Jira key; injectable for tests. */
export type ResolveMrFn = (url: string) => Promise<ResolvedMrEntry>;

export type CreateAppOptions = {
  run?: GraphRunFn;
  searchRun?: SearchRunFn;
  resolveMr?: ResolveMrFn;
}

async function defaultResolveMr(url: string): Promise<ResolvedMrEntry> {
  const parsed = parseMrUrl(url);
  if (!parsed) throw new Error('Not a GitLab merge request URL');
  const { GitlabHttpClient } = await import('../collector/gitlab-http.js');
  return resolveJiraKeyFromMr(parsed, new GitlabHttpClient({ host: parsed.host }));
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
      const results = await searchIssues(q, { searchRun: options.searchRun });
      res.json(results);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /** Resolves a GitLab MR URL to its Jira key for the UI's paste-a-link flow. */
  app.get('/api/resolve-mr', async (req: Request, res: Response) => {
    const url = req.query.url;
    if (typeof url !== 'string' || url.trim() === '') {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }
    if (!parseMrUrl(url)) {
      res.status(400).json({ error: 'Not a GitLab merge request URL' });
      return;
    }
    try {
      const resolve = options.resolveMr || defaultResolveMr;
      const resolved = await resolve(url);
      res.json({
        key: resolved.key,
        foundIn: resolved.foundIn,
        mrIid: resolved.mrIid,
        mrProject: resolved.mrProject,
        mrTitle: resolved.mrTitle,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: message });
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
    console.log(`latoile backend listening on http://localhost:${port}`);
  });
}

const entryArg = process.argv[1];
const isMain = Boolean(entryArg) && fileURLToPath(import.meta.url) === path.resolve(entryArg as string);
if (isMain) {
  start();
}

export default createApp;
