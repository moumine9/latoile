#!/usr/bin/env node
/**
 * Background watcher (PLAN-NEO4J.md phase 3): a one-shot re-traversal of the
 * stalest known issues in the knowledge graph, meant to be run periodically
 * by an external scheduler (cron, Windows Task Scheduler, etc.) rather than
 * as a long-lived daemon — the pipeline and sink are already request-shaped,
 * so "background" just means "run this on a timer".
 *
 * For each stale issue: re-traverses at maxDepth 0 (verifies the issue and
 * its own GitLab data only, not neighbors — neighbors get their own turn
 * when their `last_seen` ages past the threshold), lets the normal pipeline
 * feed the sink, and logs what changed (status/title) since the last sighting.
 */
import { buildContextGraph, closeSharedSink } from './pipeline.js';
import { createKnowledgeGraph, type KnowledgeGraph, type StoredIssue } from './sink/knowledge-graph.js';
import { config } from './config.js';
import type { LogFn } from './types.js';

const log: LogFn = (msg: string) => {
  process.stderr.write(`[watcher] ${msg}\n`);
};

export function describeChange(before: StoredIssue | undefined, after: StoredIssue | undefined): string | undefined {
  if (!before || !after) return undefined;
  const changes: string[] = [];
  if (before.status !== after.status) changes.push(`status: ${before.status ?? '?'} → ${after.status ?? '?'}`);
  if (before.title !== after.title) changes.push(`title changed`);
  if (before.assignee !== after.assignee) changes.push(`assignee: ${before.assignee ?? '?'} → ${after.assignee ?? '?'}`);
  return changes.length > 0 ? changes.join(', ') : undefined;
}

export async function runWatcher(kg: KnowledgeGraph): Promise<{ checked: number; changed: number }> {
  const keys = await kg.staleIssueKeys(config.watcherStaleMinutes, config.watcherBatchSize);
  if (keys.length === 0) {
    log('nothing stale — up to date');
    return { checked: 0, changed: 0 };
  }
  log(`refreshing ${keys.length} stale issue(s): ${keys.join(', ')}`);

  let changed = 0;
  for (const key of keys) {
    const before = (await kg.knownContext(key)).issue;
    try {
      await buildContextGraph(key, { maxDepth: 0, maxNodes: 1, log });
    } catch (err) {
      log(`${key}: refresh failed (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const after = (await kg.knownContext(key)).issue;
    const diff = describeChange(before, after);
    if (diff) {
      changed += 1;
      log(`${key}: ${diff}`);
    }
  }
  log(`done — ${keys.length} checked, ${changed} changed`);
  return { checked: keys.length, changed };
}

async function main(): Promise<void> {
  if (!config.neo4jEnabled || !config.neo4jUri) {
    log('knowledge graph not configured (LATOILE_NEO4J_URI) — nothing to watch');
    return;
  }
  const kg = await createKnowledgeGraph(
    { uri: config.neo4jUri, user: config.neo4jUser, password: config.neo4jPassword },
    log
  );
  try {
    await runWatcher(kg);
  } finally {
    await kg.close();
    await closeSharedSink();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  main().catch((err) => {
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    process.stderr.write(`Error: ${detail}\n`);
    process.exit(1);
  });
}
