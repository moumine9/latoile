/**
 * Persistence hook for the knowledge graph (see PLAN-NEO4J.md).
 *
 * The pipeline hands every raw `TraversalResult` to a sink after traversal so
 * coverage accumulates across runs. The pipeline depends only on this
 * interface — Neo4j is one implementation — and a sink failure must never
 * fail a pipeline run (callers wrap `ingest` in try/catch).
 */
import type { TraversalResult } from '../types.js';

export type GraphSink = {
  ingest(result: TraversalResult): Promise<void>;
  close(): Promise<void>;
}
