/**
 * Encoding of issue comments for Neo4j storage.
 *
 * Neo4j node properties cannot hold arrays of maps, so comments are persisted
 * on the `:Issue` node as an array of JSON strings. The encode/decode pair
 * lives together here so the sink (write) and knowledge graph (read) cannot
 * drift apart.
 */
import type { IssueComment } from '../types.js';

export function encodeStoredComment(comment: IssueComment): string {
  return JSON.stringify(comment);
}

/** Decodes stored comments, silently dropping entries that fail to parse. */
export function decodeStoredComments(stored: string[] | undefined | null): IssueComment[] {
  if (!Array.isArray(stored)) return [];
  const out: IssueComment[] = [];
  for (const entry of stored) {
    try {
      const parsed = JSON.parse(entry) as Partial<IssueComment>;
      if (typeof parsed.body !== 'string' || !parsed.body) continue;
      out.push({
        author: typeof parsed.author === 'string' ? parsed.author : '',
        created: typeof parsed.created === 'string' ? parsed.created : '',
        body: parsed.body,
      });
    } catch {
      // Not valid JSON — drop it rather than fail the whole read.
    }
  }
  return out;
}
