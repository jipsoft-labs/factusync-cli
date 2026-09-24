import { run, type CliEnv } from '../src/run.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON; throws when it is not exactly one JSON document. */
  json: () => unknown;
  /** stderr parsed as JSON. */
  error: () => { code: string; message: string; details?: unknown };
}

export async function runCli(
  argv: string[],
  env: CliEnv,
  options: { stdin?: string; timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, env, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => options.stdin ?? '',
    fetch: options.fetch ?? globalThis.fetch,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return {
    code,
    stdout,
    stderr,
    json: () => JSON.parse(stdout) as unknown,
    error: () => JSON.parse(stderr) as { code: string; message: string; details?: unknown },
  };
}
