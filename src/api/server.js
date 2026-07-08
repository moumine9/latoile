import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContextGraph } from '../pipeline.js';
import { isJiraKey } from '../collector/jiraKeys.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../public');

/**
 * Creates the Express application. The backend is "live": each request runs the
 * collector against `acli` / `glab` on demand. Query params allow overriding the
 * traversal depth / node cap per request.
 *
 * @param {object} [options]
 * @param {(key: string, opts: object) => Promise<{graph:object,context:object}>} [options.run]
 */
export function createApp(options = {}) {
  const run = options.run || ((key, opts) => buildContextGraph(key, opts));
  const app = express();

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /**
   * Live graph endpoint. `?view=graph|context|full` selects the payload:
   *   - graph   : renderable { nodes, edges } (default)
   *   - context : normalized LLM context payload
   *   - full    : both
   */
  app.get('/api/graph/:key', async (req, res) => {
    const key = String(req.params.key || '').trim().toUpperCase();
    if (!isJiraKey(key)) {
      res.status(400).json({ error: `Invalid Jira key: ${req.params.key}` });
      return;
    }

    const opts = {};
    if (req.query.maxDepth !== undefined) {
      const d = Number.parseInt(req.query.maxDepth, 10);
      if (Number.isFinite(d) && d >= 0) opts.maxDepth = d;
    }
    if (req.query.maxNodes !== undefined) {
      const n = Number.parseInt(req.query.maxNodes, 10);
      if (Number.isFinite(n) && n > 0) opts.maxNodes = n;
    }

    try {
      const { graph, context } = await run(key, opts);
      const view = String(req.query.view || 'graph');
      if (view === 'context') {
        res.json(context);
      } else if (view === 'full') {
        res.json({ graph, context });
      } else {
        res.json(graph);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use(express.static(publicDir));

  return app;
}

/** Starts the server unless imported as a module. */
export function start(port = config.port) {
  const app = createApp();
  return app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`latoile backend listening on http://localhost:${port}`);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  start();
}

export default createApp;
