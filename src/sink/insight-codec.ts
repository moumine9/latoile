/**
 * Encoding of insight sub-fields for Neo4j storage.
 *
 * Neo4j node properties cannot hold arrays of maps, so `entities` and
 * `relevantComments` are persisted on the `:Insight` node as single JSON
 * strings (see comment-codec.ts for the same pattern applied to comments).
 * The encode/decode pair lives together here so the write and read paths in
 * knowledge-graph.ts cannot drift apart.
 */
import type { InsightCommentRef, InsightEntity } from '../types.js';

export function encodeInsightEntities(entities: InsightEntity[] | undefined): string {
  return JSON.stringify(entities ?? []);
}

/** Decodes stored entities, silently dropping entries that fail to parse or lack a name. */
export function decodeInsightEntities(stored: string | undefined | null): InsightEntity[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    const out: InsightEntity[] = [];
    for (const entry of parsed as unknown[]) {
      const e = entry as Partial<InsightEntity>;
      if (typeof e?.name !== 'string' || !e.name) continue;
      out.push({ name: e.name, role: typeof e.role === 'string' ? e.role : undefined });
    }
    return out;
  } catch {
    return [];
  }
}

export function encodeInsightComments(comments: InsightCommentRef[] | undefined): string {
  return JSON.stringify(comments ?? []);
}

/** Decodes stored comment refs, silently dropping entries that fail to parse or are malformed. */
export function decodeInsightComments(stored: string | undefined | null): InsightCommentRef[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    const out: InsightCommentRef[] = [];
    for (const entry of parsed as unknown[]) {
      const c = entry as Partial<InsightCommentRef>;
      if (typeof c?.commentId !== 'string' || !c.commentId) continue;
      if (c.relevance !== 'high' && c.relevance !== 'low') continue;
      out.push({ commentId: c.commentId, relevance: c.relevance, why: typeof c.why === 'string' ? c.why : undefined });
    }
    return out;
  } catch {
    return [];
  }
}
