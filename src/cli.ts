#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { buildContextGraph } from './pipeline.js';
import { isJiraKey } from './collector/jiraKeys.js';
import type { ContextGraph } from './pipeline.js';
import type { ContextResult, GraphResult, LogFn } from './types.js';

interface CliArgs {
  view: string;
  out?: string;
  maxDepth?: number;
  maxNodes?: number;
  verbose?: boolean;
  help?: boolean;
  key?: string;
}

/**
 * CLI: latoile <JIRA-KEY> [options]
 *
 *   --out <file>         write JSON to a file instead of stdout
 *   --view graph|context|full   which payload to emit (default: full)
 *   --max-depth <n>      override traversal depth
 *   --max-nodes <n>      override node cap
 *   --verbose            log progress to stderr
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { view: 'full' };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--out':
        args.out = argv[++i];
        break;
      case '--view':
        args.view = argv[++i] ?? args.view;
        break;
      case '--max-depth':
        args.maxDepth = Number.parseInt(argv[++i] ?? '', 10);
        break;
      case '--max-nodes':
        args.maxNodes = Number.parseInt(argv[++i] ?? '', 10);
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (a !== undefined) rest.push(a);
    }
  }
  args.key = rest[0];
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `Usage: latoile <JIRA-KEY> [options]\n\n` +
      `Options:\n` +
      `  --out <file>              Write JSON to a file instead of stdout\n` +
      `  --view graph|context|full Payload to emit (default: full)\n` +
      `  --max-depth <n>           Override traversal depth\n` +
      `  --max-nodes <n>           Override node cap\n` +
      `  --verbose                 Log progress to stderr\n` +
      `  -h, --help                Show this help\n`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.key) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const key = args.key.trim().toUpperCase();
  if (!isJiraKey(key)) {
    process.stderr.write(`Invalid Jira key: ${args.key}\n`);
    process.exit(1);
  }

  const log: LogFn | undefined = args.verbose
    ? (msg: string) => {
        process.stderr.write(`${msg}\n`);
      }
    : undefined;
  const { graph, context }: ContextGraph = await buildContextGraph(key, {
    maxDepth: Number.isFinite(args.maxDepth) ? args.maxDepth : undefined,
    maxNodes: Number.isFinite(args.maxNodes) ? args.maxNodes : undefined,
    log,
  });

  let payload: GraphResult | ContextResult | ContextGraph;
  if (args.view === 'graph') payload = graph;
  else if (args.view === 'context') payload = context;
  else payload = { graph, context };

  const json = JSON.stringify(payload, null, 2);
  if (args.out) {
    await writeFile(args.out, json, 'utf8');
    process.stderr.write(`Wrote ${args.out}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

main().catch((err) => {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`Error: ${detail}\n`);
  process.exit(1);
});
