import { execFile, type ExecFileException } from 'node:child_process';
import type { LogFn, RunFn } from '../types.js';

/** Options accepted by the low-level process runner. */
export type RunProcessOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
}

/** Error thrown by {@link runProcess}, enriched with process diagnostics. */
export class ProcessError extends Error {
  stderr: string;
  code: string | number | undefined;

  constructor(message: string, stderr: string, code: string | number | undefined, cause: Error) {
    super(message, { cause });
    this.name = 'ProcessError';
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Promisified `execFile` wrapper.
 *
 * Runs a binary with an argument array (no shell interpolation, so Jira keys and
 * project paths cannot be used for command injection). Returns the trimmed
 * stdout. Throws an Error enriched with stderr / exit code on failure.
 */
export function runProcess(bin: string, args: string[], opts: RunProcessOptions = {}): Promise<string> {
  const { timeoutMs = 30000, maxBuffer = 20 * 1024 * 1024 } = opts;
  return new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer, windowsHide: true },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        if (err) {
          const message = (stderr && String(stderr).trim()) || err.message || 'process failed';
          reject(new ProcessError(`${bin} ${args.join(' ')} → ${message}`, stderr, err.code, err));
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A lower-level exec function that {@link createRunner} builds upon. */
export type ExecFn = (bin: string, args: string[], opts?: RunProcessOptions) => Promise<string>;

/** Options for {@link createRunner}. */
export type RunnerOptions = {
  exec?: ExecFn;
  delayMs?: number;
  retries?: number;
  timeoutMs?: number;
  log?: LogFn;
}

/**
 * Creates a runner that adds rate limiting and retry-with-backoff on top of an
 * underlying exec function. The underlying function is injectable, which keeps
 * the collector fully testable without `acli` / `glab` installed.
 */
export function createRunner(options: RunnerOptions = {}): RunFn {
  const { exec = runProcess, delayMs = 0, retries = 2, timeoutMs = 30000, log = () => {} } = options;

  let lastCall = 0;

  return async function run(bin: string, args: string[]): Promise<string> {
    if (delayMs > 0) {
      const wait = lastCall + delayMs - Date.now();
      if (wait > 0) await delay(wait);
    }

    let attempt = 0;
    while (true) {
      try {
        lastCall = Date.now();
        return await exec(bin, args, { timeoutMs });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        attempt += 1;
        if (attempt > retries) throw err;
        const backoff = Math.min(2000, 250 * 2 ** (attempt - 1));
        log(`retry ${attempt}/${retries} for "${bin} ${args.join(' ')}" after error: ${message}`);
        await delay(backoff);
      }
    }
  };
}

export default createRunner;
