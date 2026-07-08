import { execFile } from 'node:child_process';

/**
 * Promisified `execFile` wrapper.
 *
 * Runs a binary with an argument array (no shell interpolation, so Jira keys and
 * project paths cannot be used for command injection). Returns the trimmed
 * stdout. Throws an Error enriched with stderr / exit code on failure.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs?: number, maxBuffer?: number }} [opts]
 * @returns {Promise<string>}
 */
export function runProcess(bin, args, opts = {}) {
  const { timeoutMs = 30000, maxBuffer = 20 * 1024 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const message =
            (stderr && String(stderr).trim()) ||
            err.message ||
            'process failed';
          const wrapped = new Error(`${bin} ${args.join(' ')} → ${message}`);
          wrapped.cause = err;
          wrapped.stderr = stderr;
          wrapped.code = err.code;
          reject(wrapped);
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a runner that adds rate limiting and retry-with-backoff on top of an
 * underlying exec function. The underlying function is injectable, which keeps
 * the collector fully testable without `acli` / `glab` installed.
 *
 * @param {object} [options]
 * @param {(bin: string, args: string[], opts?: object) => Promise<string>} [options.exec]
 * @param {number} [options.delayMs]
 * @param {number} [options.retries]
 * @param {number} [options.timeoutMs]
 * @param {(msg: string) => void} [options.log]
 */
export function createRunner(options = {}) {
  const {
    exec = runProcess,
    delayMs = 0,
    retries = 2,
    timeoutMs = 30000,
    log = () => {},
  } = options;

  let lastCall = 0;

  return async function run(bin, args) {
    if (delayMs > 0) {
      const wait = lastCall + delayMs - Date.now();
      if (wait > 0) await delay(wait);
    }

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        lastCall = Date.now();
        return await exec(bin, args, { timeoutMs });
      } catch (err) {
        attempt += 1;
        if (attempt > retries) throw err;
        const backoff = Math.min(2000, 250 * 2 ** (attempt - 1));
        log(
          `retry ${attempt}/${retries} for "${bin} ${args.join(' ')}" after error: ${err.message}`
        );
        await delay(backoff);
      }
    }
  };
}

export default createRunner;
