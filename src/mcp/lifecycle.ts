/**
 * MCP server process lifecycle: in-flight tool-call tracking and the shared
 * Neo4j read handle.
 *
 * Both exist for clean shutdown. The SDK's stdio transport never signals
 * stdin EOF, and the Neo4j driver's open sockets keep the process alive
 * forever, so `server.ts` watches stdin itself and tears these down. One-shot
 * clients close stdin immediately after writing their request, so shutdown
 * must wait for in-flight calls or their responses would be dropped.
 */
import { config } from '../config.js';
import type { KnowledgeGraph } from '../sink/knowledge-graph.js';
import type { ToolResult } from './tool-result.js';

/* ------------------------- in-flight call tracking ------------------------ */

let inflightToolCalls = 0;

/** Wraps a tool-handler promise so shutdown can wait for it to settle. */
export async function tracked(work: Promise<ToolResult>): Promise<ToolResult> {
  inflightToolCalls += 1;
  try {
    return await work;
  } finally {
    inflightToolCalls -= 1;
  }
}

/**
 * Resolves once no tool call is running. The initial delay lets requests that
 * were read from stdin just before EOF reach their handlers (handler dispatch
 * crosses a microtask boundary in the SDK, so an immediate check could miss
 * them and exit before the response is written).
 */
export async function waitForInflightToolCalls(settleMs = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  while (inflightToolCalls > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/* ------------------------ shared knowledge graph -------------------------- */

// One read handle per process, created lazily like the pipeline's sink.
let sharedGraphPromise: Promise<KnowledgeGraph | undefined> | undefined;

/** Returns the shared Neo4j read handle, or undefined when unconfigured/down. */
export function getSharedKnowledgeGraph(): Promise<KnowledgeGraph | undefined> {
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

/** Closes the shared Neo4j read handle (idempotent); used on shutdown. */
export async function closeSharedKnowledgeGraph(): Promise<void> {
  const kg = await sharedGraphPromise;
  sharedGraphPromise = undefined;
  await kg?.close();
}
