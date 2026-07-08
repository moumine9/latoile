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
}

/** Runs the pipeline for a key; injectable so the server can be tested. */
export type GraphRunFn = (key: string, opts: GraphRunOptions) => Promise<ContextGraph>;

export interface CreateAppOptions {
  run?: GraphRunFn;
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

    try {
      const { graph, context } = await run(key, opts);
      const view = typeof req.query.view === 'string' ? req.query.view : 'graph';
      if (view === 'context') {
        res.json(context);
      } else if (view === 'full') {
        res.json({ graph, context });
      } else {
        res.json(graph);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
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
